/**
 * ACL editing helpers: grant/revoke a capability SID on a directory via
 * SetEntriesInAclW + SetNamedSecurityInfoW (the same calls the POC uses, with
 * the failure handling the POC lacks). Every API call is checked and every
 * failure is reported with the API name, the exact Win32 code, the formatted
 * system text, and the affected path.
 *
 * Each grant applies three edits in TWO SetNamedSecurityInfoW calls: the
 * capability-SID allow ACE plus the ambient-delete Deny ACE go out first in a
 * DACL-only call ({@link abi.DACL_SECURITY_INFORMATION}); the Low no-write-up
 * mandatory label ({@link buildLowLabelAcl}) goes out second in a
 * LABEL-only call ({@link abi.LABEL_SECURITY_INFORMATION}) after the
 * SeRelabelPrivilege attempt ({@link ensureRelabelPrivilege}). The kernel
 * evaluates every requested information class up front, so a combined
 * DACL|LABEL call by a token without what the label write needs fails
 * wholesale with ERROR_ACCESS_DENIED — losing even the DACL grant and
 * crashing the workspace binding. Decoupled, the DACL step succeeds under
 * the owner's implicit WRITE_DAC, and the label write goes out regardless
 * of whether the privilege is held: the kernel accepts EITHER
 * SeRelabelPrivilege OR the WRITE_OWNER right on the directory. When the
 * label write is still denied without the privilege, the grant self-heals
 * once — grant the caller's own user SID WRITE_OWNER on the directory (the
 * owner-implicit WRITE_DAC authorizes it), retry the label, and revoke the
 * temporary right — so adding a workspace to a workspace-write session
 * needs no elevation and no manual icacls step. A label that cannot be
 * written even after the heal throws: the DACL grant alone leaves the
 * child able to write UP into Medium-IL targets, so the workspace is not
 * usable without the label. The deny is what keeps one granted root out of another's reach:
 * Windows also authorizes a delete from the parent directory's
 * `FILE_DELETE_CHILD` right, which the token's write-restricted intersection
 * does not reach, and every granted root carries the Low label that clears
 * the integrity check.
 *
 * Concurrency: grants are read-merge-write against the directory's CURRENT
 * DACL, and the whole get-merge-set sequence runs under a per-path exclusive
 * LockFileEx lock (see {@link withPathLock}) so concurrent sandbox instances
 * cannot clobber each other's ACEs.
 * @module @deepseek-ai/dsh-sandbox-windows-acl/acl
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { Win32Error } from '@deepseek-ai/dsh-win32-process'

import { allocOverlapped, allocPtrSlot, allocUint32, decodePtr, decodePtrAt, decodeUint8At, decodeUint16At, decodeUint32, decodeUint32At, getTempPath, isInvalidHandle, isNullPtr, ptrAddress, sameSidAt, throwLastError, throwWin32 } from './ffi.ts'
import type { NativePtr, Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/**
 * Pack one EXPLICIT_ACCESS_W (48 bytes, layout verified by abi-probe.cpp):
 * perms@0, mode@4, inheritance@8, Trustee@16 { pMultipleTrustee@16,
 * MultipleTrusteeOperation@24, TrusteeForm@28, TrusteeType@32, ptstrName@40 }.
 * `permissions` is the access mask; the POC passes 0 for REVOKE_ACCESS, which
 * removes every ACE for the trustee. `inheritance` defaults to children of
 * both kinds; the ambient-delete deny narrows it to containers because
 * FILE_DELETE_CHILD is meaningless on a file and its bit would otherwise
 * spread through the file's inherited mask.
 * @param sidPtr - the trustee SID the entry names.
 * @param mode - the access mode (GRANT_ACCESS, DENY_ACCESS, or REVOKE_ACCESS).
 * @param permissions - the access mask to grant or deny (0 for REVOKE_ACCESS).
 * @param inheritance - the ACE inheritance flags.
 * @returns the packed entry buffer.
 */
export function buildExplicitAccess(
  sidPtr: NativePtr,
  mode: number,
  permissions: number,
  inheritance: number = abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
): Buffer {
  const entry = Buffer.alloc(abi.EXPLICIT_ACCESS_W_SIZE)
  entry.writeUInt32LE(permissions, 0) // grfAccessPermissions
  entry.writeUInt32LE(mode, 4) // grfAccessMode
  entry.writeUInt32LE(inheritance, 8) // grfInheritance
  entry.writeUInt32LE(abi.NO_MULTIPLE_TRUSTEE, 24) // Trustee.MultipleTrusteeOperation
  entry.writeUInt32LE(abi.TRUSTEE_IS_SID, 28) // Trustee.TrusteeForm
  entry.writeUInt32LE(abi.TRUSTEE_IS_UNKNOWN, 32) // Trustee.TrusteeType
  entry.writeBigUInt64LE(ptrAddress(sidPtr), 40) // Trustee.ptstrName = the capability SID
  return entry
}

/**
 * One lock file per protected path: `<GetTempPathW()>\dsh-acl-locks\<first 16
 * hex of sha256(lowercased path)>.lock`. The lock root derives from
 * GetTempPathW (never from runner argv or DSH_HOME), and the lowercasing
 * maps Windows's case-insensitive path spellings onto one lock.
 * @param api - the binding table.
 * @param path - the protected directory (absolute).
 * @returns the lock file path for that directory.
 */
export function lockFilePath(api: Win32Bindings, path: string): string {
  const digest = createHash('sha256').update(path.toLowerCase()).digest('hex').slice(0, 16)
  return join(getTempPath(api), 'dsh-acl-locks', `${digest}.lock`)
}

/**
 * Run `action` holding the per-path exclusive lock: CreateFileW
 * (OPEN_ALWAYS, shared read/write but NOT delete — a deletable lock file
 * could be removed and recreated under the holder, letting two processes
 * hold "the same" lock), then a one-byte LockFileEx
 * (LOCKFILE_EXCLUSIVE_LOCK, zeroed OVERLAPPED = lock from offset 0 on the
 * synchronous handle — see allocOverlapped for why not NULL), then
 * UnlockFileEx + CloseHandle. Fail-closed: open/lock/unlock/close failures
 * throw like every other Win32 call in this package; an `action` failure
 * still unlocks (best-effort) and rethrows the original error.
 * @param api - the binding table.
 * @param path - the protected directory (absolute).
 * @param action - the get-merge-set sequence to serialize.
 * @returns the action's result.
 */
export function withPathLock<T>(api: Win32Bindings, path: string, action: () => T): T {
  const lockPath = lockFilePath(api, path)
  mkdirSync(dirname(lockPath), { recursive: true })
  const handle = api.createFileW(
    lockPath,
    abi.GENERIC_READ | abi.GENERIC_WRITE,
    abi.FILE_SHARE_READ | abi.FILE_SHARE_WRITE,
    null, abi.OPEN_ALWAYS, 0, null,
  )
  if (isInvalidHandle(handle)) throwLastError(api, 'CreateFileW', lockPath)
  const overlapped = allocOverlapped() // stays zeroed: offset 0, hEvent NULL
  if (api.lockFileEx(handle, abi.LOCKFILE_EXCLUSIVE_LOCK, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the lock-failure path
    throwWin32(api, 'LockFileEx', win32Code, lockPath)
  }

  let result: T
  try {
    result = action()
  } catch (error) {
    // Best-effort release on the action-failure path: cleanup failures must
    // not mask the action's error.
    api.unlockFileEx(handle, 0, 1, 0, overlapped)
    api.closeHandle(handle)
    throw error
  }
  if (api.unlockFileEx(handle, 0, 1, 0, overlapped) === 0) {
    const win32Code = api.getLastError()
    api.closeHandle(handle) // best-effort on the unlock-failure path
    throwWin32(api, 'UnlockFileEx', win32Code, lockPath)
  }
  if (api.closeHandle(handle) === 0) throwLastError(api, 'CloseHandle', `lock file ${lockPath}`)
  return result
}

/**
 * Read the directory's current explicit DACL and mandatory label via
 * GetNamedSecurityInfoW.
 * Allocation contract (the POC's RevokeAccess, minus its missing checks): the
 * returned ACL pointer sits INSIDE the security descriptor allocation — only
 * the descriptor may be LocalFree'd, and it must not be freed before
 * SetEntriesInAclW has consumed the ACL. Freeing the ACL pointer itself
 * corrupts the heap (verified the hard way).
 * @param api - the binding table.
 * @param path - the directory whose DACL and label are read.
 * @returns the current explicit DACL and label ACL (null when the directory carries none) plus their owning descriptor.
 */
function readCurrentSecurity(
  api: Win32Bindings,
  path: string,
): { oldAcl: NativePtr | null; labelAcl: NativePtr | null; descriptor: NativePtr | null } {
  const ownerSlot = allocPtrSlot()
  const groupSlot = allocPtrSlot()
  const daclSlot = allocPtrSlot()
  const saclSlot = allocPtrSlot()
  const descriptorSlot = allocPtrSlot()
  const readResult = api.getNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION | abi.LABEL_SECURITY_INFORMATION,
    ownerSlot, groupSlot, daclSlot, saclSlot, descriptorSlot,
  )
  if (readResult !== abi.ERROR_SUCCESS) throwWin32(api, 'GetNamedSecurityInfoW', readResult, path)
  return { oldAcl: decodePtr(daclSlot), labelAcl: decodePtr(saclSlot), descriptor: decodePtr(descriptorSlot) }
}

/**
 * Build the Low mandatory label applied with every write grant: one
 * SYSTEM_MANDATORY_LABEL_ACE naming `lowLabelSidPtr` with the no-write-up
 * policy, inheriting to subcontainers and objects so later children carry the
 * same label. The caller frees the returned ACL with LocalFree
 * (SetNamedSecurityInfoW copies it); every Win32 call is checked and a
 * half-built ACL is released before the error is thrown.
 * @param api - the binding table.
 * @param lowLabelSidPtr - the Low integrity SID (S-1-16-4096) the label names.
 * @returns the ACL carrying the single inheritable label ACE.
 */
export function buildLowLabelAcl(api: Win32Bindings, lowLabelSidPtr: NativePtr): NativePtr {
  const sidLength = api.getLengthSid(lowLabelSidPtr)
  if (sidLength === 0) throwLastError(api, 'GetLengthSid', 'Low mandatory label SID')
  const aclLength = abi.ACL_HEADER_SIZE + abi.MANDATORY_ACE_OVERHEAD + sidLength
  const acl = api.localAlloc(abi.LPTR, aclLength)
  if (isNullPtr(acl)) throwLastError(api, 'LocalAlloc', 'Low mandatory label ACL')
  if (api.initializeAcl(acl, aclLength, abi.ACL_REVISION) === 0) {
    const win32Code = api.getLastError()
    api.localFree(acl) // best-effort on the error path
    throwWin32(api, 'InitializeAcl', win32Code, 'Low mandatory label ACL')
  }
  if (api.addMandatoryAce(
    acl, abi.ACL_REVISION, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowLabelSidPtr,
  ) === 0) {
    const win32Code = api.getLastError()
    api.localFree(acl) // best-effort on the error path
    throwWin32(api, 'AddMandatoryAce', win32Code, 'Low mandatory label ACL')
  }
  return acl
}

/**
 * True when the label ACL already carries the EXACT label this module would
 * add (mandatory-label ACE, OI|CI inheritance, no-write-up policy, the Low
 * SID), so a re-grant can skip the eager full-tree propagation.
 * @param labelAcl - the current label ACL pointer (from {@link readCurrentSecurity}).
 * @param lowLabelSidPtr - the Low integrity SID to match.
 * @returns whether the exact label ACE is already present.
 */
function hasExactLabel(labelAcl: NativePtr, lowLabelSidPtr: NativePtr): boolean {
  return hasExactEntry(
    labelAcl, abi.SYSTEM_MANDATORY_LABEL_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT,
    abi.SYSTEM_MANDATORY_LABEL_NO_WRITE_UP, lowLabelSidPtr,
  )
}

/**
 * The mandatory-label half of an apply: set the given label ACL, clear the
 * label, or leave it untouched. `clear` is what a revoke does when the
 * directory carries no other capability grant; `keep` is what it does while
 * another grant still relies on the shared Low level.
 */
type LabelEdit = { kind: 'apply'; acl: NativePtr } | { kind: 'clear' } | { kind: 'keep' }

/**
 * Shared tail of grantWrite and revokeWrite: merge `entries` into `oldAcl`
 * (null = no explicit DACL yet; SetEntriesInAclW builds one from scratch),
 * free the descriptor, then apply the edits in two SetNamedSecurityInfoW
 * calls — the merged DACL ALONE (owner-implicit WRITE_DAC suffices), then the
 * label edit ALONE, attempted regardless of whether the SeRelabelPrivilege
 * enable succeeded ({@link ensureRelabelPrivilege}) — freeing every ACL this
 * operation owns and reporting each failure with the caller's label and the
 * step's context (`DACL step` / `LABEL step`). A combined DACL|LABEL call
 * would fail wholesale with ERROR_ACCESS_DENIED whenever the token lacks
 * what the label write needs, losing even the DACL grant. The label goes
 * out even without the privilege because the kernel accepts EITHER the
 * privilege OR WRITE_OWNER on the directory (the {@link healLabelAccess}
 * self-heal grants the caller's own WRITE_OWNER when the first attempt is
 * denied); only a label that fails after the heal is a failure. The entry
 * count derives from the buffer, so a grant can carry its capability ACE and
 * its ambient-delete deny in one merge.
 * @param api - the binding table.
 * @param path - the directory the DACL and label edits apply to.
 * @param entries - packed EXPLICIT_ACCESS_W records to merge (grant, deny, or revoke).
 * @param oldAcl - the current explicit DACL (from {@link readCurrentSecurity}).
 * @param labelEdit - the label change to apply after the DACL step.
 * @param descriptor - the descriptor allocation owning `oldAcl`.
 * @param label - the caller's name for error details.
 */
function mergeAndApply(
  api: Win32Bindings,
  path: string,
  entries: Buffer,
  oldAcl: NativePtr | null,
  labelEdit: LabelEdit,
  descriptor: NativePtr | null,
  label: string,
): void {
  const newAclSlot = allocPtrSlot()
  const mergeResult = api.setEntriesInAclW(entries.length / abi.EXPLICIT_ACCESS_W_SIZE, entries, oldAcl, newAclSlot)
  if (mergeResult !== abi.ERROR_SUCCESS) {
    if (descriptor !== null) api.localFree(descriptor) // frees the ACL block too
    if (labelEdit.kind === 'apply') api.localFree(labelEdit.acl)
    throwWin32(api, 'SetEntriesInAclW', mergeResult, `${label}(${path})`)
  }
  const newAcl = decodePtr(newAclSlot)
  if (newAcl === null) {
    if (descriptor !== null) api.localFree(descriptor)
    if (labelEdit.kind === 'apply') api.localFree(labelEdit.acl)
    throwWin32(api, 'SetEntriesInAclW', api.getLastError(), `${label}(${path}): null new ACL`)
  }

  // The descriptor block (oldAcl included) is dead after the merge — free it
  // before applying, exactly like the POC.
  const freedDescriptor = descriptor !== null ? api.localFree(descriptor) : null

  // Step A: the DACL edit goes out ALONE. A combined DACL|LABEL call makes
  // the kernel require the SeRelabelPrivilege for the label part BEFORE any
  // part of the call is applied — a standard user token without the privilege
  // fails the whole call with ERROR_ACCESS_DENIED and loses even the DACL
  // grant, which crashes the workspace binding. DACL-only needs nothing but
  // the owner-implicit WRITE_DAC, so it succeeds on its own.
  const daclResult = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION, null, null, newAcl, null,
  )
  const freedNew = api.localFree(newAcl)
  if (daclResult !== abi.ERROR_SUCCESS) {
    // The DACL step failed: the label ACL is still owned and must not leak.
    // Free it (checked) and report with the DACL context — like the single-call
    // path, the apply failure throws before the free-result checks run.
    if (labelEdit.kind === 'apply') {
      const freedLabel = api.localFree(labelEdit.acl)
      if (!isNullPtr(freedLabel)) throwLastError(api, 'LocalFree', `${label}(${path}) label ACL`)
    }
    throwWin32(api, 'SetNamedSecurityInfoW', daclResult, `${label}(${path}) DACL step`)
  }
  if (!isNullPtr(freedNew)) throwLastError(api, 'LocalFree', `${label}(${path}) new ACL`)

  // The DACL is on disk; the label edits below can no longer roll it back.
  // `keep` leaves the standing label untouched.
  if (labelEdit.kind === 'keep') {
    if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) throwLastError(api, 'LocalFree', `${label}(${path}) descriptor`)
    return
  }

  // Step B: enable the SeRelabelPrivilege the SACL write can use. The LABEL
  // goes out EITHER WAY: the kernel accepts the label write when the caller
  // holds the privilege OR the WRITE_OWNER right on the directory (the owner
  // holds WRITE_OWNER implicitly, and an inherited Full/Modify ACE carries
  // it), so an unprivileged caller frequently labels the root cleanly on the
  // first attempt. When that attempt is denied anyway, Step C' self-heals.
  const privilege = ensureRelabelPrivilege(api, `${label}(${path}) label step`)

  // Step C: the LABEL edit goes out ALONE — `apply` sets the Low no-write-up
  // ACE, `clear` replaces the SACL with a NULL pointer (removes every label
  // ACE). The label is not optional: a DACL-only grant would leave the child
  // able to write UP into Medium-IL targets outside the roots, so a label
  // that cannot be written (even after the heal) throws fail-closed — the
  // caller's init() must not report a workspace the confined child cannot
  // safely use.
  const labelSacl = labelEdit.kind === 'apply' ? labelEdit.acl : null
  let labelResult = api.setNamedSecurityInfoW(
    path, abi.SE_FILE_OBJECT, abi.LABEL_SECURITY_INFORMATION, null, null, null, labelSacl,
  )
  if (labelResult !== abi.ERROR_SUCCESS) {
    // One self-heal pass on an access denial: grant the caller's own
    // WRITE_OWNER on the directory (the owner-implicit WRITE_DAC authorizes
    // the DACL edit), retry the label once, then restore the pre-heal DACL
    // from the snapshot taken before the merge.
    // Never skip the label because the privilege is absent — the privilege
    // was never the only gate, and a skipped label silently disables the
    // integrity confinement while reporting success.
    if (!privilege.enabled && labelResult === abi.ERROR_ACCESS_DENIED) {
      labelResult = healLabelAccess(api, path, labelSacl, labelResult)
    }
  }
  freeLabelIfOwned(api, labelEdit, `${label}(${path})`)
  if (labelResult !== abi.ERROR_SUCCESS) {
    // The write failed even after the heal — report the exact code plus the
    // diagnostic trail and let the caller's fail-closed semantics decide.
    reportLabelFailure(api, path, label, labelResult, privilege)
  }
  if (freedDescriptor !== null && !isNullPtr(freedDescriptor)) throwLastError(api, 'LocalFree', `${label}(${path}) descriptor`)
}

/** The privilege-enable outcome one label step needs. */
interface RelabelPrivilege {
  /** True when SeRelabelPrivilege was enabled in the current token. */
  enabled: boolean
  /** The human-readable reason when it was not (1300/1301 with system text, or the failing API). */
  reason: string
}

/** FormatMessageW buffer size for the diagnostic text (characters). */
const PRIVILEGE_MESSAGE_CHARS = 1024

/** Read one Win32 message string (the formatted system text for `code`). */
function privilegeMessage(api: Win32Bindings, code: number): string {
  const buffer = Buffer.alloc((PRIVILEGE_MESSAGE_CHARS + 1) * 2)
  const written = api.formatMessageW(0, null, code, 0, buffer, buffer.length / 2, null)
  if (written === 0) return ''
  return buffer.subarray(0, written * 2).toString('utf16le').trim()
}

/**
 * Enable `SE_RELABEL_NAME` (SeRelabelPrivilege) in the CURRENT process token
 * for the SACL writes that follow. Opens a fresh token handle with
 * TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES (the sandbox token opened by
 * {@link openCurrentProcessToken} carries neither right), reads the privilege
 * set, and enables the single privilege through AdjustTokenPrivileges.
 *
 * Non-throwing by contract: every failure returns `{ enabled: false }` with
 * the reason. The caller does NOT skip the label on that outcome — the LABEL
 * write goes out anyway (it can pass on the object WRITE_OWNER right) and is
 * self-healed when the denial says the privilege is genuinely absent. The
 * token and process handles are always closed, including on the failure paths.
 * @param api - the binding table.
 * @param context - the caller's name for error details.
 * @returns the enable outcome (never throws).
 */
export function ensureRelabelPrivilege(api: Win32Bindings, context: string): RelabelPrivilege {
  let processHandle: NativePtr | null = null
  let token: NativePtr | null = null
  try {
    processHandle = api.openProcess(abi.PROCESS_QUERY_INFORMATION, 0, process.pid)
    if (isNullPtr(processHandle)) {
      return { enabled: false, reason: `OpenProcess failed (Win32 ${api.getLastError()}) for pid ${process.pid}; the privilege cannot be enabled (the LABEL write is attempted anyway and may pass on the object WRITE_OWNER right)` }
    }
    const tokenSlot = allocPtrSlot()
    const opened = api.openProcessToken(
      processHandle, abi.TOKEN_QUERY | abi.TOKEN_ADJUST_PRIVILEGES, tokenSlot,
    )
    if (opened === 0) {
      const code = api.getLastError()
      return { enabled: false, reason: `OpenProcessToken failed (Win32 ${code}: ${privilegeMessage(api, code)}) for pid ${process.pid}; the privilege cannot be enabled (the LABEL write is attempted anyway and may pass on the object WRITE_OWNER right)` }
    }
    token = decodePtr(tokenSlot)
    if (token === null) {
      return { enabled: false, reason: `OpenProcessToken returned a null token handle (Win32 ${api.getLastError()}); the privilege cannot be enabled (the LABEL write is attempted anyway and may pass on the object WRITE_OWNER right)` }
    }
    if (api.closeHandle(processHandle) === 0) throwLastError(api, 'CloseHandle', 'OpenProcess process handle (privilege enable)')
    processHandle = null

    // Size query (expected to fail with ERROR_INSUFFICIENT_BUFFER) + read.
    const neededSlot = allocUint32()
    api.getTokenInformation(token, abi.TokenPrivileges, null, 0, neededSlot)
    const needed = decodeUint32(neededSlot)
    if (needed === 0) {
      return { enabled: false, reason: `GetTokenInformation(TokenPrivileges) size query returned zero (Win32 ${api.getLastError()}); the privilege cannot be enabled (the LABEL write is attempted anyway and may pass on the object WRITE_OWNER right)` }
    }
    if (needed < 8) {
      return { enabled: false, reason: `implausible TokenPrivileges size ${needed}` }
    }
    const privileges = Buffer.alloc(needed)
    if (api.getTokenInformation(token, abi.TokenPrivileges, privileges, privileges.length, neededSlot) === 0) {
      const code = api.getLastError()
      return { enabled: false, reason: `GetTokenInformation(TokenPrivileges) failed (Win32 ${code}: ${privilegeMessage(api, code)}); the privilege cannot be enabled (the LABEL write is attempted anyway and may pass on the object WRITE_OWNER right)` }
    }

    // The LUID is an 8-byte value the caller reads back after the lookup — a
    // plain buffer stands in for the PLUID (Luid.Low@0, Luid.High@4).
    const luid = Buffer.alloc(8)
    if (api.lookupPrivilegeValueW(null, abi.SE_RELABEL_NAME, luid) === 0) {
      const code = api.getLastError()
      return { enabled: false, reason: `LookupPrivilegeValueW(${abi.SE_RELABEL_NAME}) failed (Win32 ${code}: ${privilegeMessage(api, code)}); the privilege cannot be enabled (the LABEL write is attempted anyway and may pass on the object WRITE_OWNER right)` }
    }
    // x64 TOKEN_PRIVILEGES holding a single entry: PrivilegeCount@0 (DWORD),
    // then one LUID_AND_ATTRIBUTES (Luid@4, Attributes@12; the entry is 12
    // bytes, no trailing pad). AdjustTokenPrivileges reads the header's
    // PrivilegeCount first — passing a bare LUID_AND_ATTRIBUTES lets it read
    // the LUID's low word as the count and walk the token's privilege array
    // far past the buffer, corrupting the process's kernel bookkeeping
    // (libuv realpath then fails with Win32 5 for the rest of the process).
    const newState = Buffer.alloc(abi.TOKEN_PRIVILEGES_SINGLE_SIZE)
    newState.writeUInt32LE(1, 0) // PrivilegeCount
    luid.copy(newState, 4)
    newState.writeUInt32LE(abi.SE_PRIVILEGE_ENABLED, 12)
    const returnLength = allocUint32()
    // AdjustTokenPrivileges returns TRUE even when the privilege is NOT in the
    // token: it then leaves GetLastError at ERROR_NOT_ALL_ASSIGNED (1300).
    // GetLastError MUST therefore be read on the success path too — treating
    // the BOOL alone as the success signal reports a privilege the caller
    // never got, which is how a missing SeRelabelPrivilege used to masquerade
    // as "enabled" while the LABEL write went out and failed.
    const adjusted = api.adjustTokenPrivileges(token, 0, newState, newState.length, null, returnLength)
    const adjustCode = api.getLastError()
    if (adjusted !== 0 && adjustCode === abi.ERROR_NOT_ALL_ASSIGNED) {
      return { enabled: false, reason: `AdjustTokenPrivileges(${abi.SE_RELABEL_NAME}) left the privilege unassigned (Win32 ${adjustCode}: ${privilegeMessage(api, adjustCode)}) — the current token does not hold ${abi.SE_RELABEL_NAME}` }
    }
    if (adjusted !== 0) {
      return { enabled: true, reason: '' }
    }
    const code = adjustCode
    const detail = code === abi.ERROR_NOT_ALL_ASSIGNED
      ? `Win32 ${code}: ${privilegeMessage(api, code)} — the token holds ${abi.SE_RELABEL_NAME} but could not enable it; run DSH elevated (an elevated token carries the privilege enabled) or grant the principal the privilege, then retry`
      : code === abi.ERROR_NO_SUCH_PRIVILEGE
        ? `Win32 ${code}: ${privilegeMessage(api, code)} — the token does not hold ${abi.SE_RELABEL_NAME}; run DSH elevated (an elevated token carries the privilege enabled) or grant the principal the privilege, then retry`
        : `Win32 ${code}: ${privilegeMessage(api, code)}`
    return { enabled: false, reason: `AdjustTokenPrivileges(${abi.SE_RELABEL_NAME}) failed (${detail})` }
  } catch (error) {
    // Defensive: a missing binding in a partial stub (or any thrown call)
    // reports the privilege as unavailable; the caller still attempts the
    // LABEL write (and self-heals a denial) rather than failing the grant here.
    const detail = error instanceof Win32Error
      ? `${error.api} failed (Win32 ${error.win32Code})`
      : error instanceof Error
        ? error.message
        : String(error)
    return { enabled: false, reason: `${context} privilege enable failed (${detail})` }
  } finally {
    if (processHandle !== null) api.closeHandle(processHandle) // best-effort on the error paths
    if (token !== null) api.closeHandle(token)
  }
}

/** Release a label ACL the label step still owns (grants only; revoke steps own none). */
function freeLabelIfOwned(api: Win32Bindings, labelEdit: LabelEdit, context: string): void {
  if (labelEdit.kind === 'apply') {
    const freedLabel = api.localFree(labelEdit.acl)
    if (!isNullPtr(freedLabel)) throwLastError(api, 'LocalFree', `${context} label ACL`)
  }
}

/**
 * Read the CALLER's user SID (TokenUser) as a LocalAlloc'd copy the caller
 * frees with LocalFree. Used by {@link healLabelAccess} to name the calling
 * principal in a temporary WRITE_OWNER ACE. Throws on any failure — the
 * caller turns that into the original label error, never a silent degrade.
 * @param api - the binding table.
 * @returns a copied user SID (LocalFree-allocated; caller frees).
 */
function readCallerUserSid(api: Win32Bindings): NativePtr {
  const processHandle = api.openProcess(abi.PROCESS_QUERY_INFORMATION, 0, process.pid)
  if (isNullPtr(processHandle)) throwLastError(api, 'OpenProcess', 'caller user SID')
  const tokenSlot = allocPtrSlot()
  const opened = api.openProcessToken(processHandle, abi.TOKEN_QUERY, tokenSlot)
  if (opened === 0) {
    api.closeHandle(processHandle) // best-effort on the failure path
    throwLastError(api, 'OpenProcessToken', 'caller user SID')
  }
  const token = decodePtr(tokenSlot)
  if (token === null) {
    api.closeHandle(processHandle)
    throwWin32(api, 'OpenProcessToken', api.getLastError(), 'null token handle (caller user SID)')
  }
  try {
    // Size query (expected to fail with ERROR_INSUFFICIENT_BUFFER) + read.
    const neededSlot = allocUint32()
    api.getTokenInformation(token, abi.TokenUser, null, 0, neededSlot)
    const needed = decodeUint32(neededSlot)
    if (needed < 8) throwWin32(api, 'GetTokenInformation', api.getLastError(), `implausible TokenUser size ${needed}`)
    const user = Buffer.alloc(needed)
    if (api.getTokenInformation(token, abi.TokenUser, user, user.length, neededSlot) === 0) {
      throwLastError(api, 'GetTokenInformation', 'TokenUser')
    }
    // x64 TOKEN_USER: the SID pointer is the first field (SID_AND_ATTRIBUTES.Sid).
    const sidPtr = decodePtrAt(user, 0)
    if (sidPtr === null) throwWin32(api, 'GetTokenInformation', api.getLastError(), 'TokenUser returned a null SID')
    const sidLength = api.getLengthSid(sidPtr)
    if (sidLength === 0) throwLastError(api, 'GetLengthSid', 'caller user SID')
    const copy = api.localAlloc(abi.LPTR, sidLength)
    if (isNullPtr(copy)) throwLastError(api, 'LocalAlloc', 'caller user SID')
    if (api.copySid(sidLength, copy, sidPtr) === 0) {
      api.localFree(copy) // best-effort on the failure path
      throwLastError(api, 'CopySid', 'caller user SID')
    }
    return copy
  } finally {
    if (api.closeHandle(token) === 0) throwLastError(api, 'CloseHandle', 'token handle (caller user SID)')
    if (api.closeHandle(processHandle) === 0) throwLastError(api, 'CloseHandle', 'process handle (caller user SID)')
  }
}

/**
 * Grant the caller a temporary {@link abi.WRITE_OWNER} right on `path`, retry
 * the LABEL write once, then restore the directory's DACL to EXACTLY the
 * snapshot taken before the grant. This is the self-heal that makes
 * `Workspace Write` work non-elevated on a directory whose DACL grants the
 * caller Modify (not Full) and that carries no SeRelabelPrivilege: the kernel
 * accepts EITHER the privilege OR object WRITE_OWNER for a SACL write, and
 * the caller's owner-implicit WRITE_DAC authorizes the DACL edit that adds
 * the right.
 *
 * Restore-by-snapshot (not grant-then-REVOKE): a {@link abi.REVOKE_ACCESS}
 * merge on the same trustee the grant consolidated onto has
 * undefined-by-specification behaviour, and on a real Modify ACE it drops the
 * WHOLE ACE — the caller would silently lose their own right. Re-writing the
 * verbatim pre-heal ACL is the same recovery the diagnosis repair performs and
 * leaves the caller's ACEs byte-for-byte intact. The `OldAcl` from the read
 * feeds the grant merge AND the restore (SetEntriesInAclW copies it, never
 * consumes it), so the descriptor stays alive until both writes are done.
 *
 * NOT a security concession: the caller's own user SID (not the agent's
 * capability SID) is named; {@link abi.WRITE_OWNER} never enters
 * {@link abi.GRANT_MASK}; and the right exists only between the grant and the
 * restore inside this one call.
 * @param api - the binding table.
 * @param path - the directory the label write targets.
 * @param labelSacl - the SACL pointer the label write carries (null = clear).
 * @param firstResult - the original label failure code, returned on any heal-step failure.
 * @returns the retry's SetNamedSecurityInfoW code (or `firstResult`).
 */
function healLabelAccess(
  api: Win32Bindings,
  path: string,
  labelSacl: NativePtr | null,
  firstResult: number,
): number {
  let selfSid: NativePtr | null = null
  try {
    selfSid = readCallerUserSid(api)
  } catch {
    // A heal that cannot even read the caller's identity leaves the original
    // diagnostic untouched: reportLabelFailure names the true gate.
    return firstResult
  }
  const { oldAcl, descriptor } = readCurrentSecurity(api, path)
  if (oldAcl === null) {
    if (descriptor !== null) api.localFree(descriptor)
    api.localFree(selfSid) // already read: the identity SID must not leak
    return firstResult // no DACL to grant the temporary right onto
  }
  // Snapshot semantics: `oldAcl` points into `descriptor` and stays valid
  // until the descriptor is freed at the very end — SetEntriesInAclW only
  // reads it, so it doubles as the grant merge's base and the restore source.
  let retryResult = firstResult
  let granted = false
  try {
    const aclSlot = allocPtrSlot()
    // Inheritance 0: the label write targets the root object itself, so the
    // temporary right never touches the child tree (no inheritable ACE means
    // no propagation walk on either the grant or the restore write).
    const mergeResult = api.setEntriesInAclW(
      1, buildExplicitAccess(selfSid, abi.GRANT_ACCESS, abi.WRITE_OWNER, 0), oldAcl, aclSlot,
    )
    const mergedAcl = mergeResult === abi.ERROR_SUCCESS ? decodePtr(aclSlot) : null
    if (mergedAcl === null) return firstResult // grant merge failed: nothing written
    try {
      granted = api.setNamedSecurityInfoW(
        path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION, null, null, mergedAcl, null,
      ) === abi.ERROR_SUCCESS
    } finally {
      api.localFree(mergedAcl) // best-effort; the merged block is transient
    }
    if (!granted) return firstResult // could not apply WO: retry would hit the same denial
    retryResult = api.setNamedSecurityInfoW(
      path, abi.SE_FILE_OBJECT, abi.LABEL_SECURITY_INFORMATION, null, null, null, labelSacl,
    )
    return retryResult
  } finally {
    // Restore the pre-heal DACL verbatim, but only when the grant actually
    // reached the disk — otherwise the DACL never changed and a rewrite would
    // cost a propagation walk for nothing. The restored ACL no longer names
    // the WO grant, so the caller's own ACEs are exactly as they were.
    if (granted && api.setNamedSecurityInfoW(
      path, abi.SE_FILE_OBJECT, abi.DACL_SECURITY_INFORMATION, null, null, oldAcl, null,
    ) !== abi.ERROR_SUCCESS) {
      console.warn(`[dsh-sandbox-windows-acl] ${path}: heal could not restore the pre-grant DACL (integrity label ${retryResult === abi.ERROR_SUCCESS ? 'applied' : 'not applied'})`)
    }
    if (descriptor !== null) api.localFree(descriptor) // frees oldAcl (it lives inside the descriptor)
    api.localFree(selfSid) // best-effort
  }
}

/**
 * Report a failed LABEL-step SetNamedSecurityInfoW with the full diagnostic
 * trail (the exact Win32 code, the system text, and the privilege state that
 * preceded it). THROWS fail-closed: the write still failed AFTER the
 * {@link healLabelAccess} self-heal, so neither the privilege nor
 * the object WRITE_OWNER path could write the label — the workspace is NOT
 * usable (a DACL-only grant leaves the Low child able to write UP into
 * Medium-IL targets outside the granted roots) and the DACL half must not
 * be reported as success. The message names the true gate: an ACL the
 * caller cannot edit at all (a foreign/TrustedInstaller-owned root) or a
 * filesystem that cannot store the label.
 * @param api - the binding table.
 * @param path - the directory the label write targeted.
 * @param label - the caller's name (grantWrite/revokeWrite).
 * @param win32Code - the SetNamedSecurityInfoW return code.
 * @param privilege - the enable outcome that preceded the write.
 * @returns never; always throws Win32Error.
 */
function reportLabelFailure(
  api: Win32Bindings,
  path: string,
  label: string,
  win32Code: number,
  privilege: RelabelPrivilege,
): never {
  const message = privilegeMessage(api, win32Code)
  const detail = `${label}(${path}) LABEL step (DACL grant applied; integrity label NOT applied) — `
    + `privilege: ${privilege.enabled ? 'SeRelabelPrivilege enabled' : privilege.reason}; `
    + `Win32 ${win32Code}${message === '' ? '' : `: ${message}`} — `
    + 'the SACL write needs the SeRelabelPrivilege privilege OR the WRITE_OWNER right on the directory; the WRITE_OWNER self-heal was attempted and failed. '
    + `The current user cannot edit this directory's ACL: pick a directory you own, or grant WRITE_OWNER with icacls "${path}" /grant %USERNAME%:(OI)(CI)(WO), then retry.`
  throw new Win32Error('SetNamedSecurityInfoW', win32Code, detail)
}

/**
 * True when the explicit DACL already carries the EXACT entry
 * `(aceType, inheritance, mask, trustee SID)`. Every field is read through
 * koffi.decode at pointer offsets — no memcpy, no pointer arithmetic. The
 * ACE's SID is INLINE (embedded in the ACE after the 4-byte mask — there is
 * no pointer to read; reading one yields garbage addresses and crashed
 * EqualSid, verified by gdb), so it is compared field-by-field against the
 * trustee SID through bounded offset reads ({@link sameSidAt}). Allowed and
 * denied ACEs share the Mask@4/SID@8 layout. A malformed header reads as "no
 * exact entry" so the caller falls back to the merge-apply path, which owns
 * the robust failure handling.
 * @param acl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
 * @param aceType - the ACE type to match.
 * @param inheritance - the ACE inheritance flags to match.
 * @param mask - the access mask to match.
 * @param sidPtr - the trustee SID to match.
 * @returns whether the exact entry is already present.
 */
function hasExactEntry(acl: NativePtr, aceType: number, inheritance: number, mask: number, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(acl, 2)
  const aceCount = decodeUint16At(acl, 4)
  if (aclSize < 8 || aclSize > 1_048_576) return false // implausible: fall back to the merge path
  let offset = 8 // the first ACE follows the 8-byte ACL header
  for (let index = 0; index < aceCount; index++) {
    // ACE_HEADER: AceType@0, AceFlags@1, AceSize@2 (WORD); Mask@4, inline SID@8.
    const aceSize = decodeUint16At(acl, offset + 2)
    if (aceSize < 8 || offset + aceSize > aclSize) return false // implausible: fall back to the merge path
    const exact = decodeUint8At(acl, offset) === aceType
      && decodeUint8At(acl, offset + 1) === inheritance
      && decodeUint32At(acl, offset + 4) === mask
    if (exact && sameSidAt(acl, offset + 8, sidPtr, 0)) return true
    offset += aceSize
  }
  return false
}

/**
 * True when the explicit DACL already carries the EXACT write grant this
 * module would add: the Allow ACE for {@link abi.GRANT_MASK} naming the
 * capability SID.
 * @param oldAcl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
 * @param sidPtr - the capability SID to match.
 * @returns whether the exact grant ACE is already present.
 */
function hasExactGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  return hasExactEntry(oldAcl, abi.ACCESS_ALLOWED_ACE_TYPE, abi.SUB_CONTAINERS_AND_OBJECTS_INHERIT, abi.GRANT_MASK, sidPtr)
}

/**
 * True when the explicit DACL already carries the EXACT ambient-delete deny:
 * the container-inherited Deny ACE for {@link abi.FILE_DELETE_CHILD} naming
 * the world SID. It is part of the idempotent skip, so a root granted by an
 * earlier build receives the deny on its next provision.
 * @param oldAcl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
 * @param worldSidPtr - the Everyone SID the deny names.
 * @returns whether the exact deny ACE is already present.
 */
function hasExactDeny(oldAcl: NativePtr, worldSidPtr: NativePtr): boolean {
  return hasExactEntry(oldAcl, abi.ACCESS_DENIED_ACE_TYPE, abi.CONTAINER_INHERIT_ACE, abi.FILE_DELETE_CHILD, worldSidPtr)
}

/**
 * True when a capability grant for a SID OTHER than `sidPtr` stands on this
 * DACL — the condition under which a revoke must leave the shared Low label in
 * place, or the remaining grant's child would lose its write authority.
 * @param oldAcl - the current explicit DACL pointer (from {@link readCurrentSecurity}).
 * @param sidPtr - the capability SID being revoked.
 * @returns whether another capability grant remains.
 */
function hasForeignGrant(oldAcl: NativePtr, sidPtr: NativePtr): boolean {
  const aclSize = decodeUint16At(oldAcl, 2)
  const aceCount = decodeUint16At(oldAcl, 4)
  if (aclSize < 8 || aclSize > 1_048_576) return false // implausible: leave the label alone
  let offset = 8
  for (let index = 0; index < aceCount; index++) {
    const aceSize = decodeUint16At(oldAcl, offset + 2)
    if (aceSize < 8 || offset + aceSize > aclSize) return false // implausible: leave the label alone
    const isGrant = decodeUint8At(oldAcl, offset) === abi.ACCESS_ALLOWED_ACE_TYPE
      && decodeUint32At(oldAcl, offset + 4) === abi.GRANT_MASK
    if (isGrant && !sameSidAt(oldAcl, offset + 8, sidPtr, 0)) return true
    offset += aceSize
  }
  return false
}

/**
 * Grant `GRANT_MASK` (Write+Delete, displays as "Modify") to the capability SID
 * on `path`, deny the world SID the ambient `FILE_DELETE_CHILD` right, and
 * apply the Low mandatory label — one merge, applied in two SetNamedSecurityInfoW
 * calls ({@link mergeAndApply}): the DACL edit (capability ACE + deny) first,
 * the Low label second, after the SeRelabelPrivilege enable. The deny inherits
 * to containers only: the right is evaluated on directories, and inheriting its
 * bit onto files would deny every `FILE_ALL_ACCESS`/`GENERIC_ALL` open inside
 * the root (0x40 is a member of that mask). The capability ACE's DELETE bit is
 * then the only delete authority inside the root, so a file whose own DACL
 * grants no DELETE is no longer deletable through its parent's rights.
 *
 * Idempotent: the exact ACE, deny, and label together SKIP the
 * SetNamedSecurityInfoW apply, which would otherwise re-propagate the
 * identical descriptor across the whole tree (eager inheritance; minutes on
 * large workspaces). Otherwise read-merge-write, so pre-existing explicit ACEs
 * survive (same shape as {@link revokeWrite}). Runs under the per-path lock.
 * The directory must be owned by the caller (owner-implicit WRITE_DAC covers
 * the DACL step). The LABEL step needs SeRelabelPrivilege OR WRITE_OWNER on
 * the directory: when the first label write is denied and the privilege is
 * absent, the grant self-heals once ({@link healLabelAccess}) by temporarily
 * granting the caller's own WRITE_OWNER; a label that still cannot be
 * written throws, so init() never reports a workspace whose integrity
 * protection is missing.
 * @param api - the binding table.
 * @param path - the directory whose DACL and label gain the grant (the workspace or temp root).
 * @param sidPtr - the capability SID the ACE names.
 * @param lowLabelSidPtr - the Low integrity SID the mandatory label names.
 * @param worldSidPtr - the Everyone SID the ambient-delete deny names.
 */
export function grantWrite(
  api: Win32Bindings,
  path: string,
  sidPtr: NativePtr,
  lowLabelSidPtr: NativePtr,
  worldSidPtr: NativePtr,
): void {
  withPathLock(api, path, () => {
    const { oldAcl, labelAcl, descriptor } = readCurrentSecurity(api, path)
    if (oldAcl !== null && labelAcl !== null
      && hasExactGrant(oldAcl, sidPtr) && hasExactDeny(oldAcl, worldSidPtr)
      && hasExactLabel(labelAcl, lowLabelSidPtr)) {
      // The exact ACE, deny, and label stand: releasing the descriptor is the whole operation.
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `grantWrite(${path}) descriptor`)
      }
      return
    }
    let label: NativePtr
    try {
      label = buildLowLabelAcl(api, lowLabelSidPtr)
    } catch (error) {
      // The read already owns a descriptor allocation; release it before the
      // label failure propagates.
      if (descriptor !== null) api.localFree(descriptor)
      throw error
    }
    mergeAndApply(
      api, path,
      Buffer.concat([
        buildExplicitAccess(worldSidPtr, abi.DENY_ACCESS, abi.FILE_DELETE_CHILD, abi.CONTAINER_INHERIT_ACE),
        buildExplicitAccess(sidPtr, abi.GRANT_ACCESS, abi.GRANT_MASK),
      ]),
      oldAcl, { kind: 'apply', acl: label }, descriptor, 'grantWrite',
    )
  })
}

/**
 * Remove every ACE for the capability SID from the directory DACL (REVOKE_ACCESS
 * merge — other entries are preserved). The shared Low label is cleared only
 * when no other capability grant remains on the directory: two grants may
 * target one directory, and the surviving one still needs the label for its
 * child's writes. Returns whether an ACE removal was attempted (false when the
 * directory carries no DACL at all).
 *
 * Runs under the per-path lock (the whole get-merge-set sequence); the
 * descriptor/ACL allocation contract lives on {@link readCurrentSecurity}.
 * @param api - the binding table.
 * @param path - the directory whose DACL loses the capability-SID ACEs.
 * @param sidPtr - the capability SID whose ACEs are removed.
 * @returns whether an ACE removal was attempted (false when the directory carries no DACL at all).
 */
export function revokeWrite(api: Win32Bindings, path: string, sidPtr: NativePtr): boolean {
  return withPathLock(api, path, () => {
    const { oldAcl, descriptor } = readCurrentSecurity(api, path)
    if (oldAcl === null) {
      if (descriptor !== null) {
        const freed = api.localFree(descriptor)
        if (!isNullPtr(freed)) throwLastError(api, 'LocalFree', `revokeWrite(${path}) descriptor`)
      }
      return false
    }
    mergeAndApply(
      api, path, buildExplicitAccess(sidPtr, abi.REVOKE_ACCESS, 0), oldAcl,
      hasForeignGrant(oldAcl, sidPtr) ? { kind: 'keep' } : { kind: 'clear' },
      descriptor, 'revokeWrite',
    )
    return true
  })
}
