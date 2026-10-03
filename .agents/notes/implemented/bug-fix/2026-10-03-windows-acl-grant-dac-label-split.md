# Agent Note: The Windows sandbox ACL grant issues the DACL and the integrity label in separate calls

Status: implemented

English | [中文](2026-10-03-windows-acl-grant-dac-label-split.zh.md)

## Problem

`dsh-sandbox-windows-acl` granted the workspace directory its capability DACL entry and its Low integrity label (the no-write-up ACE in the SACL) in a single `SetNamedSecurityInfoW` call carrying `DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION`. Whenever the token does not hold `SeRelabelPrivilege`, the kernel validates every requested information class before applying any of them, so the whole call failed with `ERROR_ACCESS_DENIED` — including the DACL grant, which needs only the owner-implicit `WRITE_DAC`. The workspace binding crashed: a host that lacked the privilege the label alone needs lost even the grant it could have succeeded with, and the workspace was unusable.

## Decision

The shared tail of `grantWrite` and `revokeWrite` now issues the two edits in two separate `SetNamedSecurityInfoW` calls. Step A issues the merged DACL alone: the owner-implicit `WRITE_DAC` suffices, so the grant lands for every token that owns the directory. Step B enables `SeRelabelPrivilege` in the process token through `ensureRelabelPrivilege`, which opens a fresh `TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES` token and enables a single-entry `TOKEN_PRIVILEGES` via `AdjustTokenPrivileges`; it is non-throwing by contract, and every failure returns a reason naming the failing API and the exact Win32 code (1300 / 1301 with the formatted system text). Step C issues the label edit alone: `apply` writes the Low no-write-up ACE, `clear` replaces the SACL with a NULL pointer. A label step that cannot enable the privilege degrades to a diagnostic instead of a throw: the DACL grant stands, the workspace binding stays live, and the warning names the privilege gap plus the directory's `WRITE_OWNER` right and its `icacls` remedy. The label ACL is freed on every path, including the degrade path.

New constants: `SE_RELABEL_NAME = 'SeRelabelPrivilege'`, `ERROR_NOT_ALL_ASSIGNED = 1300`, `ERROR_NO_SUCH_PRIVILEGE = 1301`, `TOKEN_PRIVILEGES_SINGLE_SIZE = 16` (a 4-byte `PrivilegeCount` header plus one 12-byte `LUID_AND_ATTRIBUTES`; a bare `LUID_AND_ATTRIBUTES` would let `AdjustTokenPrivileges` read the LUID's low word as the entry count and walk far past the buffer); the FFI layer gains `allocUint32` and `decodeUint32`.

## Alternatives considered

**Enable the privilege first and keep the combined call.** Rejected: the combined call is the atomic failure point — an enabled privilege whose SACL write is still refused (the directory lacks `WRITE_OWNER`) would lose the DACL grant again, and only the split keeps the grant immune to label failure.

**Elevate the whole DSH process so the label always applies.** Rejected: it forces every deployment to run as an administrator for a workspace binding; the label is integrity hardening, not a precondition of the grant, so the label is the part that degrades, not the sandbox.

**Drop the integrity label entirely.** Rejected: the Low no-write-up ACE is what keeps a sandboxed child from writing up into the host's files; keeping it on the happy path preserves the protection on hosts that can enable the privilege.

## Consequences

A standard (non-elevated) user token now gets the full DACL grant and a live workspace binding, with the integrity label applied whenever the token holds and can enable `SeRelabelPrivilege`; a label-step failure is a diagnostic, never a crash, and it names both the privilege gap and the directory's `WRITE_OWNER` right. An elevated token keeps the original outcome through two calls instead of one. A directory that lacks `WRITE_OWNER` still fails closed on the label write even when the privilege is enabled — that state now carries the full diagnostic trail (privilege state plus the exact Win32 code) and is left to the caller's fail-closed semantics.

## Upstream status

This failure is tracked in upstream [discussion #7504](https://github.com/deepseek-ai/deepseek-harness/discussions/7504), which the maintainers verified and framed as a policy decision; as of `0.2.1-alpha.1` the core grant path is unchanged, and upstream's response is the bundled `diagnose-windows-sandbox-acl` repair skill, which grants the directory's owner an inheritable `WRITE_OWNER` ACE. That remedy mutates the workspace DACL and still leaves the label write subject to the combined call's up-front validation, so this split remains complementary: it removes the privilege and `WRITE_OWNER` preconditions from the DACL grant itself without any persistent ACL edit.

## Testing

`packages/sandbox/sandbox-windows-acl/tests/acl-failure-paths.spec.ts` drives the decoupled sequence with stub bindings: the grant issues exactly two `SetNamedSecurityInfoW` calls, the first DACL-only (no LABEL bit, no SACL pointer) and the second LABEL-only carrying the label ACE; a failed privilege enable degrades — one call, no LABEL bit, the label ACL freed, and one diagnostic naming `SeRelabelPrivilege`; a partial stub without the privilege bindings degrades the same way. `ensureRelabelPrivilege`'s failure paths each return `{ enabled: false }` with the exact API and Win32 code (87, 22, 1301, and 1300), and the success path enables exactly `SeRelabelPrivilege`. `acl.spec.ts` (win32 only) asserts the two-call shape on the real FFI round trip.
