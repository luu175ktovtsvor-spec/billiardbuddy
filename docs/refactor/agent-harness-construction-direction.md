# Agent Harness 施工总纲

本文件只在路线图选择 R2 时定义其内部施工边界。它不决定全局顺序，不把历史提交当作完成证据，也不替代当前正式源码。

## 1. R2 的产品结果

Agent 是唯一拥有 Thread、Turn、Item/Event、私有 Harness session、模型-工具循环、权限、停止和恢复语义的业务域。桌面只消费公开协议；Gateway 和模型供应商只作为 Host 的适配对象；图片、视频和发布不进入此模块。

## 2. 权威与恢复

| 事实 | 写入权威 | 恢复来源 | 公开投影 |
| --- | --- | --- | --- |
| Task、Run、thread entry、dispatch generation、用户可见 event 与 operation receipt | `ProductTaskAuthorityRepository` 的事务 | Authority 文件与跨进程锁 | Product API、任务 WebSocket、桌面公开协议 |
| Harness 消息、上下文、指令摘要与当前 Turn | `ProductHarnessSessionRepository` | 按 lineage/binding 的私有会话文件 | 仅经安全事件投影 |
| 资源租约与 fencing | `ProductResourceScheduler` | 调度日志与过期租约清理 | Supervisor 准入结果 |
| Worker 进程、IPC、心跳与瞬时缓存 | `AgentWorkerSupervisor` | 不作为业务真相；由 Authority 的 dispatch record 重新协调 | 经 Worker sink 持久化后的事件 |
| Renderer 局部状态与 Socket cursor | Renderer/Socket 自身 | 从 Authority snapshot 和 event sequence 回填 | 页面显示，不得反写业务事实 |

## 3. 允许依赖

```text
Desktop -> Product API/WebSocket -> Task Authority/Application
        -> Dispatch Port -> Worker/Host -> Harness Core -> Model/Tool Port
Worker Event -> Product Projection -> Runtime publication -> WebSocket -> Desktop
```

- Harness 只能依赖共享协议和注入的模型、工具、权限、策略、投影端口，不能导入 ProductTask Authority、桌面、WebSocket 或 Gateway 凭据实现。
- Task Service 只编排 Authority、派发、私有工件清理和运行时投影端口，不构造 Harness、Host 或 IPC 子进程。
- Scheduler 只裁决租约与资源；Worker/Host 只执行受冻结信封约束的模型、工具与进程；两者都不能成为 Task 的业务权威。
- Worker 用户可见消息必须先写 Authority，再经运行时事件与 WebSocket 投影；Renderer 没有直接写入路径。

## 4. R2.1 已核验的生产链

### 4.4 Run 到公开投影

1. Desktop 通过公开 Product API 提交或继续 Run。
2. `ProductTaskService` 调用 `ProductTaskAuthorityRepository` 的事务，原子写入 TaskRun、dispatch record、线程输入、初始事件和幂等回执。
3. `TaskRunDispatchPort` 从服务器 Composition Root 取得 `AgentWorkerSupervisor`；Supervisor 以 generation、scheduler receipt 与权限信封启动隔离 Worker。
4. Worker entrypoint 只构造 `ProductAgentHarness`，将模型与普通工具经 IPC 请求给 Host；Host 是 `runProductModel` 与工具执行的唯一执行宿主。
5. Worker 的 started、delta、activity、approval、question、compaction 与 terminal 消息由 `ProductTaskWorkerMessageSink` 串行进入 Task Service，先写 Authority event ledger，再发布运行时事件。
6. Product WebSocket 按 event sequence 回放权威事件和 snapshot；桌面只解析公开协议并保存恢复 cursor。

## 5. R2 退出条件

- 每个 Run 提交、恢复、Worker ingress、Host model/tool 调用和桌面投影都有唯一所有者。
- 续写、停止、审批、提问、context compaction 与 terminal 都经同一 Authority/Worker 链，不存在桌面或 Worker 的旁路写入。
- 服务端类型检查、桌面生产构建、源码可达性审计和差异检查通过；真实模型、工具、副作用、设备与多窗口行为另由最终软件验收确认。

四份细粒度记录分别位于 `agent-harness-production-call-chain.md`、`agent-harness-state-ownership.md`、`agent-harness-target-dependencies.md` 与 `agent-harness-physical-boundary.md`，仅保存此次源码核验的证据。
