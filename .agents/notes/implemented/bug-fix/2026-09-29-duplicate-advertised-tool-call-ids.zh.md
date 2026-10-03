# Agent Note: 重复的广告工具调用 id 视为一次独立出现（occurrence）

Status: implemented

[English](2026-09-29-duplicate-advertised-tool-call-ids.md) | 中文

## Problem

本地 OpenAI 兼容服务器（例如以 **Responses** API 提供服务的 llama.cpp）在同一次响应的并行工具调用中会输出多个携带**相同 `call_id` 与相同 `id`** 的 output item。pi-ai 的 Responses 适配器把 harness 工具调用 id 组合为 `` `${call_id}|${id}` ``，且仅按 `output_index` 跟踪槽位、不做 id 去重——于是 N 个并行调用组合出 N 个逐字节相同的 harness id，形如 `call_<tok>|fc_<tok>`。三个相互独立的表面都预设了 id 唯一：

1. v4 重载路径——`SessionLogScanner.finish()` 无条件运行 `assertReleasedV4Relationships`，在第一个重复 id 处硬性拒绝，于是*当前代*会话永久不可读、不可恢复：`SessionFormatError: assistant/message repeats advertised tool call call_<tok>|fc_<tok>`。
2. 存档迁移——v0→v1、v1→v2 与 v3→v4 的关系游走器携带同一份已发布关系断言，因此任何包含重复 id 的历史日志的迁移都以 `SessionFormatUnsupportedMigrationError` 被拒绝。
3. Web UI——`ConversationNodeAssembler` 每个 id 只持有一个 Context，于是重复 id 的每个 `tool/call` 与 `tool/result` 匹配都重新挂到那唯一的 Context 上：N 个并行调用及其 N 个结果渲染成一张卡片，用户看到的调用数少于实际执行的调用数。

## Decision

把广告 id 当作出现（occurrence）键，而不是唯一身份。

在会话格式游走器中，广告工具调用生命周期以**出现列表**跟踪，`tool/call` / `tool/result` 引用按流顺序解析：

- v0→v1 关系在新的 `allowDuplicateAdvertisedToolCall` 扩展下接纳重复广告（裸 v1 保持严格）。该标志是 `RELEASED_V2_RELATIONSHIP_EXTENSIONS` 的一部分，因此已发布的 v2 制品无条件带着它恢复，v1→v2 在已发布 v2 关系扩展中将其硬性启用。
- v3→v4 关系无条件接纳重复 id（该接缝没有扩展机制）。

真正无法区分的用例——同一 id 的重复开始、名称或参数变化、悬空结果——仍被拒绝。

在客户端，assembler 为每个基础键跟踪一个 `OccurrenceRef`，并把每个被接受的 Match 路由到一次出现：第 0 次出现保留裸基础键，因此常见的单出现情形逐字节不变。两个可选的 `ConversationNodeDefinition` 钩子让某个 Definition 在不改变其他 Definition 的前提下 opting in：`settle(match)` 把当前出现标记为终结，使之后同 id 的 Match 开新一次出现；`dedupe(match)` 返回已见过的逐出现身份以丢弃一次再发射（publication `none`）——例如一次 prune 流程重新发送 `message.id` 已被应用的 `tool/result`。chat 与 trajectory 工具 Definition 都注册了这两个钩子。

## Alternatives considered

**保持拒绝重复、转而修复提供方。** 不采纳：该 id 来自提供方的 wire 格式，且没有任何已发布写入者曾保证守卫所预设的唯一性；已存会话仍不可读，而这类提供方在本地部署中很常见。

**在 pi-ai 接缝处让 id 唯一（追加 `output_index`）。** 不采纳：它改变每个提供方的 harness id 格式——存会话、回放查找、wire 词表全都会断——而让单出现情形保留裸 id、逐字节不变，正是第 0 次出现所保持的东西。

**让 assembler 以调用/结果对而非 id 作为键。** 不采纳：结果通过 id 引用其调用，所以 id 必须继续作为连接键；修复方式是给键引入多重性（出现），同时保住连接。

## Consequences

含重复广告 id 的会话可读且可恢复——v4 重载接纳它、历史日志可以迁移——Web UI 把每次出现渲染成各自的卡片，并按流顺序把每个结果与其调用配对。单出现会话逐字节不变：第 0 次出现保留裸基础键，裸 v1 制品保持严格。抓住真实损坏（重复开始、名称或参数变化、悬空结果）的严格性被保留。

## Testing

`packages/session/session-format-v0-to-v1/tests/relationships.spec.ts` 固定扩展门控的接纳：裸 v1 保持严格，扩展 v1 接纳重复广告并按流顺序解析引用，重复开始、参数变化与悬空结果被拒绝。`packages/session/session-format-v1-to-v2/tests/validation.spec.ts` 固定已发布 v2 扩展中的硬性启用。`packages/session/session-format-v3-to-v4/tests/relationships.spec.ts` 固定该接缝处的无条件接纳。`packages/client/ui-conversation/tests/conversation-assembler.client.spec.ts` 固定出现拆分：C,R,C,R 与 C,C,R,R 把每个结果与其自身调用配对，prune 再发射被丢弃，逐调用 delta 重新确认存活的出现而不是开新一次。
