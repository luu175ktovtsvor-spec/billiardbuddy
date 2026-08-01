# 通用 Agent 工作台

> 施工状态：第一个正式产品模块。以 [目标架构与施工顺序](./00-目标架构与施工顺序.md) 为边界；本文描述目标，不把当前 `ProductTask` 或 Harness 的形状当成既成事实。

## 用户结果

BilliardBuddy Agent 是通用的长期工作助手。用户在一个项目中创建任务、给出目标和附件，看到计划、运行活动、审批、终端/浏览器/文件证据与最终成果；任务能在停止、断网、进程崩溃和应用重启后得到可信状态，而不是退化为一次聊天回复。

前端的信息架构参考 Codex：项目与任务导航、独立运行工作面、可见进度和成果、可继续的对话，以及用户随时介入的审批和后续指令。它不复制 Codex 的品牌、云端工作树或内部实现。官方公开说明也强调任务可在后台持续、用户可审阅变更与结果；BilliardBuddy 以本地门店工作流实现这一体验。[Codex app](https://openai.com/index/introducing-the-codex-app/)

## 源码参考与适配边界

| 参考 | 用来学习什么 | BilliardBuddy 的边界 |
| --- | --- | --- |
| 官方 `openai/codex` 源码（Apache-2.0，固定 `ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff`） | App Server 的 Thread / Turn / Item 协议，Core 的单会话活动回合、模型—工具循环、持久历史和执行服务分层 | 本机只读参考在 `codex-frontend-reference/upstream-cli-ee0247f/`；不继承 Rust CLI、Codex 品牌、OpenAI 认证、云端工作树或单一 Responses 实现 |
| 本地 `codex-frontend-reference/` 解出产物 | 项目—任务—运行工作面的信息架构、活动/成果/侧栏的可见组织 | 它不是 BilliardBuddy 的源码依赖；不复制 bundle、资源、文案、内部端点或实现 |
| 本地 WorkBuddy 安装包静态文件 | Electron 宿主、侧车、CLI/MCP、权限、沙箱和扩展协议的边界 | 只读取静态内容，不启动 UI；不复制私有代码、资产、配置或任何凭据 |

参考来源帮助判断，不取代本模块的用户结果。BilliardBuddy 的正式路径必须由自己的任务账本、权限信封和公开事件合同拥有；任何外部实现都只能在这里重新定义为可验证的产品行为。

## Agent 的事实模型

这里的名称描述产品事实，不冻结 TypeScript 类名或文件位置：

| 事实 | 含义 | 不属于它的东西 |
| --- | --- | --- |
| AgentProject | 用户选择的工作区、线程集合和项目级指令 | 图片作品、视频作品、任意共享“项目”引擎 |
| AgentThread | 可恢复的长期上下文、指令快照和输入队列归属 | Renderer 的临时流状态或上游会话 ID |
| AgentTurn | 用户一次明确输入及其可见完成边界 | 图片生成操作、视频渲染操作 |
| AgentRun | 一个 Turn 的可调度执行代次、权限快照、取消意图和恢复状态 | UI 的 Promise、上游 provider 会话或另一个领域的 Job |
| AgentItem | 消息、计划、工具活动、审批、Diff、成果和终态的持久记录 | 尚未完成的 Promise 或只存在于 UI 的气泡 |
| EffectReceipt | 有副作用调用的操作身份、输入摘要、幂等键、状态和持久检查点 | provider 原始密钥、完整推理内容或另一条业务的账本 |

一条线程同一时刻最多有一个活动回合；后续用户输入必须成为有顺序、可编辑的队列项。Renderer 只提交版本化意图：`start`、`steer`、`interrupt`、`approve`、`inspect`。本机可信服务验证目标回合和权限后执行；模型、工具、文件、终端和凭据不能由 Renderer 直连。

## 领域拥有者与调用链

```text
任务页命令
  -> AgentDomainService（校验 thread / run / generation 前置条件）
  -> AgentRunLedger（落盘输入、队列、权限、effect receipt 与事件）
  -> WorkerHost（只发放冻结 Run 快照和窄能力端口）
  -> AgentExecutionKernel：模型 -> ToolExecutor / 审批 -> 模型循环
  -> 父进程持久 AgentItem / artifact 引用 / 运行投影
  -> 同一 operation_id 写入 checkpoint 后才确认 effect
  -> WebSocket/HTTP 快照 -> 任务页、活动栏、成果面板
```

Agent 域账本拥有 Project、Thread、Turn、Run、排队输入、审批、Item、上下文快照和恢复终态。私有执行内核只拥有该次 Run 的模型轨迹和工具执行上下文；它在每个可恢复边界提出事件和结果候选，由父进程写入账本。Renderer 只消费公开投影。

### Harness 收缩为 AgentExecutionKernel

正式实现把当前 Harness 视为候选的 `AgentExecutionKernel`，而不是产品总后端。它只做四件事：读取冻结的 Run 上下文、调用模型适配器、解析完整工具调用、通过 ToolExecutor 形成下一轮模型输入。它不能读取或修改项目索引、迁移文件、图片/视频状态、Gateway 配额、个人 Key 或最终的 Run 终态。

终端、浏览器、FFmpeg 和脚本等本机进程能力下沉到受控 `ProcessBroker`：启动、输出、退出和完全关闭分别是可观察事件；逻辑 `process_id` 不等同于操作系统 PID。Harness 只能经 ToolExecutor 请求这些能力，不能直接把“进程已启动”当成“工具已完成”。

### 终态先于释放

用户停止先写入独立的 stop intent；已获调度准入的 Worker 则由账本签发一次性 execution claim。停止、模型/工具异常或子进程退出时，持有同一 claim 的监督器先写持久 `recovery fence`，令后续模型/工具请求立即失去令牌，再停止本进程的 Worker。只有精确 terminal projection 或 recovery terminal 已成功写入，才能释放本进程拥有的调度租约、推进下一条排队输入或允许该运行结束。若写入途中进程中断，启动恢复只在 scheduler 已无存活 lease、且账本 claim 仍是同一把令牌时把 fence 收为 `recovery_required`；它不猜测已完成、不重放模型/工具，也不终止另一台本地服务仍持有的运行。

### 外部操作的未知结果

每一次真正跨出本机任务边界的操作必须单独持久化开始回执：MCP 准备、聊天附件处理、命令提示、模型请求、工具执行、Hook Shell/HTTP、初始化或自动记忆的工作区写入都在账本中占用不透明的 `operation_id` 和固定类别。Worker 只有在这份 `in_flight` 回执落盘后才可发出请求；账本不保存原始提示词、命令、URL、Header 或凭据。

拿到外部结果不是完成。正式状态顺序为：

```text
in_flight
  -> result_obtained（Worker 仅回传 operation_id 与安全结果候选）
  -> checkpointed（父进程已持久化 AgentItem / 工具结果 / 运行投影）
  -> completed（才允许确认上游回执并释放重放风险）
```

Worker 无权清除 receipt。任何 checkpoint 前的 stop、崩溃、IPC 断开、超时或传输异常都进入 `outcome_unknown`，保留该 receipt 并阻塞队列；它既不伪造 terminal，也不自动重跑。父进程在 `outcome_unknown` 事务成功后必须推送专用运行事件，让桌面立即退出“仍在执行”的假象、刷新 Thread 和队列。界面只公开安全的 `{ operationId, kind, startedAt, generation }`，用户的确认也必须绑定这次操作和执行代次；不能用一个泛化布尔值确认未来的重跑。

确定收到的业务失败（例如非 2xx Hook 响应或非零退出码）仍按普通失败处理，不应被误标为未知结果。用户停止会先持久化 stop intent；如果外部结果此后才到达，不能清掉 receipt 并把该效果遗忘，必须按上述未知结果规则收口。

### HookRun 的可见活动

每个实际匹配并执行的同步 Hook 都必须形成同一 Agent Run 下的一对安全活动投影：`started -> completed` 或 `started -> failed`。活动身份由该次 Run 和 Hook 调用序号确定，父进程先写入账本再推送任务页；任务页和重连回放只能看到“项目自动化正在运行、已完成、未完成”，不展示命令、URL、输入、输出、路径、配置来源或凭据。

Hook 的 Shell/HTTP 副作用仍复用本节的 EffectReceipt 和 checkpoint；HookRun 活动不另造一份效果账本。无法等待并保存结果的异步 Command Hook 必须继续明确拒绝，不能作为 Harness 中脱离账本的后台 Promise 执行。

### 项目能力准备的可见状态

每次普通 Agent Run 在冻结工具面前，必须先把项目指令、Skills、Plugins 和 MCP 的准备过程投影为同一账本中的一项 `extension` 活动：`started -> completed` 或 `started -> failed`。它是一次 Run 的稳定活动身份，父进程先持久化再推送或重放；任务页只显示“正在加载项目能力、项目能力已就绪、项目能力未就绪”。

MCP 的 `failed` 和 `needs-auth` 会把这项活动收为“未就绪”，避免把未连通的能力伪装为可用；不展示服务器名、命令、URL、路径或凭据，也不阻止其余已准备好的本地工具继续运行。`extension_snapshot` 仍只保存工具、命令、MCP 数量和摘要 hash，不能把它替代成配置明细或第二份扩展状态源。

### 迁移与执行边界

历史 `product-tasks.json`（v1–v4）以及当前 `product-task-authority.v1.json` 都只可作为迁移输入或过渡读取源。它们的 schema、版本归一化和旧 Core 映射属于迁移层；新 Agent 域完成切换后，正式路径只读取 Agent 自己的账本，不能维持两份可写运行真相。

私有 Worker 不接收 `ProductTaskService` 这个总服务，也不能接触项目目录、工作区、草稿、附件管理或旧存储。它只通过明确的 AgentRun ledger 端口读取本回合身份/模型绑定，并写入活动、计划、审批、压缩、文字和终态候选。这让以后替换执行内核、模型协议或调度器时，不会重新耦合任务目录与历史迁移代码。

### 新任务的工作区边界

新建任务必须先选择一个本机可写目录。目录在草稿创建时经服务端规范化、身份校验并登记为工作区；提交草稿时，任务、项目、目录映射、工作区 scope、会话执行目录和首个 TaskRun 在同一权威事务中关联。首个 run 只能以这个工作区为 `work_dir` 启动；目录丢失、只读或身份变化会拒绝运行，绝不能回退到 BilliardBuddy 的配置或数据目录。

任务列表只在该工作区当前可用时向 Renderer 投影目录路径。权威变更回执不携带原始路径，因此界面不能把一次旧快照当作持续授权。

历史任务如果没有可验证工作区，任务页必须明确要求用户重新选择可写目录；关联操作会更新该任务的 workspace scope、当前会话的执行目录以及 revision 8 下的项目/目录映射。关联失败、目录只读或身份变化时，任务保持暂停，不能借用配置目录、数据目录或任意旧路径继续执行。

## 模型与远程能力协议

默认模型由 BilliardBuddy 服务选择、执行能力校验并控制额度；用户无需看到 provider、密钥或内部路由。用户明确添加并选择个人模型后，个人 API Key 只由本机受信服务保存和直接请求上游，绝不经 BilliardBuddy Gateway/Relay。两条路由都必须保持相同的任务、工具、权限和恢复语义。

个人模型至少支持以下两种 OpenAI 协议：

- **Chat Completions**：流式文本、工具调用及终态；因长度截断的响应不能执行部分工具调用。
- **Responses**：输入/输出项、工具调用参数流和完成终态；只以 `response.function_call_arguments.done` 或最终输出项的参数为准，只有 `response.completed` 才能进入工具执行。

Chat 终态与工具轨迹必须一致：`stop` 不能携带待执行工具，`tool_calls`/`function_call` 也不能在没有完整调用时结束。Responses 中未收到参数完成信号的函数调用同样不能执行。

协议适配是模型运行时的职责，不泄露到任务页、工具或项目状态。请求必须有操作身份；结果在持久化后才确认给上游，模糊结果不能自动重放外部副作用。

官方 Codex 当前模型 wire 只保留 Responses，不能直接满足本产品要求；BilliardBuddy 因此保留自己的 `ModelTransportAdapter`，统一投影为 `text_delta`、完整工具调用、terminal、usage 和安全错误。Gateway、Relay、个人 Key 和版本化 provider contract 的共同规则见[模型与远程能力平台](./模型与远程能力平台.md)；本模块只拥有 Agent 对这些能力的调用与恢复语义。

## 完整能力范围

1. 项目、任务、分支/子任务、会话、消息、运行与成果；
2. 连续模型—工具循环、流式文字、计划和活动；
3. 运行中的补充、引导、排队、编辑、删除、排序、立即发送；
4. Ask for approval、Approve for me、Full access 三种清楚可见的权限；
5. 文件、命令、PTY、浏览器、网页研究、审阅与项目自动化工具；
6. 项目指令、Skills、Plugins、MCP、Hooks 和子任务的受控加载及运行；
7. 停止、取消、重试、继续、分叉、上下文压缩、断网和崩溃恢复；
8. 附件、Diff、网页、文件、终端和最终成果的可追溯预览。

## 不允许的替代品

- 聊天页面或单轮模型回复不等于 Agent；
- Worker 内存、renderer Store 或模型说“已完成”不等于任务完成；
- 模型截断、未知网络结果或未持久化工具结果不能继续执行；
- 异步 Command Hook 不能脱离 TaskRun 账本在后台直接执行。尚未有操作身份、开始/终态回执、未知副作用恢复和结果投递机制前，它必须明确拒绝，而不是静默执行或在崩溃后重放；
- 插件、MCP、Hook 或子任务只有列表和设置页不算已生效；
- 用户个人 Key 不能回传、转发或伪装为平台额度调用。

## 完成验收

以正式桌面路径验证：创建 Project/Thread 并恢复会话；真实模型完成多步工具任务；运行中加入和调整后续输入；三档权限各自准确拦截或放行；至少一个 Skill、Plugin、MCP、Hook 与子任务真实影响任务；压缩、停止、进程重启、模型/网络/工具失败均留下一致可继续或不可继续终态。验收必须覆盖“外部结果已到、但 Item 尚未落盘”的中断：它只能进入 `outcome_unknown`，不得通过普通恢复重放。验收同时覆盖托管模型和不经服务器的个人 Key 路由，但不得自动发起付费请求。
