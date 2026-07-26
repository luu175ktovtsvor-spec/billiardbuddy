# 聊天 Harness 持久 Item/Event：参考—改动表

本文只服务于 `BilliardBuddy-重构合同.md` 第一轮聊天 Harness 的一次落地，不是第二份产品合同。产品方向、边界和完成标准仍只由重构合同裁决。

## 施工结论

当前 Core 已在一次调用内部完成模型—工具—结果—模型循环，但 Product Server 只持久化用户输入。助手正文、工具活动和 Turn 终态只存在于内存事件，桌面重开后再从私有 Core session transcript 重建公开线程。这让私有执行记录反过来成为第二套用户任务真相，也让 cursor 只能恢复用户消息。

本次将 `ProductTask → TaskRun/Turn → Item/Event` 补成唯一公开事实链：worker 只上报产品安全的正文、活动和终态；Product Server 在对 renderer 发布完成前先持久化；线程与 cursor 都从同一事件账本投影。Core session、原始工具名、参数、结果、模型消息和本机路径继续留在私有执行层。旧任务在没有新型事件时才使用一次兼容读取，不能把旧 transcript 继续写回新账本。

## 参考—改动

| 参考文件 / commit | 证据等级与直接证据 | 要解决的用户问题 | BilliardBuddy 当前代码路径 | 唯一状态源 | 最小改动 | 失败 / 恢复行为 | 测试与真实旅程 |
|---|---|---|---|---|---|---|---|
| OpenAI Codex commit `62fd410384cca008446c2d64a4f2b3f915f4906e`：`codex-rs/core/src/session/turn.rs`、`codex-rs/app-server/README.md`；Apache-2.0 | 直接源码与协议证据。同一 Turn 内 tool result 返回模型直至最终回复；App Server 以 `item/started|completed`、审批和 Turn 终态事件供客户端恢复，并提供历史分页。 | 桌面重开后应继续看到同一 Turn 的回复、工具状态和完成结果，而不是只剩用户问题或依赖一个私有 session 尚可读取。 | `taskRunDispatchBridge.ts` 只实时发布正文；`taskService.ts#getTaskThread` 回读 `core_binding.session_id`；`listTaskEvents` 只返回 `user_text`。 | Product Server 的 `task_events`；每条事件绑定 task、run、全局单调 sequence 和稳定 item id。 | 扩展现有事件账本和投影，不引入第二个 Harness；先持久化安全 assistant/activity/terminal，再发布实时完成；新线程不再回读 Core transcript。 | late event 由 run/generation 与终态 fence 拒绝；崩溃前已写事件可按 cursor 恢复；无终态的 run 仍由既有 dispatch recovery 标记处理。 | authority schema、重复/晚到、终态前落盘、cursor 增量、线程重开和旧任务兼容测试；真实 DeepSeek/Tool 旅程另行验收。 |
| Pi commit `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`：`packages/agent/src/agent-loop.ts`；MIT | 直接源码证据。内循环的 assistant、tool execution start/end 和 agent end 都经事件 sink 顺序输出；tool result 回到同一循环。 | 用户需要看到“正在做什么”和最终答案属于同一次运行，工具活动不能只是一条不可恢复的瞬时提示。 | `createServerPrivateNativeCorePort` 已复用 Query 的内部 tool loop，但 worker 协议的 `tool` 事件无身份/阶段，sink 还直接忽略它。 | 同一 TaskRun 下的 assistant item、activity item 和 terminal event。 | worker 协议只增加有界、产品撰写的 activity envelope；不传工具参数/结果，不复制 Query transcript。 | activity started 后若失败或重启，保留已落事件并由 run terminal/recovery 给出最终状态；不得用 renderer 猜测完成。 | 协议拒绝额外字段/敏感 payload，activity stable id、phase 更新和失败恢复测试。 |
| Claude Managed Agents 公开 Session/Tools 合同（2026-07-26 核对）：`/docs/en/managed-agents/sessions`、`/tools`；核心 Claude Code 执行器未公开 | 直接公开协议证据；不推断未公开实现。Session 保存历史，custom tool 产生结构化请求，宿主执行后把结果送回；工具授权由宿主管理。 | 工具执行和授权必须有宿主可验证的记录，但 GUI 不应获得原始命令、凭据、路径或模型内部 envelope。 | approval 已写入 `dispatch_records.approvals`，但普通 tool activity 和 assistant/terminal 没有持久公开记录。 | 权限决定仍由 durable dispatch approval 持有；公开 Item/Event 只保存安全状态投影。 | 保留现有审批权威并把请求/解决投影接入同一可恢复事件视图；此次先补 assistant/activity/terminal，不改变权限判定。 | 审批等待可重连；拒绝、投递失败和恢复要求必须有终态，不能让 UI 永久停在 working。 | 审批现有测试继续通过；后续单独补全审批历史事件与权限升级事件。 |
| 本地 Codex 前端参考 `codex-frontend-reference/26.721.41059`：`README.md`、raw/reverse-readable `local-conversation-thread-Bj5uKwgs.js`、`queued-message-list-CJCiiVt0.js`、`thread-side-panel-tabs-B3tKzciM.js`，host bridge `build/main-DXmJ7M03.js` | 直接 bundle 与 host bridge 证据。线程消费 App Server item/turn 通知，队列与失败恢复有明确状态；bridge 把真实 `thread/start|resume`、`turn/start`、item 通知接入 renderer。无 source map 的内部算法不作推断。 | 主线程、运行检查器和重连后内容必须来自同一产品事件，而不是 DOM 临时文本与后台 transcript 混合。 | `productTaskRuntimeStore.ts` 合并 thread snapshot 与 live delta；socket resume 当前只重放 user_text。 | renderer store 是事件投影缓存，不是权威；服务端 cursor 和 thread snapshot 来自同一 `task_events`。 | 保留当前组件与 live delta 体验，改成终态后用权威 thread 对账；resume 可重放所有持久事件。 | socket 断开不丢已持久内容；snapshot 与 live 重叠按稳定 item id 去重；旧 live entry 在权威项到达后被替换。 | protocol parser、store merge、断线重连、cursor 分页及重复事件测试。 |
| BilliardBuddy 当前生产链（2026-07-26）：`shared/product/taskEvents.ts`、`shared/product/agentWorker.ts`、`cli/print.ts#createServerPrivateNativeCorePort`、`taskRunDispatchBridge.ts`、`taskService.ts`、`ws/handler.ts`、`productTaskRuntimeStore.ts` | 直接当前代码事实。Query 内部已有连续 tool loop；`TaskEvent` 只有 user_text；worker sink 忽略 tool、只内存发布正文/完成；`getTaskThread` 以私有 Core session 为公开历史；cursor 仅回放 user_text。 | 当前运行看见的回复在重启后可能依赖另一份存储，工具活动和终态不能可靠恢复。 | 上述完整生产链及 authority validator、桌面协议 parser。 | `task_events` 是普通任务消息、活动、终态和 cursor 的唯一公开账本；`dispatch_records` 继续持有调度与批准细节。 | 使用现有 authority transaction、sequence、TaskRun fence 和桌面 thread entry；不搬运 Core 原始消息，不增加新数据库。 | terminal 必须在 `turn_complete` 前持久；持久化失败触发既有 recovery；terminal 后的事件拒绝；旧 schema 可读，新写入严格校验。 | 服务端/桌面全套检查、`git diff --check`；真实 provider、工具、安装后重开与分页旅程尚未验证前不宣称完成。 |

## 不采用的做法

- 不继续把 Core transcript 当新任务线程来源；它是可替换的私有执行细节。
- 不把原始工具名、输入、输出、命令、本机路径或模型 envelope 写进产品事件。
- 不新建一套与 `task_events` 并行的 Item 数据库；稳定 item id 和状态更新都落在现有权威文件。
- 不用一次全量 thread 请求冒充分页历史；cursor 先覆盖增量恢复，历史分页边界继续在后续 Harness 单元补齐。
- 不把这一单元完成称为聊天 Harness 完成；steer/follow-up、compact 快照、审批历史和真实 provider 旅程仍需继续验收。

## 本次验收边界

本次只证明 assistant、产品安全 activity 和 TaskRun terminal 有唯一持久真相，且桌面重开/cursor 不再依赖新任务的 Core transcript。它不证明 steer/follow-up、compact、完整权限事件或整个重构已经完成。
