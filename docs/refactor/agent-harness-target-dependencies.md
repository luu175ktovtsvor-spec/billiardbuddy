# Agent Harness 目标依赖

## 目的与范围

本记录对应 R2 的 A0.3。它定义 Agent Harness 重构后的允许依赖方向，并列出当前必须在 A0.4 物理收口时消除的反向耦合。它不在本步骤移动任何代码。

目标不是把现有模块换名，而是让任务持久化、调度、Worker 宿主、Harness 执行和桌面投影各自只依赖其需要的端口。

## 允许的依赖方向

```text
桌面页面与运行时投影
        |
        v
产品 API / WebSocket 适配层
        |
        v
ProductTask Authority 与 TaskRun 编排
        |
        v
TaskRun Dispatch Port ----> Scheduler Port
        |                         |
        v                         v
Worker Launcher Port <---- Worker Host
        |                         |
        v                         v
Agent Harness Core ----> Model Port / Tool Port / Permission Port
        |
        v
Worker Event Port ----> Product Event Projection ----> WebSocket 投影
```

依赖规则如下：

| 层 | 可以依赖 | 不可依赖 |
| --- | --- | --- |
| 桌面页面、Zustand 运行时、Socket 管理器 | 公共任务协议、产品 HTTP/WebSocket 端口 | Authority 文件、调度器、Worker、Harness 私有会话、模型凭据 |
| 产品 API 与 WebSocket 适配层 | `ProductTaskService` 的公开命令/查询接口、公共协议 | Harness 内部消息数组、Worker 进程对象、Scheduler 日志 |
| ProductTask Authority 与 TaskRun 编排 | Authority Repository、TaskRun Dispatch Port、产品事件投影端口 | IPC 实现、原生模型调用、工具执行、桌面运行时单例 |
| Scheduler | 资源声明和持久化日志 | `ProductTask` 领域细节、Harness 会话、界面事件 |
| Worker Launcher 与 Worker Host | Worker 协议、策略绑定执行信封、Core Factory | Authority 文件路径、桌面状态、产品 API 请求对象 |
| Agent Harness Core | 通用消息/事件协议、注入的模型/工具/权限/会话端口 | `ProductTaskService`、Authority Repository、WebSocket、桌面模块、具体 Gateway 凭据 |
| 产品事件投影 | Worker Event Port、`ProductTaskService` 的安全记录接口 | Harness 私有消息文件、桌面 Store、Worker 子进程控制权 |

共享类型只放入不依赖服务器或桌面的协议层。它们描述输入、输出、版本和错误码，但不携带存储路径、环境变量、进程对象或 UI 实现。

## 当前必须消除的耦合

以下是源码中已确认的反向依赖，A0.4 的物理边界收口必须逐项处理：

| 当前位置 | 当前耦合 | 目标端口 |
| --- | --- | --- |
| `agent-worker/productAgentHarness.ts` | 直接导入产品任务审批、事件投影、入站策略、Gateway 运行时和失败分类 | Harness 输入/输出协议；由 Host 注入模型、工具、审批和事件投影能力 |
| `agent-worker/productAgentHostRuntime.ts` | 直接依赖产品事件投影、权限决策和 Gateway 默认模型 | Model Port、Tool Port、Permission Port 与 Worker Event Port |
| `product/taskService.ts` | 同时操作 Authority、Harness Session Repository 与运行时事件单例 | Authority 服务保留任务事实；私有 Harness 清理由专用会话生命周期端口处理；发布经事件投影端口 |
| `product/taskRunDispatchBridge.ts` | 在同一桥接中创建 Scheduler、Supervisor、IPC Launcher、原生 Core Factory 和事件 Sink | 显式 Composition Root；`TaskRunDispatchPort`、`WorkerLauncherPort` 和 `WorkerEventSink` 分别注入 |
| `product/taskWebSocket.ts` | 直接持有全局运行时事件单例并参与审批记忆 | WebSocket 只订阅事件流和请求产品命令；审批的最终事实回到 Authority |

## 强制边界

- `ProductTaskService` 可以提交、恢复、查询和记录安全投影，但不得构造 Harness、调用模型或拥有 Worker 子进程。
- Agent Harness Core 可以驱动 Turn 与 Tool 循环，但不得读取或修改产品 Authority，也不得知道桌面、WebSocket 或 Gateway 令牌如何取得。
- Worker Host 可以把 Host 资源注入 Core，但不得把进程内对象泄露给产品任务服务或渲染进程。
- Scheduler 只裁决资源与租约；TaskRun 的业务状态仍由 Authority 事务确认。
- 事件路径必须单向：Worker Event Port -> Product Event Projection -> 运行时发布 -> WebSocket -> 桌面投影。任何反向写入都必须转化为正式产品命令。

## A0.4 的完成定义

物理收口完成时，生产源码的模块依赖应能证明以下事实：

1. Agent Harness Core 不再从 `product/` 导入任务服务、Gateway 运行时、事件投影或桌面相关模块。
2. `ProductTaskService` 不再直接构造或清理 Harness 私有会话，也不直接发布进程内 Worker 事件。
3. IPC、Scheduler、Worker Launcher 与 Core Factory 只在一个明确的服务器 Composition Root 组装。
4. 桌面只经 API 与 WebSocket 协议获得投影，不能导入服务器实现或恢复私有执行状态。
