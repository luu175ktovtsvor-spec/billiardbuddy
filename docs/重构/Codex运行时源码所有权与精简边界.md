# Codex 运行时源码所有权与精简边界

> 施工状态：当前 Agent 后端的实况审计与架构裁决。产品完成定义以仓库根目录的
> [BilliardBuddy-重构合同](../../BilliardBuddy-重构合同.md) 为准；本文件只定义
> “怎样直接产品化 Codex Rust 源码而不重新制造一套 Agent 后端”。

## 结论

BilliardBuddy 不应新建 `native/billiardbuddy-agent`、Rust FFI 外壳或第二个
Agent 服务。它们只会在 Electron 与 Codex Core 之间再增加一个没有状态所有权的层。

正式形态是：锁定并以源码构建的 `third_party/codex-engine` 是唯一 Agent Runtime；
它继续以独立 `codex-app-server` 进程运行，Electron Main 是其唯一桌面协议客户端。
“直接使用源码”与“保留 App Server 进程边界”不是二选一：前者解决代码可审计、
可构建和可维护，后者解决进程隔离、崩溃收口、JSON-RPC 流和桌面宿主边界。

```text
Renderer（只显示 Thread / Item，并提交用户意图）
  ↓ 受信 IPC
Electron Main（窗口、系统安全存储、App Server 生命周期）
  ↓ stdio JSON-RPC
BilliardBuddy 打包的 codex-app-server（Rust）
  ├─ Core / Thread Store / Context / Tools / Exec / Sandbox
  ├─ Approval / MCP / Skills / Hooks / Review / collaboration
  └─ Responses Provider
       ├─ 托管 DeepSeek：本机短令牌桥 → Gateway /v1/responses → DeepSeek
       ├─ 用户 Responses Key：直接 → 用户 endpoint
       └─ 用户 Chat Completions Key：本机无状态转换 → 用户 endpoint
```

`Bun Sidecar` 不在这条 Agent 链上。它仅服务图片、视频、语音、设置、能力快照和
历史目录投影；它不能启动、配置或执行 Rust Agent。

## 当前源码事实

| 事实 | 当前证据 | 架构判断 |
| --- | --- | --- |
| Rust 源码基线 | `third_party/codex-engine` 是指向 `openai/codex` revision `ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff` 的 Git 子模块；其中有 `codex-core`、`codex-app-server`、`codex-thread-store`、`codex-exec-server`、`codex-sandboxing`、`codex-mcp`、`codex-skills` 和 `codex-hooks` crate。 | Rust 内核真实存在，但不是另一个 BilliardBuddy 自有 crate。 |
| 产品构建 | `ts/desktop/scripts/stage-codex-engine.ts` 从该 revision 以 Cargo 构建 `codex-app-server`，并连同 LICENSE、NOTICE、revision、哈希清单打入安装包。 | 源码构建与发行归产品控制；不要改为下载不透明二进制。 |
| 产品启动 | `ElectronCodexNativeRuntime` 只启动打包后的受控二进制，设私有 `CODEX_HOME`，并经 stdio JSON-RPC 做 `initialize`。 | 保留这个进程边界；不要把 Core 嵌入 Electron 或 Bun。 |
| Rust 状态 | Thread、Turn、Item、上下文、工具、审批、恢复和分叉由私有 `CODEX_HOME` 内的 Rust Thread Store / rollout / state database 持有。 | Electron 只持有活跃进程句柄与窗口归属，Gateway / Sidecar / Renderer 不得镜像 Agent 账本。 |
| App Server 协议 | 锁定版本公开了 98 个 client request、10 个 server request 和 72 个 server notification。当前 Electron 包装了 18 个 client request。 | Rust 能力不等于产品已全部接通；必须逐项补正式协议消费和真实验收。 |
| 原生模型 | `codexNativeProvider.ts` 将 Rust provider 固定为 Responses；托管 DeepSeek、个人 Responses、个人 Chat Completions 三路均从此处进入。 | 三路模型是同一个 Rust Agent Loop 的 provider 差异，不是三套 Agent。 |
| 旧 TypeScript Agent | 本机 Bun Server 对旧 Agent HTTP 与 WebSocket 返回 `LEGACY_AGENT_BACKEND_RETIRED`，不再启动 Worker、Run ledger 或 Tool Host。 | 不恢复，也不把它包装成“兼容层”。 |

## 哪些跳转必须保留

| 跳转 | 是否保留 | 原因 |
| --- | --- | --- |
| Renderer → Electron Main | 保留 | Renderer 不可读取系统密钥、启动受信进程或决定 OS 权限。 |
| Electron Main → Rust App Server（stdio） | 保留 | App Server 本身就是 Codex 给富客户端的双向协议边界；它将 Agent 崩溃、工具执行和 Thread Store 与桌面壳隔离。 |
| Rust → 用户 Responses endpoint | 直接保留 | 标准 Responses 协议，不需要中间业务服务。 |
| Rust → 本机 Chat 转换器 → 用户 Chat endpoint | 保留 | Codex Core 固定 Responses，而用户明确需要 Chat Completions；转换器只做 wire 语义转换，不拥有 Thread、工具、审批或持久化。 |
| Rust → 本机托管令牌桥 → Gateway → DeepSeek | 暂时保留 | Rust 子进程不持有可长期使用的 Gateway bearer；桥在每次调用时从 Main 取得当前短令牌。它不是 Agent 服务，也不保存会话。若以后能在不降低轮换和恢复语义的前提下由 Rust 原生安全刷新短令牌，才可以替换它。 |
| Bun Sidecar → Rust Agent | 删除 | 两者没有共享 Agent 状态，也没有合法消费者。 |

当前不把“少一跳”误解为把短令牌直接写入持久配置、让 Renderer 直连 Gateway，或把
Chat Completions 假装成 Responses。那会减少表面层数，却破坏凭据边界或用户要求。

## 明确禁止的重复层

1. 不新增 `native/billiardbuddy-agent`、FFI 桥、第二个 Rust HTTP Agent Server 或
   TypeScript Harness。
2. 不让 Gateway 保存、恢复或调度 Agent Thread、Turn、工具、审批、沙箱或子 Agent。
3. 不让 Bun Sidecar 启动 App Server、读取用户模型 Key、持有 Rust Thread 或接收
   Agent 工具调用。
4. 不让 Renderer 根据流事件自行写入 Agent 成功、失败或权限终态。
5. 不把 Chat Completions 适配器扩张为会话服务、工具 Host、重试账本或模型缓存。

## 当前缺口，不以源码存在冒充完成

| Codex 能力域 | Rust 内核 | 当前 BilliardBuddy 接入 | 缺口与后端验收条件 |
| --- | --- | --- | --- |
| Thread / Turn | 已有 | 创建、恢复、读取、分叉、归档、开始、引导与中断已接 | 仍未接入列表、命名、删除、段落、压缩、回滚等正式 RPC；需由后续桌面协议消费者决定并验收。 |
| 工具 / Exec / Sandbox | 已有 | 命令和文件审批可原样转发 | 追加权限、工具追问、MCP elicitation 和动态工具尚无界面；冻结界面期间必须 fail-closed，不能由 Main 猜测允许。 |
| MCP / Skills / Hooks / 协作 | 已有 | 状态、OAuth、目录和协作模式 RPC 已可调用 | 未完成真实 MCP、Skill、Hook、Review、协作 Agent 的端到端旅程。 |
| 模型与凭据 | 已有 Responses provider | 托管 DeepSeek 真实受控调用已验证；个人 Responses / Chat 已做协议级受控验证 | 用户真实 Key 的完整桌面旅程、取消、断网、令牌轮换与恢复仍须单独证明。 |
| 进程恢复 | 已有 Thread Store | 受控立即关闭后能恢复 Thread | 尚未证明 OS 异常终止整个 Electron 进程后的用户旅程与跨平台沙箱。 |
| 协议覆盖 | 已有 | 18 个手写调用和通知转发 | 必须改为从锁定 App Server 版本生成并受控保存协议类型，避免临时类型和静默协议漂移。 |

## 最小施工顺序

1. **运行时源码卫生（已完成）**：已移除默认关闭、无消费者的
   `host_managed_tools_only` 历史补丁，并从干净锁定源码重新构建、签名和验证
   `codex-app-server`。发行清单升为 `schemaVersion: 2`，不再记录补丁哈希；
   源码锁、LICENSE/NOTICE、二进制哈希和正式桌面构建均已验证，不能只改文档或清单。
2. **App Server 协议收口**：将当前实际调用收敛到直接从锁定 Rust 协议源码审计的
   方法和字段清单。上游导出的 TypeScript 类型没有覆盖全部实验性方法，且会把 Rust
   `serde(default)` 输入误标为必填，不能把它误当完整合同；保留一个通用 stdio client，
   以 Rust 定义和自动协议校验防止静默漂移，不再按页面或旧 ProductTask 复制状态。
3. **原生执行证据**：按 Rust 正式链路验证工具、审批、取消、进程退出与恢复；用户界面
   尚未具备的 server request 必须继续 fail-closed，而不是由 Main 猜测允许。
4. **模型/凭据证据**：分别验证托管 DeepSeek、个人 Responses、个人 Chat 三路，但三者
   必须共用同一个 Rust Thread / Turn 语义。
5. **全盘后端审计**：删除无消费者的旧 Agent HTTP、IPC、配置和二进制引用；之后才进入
   图片、视频领域审计，最后才改前端。

本文件不授权恢复旧 Agent 代码，也不授权提前改 React 页面。每一步都必须由一个独立提交
收口，并以真实调用链证明其没有产生第二个 Agent 状态来源。
