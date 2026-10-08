# Agent Note: 重复的广告工具调用 id 视为一次独立出现（occurrence）

Status: implemented

[English](2026-09-29-duplicate-advertised-tool-call-ids.md) | 中文

## Problem

提供 OpenAI **Responses** API 的本地兼容服务器（llama.cpp 以及同类服务器）会为一次响应中的并行调用，用同一个 `call_id` 和同一个条目 `id` 重复发出同一个工具调用。pi-ai 将 harness 的 tool-call id 组合为 `` `${call_id}|${item.id}` ``，并且只按 `output_index` 索引它的输出槽位，因此不同的调用会组合出逐字节相同的 harness id，形如 `call_<tok>|fc_<tok>`。对 22 个已存储会话日志（2,936 条 `assistant/message` 事件）的只读扫描测得：45 组重复 id，每组恰好 2 次出现；没有任何 id 跨 step 或跨 turn 重复；45/45 组共享同一个工具 `name`；没有空 id；没有缺少 `tool/result` 的重复执行；所有受影响的消息都位于 `local` / `openai-responses` 路由——约占 `assistant/message` 事件的 1.2%。

重新打开一个已存储的 v4 会话会在 `SessionLogScanner.finish()` 处被拒绝：`SessionFormatError: assistant/message repeats advertised tool call call_<tok>|fc_<tok>`。v0→v1、v1→v2 与 v3→v4 遍历器中的同一断言，会以 `SessionFormatUnsupportedMigrationError` 拒绝任何包含重复 id 的历史日志。一个当前世代的会话因此永久不可读取、不可恢复。

这道防护从未在产生重复的地方运行。`core/session/src/invariant.ts` 只校验打开的 turn 与 step，因此实时写入路径会把带重复 id 的 assistant 消息不加检查地持久化，拒绝只在稍后的读取时出现。其失效方式是可用性，而非正确性。正确性从来不依赖 id 唯一：`executeToolCalls` 为每个模型顺序位置保留一个 `Slot`，并且只提交模型顺序上连续的槽位（`core/agent-loop/src/tool-calls.ts:156`），所以持久化日志按发出顺序而非完成顺序写入；`appendToolResult` 为每个结果标记 `sourceEventSeqs: [callSeq]`（`core/agent-loop/src/tool-calls.ts:289`），即从结果指回它所应答的那条 `tool/call` 事件的直接指针。

## Decision

对未来做规范化，对已存储的做接纳。

**摄取层。** `toStreamChunks`（`packages/llm/llm-pi-ai/src/stream.ts`）在 `toolcall_start` 处为每个 content index 铸造一次 harness id。一个 id 的第一次出现保持不变；同一 assistant turn 中每次后续出现获得 `#<n>`，其中 `<n>` 是它的 1 基序号。`toolcall_delta` 与最终定稿的 `block-end` 复用这个被跟踪的 id，因此实时增量、持久化块与装配出的 Context 携带同一个身份。每次被消歧的出现都会通过 `PiAiAdapterConfig.onDuplicateToolCallId` 上报，`src/index.ts` 以该路由、模型、服务器发出的原始 id 以及出现序号记录一条警告。异常是被规范化并上报，而不是被吞掉。

该后缀不会扰乱与服务器之间的往返。Responses 适配器只把第一个 `|` 之前的部分作为 `call_id` 发出，因此服务器收到的仍是它自己发出的 id。Chat Completions 适配器把 assistant 的 tool-call id 与 tool-result 的 id 经由同一个 `normalizeToolCallId` 映射，因此服务器看到的那一对仍然一致。

**读取层。** 每个 id 的广告工具生命周期按出现列表跟踪，`tool/call` 与 `tool/result` 按流顺序解析。

- v3→v4 的 `Relationships` 接收该接缝本就携带的 `SessionFormatRecovery` 模式。`strict` 仍以 `assistant/message repeats advertised tool call <id>` 拒绝重复广告；`recoverable` 追加这一次出现。`SessionLogScanner.finish()` 传入扫描器自身的模式，因此常规重新打开会接纳，而显式的严格校验会拒绝。已安装的 catalog 以 `recoverable` 恢复，因为在 id 消歧之前写下的已发布日志确实存在。
- v0→v1 无条件接纳各次出现，并且移除 `allowDuplicateAdvertisedToolCall` 扩展；v1→v2 不再携带与之相关的已发布关系扩展。该接缝没有可供查询的 recovery 模式，而在此处拒绝会使会话永久无法迁移。
- `step/end` 与 `turn/end` 仍然拒绝任何未解决的出现。

**恢复写入器。** `ToolCallRecovery`（`packages/core/session/src/repair.ts`）把每个 id 映射到它按广告顺序排列的各次出现。`tool/call` 标记第一个尚未开始的出现；一条追加的 `tool/result` 应答其自身 turn 与 step 中第一个已开始的出现，若没有则应答第一个未开始的出现，并且只移除那一次出现。`results()` 为每个剩余出现产出一个合成结果，因此被中断的 step 会关闭它广告过的每一次出现，写入器不再产出自己读取层会拒绝的日志。单次出现的 id 保持原有输出逐字节一致：相同的消息 id、相同的 `sourceEventSeqs` 存在性、相同的时间戳与序号基准。

**仍然拒绝**，在所有界面上：同一 id 的重复 start、被改动的 `name` 或 `arguments`、悬空的结果、数量对不上的情形，以及跨 step 或跨 turn 重复出现的 id。

## Alternatives considered

**继续拒绝重复。** 被否决：id 来自服务器的线路格式，没有任何已发布的写入器保证过这些防护所预设的唯一性，而已存储的会话会保持不可读取。这类服务器在本地部署中很常见。

**在实时写入器上加唯一性防护**（`packages/core/session/src/invariant.ts`）。被否决：它把服务器侧的 id 冲突变成一次 turn 内的 agent 失败，其后果比一条记录下来的异常更糟。

**客户端侧的出现路由。** 被否决：让会话装配器每个 id 持有一个 Context 并加上按出现的键、`settle` 与 `dedupe` 的 Definition 钩子、按出现的 Trajectory 行身份、以及感知出现的 Inspect 焦点，这使得每个 Definition 的键控都取决于一种服务器异常；`dedupe` 钩子改变了 compaction pruner 替换项的 Trajectory 行身份；并且与 [docs/subsystems/conversation.md](../../../docs/subsystems/conversation.md) 相矛盾，后者写明每个后续 Match 都调用 `update`。在摄取层给出互不相同的 id 之后，这套机制全部不再必要。

**为所有服务器无条件使 id 唯一**，即把 `output_index` 折进每一个 harness id。被否决：这会改变每一个服务器的 harness id 格式，包括那些从不冲突的服务器。已落地的形式只在冲突确实发生时才追加后缀，因此不冲突的流保持不变。

**修复受影响的日志，或重写一个已提交的世代。** 被否决：相邻迁移可以新增一个以版本号命名的后继，但绝不移动、覆盖或删除已提交的世代，而且不平衡位于一个已提交的 turn 内部，并非位于打开的尾部。今天写下的日志会继续在更大的语料上累积同样的模式。

**为该异常新增一种 Session 事件类型。** 被否决：它会要求格式 catalog、两个 SDK 投影以及快照 fixture 共同承载一条服务器日志本已上报的诊断信息。

**提供一个可关闭消歧的服务器选项。** 是推迟而非落地：当前没有任何消费者需要它，而可配置性并不能为一个缺乏支撑的默认值提供理由。该路由属于服务器 profile 字段，而不是 preset。

## Consequences

受影响的当前会话可以重新打开，历史日志可以迁移。针对受影响服务器的新会话会为每次调用得到互不相同的 id，并且每次被消歧的出现产生一条警告，写明路由、模型、原始 id 与出现序号。对正确的会话，磁盘上的内容没有任何变化：不冲突的流逐字节相同，第 1 次出现保留裸 id，单次出现的关闭器保持不变。

两个读取接缝之间的不对称是有意为之。当前世代的 v4 读取层依据该接缝本就具备的 recovery 模式设卡，因此严格校验保留它的拒绝。历史迁移链无条件接纳各次出现，因为那个接缝没有 recovery 模式，而在那里拒绝会使会话永久无法迁移。

引擎对 id 是无感的：共享一个 id 时，它无法仅凭 id 区分两个结果。让共享 id 的情形保持正确的是日志顺序加上 `sourceEventSeqs` 反向指针，这正是修复方式是一个不同的 id、而不是新的归属逻辑的原因。

在重复 id 的块内部，name 与 arguments 不一致的比例（13.3%）高于其他位置（4.2%）。那是一个独立的服务器与模型批处理问题，此处不予处理。

严格性是需要逐步赢得的。一个重新拒绝重复广告的 v4→v5 世代不在本次范围之内：让本次改动得以读取的既有语料，正是反对在今天继续拒绝的证据。

## Testing

`packages/llm/llm-pi-ai/tests/convert.spec.ts` 固定摄取规则的两半：同一个 id 广告两次会在增量与最终定稿块中产生 `call_dup|fc_dup` 与 `call_dup|fc_dup#2`，并上报一次 `{ id, occurrence: 2 }`；而 id 互不相同的 turn 产出不变的 chunk 且不上报。`packages/session/session-persistence-jsonl/tests/jsonl.spec.ts` 固定重新打开的接缝：同样的存储行在扫描器默认的 `recoverable` 模式下打开，在 `strict` 模式下被拒绝。`packages/session/session-format-v3-to-v4/tests/relationships.spec.ts` 固定 `assertReleasedV4Relationships` 在 `strict` 下拒绝、在 `recoverable` 下接纳，两次出现的流顺序解析，以及为一个广告了同一 id 两次的 step 准备的崩溃恢复关闭器——每个 id 一个关闭器的那一组以 `step/end leaves unresolved tool call` 被拒绝，按出现的那一组被接受。`packages/session/session-format-v0-to-v1/tests/relationships.spec.ts` 固定无条件接纳、`step/end` 处对未解决出现的拒绝，以及保留下来的拒绝：重复 start、被改动的 arguments、悬空的结果。`packages/core/session/tests/repair.spec.ts` 固定写入器：一个 id 在一个 step 内广告两次会关闭两次出现，已开始与未开始的出现各自取得自己的错误码，而一个只应答两者之一的结果只留下另一者待关闭。
