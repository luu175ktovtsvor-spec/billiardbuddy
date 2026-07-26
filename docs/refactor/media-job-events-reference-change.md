# 媒体 Job 事件与 cursor 重连：参考—改动表

本文只服务于 `BilliardBuddy-重构合同.md` 第二、三轮工作台的一次落地，不是第二份产品合同。产品方向、边界和完成标准仍只由重构合同裁决。

## 施工结论

`MediaTask` 文件继续作为 `MediaJob` 的唯一持久状态；每次对用户可见的 Job 状态变化在保存 Task 后追加一条同项目的持久事件，并取得单调 cursor。图片与视频 renderer 通过同一 cursor 接口长连接读取事件，只接受更大的 cursor 与 `status_sequence`，再用项目查询校正事件丢失、服务重启和投影漂移。

当前 `ImageWorkbench.tsx`、`VideoStudio.tsx` 的定时 GET 单 Task 链及其 provider polling backoff 从 renderer 删除。远程图片上游状态读取仍由 Product Server 负责，但只在服务端恢复原 Operation，不把 provider 轮询语义泄漏给工作台 UI。

## 参考—改动

| 参考文件 / commit | 证据等级与直接证据 | 要解决的用户问题 | BilliardBuddy 当前代码路径 | 唯一状态源 | 最小改动 | 失败 / 恢复行为 | 测试与真实旅程 |
|---|---|---|---|---|---|---|---|
| InvokeAI commit `68b90174`：`invokeai/app/services/session_queue/session_queue_base.py`；Apache-2.0 | 直接证据。队列在服务端拥有 enqueue、状态、取消、重试和 cursor 分页；`list_queue_items` 明确以 cursor 返回持久队列项。 | 工作台重开后必须从服务端持久状态恢复，不能靠 renderer 记住上一次定时器或猜测任务仍在运行。 | `MediaProjectService` 已持久化 project/task JSON，但 API 只支持按 task id 单次 GET。 | `MediaTask` 是 Job 真相；事件只是同一真相的顺序投影。 | 为 Task 增加服务端生成的 `status_sequence`；保存可见状态变化后追加项目事件 journal，并提供 cursor 读取。 | Task 已写入但事件追加前崩溃时，重连项目查询校正；事件写入失败不能把未落盘 Task 冒充成功。旧 Task 首次迁移生成基线事件。 | 旧 Task 迁移、cursor 分页、保留窗口越界、单调序列、服务重建后补读。 |
| InvokeAI 同 commit：`invokeai/frontend/web/src/services/events/queueStatusEvents.ts`、`onQueueItemStatusChanged.tsx` | 直接证据。前端按 `status_sequence` 拒绝旧事件，先乐观更新具体 queue item，再 invalidation/refetch 处理丢失、乱序以及 processor 状态漂移；终态清理进度副作用。 | 用户不能看到已完成 Job 被迟到的 running 事件覆盖，也不能因漏掉一条事件永久卡在处理中。 | `mediaWorkbenchStore.ts` 目前以并发请求版本号压制旧 GET，但没有跨重启 cursor 或事件顺序。 | store 只保存服务端 Task/Project 的当前投影和每项目 cursor，不产生 Job 状态。 | 复用“单调事件 + 查询校正”的边界，不移植 InvokeAI 的 Redux、完整队列或模型执行器。 | 乱序/重复事件被忽略；cursor 超出保留窗口时先重读项目，再从服务端给出的当前 cursor 继续。断线只恢复订阅，不创建新 Operation。 | store 测试注入重复、乱序、终态和 reset；图片与视频组件测试证明无 `setTimeout` Task 轮询。 |
| 本地 Codex 前端参考 `codex-frontend-reference/26.721.41059`：`README.md`、raw/reverse-readable `local-conversation-thread-Bj5uKwgs.js` 与 `queued-message-list-CJCiiVt0.js`、host bridge `build/preload.js` / `main-DXmJ7M03.js` | 直接 bundle 证据与有限交叉推理。renderer 订阅宿主消息并返回明确 unsubscribe；preload 对 chunk `sequence` 连续性校验，乱序时丢弃 transfer；真实状态由宿主/App Server 提供。Source map 未提供，不推断未读算法。 | 切换项目或卸载工作台时必须停止旧订阅，不能让旧项目事件污染当前视图。 | 两个工作台组件各自创建 timer；桌面 API 没有共享订阅生命周期。 | Product Server 的项目、Task 与事件；组件只选择当前项目并注册/释放订阅。 | store 复用一个按 project id 引用计数的订阅，组件 effect 只负责 subscribe/unsubscribe；不引入 Codex bundle 运行时。 | 项目切换立即 abort 旧长请求；短暂网络错误只重连同一 cursor。应用重开从持久 cursor/event 和项目查询恢复。 | 组件卸载、项目切换、共享订阅、abort 与重连测试；桌面构建验证宿主边界。 |
| BilliardBuddy 当前生产链（2026-07-26）：`ts/shared/contracts/media.ts`、`MediaProjectService.saveTask/getTask`、`ts/src/server/api/media.ts`、`mediaWorkbenchStore.ts`、`ImageWorkbench.tsx`、`VideoStudio.tsx` | 直接当前代码事实。Task 已持久化状态、进度、阶段、Operation 身份和终态；图片/视频组件分别 `setTimeout` 后 GET Task，终态再整表刷新项目。 | 两个工作台使用重复轮询，重启不保存 cursor，快速状态切换可能漏读，前端还继承 provider 的 poll 间隔。 | 上述完整链路及对应服务/API/store/组件测试。 | 单一 Task 文件 + 同项目事件 journal；Project 仍是作品版本真相。 | 新增共享事件合同、journal、cursor API 与 store 订阅；删除 `refreshTask` 正式消费者和组件 timer。 | 服务重启不丢已落盘事件；journal 损坏 fail closed 并返回稳定媒体错误；删除/恢复项目时事件 journal 与项目一同进入/离开回收区。 | 服务纵向测试、API owner 隔离、桌面 store 乱序测试、图片/视频组件、完整 server/desktop/product-contract gates。 |

## 不采用的做法

- 不把 Task 状态复制进第二个可写数据库；事件只记录已经持久化的 Task 快照。
- 不使用 renderer WebSocket/SSE 临时消息作为完成真相；重连必须能由 cursor 补读。
- 不让 renderer 直接轮询 Relay/provider；远程恢复、幂等和 `outcome_unknown` 继续由 Product Server 管理。
- 不以事件到达代替项目校正；终态、跨阶段视频任务和保留窗口 reset 后仍重读权威 Project。

## 本次验收边界

本次完成只证明图片/视频工作台从 Task 定时轮询迁到可恢复的 Job/Event cursor 投影，不宣称画布、视频时间线状态机、独立预览线程或真实素材旅程已经全部完成。
