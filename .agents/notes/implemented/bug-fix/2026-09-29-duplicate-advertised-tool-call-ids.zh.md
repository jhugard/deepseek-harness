# Agent Note: 重复的广告工具调用 id 视为一次独立出现（occurrence）

Status: implemented

[English](2026-09-29-duplicate-advertised-tool-call-ids.md) | 中文

## Problem

本地 OpenAI 兼容服务器（例如以 **Responses** API 提供服务的 llama.cpp）在同一次响应的并行工具调用中会输出多个携带**相同 `call_id` 与相同 `id`** 的 output item。pi-ai 的 Responses 适配器把 harness 工具调用 id 组合为 `` `${call_id}|${id}` ``，且仅按 `output_index` 跟踪槽位、不做 id 去重——于是 N 个并行调用组合出 N 个逐字节相同的 harness id，形如 `call_<tok>|fc_<tok>`。六个相互独立的表面都预设了 id 唯一：

1. v4 重载路径——`SessionLogScanner.finish()` 无条件运行 `assertReleasedV4Relationships`，在第一个重复 id 处硬性拒绝，于是*当前代*会话永久不可读、不可恢复：`SessionFormatError: assistant/message repeats advertised tool call call_<tok>|fc_<tok>`。
2. 存档迁移——v0→v1、v1→v2 与 v3→v4 的关系游走器携带同一份已发布关系断言，因此任何包含重复 id 的历史日志的迁移都以 `SessionFormatUnsupportedMigrationError` 被拒绝。
3. Web UI——`ConversationNodeAssembler` 每个 id 只持有一个 Context，于是重复 id 的每个 `tool/call` 与 `tool/result` 匹配都重新挂到那唯一的 Context 上：N 个并行调用及其 N 个结果渲染成一张卡片，用户看到的调用数少于实际执行的调用数。
4. 恢复写入器——`ToolCallRecovery` 以待处理 map 按 id 为键，因此一个 step 两次广告同一 id 只记录一条待处理条目，`results()` 发射一个合成关闭器，而读取器要求每次出现各一个。中断这样的 step 会写出一份被放宽后的读取器随后拒绝的日志：`SessionFormatError: step/end leaves unresolved tool call call_<tok>|fc_<tok>`。读取器已放宽为出现、写入器仍以 id 为键，就会产出被自身格式闸门拒绝的日志。
5. Trajectory 账本——`deriveTrajectoryLayout` 以 `callId` 为键索引结果、开始时间与广告 id，而行身份 `trajectoryRecordId` 对携带 `callId` 的单元格解析为 `tool\0call\0<callId>`。于是重复 id 的每次出现都读取同一份结果列表与同一开始时间，且两行携带同一身份，而该身份同时是 React key、`data-trajectory-row-key`、搜索索引键与选择键。在两调用夹具上的实测：两行都显示第二个调用的结果预览、开始时间与时长，渲染出的表格两次记录 `Encountered two children with the same key`——即讨论中报告的重复行与空白行。
6. 跨视图 Inspect——Chat 卡片的 Inspect 动作以裸 id 寻址目标视图，而 Trajectory 账本用 `find` 解析它，因此点击两条同 id 卡片中第二条的 Inspect 会打开第一次出现的记录。

## Decision

把广告 id 当作出现（occurrence）键，而不是唯一身份。

在会话格式游走器中，广告工具调用生命周期以**出现列表**跟踪，`tool/call` / `tool/result` 引用按流顺序解析：

- v0→v1 关系在新的 `allowDuplicateAdvertisedToolCall` 扩展下接纳重复广告（裸 v1 保持严格）。该标志是 `RELEASED_V2_RELATIONSHIP_EXTENSIONS` 的一部分，因此已发布的 v2 制品无条件带着它恢复，v1→v2 在已发布 v2 关系扩展中将其硬性启用。
- v3→v4 关系无条件接纳重复 id（该接缝没有扩展机制）。

真正无法区分的用例——同一 id 的重复开始、名称或参数变化、悬空结果——仍被拒绝。

在客户端，assembler 为每个基础键跟踪一个 `OccurrenceRef`，并把每个被接受的 Match 路由到一次出现：第 0 次出现保留裸基础键，因此常见的单出现情形逐字节不变。两个可选的 `ConversationNodeDefinition` 钩子让某个 Definition 在不改变其他 Definition 的前提下 opting in：`settle(match)` 把当前出现标记为终结，使之后同 id 的 Match 开新一次出现；`dedupe(match)` 返回已见过的逐出现身份以丢弃一次再发射（publication `none`）——例如一次 prune 流程重新发送 `message.id` 已被应用的 `tool/result`。chat 与 trajectory 工具 Definition 都注册了这两个钩子。

在恢复写入器中，`ToolCallRecovery` 把每个 id 映射到**按广告顺序排列的出现列表**（`PendingCall` 列表）。`observe()` 为每个广告的 `tool-call` 块压入一条条目；`tool/call` 标记第一条未开始的出现；一次 append 的 `tool/result` 应答其自身 turn 与 step 内第一条已开始的出现，若无则应答第一条未开始的出现，并且只移除那一条。`results()` 为每条剩余出现各发射一个合成结果。单出现 id 的输出与之前逐字节一致：相同的 message id、相同的 `sourceEventSeqs` 存在性、相同的时间戳与序号基准。

在 Trajectory 布局中，一个 pass 作用域的 `OccurrencePairing` 分别统计广告块、孤立结果与子派发记录，因此某 id 的第 N 个块按流顺序与该 id 的第 N 个结果配对——与 conversation assembler 施加的配对一致。每个工具单元格显式携带由 `toolRecordId(kind, callId, occurrence)` 产生的 `recordId`，而第 0 次出现解析为 `trajectoryRecordId` 已从裸 `callId` 导出的身份，因此单出现行逐字节保留其身份，后续出现追加 `\0<N>`。`indexResults` 按 id 返回结果列表，`callStartById` 与 `callById` 为每次出现各持一条条目，运行中的调用占位仅出现在超出已持久化广告的出现上。每条 assistant 消息的来源块携带其调用的出现序号，`openCallSummary(callId, occurrence)` 打开该 id 的第 N 条账本工具记录，因此从消息的 Block 列表跳转时落在被点击调用对应的工具行，而不再总是第一条。由于 `appendTrajectoryPartialLayout` 会从头重新推导进行中的 step，`TrajectoryView` 传入已定型布局消耗的计数（`advertisedToolCallCounts`，它排除 partial 自身的 turn 与 step），于是流式调用重新打开已定型布局赋予它的那次出现，而不是开第二次。

对于 Inspect，assembler 在每个 `ConversationNodeContext` 上发布 `occurrence`，chat 的 Tool Definition 把它复制进 `ToolChatData`，`ToolCallTree` 将其传给 `inspectCall(callId, occurrence)`。`ConversationViewDefinition.toolCallFocus(callId, occurrence)` 用 `occurrenceKey` 编码这一对——第 0 次出现就是裸 id，因此此变更之前持久化的 focus 仍可解析——`TrajectoryView` 用 `parseOccurrenceKey` 解码后把两部分交给账本，账本选出该 id 的第 N 条工具记录。一条不再被广告的出现（被 fork 截断）被钳制到仍存在的最后一条记录。

## Alternatives considered

**保持拒绝重复、转而修复提供方。** 不采纳：该 id 来自提供方的 wire 格式，且没有任何已发布写入者曾保证守卫所预设的唯一性；已存会话仍不可读，而这类提供方在本地部署中很常见。实测佐证：一份实时日志在 22 个 turn 中携带 201 处重复 id 广告，因此提供方侧的修复无法让任何已存会话变得可读。

**在恢复时用修复损坏尾部取代修复写入器。** 不采纳：`interruptedTurnClosers` 在这样的日志中找不到可关闭的东西——被中断的 turn 已连同其（数量不足的）关闭器一并提交，失衡位于已持久化前缀内部，而非开放尾部。要让已存储日志可读，需要插入缺失的那次出现的关闭器并对之后每个事件重新编号，这是一个新代次而非一次修复，而相邻迁移规则禁止就地重写已提交的代次。

**在 pi-ai 接缝处让 id 唯一（追加 `output_index`）。** 不采纳：它改变每个提供方的 harness id 格式——存会话、回放查找、wire 词表全都会断——而让单出现情形保留裸 id、逐字节不变，正是第 0 次出现所保持的东西。

**让 assembler 以调用/结果对而非 id 作为键。** 不采纳：结果通过 id 引用其调用，所以 id 必须继续作为连接键；修复方式是给键引入多重性（出现），同时保住连接。

## Consequences

含重复广告 id 的会话可读且可恢复——v4 重载接纳它、历史日志可以迁移——Web UI 把每次出现渲染成各自的卡片，并按流顺序把每个结果与其调用配对，Trajectory 账本为每次出现给出各自的结果、开始时间、时长与行身份，Inspect 打开被点击卡片对应的记录，而一个被中断的 step 会关闭它所广告的每一次出现，于是写入器不再产出被自身读取器拒绝的日志。单出现会话逐字节不变：第 0 次出现保留裸基础键，裸 v1 制品保持严格，单出现的关闭器不变，单出现的 Trajectory 行保留其原有身份，单出现 id 的 Inspect focus 仍是裸调用 id。抓住真实损坏（重复开始、名称或参数变化、悬空结果）的严格性被保留。

在写入器修复之前写出的日志无法通过恢复修复：其失衡位于已提交的 turn 内部，接纳它将意味着重写一个已发布代次。这样的会话仍不可读。

## Testing

`packages/session/session-format-v0-to-v1/tests/relationships.spec.ts` 固定扩展门控的接纳：裸 v1 保持严格，扩展 v1 接纳重复广告并按流顺序解析引用，重复开始、参数变化与悬空结果被拒绝。`packages/session/session-format-v1-to-v2/tests/validation.spec.ts` 固定已发布 v2 扩展中的硬性启用。`packages/session/session-format-v3-to-v4/tests/relationships.spec.ts` 固定该接缝处的无条件接纳，其跨边界测试把一次重复广告经由 `ToolCallRecovery` 重放并重新打开两组关闭器：每 id 一个关闭器的集合以 `step/end leaves unresolved tool call` 被拒绝，逐出现的集合被接纳。`packages/client/ui-conversation/tests/conversation-assembler.client.spec.ts` 固定出现拆分：C,R,C,R 与 C,C,R,R 把每个结果与其自身调用配对，prune 再发射被丢弃，逐调用 delta 重新确认存活的出现而不是开新一次。`packages/core/session/tests/repair.spec.ts` 固定写入器：一个 step 内两次广告的 id 关闭两条出现，一条已开始与一条未开始的出现各自取得其错误码，一个结果应答两条中的一条时只有另一条待关闭。`packages/client/ui-trajectory/tests/layout.client.spec.tsx` 固定账本：一条消息在同一 id 下广告两个调用会产生两行，各有自身的工具名、预览、结果预览、开始时间与时长；单出现 id 保留 `trajectoryRecordId` 从裸调用 id 导出的身份；重复 id 的孤立结果成为自身的一条记录而不是被丢弃；`table.client.spec.tsx` 打开两条同 id 调用块中的第二条，并断言被选中的账本行是第二条工具记录。Inspect 接缝在每一跳被固定：`conversation-assembler.client.spec.ts` 在交给 Definition 的 Context 上发布出现序号，`ui-tool/tests/tool-call-tree.client.spec.tsx` 把节点的出现传给 `inspectCall`，`conversation-definitions.client.spec.ts` 把它编码进 focus 键，`table.client.spec.tsx` 打开由出现键指定的 inspect 请求所命名的记录。
