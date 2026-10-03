# Agent Note: A repeated advertised tool-call id is a separate occurrence

Status: implemented

English | [中文](2026-09-29-duplicate-advertised-tool-call-ids.zh.md)

## Problem

Local OpenAI-compatible servers (e.g. llama.cpp serving the OpenAI **Responses** API) emit several output items carrying the **same `call_id` and the same `id`** for the parallel tool calls of one response. The pi-ai Responses adapter composes the harness tool-call id as `` `${call_id}|${id}` `` and tracks its slots by `output_index` only, with no id dedup — so N parallel calls compose N byte-identical harness ids of the shape `call_<tok>|fc_<tok>`. Three independent surfaces presupposed id uniqueness:

1. The v4 reload path — `SessionLogScanner.finish()` runs `assertReleasedV4Relationships` unconditionally and hard-refuses at the first duplicated id, so a *current-generation* session is permanently unreadable and unresumable: `SessionFormatError: assistant/message repeats advertised tool call call_<tok>|fc_<tok>`.
2. The stored migration — the v0→v1, v1→v2, and v3→v4 relationship walkers carry the same released-relationship assertion, so migrating any historical log containing a duplicated id is refused with `SessionFormatUnsupportedMigrationError`.
3. The Web UI — the `ConversationNodeAssembler` holds one Context per id, so every `tool/call` and `tool/result` match for a repeated id re-attaches to that single Context: N parallel calls and their N results render as one card, and the user sees fewer calls than ran.

## Decision

Treat the advertised id as an occurrence key rather than a unique identity.

In the session format walkers, advertised tool-call lifecycles are tracked as **occurrence lists** and `tool/call` / `tool/result` references resolve in stream order:

- v0→v1 relationships admit a duplicate advertisement under the new `allowDuplicateAdvertisedToolCall` extension (bare v1 stays strict). The flag is part of `RELEASED_V2_RELATIONSHIP_EXTENSIONS`, so released v2 artifacts restore with it unconditionally, and v1→v2 hard-enables it in the released v2 relationship extensions.
- v3→v4 relationships admit duplicated ids unconditionally (there is no extension mechanism at that seam).

Truly indistinguishable cases — a repeated start for the same id, a changed name or arguments, a dangling result — are still refused.

In the client, the assembler tracks one `OccurrenceRef` per base key and routes each accepted Match to an occurrence: occurrence 0 keeps the bare base key, so the common single-occurrence case stays byte-identical. Two optional `ConversationNodeDefinition` hooks let a Definition opt in without changing any other Definition: `settle(match)` marks the current occurrence terminal so a later same-id Match opens a fresh one, and `dedupe(match)` returns an already-seen per-occurrence identity to drop a re-emission (publication `none`) — e.g. a prune pass re-sending a `tool/result` whose `message.id` was already applied. The chat and trajectory tool Definitions register both hooks.

## Alternatives considered

**Keep refusing duplicates and fix the provider.** Rejected: the id comes from the provider's wire format, and no released writer ever guaranteed the uniqueness the guards presuppose; already-stored sessions stay unreadable, and the provider class is common in local deployments.

**Make the id unique at the pi-ai seam (append the `output_index`).** Rejected: it changes the harness id format for every provider — stored sessions, replay lookups, and the wire vocabulary all break — where keeping the bare id for the single-occurrence case byte-identical is exactly what occurrence 0 preserves.

**Key the assembler by a call/result pair instead of the id.** Rejected: results reference their call by id, so the id must remain the join key; the fix is to give the key multiplicity (occurrences) while keeping the join.

## Consequences

A session with duplicated advertised ids is readable and resumable — the v4 reload admits it and historical logs migrate — and the Web UI renders each occurrence as its own card, pairing each result with its call in stream order. Single-occurrence sessions are byte-identical: occurrence 0 keeps the bare base key and bare v1 artifacts stay strict. The strictness that catches real corruption (repeated start, changed name or arguments, dangling result) is retained.

## Testing

`packages/session/session-format-v0-to-v1/tests/relationships.spec.ts` pins the extension-gated admission: bare v1 stays strict, extended v1 admits a duplicate advertisement and resolves references in stream order, and repeated start, changed arguments, and a dangling result are refused. `packages/session/session-format-v1-to-v2/tests/validation.spec.ts` pins the hard-enable in the released v2 extensions. `packages/session/session-format-v3-to-v4/tests/relationships.spec.ts` pins unconditional admission at that seam. `packages/client/ui-conversation/tests/conversation-assembler.client.spec.ts` pins occurrence splitting: C,R,C,R and C,C,R,R pair each result with its own call, a prune re-emission is dropped, and a per-call delta re-affirms the live occurrence instead of opening a fresh one.
