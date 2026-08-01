# Agent Harness 状态权威图

## 目的与范围

本记录对应 R2 的 A0.2。它为当前 Agent Harness 生产链中的状态指定唯一写入权威、恢复来源和对外可见投影，避免把同一状态同时交给 API、Worker、桌面和内存缓存维护。

这里的“唯一”指某类事实的最终写入入口，不要求所有状态落入同一文件。不同生命周期、故障模型和保密边界的状态必须保留不同的权威。

## 状态与权威

| 状态类别 | 唯一写入权威 | 持久化与恢复来源 | 对外可见投影 | 禁止作为权威的层 |
| --- | --- | --- | --- | --- |
| `ProductTask`、线程条目、`TaskRun`、`dispatch_records`、用户可见 `task_events`、输入队列与上下文快照 | `ProductTaskService` 经 `ProductTaskAuthorityRepository` 的事务接口 | Authority 文件、跨进程锁、原子替换与版本校验；服务启动后从该文件恢复 | 产品 API、任务 WebSocket 回放、任务线程读取接口 | 桌面 Zustand 状态、Worker 内存、运行时事件缓存 |
| 提交操作的幂等回执、权威版本和事件序号 | 同一 `ProductTaskAuthorityRepository` 事务 | Authority 文件中的 `receipts`、`events`、`revision`、`event_sequence` | API 提交回执及按序事件流 | HTTP 重试计数、桌面临时请求状态 |
| Harness 私有消息、上下文前缀、指令摘要、当前 Turn 状态和完成结果 | `ProductHarnessSessionRepository` | 每个绑定的会话文件、独立锁和原子替换；按 `binding_id` 与 `lineage_id` 重载 | 仅经 Harness 生成的安全事件或后续模型上下文；不直接暴露原始会话文件 | `task_events`、桌面线程文本、Worker IPC 缓冲 |
| 资源队列、调度声明、租约、围栏令牌与资源占用 | `ProductResourceScheduler` | 调度器元数据日志、OS 锁、原子写入；启动与每次变更均清理过期租约 | `AgentWorkerSupervisor` 的准入结果；必要时映射为任务状态 | `TaskRun` 本体、子进程进程号、桌面运行状态 |
| 单次 Worker 子进程、IPC 握手、心跳定时器、正在发送的事件和本进程活动映射 | `AgentWorkerSupervisor` | 不作为可直接恢复的业务真相；进程退出后以 Authority 中的派发记录和 Scheduler 租约为准重新协调 | 受验证的 IPC；经 Worker 消息汇写入后才可形成用户事件 | Harness 会话文件、桌面 Socket、任何跨进程内存副本 |
| 运行时活动摘要、待处理审批和瞬态工作状态 | `productTaskWorkerRuntimeEvents` | 仅内存；服务重启后丢弃，并由 Authority 事件回放或线程读取重建用户视图 | 当前连接的任务 WebSocket 与短时运行快照 | 任务长期历史、审批或终止的最终事实 |
| WebSocket 恢复游标、连接生命周期和订阅者集合 | `ProductTaskSocketManager` | 仅当前桌面进程内存；断线后以服务端 `event_sequence` 继续 | `productTaskRuntimeStore` | 服务端事件日志、任务运行事实 |
| 桌面线程条目合并、活动显示、局部错误和控件状态 | `productTaskRuntimeStore` | 仅当前渲染进程内存；重新加载时由线程/队列 API 与 WebSocket 回填 | `ProductTaskPage` 及子组件 | 用户可见任务历史、派发状态、审批决策 |
| 模型访问令牌、权限信封和工作目录限制 | 本机安装会话存储与 `ProductAgentHostRuntime` 的受策略执行边界 | 安装会话由加密凭据存储恢复；每次 Worker 启动重新派生权限信封 | 仅成功或失败的安全投影，绝不将密钥或信封原文送至桌面 | Harness 会话、Authority 事件、Worker 子进程环境继承 |

## 写入规则

- API 层只能请求 `ProductTaskService` 的权威事务，不能绕过它写任务文件或直接向 WebSocket 广播任务结果。
- Worker 只能通过 `AgentWorkerSafeMessageSink` 交付用户可见事件。Sink 成功写入 `ProductTaskService` 的投影后，才允许发布运行时事件。
- 调度器租约只证明某次执行尝试的资源所有权；它不能替代 `dispatch_records` 的派发代际和最终终止状态。
- Harness 文件只保存模型执行所需的私有恢复材料。其内容必须通过事件投影规则降维后才可进入产品任务历史。
- 桌面收到的 HTTP 响应和 WebSocket 消息都是投影。重连、刷新或进程重启时必须向服务端请求权威快照，不能把本地内存反写为任务事实。

## 恢复顺序

1. Local Product Server 先加载并校验 Authority 文件，恢复待派发、需要恢复和已终止的 `TaskRun` 事实。
2. Scheduler 读取自身日志，清理或围栏失效的资源租约；`AgentWorkerSupervisor` 再按 Authority 派发代际协调可恢复的运行。
3. Worker 仅在新的合法派发声明、资源租约和一次性启动能力齐全时重建 Host 与 Harness。
4. Harness 按绑定加载私有会话；不能加载时将该次运行转为可恢复或失败投影，而不是用桌面缓存补造上下文。
5. 桌面重新读取任务线程和队列，并以服务端事件序号恢复 WebSocket；本地运行时投影只作为等待回填期间的显示状态。

## 后续约束

A0.3 必须据此明确目标依赖：Authority、Harness 会话、Scheduler、Worker Supervisor 和桌面投影之间只能通过各自的公开端口交互。任何新的跨层直接文件读写、共享可变对象或将私有会话写入用户事件的实现，都不属于 R2 的目标边界。
