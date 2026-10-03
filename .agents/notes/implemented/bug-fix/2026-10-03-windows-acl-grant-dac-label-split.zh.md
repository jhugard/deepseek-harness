# Agent Note: Windows 沙箱 ACL 授权分两次调用下发 DACL 与完整性标签

Status: implemented

[English](2026-10-03-windows-acl-grant-dac-label-split.md) | 中文

## Problem

`dsh-sandbox-windows-acl` 此前把工作区目录的能力 DACL 条目与 Low 完整性标签（SACL 中的 no-write-up ACE）合并在一次携带 `DACL_SECURITY_INFORMATION | LABEL_SECURITY_INFORMATION` 的 `SetNamedSecurityInfoW` 调用中下发。只要 token 不持有 `SeRelabelPrivilege`，内核就会先校验所有请求的信息类、再应用其中任何一项，于是整次调用以 `ERROR_ACCESS_DENIED` 失败——连同只需要属主隐式 `WRITE_DAC` 的 DACL 授权一起失败。工作区绑定随之崩溃：缺少标签所需特权的宿主连本可成功的授权也一并丢失，工作区不可用。

## Decision

`grantWrite` 与 `revokeWrite` 的共享尾部现在把两项编辑拆成两次独立的 `SetNamedSecurityInfoW` 调用。步骤 A 单独下发合并后的 DACL：属主隐式 `WRITE_DAC` 已足够，任何拥有该目录的 token 都能拿到授权。步骤 B 通过 `ensureRelabelPrivilege` 在进程 token 中启用 `SeRelabelPrivilege`——它打开一个新的 `TOKEN_QUERY | TOKEN_ADJUST_PRIVILEGES` token，并通过 `AdjustTokenPrivileges` 启用单条目的 `TOKEN_PRIVILEGES`；按契约绝不抛出，任何失败都返回点名失败 API 与精确 Win32 代码（1300 / 1301 附带格式化系统文本）的原因。步骤 C 单独下发标签编辑：`apply` 写入 Low no-write-up ACE，`clear` 用 NULL 指针替换 SACL。无法启用特权的标签步骤降级为诊断信息而非抛错：DACL 授权保持生效，工作区绑定保持存活，警告同时点明特权缺口、目录的 `WRITE_OWNER` 权限及其 `icacls` 补救。标签 ACL 在每条路径上都会被释放，包括降级路径。

新增常量：`SE_RELABEL_NAME = 'SeRelabelPrivilege'`、`ERROR_NOT_ALL_ASSIGNED = 1300`、`ERROR_NO_SUCH_PRIVILEGE = 1301`、`TOKEN_PRIVILEGES_SINGLE_SIZE = 16`（4 字节 `PrivilegeCount` 头加一条 12 字节 `LUID_AND_ATTRIBUTES`；若直接传裸 `LUID_AND_ATTRIBUTES`，`AdjustTokenPrivileges` 会把 LUID 的低字读成条目数并越界遍历缓冲区）；FFI 层新增 `allocUint32` 与 `decodeUint32`。

## Alternatives considered

**先启用特权、保留组合调用。** 不采纳：组合调用本身就是原子失败点——特权启用后 SACL 写入仍被拒绝（目录缺少 `WRITE_OWNER`）时仍会连 DACL 授权一起丢失，只有拆分形式才能让授权对标签失败免疫。

**让整个 DSH 进程以管理员身份运行，保证标签总能应用。** 不采纳：那会迫使所有部署为了一个工作区绑定都提权运行；标签是完整性加固而非授权的前提，该降级的是标签，而不是沙箱。

**彻底放弃完整性标签。** 不采纳：Low no-write-up ACE 正是阻止沙箱子进程向上写入宿主文件的手段；在快乐路径上保留它，能让可启用特权的宿主保住该保护。

## Consequences

标准（非提权）用户 token 现在能拿到完整的 DACL 授权与存活的工作区绑定，完整性标签在 token 持有并可启用 `SeRelabelPrivilege` 时应用；标签步骤失败是诊断信息而非崩溃，同时点明特权缺口与目录的 `WRITE_OWNER` 权限。提权 token 保持原有结果，只是从一次调用变成两次。缺少 `WRITE_OWNER` 的目录在特权已启用时标签写入仍会失败关闭——该状态现在携带完整诊断轨迹（特权状态加精确 Win32 代码），交由调用方的 fail-closed 语义决定结果。

## Upstream status

该故障在上游由 [discussion #7504](https://github.com/deepseek-ai/deepseek-harness/discussions/7504) 跟踪，维护者已逐条核实并将其定性为策略决策；截至 `0.2.1-alpha.1`，核心授权路径保持不变，上游的应对是内置的 `diagnose-windows-sandbox-acl` 修复技能，它为目录属主补一条可继承的 `WRITE_OWNER` ACE。该补救会改动工作区 DACL，且标签写入仍受组合调用的前置校验约束，因此本拆分方案与其互补：它无需任何持久化 ACL 编辑，就直接消除了 DACL 授权本身对特权与 `WRITE_OWNER` 的前提。

## Testing

`packages/sandbox/sandbox-windows-acl/tests/acl-failure-paths.spec.ts` 用桩绑定驱动拆分后的序列：授权恰好发起两次 `SetNamedSecurityInfoW` 调用，第一次仅 DACL（无 LABEL 位、无 SACL 指针），第二次仅 LABEL 且携带标签 ACE；特权启用失败时降级——仅一次调用、无 LABEL 位、标签 ACL 被释放、一条点名 `SeRelabelPrivilege` 的诊断；缺少特权绑定的部分桩以同样方式降级。`ensureRelabelPrivilege` 的每条失败路径都返回 `{ enabled: false }` 与精确的 API 和 Win32 代码（87、22、1301、1300），成功路径恰好启用 `SeRelabelPrivilege`。`acl.spec.ts`（仅 win32）在真实 FFI 往返上断言两次调用的形态。
