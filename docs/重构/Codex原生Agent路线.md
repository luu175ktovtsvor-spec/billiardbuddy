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
  ├─ Codex 原生 Responses provider 配置
  │    ├─ BilliardBuddy 托管 DeepSeek：自有薄模型网关 /v1/responses
  │    ├─ 用户本地 API Key：直接 Responses endpoint
  │    └─ 用户本地 API Key：无状态 Responses ↔ Chat Completions 适配器
  ├─ 生图工作台（独立领域）
  └─ 剪辑工作台（独立领域）
```

锁定的 Codex Rust 源码已将 `wire_api = "chat"` 明确移除，Codex provider 只接受 `wire_api = "responses"`；这是 Core 的内部边界，不是 BilliardBuddy 对用户模型协议的删减。用户仍可在设置中配置 Responses 或 Chat Completions。BilliardBuddy 在每个私有 Codex Home 写入临时 provider 配置：`base_url`、`env_key`、`wire_api = "responses"`、模型与重试策略；Key 只由 Electron Main 从系统安全存储取出。个人 Responses Key 仅作为该 App Server 子进程的短生命周期环境变量；Chat Completions Key 则只留在 Electron Main 内存，由本机适配器持有，子进程仅得到不可复用的 loopback capability。`config.toml`、Thread 事件、Renderer、日志与 Gateway 请求体都不保存用户明文 Key。

托管路线使用 BilliardBuddy 自己控制的 DeepSeek 模型，但网关收敛为标准 `/v1/responses` 的模型控制面：鉴权、套餐/额度、限流、上游路由、用量、幂等和模型操作回放。它必须持久化账户与授权、用量预约/结算、操作 ID 与请求指纹、终态 Responses SSE 回放结果及安全审计，以便断线、重试或结算中断后绝不再发起第二次上游调用。它不保存 Codex Thread、Turn、工具执行、权限决定、沙箱状态或 Agent 恢复状态，也不能据此重建一套 Agent 会话。托管 App Server 也不持有会过期的 Gateway bearer：它只拿本机 loopback capability，受限转发器在每一次模型请求时从 Electron Main 取得最新短令牌并原样转发 Responses 流。用户 Key 的 Responses 路线绕过该网关、由原生 Codex Core 直连；Chat Completions 路线也绕过网关，但连接到 BilliardBuddy 本机的无状态适配器，由它把源 Responses 请求和 SSE 结果转换为用户选择的 Chat Completions provider。

这些本机适配器是保留用户协议选择和令牌轮换的最小边界，不能演变为旧后端：它们只接受来自同一 App Server 子进程的受限 loopback 请求；Chat 适配器转换消息/函数定义/函数结果/流式文本和 tool call，托管 Gateway 适配器只取得当前短令牌并转发原始 Responses 流。子进程拿到的都是一次性 capability，不是用户 Key 或 Gateway bearer。它们不写 Thread、数据库、任务账本或审批记录；不执行工具、文件、终端、浏览器或 MCP；退出 App Server 时一并退出。

## 状态分层与恢复

“对齐 Codex”不是让所有层都不保存状态，而是让每类状态只在正确的一层保存。开源 Codex 的 Thread Store、rollout 和 state database 本来就保存本机会话、事件、分叉/归档索引和恢复资料；BilliardBuddy 应直接采用这一实现，不再复制一套 ProductTask 状态机。

| 状态 | 唯一拥有者 | 保留原因 | 不允许的复制 |
| --- | --- | --- | --- |
| Thread、Turn、Item、上下文压缩、工具调用/结果、审批、fork、子 Agent、恢复 | 私有 Codex Home 中的 Rust App Server/Core Thread Store、rollout 与 state database | 与 Codex 相同的本机会话恢复、历史、分叉与可追溯执行 | 网关、Renderer、ProductTask/Run 账本不得另存一套权威 Agent 状态 |
| 当前进程连接、背压、未完成请求 | Rust App Server | 正确处理连接中断、server request 和 turn 生命周期 | Renderer 不自行推断执行成功或写入虚假终态 |
| 账户、组织、登录授权、套餐、模型额度、限流、用量和模型操作幂等/回放 | BilliardBuddy 远程模型网关 | 平台模型必须可计费、可恢复且不重复调用上游 | 网关不得拥有 Agent 的 Thread 或工具/权限语义 |
| 用户自己的 API Key 与个人 provider 配置 | Electron Main 的系统安全存储；每个 App Server 子进程只拿短生命周期环境变量 | 用户可在设置中配置 Responses 或 Chat Completions，同时 Key 不进入 renderer、配置文件或远端网关 | Thread、日志、模型请求回放和 Gateway 永不持久化明文 Key |
| DeepSeek/其他上游的请求保存 | 上游服务自己的规则 | 由对应供应商协议与隐私政策决定，BilliardBuddy 不伪造或假设其内部行为 | BilliardBuddy 不以“兼容 Codex”为由增加未声明的云端会话镜像 |

开源源码只能证明本地 Codex 的实现，不能证明 OpenAI 未公开云端服务的全部内部数据模型。因此我们只复用可验证的 Thread Store、App Server、Core 和 Exec 行为；远端服务按自身必要的授权、计费、幂等与隐私责任设计，不假冒或臆测 OpenAI 私有后端。

图片与剪辑不是 Codex 工具。它们继续拥有自己的项目、资产、画布/时间线、异步 Job 与导出状态；未来如需互通，只能通过显式成果引用或启动命令，不把媒体状态塞进 Codex Thread。

## 过渡实现与终态

旧 `host_managed_tools_only=true` 补丁及 TypeScript ProductTask/Worker 链只属于历史过渡路径。它们不得进入原生 Agent 默认启动链，也不能成为 Rust Core 外层的第二个执行器；在媒体与共享设置完成脱钩后删除其实现和启动入口。

当前桌面本机边车已先完成启动链切断：它只启动媒体、图片、视频、语音、设置、凭据更新与能力快照服务；不再实例化 ProductTask、Run ledger、Worker、Cron、旧 Chrome 招聘桥或 ProductTask WebSocket。`/api/product/voice`、`/api/product/settings`、`/api/product/capabilities` 和目录选择器所需的 `/api/product/projects/recent` 继续存在；最近目录只从历史 `product-tasks.json` 做只读投影，绝不触发迁移、Core session 导入或写入。其他旧 Agent HTTP 接口及 `/ws/product/tasks/*` 均返回 `LEGACY_AGENT_BACKEND_RETIRED`，使旧执行路径不能被悄悄重新启用。

招聘网站专用的 Chrome 扩展、Native Messaging、候选人操作账本及其 Electron IPC 也已从运行路径退役；`/api/browser` 同样明确返回 `LEGACY_AGENT_BACKEND_RETIRED`。这不削减 Codex 的浏览器/网页能力：正式路径将使用 Rust Core 的原生工具、Exec/sandbox 和 approval request，而不会把旧招聘桥改名后继续作为 Agent 工具。

MCP 的正式控制面同样不再经 Bun 侧车探测或连接。Electron Main 只能代表已拥有的 Rust Thread 调用上游 `config/value/write`（固定在 `mcp_servers.<name>`）、`config/mcpServer/reload`、`mcpServerStatus/list` 和 `mcpServer/oauth/login`；配置、工具清单、启动状态和 OAuth 凭据分别由 Codex 私有 Home、MCP runtime 与其配置的凭据存储拥有。前端冻结期间不复用旧 MCP 设置页，后续页面只接这些原生 RPC。

旧 `/api/mcp` 已返回 `LEGACY_AGENT_BACKEND_RETIRED`，Electron 也不再为它生成或向 Bun 侧车注入 OAuth 主密钥。历史 JSON 配置和历史加密凭据只保留在磁盘上、不执行、不迁移、不删除；之后由用户明确决定是否手工重建为 Rust 原生 MCP 配置。

终态将新增 BilliardBuddy 的 **native Codex profile**：

- 不再开启 `host_managed_tools_only`；使用上游工具、审批、沙箱、MCP、Skills、Hooks、Review 和 multi-agent；
- 不把 `environments` 清空，也不手工屏蔽 Codex 的权限/项目指令/协作配置；
- Electron 只作为 App Server 协议客户端，按源 Item 与 Codex 原生审批请求显示界面；
- Thread 的持久化、上下文压缩、fork 和子 Agent 由 Codex Rust 线程存储和控制器负责；
- 现有 TypeScript Agent Worker、产品 Run 账本、权限信封、工具 Host、Subtask 协调器和 UI 投影在原生路径通过正式 Electron 验收后删除，而不是与 Codex 双写、双调度。

这不是“把整个 BilliardBuddy 改成 Rust”：React/Electron、Gateway 兼容层以及两个媒体领域保留现有合适实现。要替换的是 Agent 执行域及其状态机，使其成为 Codex Rust 的直接产品化版本。

## 权限适配原则

权限不是由 BilliardBuddy 再写一套“允许/拒绝”业务规则，然后让 Codex 服从它。正式路径只使用上游的 `approval_policy`、`sandbox_mode`、工作区根目录、网络权限、`item/*/requestApproval` 和对应的 JSON-RPC 决策；Electron 负责展示请求和把用户选择原样回复给 App Server。

| BilliardBuddy 显示的选择 | Codex 原生配置与行为 | 不做的事 |
| --- | --- | --- |
| Ask for approval | `workspace-write`、`on-request`、`user`；工作目录内按 Codex 默认运行，越界、联网及其他升级由原生请求交给用户 | 不转换成旧 PermissionExecutionEnvelope，也不在 renderer 直接放行 |
| Approve for me | 相同 `workspace-write` 与 `on-request`，但使用 Codex `auto_review` reviewer；审查子流程仍受 Rust sandbox、MCP 与 Hook 规则约束 | 不伪造“自动批准”来绕开 Codex 的安全边界 |
| Full Access | Electron Main 的受信任原生确认后，才向 Rust Thread 写入 `danger-full-access` 与 `never`；完整风险提示与最终结果仍来自 Codex Item | 不把全权限解释成 Gateway、图片或视频服务的额外权限 |

`item/commandExecution/requestApproval`、`item/fileChange/requestApproval`、`item/permissions/requestApproval`、MCP 表单追问和 `request_user_input` 都要由同一个 App Server 连接处理；`item/completed` 是命令和文件改动是否实际完成的唯一结果。BilliardBuddy 可以保存用于界面恢复的事件投影，但不得据此重建另一套授权或执行状态机。

## Agent 后端替换边界

以下是“换成 Codex 后端”的准确边界：不是只嵌入一个循环，也不是继续让旧 Product Server 在外层控制 Codex。

| 层 | BilliardBuddy 正式实现 | 旧实现处理 |
| --- | --- | --- |
| 桌面接入与事件 | Electron Main 通过 stdio JSON-RPC 连接 Rust App Server；Renderer 消费 Thread/Turn/Item/approval 事件 | 删除旧 HTTP 任务 API、Worker IPC 事件投影和 ProductTask 路由 |
| 会话与协作 | Codex App Server Thread Manager、Thread Store、fork/archive、Core Session、背压与超时 | 删除 Run 账本、子任务协调器和 TypeScript 的恢复/分叉状态 |
| Agent 执行 | Codex Core 的 Agent Loop、Context、Tool Router、Workspace、AGENTS.md、Hooks、MCP、Skills、Review 与 multi-agent | 删除 Harness、Tool Host、动态工具桥、旧 prompt/compaction/hook 编排 |
| 本机执行与权限 | Codex Exec/Tools/sandboxing/execpolicy 及原生 approval request | 删除 PermissionExecutionEnvelope 与旧 shell/文件/PTY/browser 授权实现 |
| 模型调用 | Codex 原生 Responses client；托管 DeepSeek、个人 Responses 直连，或个人 Chat Completions 经无状态本机适配器 | 删除旧 `CodexResponsesModelBridge`、`runProductModel`；保留新适配器但不允许它获得 Agent 状态或工具权限 |
| 平台服务 | 独立的 DeepSeek 模型网关、身份/套餐/额度/用量、幂等回放与运维 | 不保存或调度任何 Agent Thread、工具、权限或恢复状态 |

生图和剪辑不属于上表中的 Agent 后端。它们保留自己的领域服务和任务状态；两者与 Agent 的连接只允许成果引用或显式启动动作。

## 后端优先施工顺序

前端不是 Agent 的事实来源，不能先用页面替代未完成的执行域。先完成并验证后端边界，再用 Codex 的信息架构补桌面工作面；在此之前不得为了“看起来像 Codex”扩张 React 状态、模拟工具结果或新增 ProductTask 兼容层。

1. **原生构建与 App Server**：以锁定 revision 构建不启用宿主工具限制的 `codex-app-server`，完成 stdio/WebSocket JSON-RPC、连接生命周期、Thread Store、恢复、背压和超时；保留 Apache-2.0 NOTICE 审计。
2. **模型与凭据边界**：以 Codex `model_providers` 和 `wire_api = "responses"` 配置 BilliardBuddy 托管 DeepSeek、用户 Responses Key 直连，以及用户 Chat Completions Key 的无状态本机适配器；删除旧 Gateway/个人 Key bridge 的 Agent 状态或工具耦合。
3. **原生执行、权限与扩展**：完成 Core、Exec/sandbox、permission profile、原生审批、Workspace/AGENTS.md、MCP、Skills、Hooks、Review、multi-agent 和 Thread Store 恢复的正式后端链；Electron Main 只做受控 JSON-RPC 客户端与凭据边界。
4. **旧 Agent 后端切除**：从本地 Product Server 启动链中拆除 ProductTask、Run ledger、Worker、Tool Host、权限信封、旧任务 HTTP/WebSocket API 与恢复队列；保留并独立验证图片、剪辑及真正共享的设置/凭据服务。
5. **后端实跑验收**：只针对 Rust App Server 的正式路径验证创建/恢复/fork、模型流、工具循环、审批、停止、崩溃恢复、幂等和错误边界。真实模型调用按产品成本规则受控进行，不用静态检查冒充验收。
6. **前端产品化**：后端协议与状态所有权稳定后，再从本地 Codex 前端行为推导 BilliardBuddy 的 Thread/Turn/Item、审批、Diff、终端、网页、队列和历史界面；前端只投影 Rust 状态，不新建 Agent 账本。

每一步都必须是一个独立、可构建的提交。图片、剪辑和发布不在 Agent 后端切除范围内。
