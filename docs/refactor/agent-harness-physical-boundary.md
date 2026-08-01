# Agent Harness 物理边界收口记录

## 对应范围

本记录对应 R2 的 A0.4。此前 A0.1 已确认生产调用链，A0.2 已划分状态权威，A0.3 已规定目标依赖；本步骤把这些规则落实为正式源码边界。

## 已收口的边界

| 边界 | 当前实现 | 证据 |
| --- | --- | --- |
| Agent Core | Harness、执行循环和端口合同只依赖共享协议及 `agent-worker/` 内的端口 | `productAgentHarness.ts`、`productAgentLoop.ts`、`agentHarnessPorts.ts`、`agentModelPort.ts` 不导入 `product/` 实现 |
| 产品投影 | 审批、提问、活动和失败分类由产品适配器实现，通过 Harness 投影端口注入 | `product/agentHarnessProjectionPort.ts` 与 Worker 入口 |
| 模型策略 | 模型解析和压缩阈值由产品策略端口提供，循环必须接收已选定模型和模型/工具执行器 | `product/agentHarnessModelPolicyPort.ts`、`agentModelPort.ts` |
| 任务服务 | `ProductTaskService` 只依赖任务运行派发、私有工件清理和运行时事件发布端口 | `taskRunDispatchPort.ts`、`taskPrivateArtifactPort.ts`、`taskRuntimeEventPort.ts` |
| Worker 组成 | Scheduler、Supervisor、IPC Launcher、Core Factory 和 Worker 事件 Sink 在一个服务器 Composition Root 装配 | `agent-worker/taskRunComposition.ts` |
| 桌面投影 | 桌面只使用产品 HTTP/WebSocket 协议与本地运行时状态，不导入服务器实现 | `desktop/src/product/` 与 `desktop/electron/` 的静态依赖审计 |

## 组装与关闭

`startServer` 创建一份 `ProductTaskRunComposition`，将其派发端口注入 `ProductTaskService`。Composition Root 第一次派发时创建单一 `AgentWorkerSupervisor`，并在 `stopServerRuntimeForShutdown` 中由同一对象关闭。

`index.ts` 中为浏览器桥接创建的 `desktopResourceScheduler` 是独立的浏览器资源服务，不属于 `TaskRun` Worker 组成；它不向 Agent Harness 暴露 Worker 进程、任务权威或模型端口。

## 静态审计结论

- Core 文件未发现对 `product/` 实现的导入。
- `ProductTaskService` 未发现对 Harness Session Repository、全局 Worker 运行时事件单例或派发桥接的直接引用。
- TaskRun 的 `ProductResourceScheduler`、`IpcAgentWorkerLauncher` 和 `serverPrivateNativeCoreFactory` 只在 `taskRunComposition.ts` 同时组装。
- 桌面生产源码未发现服务器实现路径导入。

本步骤只封闭依赖与组装边界，不重写 Thread、Turn、Item、Event 的领域模型；这些工作从 A1 开始。
