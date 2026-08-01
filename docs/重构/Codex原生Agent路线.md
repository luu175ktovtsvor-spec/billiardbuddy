# Codex 原生 Agent 路线

> 决策：Agent 域不再长期在 TypeScript 中复刻 Codex 的 Thread、上下文、工具、协作或恢复机制。BilliardBuddy 以锁定的 Codex Rust 源码作为正式 Agent 实现；BilliardBuddy 只保留品牌、模型接入以及与图片/剪辑工作台的产品边界。

## 目标

用户在 BilliardBuddy 里获得与 Codex 同类的本地编码 Agent 能力：项目与工作区、Thread 创建/恢复/fork/归档、流式 Turn/Item、文件与终端、Codex 原生审批与沙箱、MCP、Skills、Hooks、Web、代码审查、子 Agent、消息、追问、等待与中断。

“同类能力”指使用同一份上游 Rust 实现和同一套 App Server 协议，不是在 BilliardBuddy 中另写一套名称相同但语义不同的 TypeScript Harness。BilliardBuddy 的名称、图标、桌面入口、模型套餐与媒体工作台仍是自己的产品；不冒充 OpenAI 服务，也不复制 Codex 的 CLI/TUI 品牌或私有云端服务。

## 已核对的上游实现

当前锁定源码为 `third_party/codex-engine` 的 `ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff`，许可证为 Apache-2.0，并已随桌面构建保留 LICENSE、NOTICE、revision 与补丁清单。

| 用户能力 | 直接采用的 Rust 组件 | BilliardBuddy 的职责 |
| --- | --- | --- |
| Thread、Turn、Item、流式事件、恢复/fork/archive | `codex-rs/app-server` | 将 JSON-RPC 事件接到 BilliardBuddy 桌面，而不是再造 Run 账本 |
| 单 Agent 循环、上下文压缩、项目指令、模型调用 | `codex-rs/core` | 提供模型配置与产品级默认设置 |
| 文件、补丁、终端、PTY、网络与审批 | `tools`、`exec`、`exec-server`、`sandboxing`、`execpolicy` | 不再适配旧 Billiard 权限信封；桌面只呈现并回复 Codex 原生审批请求 |
| MCP、Skills、Plugins、Hooks | `codex-mcp`、`skills`、`hooks`、对应 extension crate | 用 BilliardBuddy 的配置目录和品牌入口加载，不重写协议 |
| 多 Agent、fork、消息、追问、等待、中断 | `core/src/agent/control/` 与 `tools/handlers/multi_agents_v2/` | 直接呈现源 Thread 树与 item 事件；不再由 TypeScript child Run 模拟 |
| Review、配置、模型/权限 profile | `app-server`、`config`、`core` | 把 Billiard 模型 profile 映射为 Codex provider/config，不改 Agent 语义 |

上游 `codex-app-server` 已提供 stdio 与实验性 WebSocket JSON-RPC，`thread/start`、`thread/resume`、`thread/fork`、`turn/start`、`turn/steer`、流式 item、审批请求和 Thread 存储。这就是 BilliardBuddy Agent 桌面应当直接消费的协议。

## 目标形态

```text
BilliardBuddy Electron / React（品牌与桌面工作面）
  ├─ Codex App Server JSON-RPC 客户端
  │    └─ BilliardBuddy Codex App Server（Rust，锁定上游源码构建）
  │         ├─ Codex Core：Thread / Agent Loop / Context / Multi-Agent
  │         ├─ Codex Tools / MCP / Skills / Hooks / Review
  │         └─ Codex Exec Server / sandbox / approval profiles
  ├─ BilliardBuddy 模型 Provider Bridge
  │    ├─ 受管 Gateway 模型
  │    └─ 用户本地 API Key 的 Chat Completions → Responses 适配
  ├─ 生图工作台（独立领域）
  └─ 剪辑工作台（独立领域）
```

模型 Provider Bridge 只是对 BilliardBuddy 受管模型与个人 Key 的协议适配；它不拥有 Thread、工具、上下文、子 Agent 或权限。Rust App Server 的自定义 `model_provider` 通过本机受限端点调用它，因而可保留 Gateway 配额和个人 Key 不交给前端的边界，同时让 Codex Core 保持原生循环。

图片与剪辑不是 Codex 工具。它们继续拥有自己的项目、资产、画布/时间线、异步 Job 与导出状态；未来如需互通，只能通过显式成果引用或启动命令，不把媒体状态塞进 Codex Thread。

## 过渡实现与终态

现有 `host_managed_tools_only=true` 补丁及 TypeScript ProductTask/Worker 链只作为已验证的过渡路径。补丁默认关闭，不会改变正常 Codex；当前运行时显式打开它，才把源内核缩成由宿主提供动态工具的单 Run 引擎。

终态将新增 BilliardBuddy 的 **native Codex profile**：

- 不再开启 `host_managed_tools_only`；使用上游工具、审批、沙箱、MCP、Skills、Hooks、Review 和 multi-agent；
- 不把 `environments` 清空，也不手工屏蔽 Codex 的权限/项目指令/协作配置；
- Electron 只作为 App Server 协议客户端，按源 Item 与 Codex 原生审批请求显示界面；
- Thread 的持久化、上下文压缩、fork 和子 Agent 由 Codex Rust 线程存储和控制器负责；
- 现有 TypeScript Agent Worker、产品 Run 账本、权限信封、工具 Host、Subtask 协调器和 UI 投影在原生路径通过正式 Electron 验收后删除，而不是与 Codex 双写、双调度。

这不是“把整个 BilliardBuddy 改成 Rust”：React/Electron、Gateway 兼容层以及两个媒体领域保留现有合适实现。要替换的是 Agent 执行域及其状态机，使其成为 Codex Rust 的直接产品化版本。

## 施工顺序

1. **原生构建 Profile**：以相同锁定 revision 构建不启用宿主工具限制的 `codex-app-server`，保留 Apache-2.0 NOTICE 审计；不改变当前默认路径。
2. **模型 Provider**：把现有 Gateway/个人 Key 的 Responses bridge 变成原生 App Server 可用的受限 provider；保留 Chat Completions 兼容只在这层发生。
3. **Thread 协议直连**：Electron Main 管理一个原生 App Server 连接，Renderer 直接消费 Thread/Turn/Item/approval JSON-RPC 映射；不再投影成旧 ProductTask 事件。
4. **原生权限与工具**：以 Codex permission profile、sandbox、审批请求、MCP/Skill/Hook 为唯一 Agent 工具面；不迁移旧 Billiard 权限模式，关闭过渡动态工具 Host。
5. **原生协作与恢复**：开启 Codex 上游 multi-agent、fork、消息、follow-up、wait、interrupt 和 Thread Store；不再保留 TypeScript `Subtask` 协调器。
6. **一次性切换与删除**：完整 Electron 实跑验证后切换默认路径，删除过渡 Agent Worker、Run ledger、host-managed 补丁依赖和旧 UI 投影。图片、剪辑和发布均不在这次删除范围内。

每一步都必须是一个独立、可构建的提交。第一步只建立并验证 native Codex build/profile，不假装它已经接通模型或成为默认用户路径。
