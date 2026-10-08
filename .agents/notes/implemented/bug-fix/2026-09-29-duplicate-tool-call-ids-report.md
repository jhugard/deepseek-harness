# Agent Note: Duplicate advertised tool-call id bug report (llama.cpp-style Responses servers)

Status: implemented

English | [中文](2026-09-29-duplicate-tool-call-ids-report.zh.md)

## Problem

Local OpenAI-compatible **Responses** servers (llama.cpp is the common case) emit several output items carrying the **same `call_id` and the same `id`** for the parallel tool calls of one response. The `@earendil-works/pi-ai` Responses adapter composes the harness tool-call id as `` `${item.call_id}|${item.id}` `` (`dist/api/openai-responses-shared.js:368` for `function_call`, `:389` for `custom_tool_call`) and keys its slot map **only** on `output_index` (`:329-332`, `getOrCreateSlot :410-412`) with no id dedup — so N distinct slots with repeated server ids compose N **byte-identical** harness ids of the shape `call_<tok>|fc_<tok>`. Three independent surfaces presuppose id uniqueness and all fail on the pattern:

1. **The v4 reload guard.** Reopening a stored v4 session runs `assertReleasedV4Relationships` unconditionally from `SessionLogScanner.finish()` (`session-persistence-jsonl/src/format.ts:468`) and hard-refuses at the first duplicated id — `SessionFormatError: assistant/message repeats advertised tool call call_<tok>|fc_<tok>`. There is no recovery mode, admission flag, or per-row bypass: one duplicated id anywhere makes the *current-generation* session permanently unreadable and unresumable.
2. **The stored migration.** The v0→v1 and v1→v2 relationship walkers carry the same released-relationship assertion, and the v3→v4 stage re-emits every event's id verbatim with **no** deduplication, so migrating any historical (v0–v3) log is refused with `SessionFormatUnsupportedMigrationError` wrapping the identical guard (`session-format/src/catalog.ts:245-248`).
3. **The Web UI.** The `ConversationNodeAssembler` holds **one** Context per id (`conversationContextKey(kind, id)`), so every `tool/call` and `tool/result` match for a repeated id re-attaches to that single Context: N parallel calls under one id render as a single card, hiding real execution from the user.

Severity is blocking for (1) — data availability, not data correctness — and cosmetic-to-misleading for (3). The id pattern is **not evidence of a corrupted log**: it is produced in normal operation, by a real and common provider, with fully well-formed lifecycles. No released writer ever enforced uniqueness — the live write path persists such a message without any check (`core/session/src/invariant.ts:118-121` validates only that a turn/step is open; the `pendingCalls` set at `:124` is a `Set` of *pending* ids, cleared on result, so a second `call → result` for the same id passes silently) — and the engine's *data* path stays correct under the collision, so what breaks is (a) the *format* guards that assert uniqueness and (b) the *UI* that assumes one occurrence per id. This is an acceptance/rendering problem, not a data-integrity problem.

Observed shape, verbatim from a live store (one `assistant/message`, three tool-call blocks):

```jsonc
{ "id": "call_rdFmKWQLQM7RrGzZA4pjj…|fc_rdFmKWQLQM7RrGzZA4pjj…", "name": "pwsh", "arguments": "{\"command\":\"Get-Location; …\"}" }
{ "id": "call_PfUjohFYAJat678zz6cFc…|fc_PfUjohFYAJat678zz6cFc…", "name": "glob", "arguments": "{\"command\":\"Get-Location; …\"}" }
{ "id": "call_PfUjohFYAJat678zz6cFc…|fc_PfUjohFYAJat678zz6cFc…", "name": "glob", "arguments": "{\"pattern\":\"packages/llm/**/*.ts\"}" }
```

and the reload failure, verbatim:

```
Failed to load history: stored session "session-<id>" is corrupt: session "session-<id>": stored log is corrupt: SessionFormatError: assistant/message repeats advertised tool call call_<tok>|fc_<tok> (raw log: <store-path>) (gateway/internal)
```

## Decision

The advertised id is treated as an **occurrence key** rather than a unique identity, and the three surfaces were fixed so that they move together — relaxing only some of them leaves the rest failing.

**Session layer.** The three format walkers track advertised tool-call lifecycles as **occurrence lists** per id, and `tool/call` / `tool/result` references resolve in stream order:

1. `assistant/message` appends an occurrence instead of throwing on a repeat.
2. `tool/call` matches the earliest still-`advertised` occurrence (comparing `name` + `arguments` as before) and marks it started; `tool/result` consumes the earliest `started` occurrence — stream-order FIFO, the same pairing the data path already relies on.
3. `step/end` still rejects any unresolved occurrence (unchanged strictness).

Admission is gated the way released-log exceptions already are: the new `allowDuplicateAdvertisedToolCall` extension in `session-format-v0-to-v1` (bare v1 stays strict), hard-enabled for released v2 in `session-format-v1-to-v2` as part of `RELEASED_V2_RELATIONSHIP_EXTENSIONS`, and admitted unconditionally in the v3→v4 walker, where no extension mechanism exists. This is what makes the affected sessions reloadable and migratable again.

**Client layer.** The assembler tracks, per base key, an ordered list of occurrences (`OccurrenceRef { key, started, settled }`); occurrence 0 keeps the bare base key, so a single-occurrence id is byte-identical to before. A private `resolveOccurrence` routes each accepted Match to an occurrence — for **start** Matches it re-affirms the one still anchored by a transient live start (a call's per-chunk deltas share one anchor and the durable start re-joins it), opening a fresh occurrence only when no open one still expects a start; for **update** Matches it attaches to the first started, unsettled occurrence, then to the first still-open one, then opens a new one, so **results pair with their calls in stream order**. Two new optional `ConversationNodeDefinition` hooks let a Definition opt in without changing any other Definition's behaviour: `settle(match)` marks the current occurrence terminal so a later same-id Match opens a fresh one, and `dedupe(match)` drops a re-emission of an already-recorded event (e.g. a prune pass re-sending a `tool/result` whose `message.id` was already applied, `compaction-tool-result-pruner/src/index.ts:165-171`). The chat and trajectory tool Definitions register both. This is what makes the N parallel calls under one shared id render as N distinct cards.

**The recommended upstream root fix**: normalize non-unique ids **at ingest** in the Responses adapter — when a slot's composed `call_id|id` collides with an earlier slot in the same assistant message, mint a distinct id (the adapter already keys slots on `output_index`, so the disambiguating information is already there; it just never folds into the id). A unique harness id satisfies the walkers' uniqueness assumption and the UI's one-Context-per-id design with zero downstream special-casing, and it eliminates all three surfaces at once.

**Still refused, on all three surfaces**, because these are genuine ambiguity and none were observed in the store: a duplicate id appearing in a different step (or a call in step N with its result in step N+1), counts that do not line up (N advertised vs fewer `tool/call` / `tool/result`, an unmatched result, an unresolved call at `step/end`), and an empty-string tool-call id.

## Alternatives considered

**A uniqueness guard on the live writer** (`core/session/src/invariant.ts:118`). Rejected: it converts a provider-side id collision into a mid-turn agent failure — a worse outcome than a cosmetic log blemish. If anything is done at runtime, the right seam is normalizing ids at ingest, not rejecting downstream.

**Leaving the id format alone and fixing only some surfaces.** Rejected: relaxing the reload guard but not the UI still renders collapsed cards; relaxing the UI but not the migration still blocks stored migration. The three acceptance surfaces must move together.

**Repairing affected logs by hand.** Possible — an id-rename preserving `seq` density and every `sourceEventSeqs` / `surfaceOp` reference, applied in lock-step across four surfaces (`assistant/message` content blocks, `tool/call.callId`, `tool/result` `source.callId` + `content[0].toolCallId`, and the embedded `assistant/attempt` chunk stream, which must still re-assemble to deep-equal the stored content) — but it is not a fix: logs written *today* keep accumulating the pattern, so any future migration inherits the same refusal against a larger corpus.

## Consequences

Affected current-generation sessions are readable and resumable, historical (v0–v3) logs migrate, and the Web UI renders each occurrence as its own card with its own result. Single-occurrence sessions are byte-identical in both layers: occurrence 0 keeps the bare base key and bare v1 artifacts stay strict. The data path was never wrong, so nothing on disk changes — tool results stay correctly attributed because three independent signals do not depend on id uniqueness:

1. **Message identity** — a `tool/result` is matched to its call by the identity of the result message (the UI's tool Definition updates the Context keyed by `match.event.data.message.source.callId`, `ui-chat/src/client/conversation-nodes/tool.ts:257-258`), and each `ToolResultMessage.id` is a `brandString(randomUUID())`, unique per real result.
2. **Model-ordered durable commit** — `executeToolCalls` (`core/agent-loop/src/tool-calls.ts`) keeps one `Slot` per model-order position and commits contiguous model-order slots only, so the on-disk journal is written in model/issuance order, not completion order.
3. **`sourceEventSeqs` back-link** — `appendToolResult` stamps each result with `sourceEventSeqs: [callSeq]` (`core/agent-loop/src/session-wire-event.ts:28`), a direct pointer from a result back to the exact `tool/call` event it answers.

The one caveat: the engine is **id-agnostic** — with a shared id it cannot, from the id alone, tell two results apart; what keeps the shared-id case correct is the journal order combined with first-in-first-out pairing in the UI, which is precisely why the client fix is a settle-on-result plus stream-order FIFO rather than any id-based disambiguation. Upstream status was verified against `origin/master`: the advertised-id guard is unchanged there, the v3/v4 generation added the second, wider guard, and an admission-flag precedent for exactly this class of fix already exists (`ReleasedRelationshipExtensions.legacyInterruptedTurnRestart`). Without the fix, any user running a local Responses server keeps accumulating logs the released chain permanently refuses — and the live session that produced this report already carried 99 duplicated groups in its own v4 log, and growing.

## Testing

The replay harness (`acl-diag-reports/dup-demo.mjs`, transcript `acl-diag-reports/dup-demo-output.txt`) snapshots two live store logs — a frozen v2 and the live v4 of the session writing this report — and replays them through the checkout's own built validation code at release `dsh-v0.2.0-rc.1` with the exact production options (`recovery: 'strict'` / `recovery: 'recoverable'`, `validation: 'transformed'`): every row decodes on both paths, and both surfaces refuse exactly at `finish()`. A control run with `validation: 'current'` throws the identical `SessionFormatError` from inside `finish()`. A read-only scan of 22 session log files (2,936 `assistant/message` events) measured 36 affected events (1.2%), 45 duplicated id-groups of exactly 2 occurrences each, 0 ids recurring across steps or turns, 45/45 groups sharing one tool `name`, 0 duplicate executions lacking a `tool/result`, 0 empty-string ids, and every affected message on `local` / `openai-responses`. A per-occurrence audit of the live log verified 211/211 events: 99 duplicated groups, 85 clean FIFO+settle pairs, 14 prune re-emissions correctly dropped by the `dedupe` hook, no mis-attributed result anywhere. Name/arguments mismatches occur at a meaningful base rate independent of duplicate ids (13.3% in duplicate-id blocks vs 4.2% elsewhere) — mis-attribution is a separate provider/model batching problem and is tracked separately.

The format walkers are pinned in `packages/session/session-format-v0-to-v1/tests/relationships.spec.ts` (extension-gated admission; repeated start, changed arguments, and a dangling result are refused), `packages/session/session-format-v1-to-v2/tests/validation.spec.ts` (hard-enable in the released v2 extensions), and `packages/session/session-format-v3-to-v4/tests/relationships.spec.ts` (unconditional admission at that seam). The occurrence split is pinned in `packages/client/ui-conversation/tests/conversation-assembler.client.spec.ts`: C,R,C,R and C,C,R,R pair each result with its own call, a prune re-emission is dropped, and a per-call delta re-affirms the live occurrence instead of opening a fresh one.
