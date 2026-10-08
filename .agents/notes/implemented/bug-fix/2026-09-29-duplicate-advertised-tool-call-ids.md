# Agent Note: A repeated advertised tool-call id is a separate occurrence

Status: implemented

English | [中文](2026-09-29-duplicate-advertised-tool-call-ids.zh.md)

## Problem

Local OpenAI-compatible servers that serve the OpenAI **Responses** API (llama.cpp and the same class of servers) re-emit one tool call under the same `call_id` and the same item `id` for the parallel calls of one response. pi-ai composes the harness tool-call id as `` `${call_id}|${item.id}` `` and keys its output slots on `output_index`, so distinct calls compose byte-identical harness ids of the shape `call_<tok>|fc_<tok>`. A read-only scan of 22 stored session logs (2,936 `assistant/message` events) measured 45 duplicated id-groups, each of exactly 2 occurrences, 0 ids recurring across steps or turns, 45/45 groups sharing one tool `name`, 0 empty ids, 0 duplicate executions lacking a `tool/result`, and every affected message on a `local` / `openai-responses` route — about 1.2% of `assistant/message` events.

Reopening a stored v4 session refused at `SessionLogScanner.finish()`: `SessionFormatError: assistant/message repeats advertised tool call call_<tok>|fc_<tok>`. The same assertion in the v0→v1, v1→v2, and v3→v4 walkers refused any historical log containing a duplicated id with `SessionFormatUnsupportedMigrationError`. A current-generation session was permanently unreadable and unresumable.

The guard never ran where the duplicate was produced. `core/session/src/invariant.ts` validates only the open turn and step, so the live write path persisted duplicate-id assistant messages unchecked and the refusal appeared only later, at read time. The failure mode is availability, not correctness. Correctness never depended on id uniqueness: `executeToolCalls` keeps one `Slot` per model-order position and commits contiguous model-order slots (`core/agent-loop/src/tool-calls.ts:156`), so the durable journal is written in issuance order rather than completion order, and `appendToolResult` stamps each result with `sourceEventSeqs: [callSeq]` (`core/agent-loop/src/tool-calls.ts:289`), a direct pointer from a result to the `tool/call` event it answers.

## Decision

Normalize the id going forward, and admit what is already stored.

**Ingest.** `toStreamChunks` (`packages/llm/llm-pi-ai/src/stream.ts`) mints the harness id once per content index at `toolcall_start`. The first occurrence of an id is unchanged; each later occurrence in the same assistant turn gains `#<n>`, where `<n>` is its 1-based occurrence number. `toolcall_delta` and the finalized `block-end` reuse the tracked id, so the live deltas, the durable block, and the assembled Context carry one identity. Each disambiguated occurrence is reported through `PiAiAdapterConfig.onDuplicateToolCallId`, which `src/index.ts` logs with the route, model, the id exactly as the provider issued it, and the occurrence number. The anomaly is normalized and reported, not swallowed.

The suffix does not disturb the provider round trip. The Responses adapter sends only the part before the first `|` as `call_id`, so the provider receives the id it issued. The Chat Completions adapter maps the assistant tool-call id and the tool-result id through the same `normalizeToolCallId`, so the pair the provider sees stays consistent.

**Readers.** Advertised tool-call lifecycles are tracked as occurrence lists per id, and `tool/call` and `tool/result` resolve in stream order.

- v3→v4 `Relationships` takes the `SessionFormatRecovery` mode that seam already carries. `strict` still refuses a repeated advertisement with `assistant/message repeats advertised tool call <id>`; `recoverable` appends the occurrence. `SessionLogScanner.finish()` passes the scanner's own mode, so a normal reload admits and an explicit strict verification refuses. The installed catalog restores with `recoverable` because released logs written before id disambiguation existed.
- v0→v1 admits occurrences unconditionally, and the `allowDuplicateAdvertisedToolCall` extension is removed; v1→v2 carries no released-relationship extension for it. That seam has no recovery mode to consult, and a refusal there permanently blocks the session from migrating.
- `step/end` and `turn/end` still refuse any unresolved occurrence.

**Recovery writer.** `ToolCallRecovery` (`packages/core/session/src/repair.ts`) maps each id to its occurrences in advertisement order. `tool/call` marks the first unstarted occurrence; an appended `tool/result` answers the first started occurrence in its own turn and step, else the first unstarted one, and removes only that occurrence. `results()` emits one synthetic result per remaining occurrence, so an interrupted step closes every occurrence it advertised and the writer no longer produces a log its own reader refuses. A single-occurrence id keeps its previous output byte-for-byte: same message ids, same `sourceEventSeqs` presence, same timestamps and sequence base.

**Still refused**, on every surface: a repeated start for one id, a changed `name` or `arguments`, a dangling result, counts that do not line up, and an id recurring across steps or turns.

## Alternatives considered

**Keep refusing duplicates.** Rejected: the id comes from the provider's wire format, no released writer ever guaranteed the uniqueness the guards presupposed, and already-stored sessions stay unreadable. The provider class is common in local deployments.

**A uniqueness guard on the live writer** (`packages/core/session/src/invariant.ts`). Rejected: it converts a provider-side id collision into a mid-turn agent failure, a worse outcome than a logged anomaly.

**Client-side occurrence routing.** Rejected: giving the conversation assembler one Context per id plus per-occurrence keys, `settle` and `dedupe` Definition hooks, per-occurrence Trajectory row identity, and an occurrence-aware Inspect focus made every Definition's keying conditional on a provider anomaly, changed Trajectory row identity for compaction pruner replacements through the `dedupe` hook, and contradicted [docs/subsystems/conversation.md](../../../docs/subsystems/conversation.md), which states that every later Match calls `update`. Distinct ids at ingest make all of that machinery unnecessary.

**Make the id unique for every provider unconditionally**, by folding `output_index` into every harness id. Rejected: it changes the harness id format for every provider, including the ones that never collide. The shipped form applies the suffix only when a collision actually occurs, so a non-colliding stream is unchanged.

**Repair affected logs, or rewrite a committed generation.** Rejected: adjacent migration may add a version-named successor but never moves, overwrites, or deletes a committed generation, and the imbalance sits inside a committed turn rather than an open tail. Logs written today would keep accumulating the pattern against a larger corpus.

**A new Session event type for the anomaly.** Rejected: it would require the format catalog, both SDK projections, and snapshot fixtures to carry a diagnostic the provider log already reports.

**A provider option that turns disambiguation off.** Deferred rather than shipped: no current consumer needs it, and configurability does not justify an unsupported default. The route is a provider profile field, not a preset.

## Consequences

Affected current-generation sessions reload and historical logs migrate. A new session against an affected server gets distinct ids per call and one warning per disambiguated occurrence naming the route, model, original id, and occurrence number. Nothing on disk changes for a correct session: a non-colliding stream is byte-identical, occurrence 1 keeps the bare id, and single-occurrence closers are unchanged.

The asymmetry between the two reader seams is deliberate. The current-generation v4 reader gates on the recovery mode that seam already has, so strict verification keeps its refusal. The historical migration chain admits occurrences unconditionally because that seam has no recovery mode and a refusal there permanently blocks the session.

The engine is id-agnostic: with a shared id it cannot tell two results apart from the id alone. What kept the shared-id case correct was journal order plus the `sourceEventSeqs` back-link, which is why the fix is a distinct id rather than new attribution logic.

Name and arguments mismatch more often inside duplicate-id blocks (13.3%) than elsewhere (4.2%). That is a separate provider and model batching problem and is not addressed here.

Strictness is something to earn later. A v4→v5 generation that re-refuses duplicate advertisements is out of scope: the stored corpus that this change makes readable is the evidence against refusing it today.

## Testing

`packages/llm/llm-pi-ai/tests/convert.spec.ts` pins both halves of the ingest rule: one id advertised twice yields `call_dup|fc_dup` and `call_dup|fc_dup#2` across deltas and finalized blocks and reports `{ id, occurrence: 2 }` once, and a turn whose ids are distinct produces the unchanged chunks and no report. `packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` pins the reload seam: the same stored rows open under the scanner's default `recoverable` mode and refuse under `strict`. `packages/session/session-format-v3-to-v4/tests/relationships.spec.ts` pins `assertReleasedV4Relationships` refusing under `strict` and admitting under `recoverable`, stream-order resolution of two occurrences, and the crash-repair closers for a step that advertised one id twice — the one-closer-per-id set is refused with `step/end leaves unresolved tool call`, the per-occurrence set is accepted. `packages/session/session-format-v0-to-v1/tests/relationships.spec.ts` pins unconditional admission, the unresolved-occurrence refusal at `step/end`, and the retained refusals for a repeated start, changed arguments, and a dangling result. `packages/core/session/tests/repair.spec.ts` pins the writer: an id advertised twice in one step closes both occurrences, a started and an unstarted occurrence get their own codes, and a result answering one of two leaves only the other to close.
