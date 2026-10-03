# Agent Note: 重复广告工具调用 id 的 bug 报告（llama.cpp 风格的 Responses 服务器）

Status: implemented

[English](2026-09-29-duplicate-tool-call-ids-report.md) | 中文

## Problem

本地 OpenAI 兼容的 **Responses** 服务器（llama.cpp 是常见情形）在同一次响应的并行工具调用中会输出多个携带**相同 `call_id` 与相同 `id`** 的 output item。`@earendil-works/pi-ai` 的 Responses 适配器把 harness 工具调用 id 组合为 `` `${item.call_id}|${item.id}` ``（`function_call` 在 `dist/api/openai-responses-shared.js:368`，`custom_tool_call` 在 `:389`），且槽位映射**只**按 `output_index` 为键（`:329-332`、`getOrCreateSlot :410-412`）、不做 id 去重——于是 N 个不同槽位配上重复的服务器 id，就会组合出 N 个**逐字节相同**的 `call_<tok>|fc_<tok>` 形态的 harness id。三个相互独立的表面都预设了 id 唯一，且都会在该模式下失败：

1. **v4 重载守卫。** 重新打开存档 v4 会话会从 `SessionLogScanner.finish()`（`session-persistence-jsonl/src/format.ts:468`）无条件运行 `assertReleasedV4Relationships`，并在第一个重复 id 处硬性拒绝——`SessionFormatError: assistant/message repeats advertised tool call call_<tok>|fc_<tok>`。没有恢复模式、接纳标志或逐行豁免：日志中任何一处重复 id 都会让*当前代*会话永久不可读、不可恢复。
2. **存档迁移。** v0→v1 与 v1→v2 的关系游走器携带同一份已发布关系断言，而 v3→v4 阶段逐字重放每个事件的 id 且**不**做去重，因此任何历史（v0–v3）日志的迁移都以包裹同一守卫的 `SessionFormatUnsupportedMigrationError` 被拒绝（`session-format/src/catalog.ts:245-248`）。
3. **Web UI。** `ConversationNodeAssembler` 每个 id 只持有**一个** Context（`conversationContextKey(kind, id)`），于是重复 id 的每个 `tool/call` 与 `tool/result` 匹配都重新挂到那唯一的 Context 上：同一 id 下的 N 个并行调用渲染成一张卡片，把真实执行藏起来了。

严重度对 (1) 是阻塞性的——数据可用性而非数据正确性——对 (3) 则是表面到误导性。该 id 模式**不是日志损坏的证据**：它在正常运行中由一个真实且常见的提供方产生，生命周期完全良构。没有任何已发布写入者强制过唯一性——活动写路径在不做任何检查的情况下持久化此类消息（`core/session/src/invariant.ts:118-121` 只校验 turn/step 是打开的；`:124` 的 `pendingCalls` 集合是*待处理* id 的 `Set`，在结果到达时清空，所以同一 id 的第二次 `call → result` 会静默通过）——而引擎的*数据*路径在冲突下依然正确，因此坏掉的是 (a) 断言唯一性的*格式*守卫和 (b) 假设每 id 一次出现的*UI*。这是接纳/渲染问题，不是数据完整性问题。

从活动存储逐字观察到的形态（一个 `assistant/message`，三个 tool-call 块）：

```jsonc
{ "id": "call_rdFmKWQLQM7RrGzZA4pjj…|fc_rdFmKWQLQM7RrGzZA4pjj…", "name": "pwsh", "arguments": "{\"command\":\"Get-Location; …\"}" }
{ "id": "call_PfUjohFYAJat678zz6cFc…|fc_PfUjohFYAJat678zz6cFc…", "name": "glob", "arguments": "{\"command\":\"Get-Location; …\"}" }
{ "id": "call_PfUjohFYAJat678zz6cFc…|fc_PfUjohFYAJat678zz6cFc…", "name": "glob", "arguments": "{\"pattern\":\"packages/llm/**/*.ts\"}" }
```

以及逐字的重载失败：

```
Failed to load history: stored session "session-<id>" is corrupt: session "session-<id>": stored log is corrupt: SessionFormatError: assistant/message repeats advertised tool call call_<tok>|fc_<tok> (raw log: <store-path>) (gateway/internal)
```

## Decision

把广告 id 当作**出现（occurrence）键**而非唯一身份，并让三个表面的修复同步推进——只放宽其中一部分，其余部分仍会失败。

**会话层（提交 `e78c8822e4`，"fix(session): admit duplicate advertised tool-call ids"）。** 三个格式游走器把广告工具调用生命周期按 id 跟踪为**出现列表**，`tool/call` / `tool/result` 引用按流顺序解析：

1. `assistant/message` 在重复时追加一个出现，而不是抛错。
2. `tool/call` 匹配最早仍处 `advertised` 状态的出现（如前比较 `name` + `arguments`）并标记为已开始；`tool/result` 消费最早的 `started` 出现——流顺序 FIFO，即数据路径本就依赖的同一配对。
3. `step/end` 仍拒绝任何未解决的出现（严格度不变）。

接纳方式沿用已发布日志例外的既有形态：`session-format-v0-to-v1` 中新的 `allowDuplicateAdvertisedToolCall` 扩展（裸 v1 保持严格）、在 `session-format-v1-to-v2` 中作为 `RELEASED_V2_RELATIONSHIP_EXTENSIONS` 的一部分为已发布 v2 硬性启用、以及在没有扩展机制的 v3→v4 游走器中无条件接纳。这就是让受影响会话重新可读、可迁移的东西。

**客户端层（提交 `4de770ef18`，"fix(client): render duplicate advertised tool-call ids as separate occurrences"）。** assembler 按基础键跟踪一个有序的出现列表（`OccurrenceRef { key, started, settled }`）；第 0 次出现保留裸基础键，因此单出现 id 与之前逐字节相同。私有的 `resolveOccurrence` 把每个被接受的 Match 路由到一次出现——对 **start** Match 它重新确认仍被瞬态活动开始锚定的那一个（一次调用的逐块 delta 共享同一锚点，其持久开始重新并入其中），仅当没有仍在等待 start 的未关闭出现时才开新一次；对 **update** Match 它先挂到第一个已开始且未结算的出现，再到第一个仍打开的出现，最后新开一个，从而**结果与其调用按流顺序配对**。`ConversationNodeDefinition` 上两个新的可选钩子让某个 Definition 在不改变其他 Definition 行为的前提下 opting in：`settle(match)` 把当前出现标记为终结，使之后同 id 的 Match 开新一次；`dedupe(match)` 丢弃已记录事件的再发射（例如一次 prune 流程重新发送 `message.id` 已被应用的 `tool/result`，`compaction-tool-result-pruner/src/index.ts:165-171`）。chat 与 trajectory 工具 Definition 都注册了两者。这就是让同一共享 id 下的 N 个并行调用渲染成 N 张独立卡片的东西。

**推荐的根因上游修复**（随这些提交一并上报）：在 Responses 适配器的**摄入时**归一化非唯一 id——当某槽位组合出的 `call_id|id` 与同一 assistant 消息中更早的槽位冲突时，铸造一个不同的 id（适配器本就按 `output_index` 为槽位键，消歧信息已经在手，只是从未折进 id）。唯一的 harness id 让游走器的唯一性假设与 UI 的每 id 一 Context 设计都得到满足，且零下游特判，并一次性消除全部三个表面。

**在所有三个表面上仍然拒绝**的，是真正的歧义，且存储中从未观察到：出现在*不同* step 的重复 id（或 step N 的调用与 step N+1 的结果）、对不上的数量（N 个广告对更少的 `tool/call` / `tool/result`、未配对的结果、`step/end` 时未解决的调用）、以及空字符串工具调用 id。

## Alternatives considered

**活动写入者上的唯一性守卫**（`core/session/src/invariant.ts:118`）。不采纳：它把提供方的 id 冲突变成回合中途的 agent 失败——比一处表面的日志瑕疵更糟。运行时若要做，正确的接缝是在摄入时归一化 id，而不是在下游拒绝。

**保持 id 格式不变、只修复部分表面。** 不采纳：只放宽重载守卫而不改 UI，卡片仍会折叠；只放宽 UI 而不改迁移，存档迁移仍被阻塞。三个接纳表面必须同步推进。

**手工修复受影响日志。** 可行——做一次保持 `seq` 密度与每个 `sourceEventSeqs` / `surfaceOp` 引用的 id 重命名，在四个表面上同步施加（`assistant/message` 内容块、`tool/call.callId`、`tool/result` 的 `source.callId` + `content[0].toolCallId`，以及内嵌的 `assistant/attempt` 块流，后者仍须重新组装为与存储内容深度相等）——但它不是修复：*今天*写入的日志仍在累积该模式，因此未来的任何迁移都会对更大的语料继承同样的拒绝。

## Consequences

受影响的当前代会话可读且可恢复，历史（v0–v3）日志可以迁移，Web UI 把每次出现渲染成各自带自己结果的独立卡片。单出现会话在两层中都逐字节不变：第 0 次出现保留裸基础键，裸 v1 制品保持严格。数据路径从未出错，所以磁盘上没有任何变化——工具结果仍被正确归属，因为三个相互独立的信号都不依赖 id 唯一：

1. **消息身份**——`tool/result` 按结果*消息*的身份与其调用配对（UI 的 tool Definition 按 `match.event.data.message.source.callId` 为键更新 Context，`ui-chat/src/client/conversation-nodes/tool.ts:257-258`），且每个 `ToolResultMessage.id` 是 `brandString(randomUUID())`，对每个真实结果唯一。
2. **模型顺序的持久提交**——`executeToolCalls`（`core/agent-loop/src/tool-calls.ts`）每个模型顺序位置保持一个 `Slot` 且只提交连续的模型顺序槽位，所以磁盘日志按模型/发出顺序而非完成顺序写入。
3. **`sourceEventSeqs` 回链**——`appendToolResult` 给每个结果打上 `sourceEventSeqs: [callSeq]`（`core/agent-loop/src/session-wire-event.ts:28`），一个从结果直接指回其应答的 `tool/call` 事件的指针。

唯一的注意事项：引擎是**id 无感知**的——共享 id 时它无法单凭 id 区分两个结果；真正让共享 id 情形保持正确的是日志顺序加上 UI 中的先入先出配对，这正是客户端修复采用"结果即结算 + 流顺序 FIFO"而非任何基于 id 的消歧的原因。已对照 `origin/master` 核实上游状态：广告 id 守卫在那里未变，v3/v4 代新增了第二个、更宽的守卫，且针对此类修复的接纳标志先例已存在（`ReleasedRelationshipExtensions.legacyInterruptedTurnRestart`）。若不修复，任何运行本地 Responses 服务器的用户都会持续累积被发布链永久拒绝的日志——而产出本报告的活动会话自己的 v4 日志已携带 99 个重复组，且仍在增长。

## Testing

回放测试装置（`acl-diag-reports/dup-demo.mjs`，转录 `acl-diag-reports/dup-demo-output.txt`）把两个活动存储日志（一个冻结的 v2 与写本报告会话的活动 v4）快照后，用 `4878cdabd8`（dsh-v0.2.0-rc.1）检出自带的构建校验代码、以精确的生产选项（`recovery: 'strict'` / `recovery: 'recoverable'`、`validation: 'transformed'`）回放：两条路径上每行都解码通过，两个表面都恰好拒绝在 `finish()`。以 `validation: 'current'` 的对照运行从 `finish()` 内部抛出同一 `SessionFormatError`。对 22 个会话日志文件（2,936 个 `assistant/message` 事件）的只读扫描测得 36 个受影响事件（1.2%）、45 组各恰好 2 次出现的重复 id、0 个跨 step 或跨 turn 复现的 id、45/45 组共享同一工具 `name`、0 个缺 `tool/result` 的重复执行、0 个空字符串 id，且每个受影响消息都在 `local` / `openai-responses` 上。对活动日志的逐出现审计核对了 211/211 个事件：99 个重复组、85 对干净的 FIFO+settle 配对、14 次被 `dedupe` 钩子正确丢弃的 prune 再发射，没有任何误归属的结果。名称/参数失配在以独立于重复 id 的有意义基率出现（重复 id 块中 13.3% vs 其他 4.2%）——误归属是另一个提供方的模型批处理问题，另行跟踪。

格式游走器由 `packages/session/session-format-v0-to-v1/tests/relationships.spec.ts`（扩展门控的接纳；重复开始、参数变化与悬空结果被拒绝）、`packages/session/session-format-v1-to-v2/tests/validation.spec.ts`（已发布 v2 扩展中的硬性启用）与 `packages/session/session-format-v3-to-v4/tests/relationships.spec.ts`（该接缝处的无条件接纳）固定。出现拆分由 `packages/client/ui-conversation/tests/conversation-assembler.client.spec.ts` 固定：C,R,C,R 与 C,C,R,R 把每个结果与其自身调用配对，prune 再发射被丢弃，逐调用 delta 重新确认存活的出现而不是开新一次。
