# Agent Harness 正式调用链

## 目的与范围

本记录对应 R2 的 A0.1，只确认当前正式代码从用户输入到事件回放的生产调用链。它不迁移代码、不定义新的状态归属，也不替代后续 A0.2 的状态权威划分。

范围仅覆盖交互式 `ProductTask` 的主链：`ProductTask -> TaskRun -> Worker -> Harness -> Model/Tool -> Event`。定时任务复用同一 `TaskRun` 派发和 Worker 链路，但不在此处展开其调度入口。

## 生产调用链

| 阶段 | 正式入口或转换 | 输出 | 下游消费者 |
| --- | --- | --- | --- |
| 桌面输入 | `ProductTaskPage` 通过 `productTaskRuntimeStore` 调用 `taskCommands` | HTTP 创建任务或提交任务运行请求 | Local Product Server 的 `handleProductApi` |
| API 接收 | `handleProductApi` 校验请求后调用 `ProductTaskService.createAndSubmitTask` 或 `submitTaskRun` | 经过身份、任务和操作标识校验的提交参数 | `ProductTaskService` |
| 持久化接收 | `ProductTaskService.submitTaskRun` 调用 `ProductTaskAuthorityRepository.transactSubmit` | 同一事务中的 `task_runs`、`dispatch_records`、用户线程条目、初始 `task_events` 与提交回执 | API 回执；提交后的 `dispatchAcceptedRun` |
| 恢复重派 | `recoverTaskRun` 递增 `dispatch_generation` 后调用 `dispatchAcceptedRun` | 新一代待派发记录 | 与首次提交相同的派发链 |
| Worker 派发 | `dispatchAcceptedRun` 经 `taskRunDispatchBridge.dispatcherFor` 进入 `AgentWorkerSupervisor.dispatch` | 经资源调度和派发声明后的受策略约束信封、一次性启动能力 | `IpcAgentWorkerLauncher` |
| 子进程与 Host | `IpcAgentWorkerLauncher` 创建 IPC Worker；`AgentWorkerService` 验证信封与启动能力；`serverPrivateNativeCoreFactory` 建立 `ProductAgentHostRuntime` | 绑定 `TaskRun` 的 Host、权限信封、工作目录和 Worker 消息通道 | `createProductAgentHarness` |
| Harness 与执行循环 | `createProductAgentHarness` 持有本次会话执行，调用 `runProductAgentLoop` | 开始、文本增量、活动、审批、提问、上下文压缩和终止事件 | Worker IPC 消息通道 |
| 模型与工具端口 | `ProductAgentHostRuntime.model` 调用 `runProductModel`；`tools` 调用 `runProductTools`，两者都在产品权限信封和工作目录覆盖内执行 | 模型事件、工具执行更新、审批或提问请求 | `runProductAgentLoop`，再回到 Harness |
| 事件落库与发布 | Worker 事件经 `AgentWorkerSupervisor` 进入 `ProductTaskWorkerMessageSink.record`；桥接层调用 `ProductTaskService.recordTaskRun*` 写入投影并发布运行时事件 | 可回放任务事件、运行状态与终止投影 | Local Product Server 的任务事件发布器 |
| 桌面回放 | `taskSocket` 接收并解析任务 WebSocket 事件，维护恢复游标；`productTaskRuntimeStore` 应用事件 | 可渲染的任务、运行和线程视图状态 | `ProductTaskPage` 及其子视图 |

## 当前边界

- 用户可见任务真相先由 `ProductTaskAuthorityRepository` 的提交事务接收；桌面状态不是任务或任务运行的写入权威。
- Worker 不能绕过 `ProductTaskWorkerMessageSink` 直接驱动桌面。用户可见的进度、文本、审批、提问和终止都必须先进入服务器侧的事件记录和运行时发布路径。
- `dispatch_generation`、调度声明、Worker 信封和一次性启动能力共同界定一次派发尝试；恢复不复用旧的派发身份。
- `ProductAgentHarness` 的会话细节、Host 进程状态和调度声明均有各自的持久化或进程内写入点。本记录只枚举调用链，不把它们与 `ProductTask` 的用户可见权威混为一处。
- 个人模型、托管模型、额度账本、媒体工作台和桌面 Shell 不属于本步骤的改动范围。

## A0.2 的输入

下一步必须为下列状态分别指定写入权威、恢复来源和可见投影，不能因本调用链相连而合并它们：

- `ProductTask`、`TaskRun`、`dispatch_records` 和用户可见 `task_events`；
- Harness 私有会话、消息上下文和工具执行状态；
- 调度器声明、Worker 生命周期和进程内事件缓冲；
- 模型访问凭据与权限信封；
- 桌面运行时投影、WebSocket 恢复游标和页面局部状态。
