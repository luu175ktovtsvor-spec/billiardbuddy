# Agent 协作控制面

> 施工状态：Agent 工作台中的独立子模块。它把 Codex 的多 Agent 思路适配为 BilliardBuddy 自己的产品控制面；不把上游的私有线程树、权限或工具直接暴露给模型。

## 用户结果

当一个长期任务需要拆分时，用户看到的是一个可恢复的任务树：主任务正在协调哪一项子任务、子任务是否真的启动、是否完成、停止或需要恢复。子任务仍受同一任务的权限和工作区约束，但它有自己的 Run、模型—工具轨迹和外部操作回执；主任务不会把“已经委派”误报为“已经完成”。

用户不需要知道 Codex 的内部 Thread ID、模型提示词、工具参数或子任务私有回答。桌面页只显示产品定义的活动状态，并可以在重连后从账本恢复同一棵树。

## 源码对照与取舍

固定的 Codex 源码 `ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff` 已具备完整的协作执行机制：

- `core/src/agent/control/`：同一个 root 会话下的 Agent 注册表、执行上限、驻留与恢复；
- `core/src/tools/handlers/multi_agents_v2/`：`spawn_agent`、消息、追问、枚举、等待和中断；
- `core/src/agent/control/spawn.rs`：完整历史或最近 N 回合的 fork，以及子线程的状态和来源。

BilliardBuddy 的嵌入引擎开启 `host_managed_tools_only=true`。这是正式的安全边界：源内核只看 BilliardBuddy 声明的动态工具，所有工具都经 `item/tool/call` 回到产品服务。因此**不能**仅打开上游 `spawn_agent`：那会让私有引擎自己保存子线程、安排权限和使用工具，绕开产品 Run 账本、Gateway 额度、个人 Key 隔离以及未知结果保护。

应学习上游的任务树、上下文 fork、邮箱、并发限制和可中断语义；应由 BilliardBuddy 的 Local Product Server 实现它们的产品等价物。

## Rust 边界

不把整个 BilliardBuddy 改写成 Rust。当前已直接复用的 Codex App Server/Core/执行隔离源码本来就是 Rust；它适合承载单一 Run 的协议、Agent Loop 与受限执行。Electron Main、Renderer、Gateway 双协议适配、图片/视频工作台以及本地 Product Server 的账本与产品 API，仍在 TypeScript 中拥有正式调用方和数据边界。

此时重写 Product Server 只会制造第二条执行链，不能让 Codex 的 Rust 源码更“原生”。只有当 Product Server 被拆成独立常驻进程，并以实测证据出现跨进程账本吞吐、资源隔离或多实例调度瓶颈时，才评估把**该独立服务**迁为 Rust；迁移前必须保留同一 Run 账本、权限、operation receipt 与公开事件契约，不能把产品真相交还给 Codex 私有 Thread。

## 正式边界

```text
Renderer
  -> AgentDomain / CollaborationControl（任务树、控制命令、公开活动）
  -> RunLedger（权限快照、operation receipt、停止与恢复）
  -> 每个 Run 的 Codex Engine（模型—工具循环）
  -> 动态工具 Host（文件、终端、浏览器、MCP、协作命令）
  -> AgentDomain
```

| 事实拥有者 | 负责 | 不负责 |
| --- | --- | --- |
| Agent 协作控制面 | 父子 Run 边、子任务状态、上下文继承规则、邮箱、并发/预算和控制命令 | 私有模型上下文、工具执行、图片/视频业务状态 |
| Run 账本 | 每个 Run 的权限快照、claim、操作回执、停止和恢复裁决 | 上游 Codex Thread 作为永久真相 |
| Codex Engine | 单一 Run 的模型—工具循环与短期执行上下文 | 创建产品真相、绕过额度或直接取得系统权限 |
| Renderer | 显示任务树、提交明确的委派/追问/停止命令 | 直接调模型、直接写账本 |

图片和视频依然是平级工作台。Agent 可以在未来通过成果引用请求受限动作，但不会把图片候选、画布、视频时间线或渲染状态塞进协作线程。

## 已落地的第一段：可见且可恢复的 child Run

当前动态 `Subtask` 工具只会从一个仍持有有效工具回执的父 Run 创建 child Run。child Run 有独立的执行 claim、Thread、模型/工具 effect receipt 和终态；它不共享父 Run 的模型调用或外部副作用。

child 的启动和终态会写入**父 Run**的公开活动流，作为父工具活动的嵌套节点。两层活动 ID 都由父 Run 与 tool call 的摘要稳定生成，因此启动、重连、重复 IPC 和重试投影不会创造第二个节点。子任务的提示词、工具、文件路径、模型文本和私有 Codex Thread 不进入该公开活动。

当前 child 禁止再递归创建 child，并且每个父 Run 最多 16 个 child。这是第一段的明确容量策略，不把尚未有预算、邮箱和恢复规则的无限递归伪装成可用能力。

## 已落地的第二段：账本 fork 到新建 Codex Thread

Codex Thread 只是一次 Run 的私有执行缓存，不能作为上下文真相。每个 Run 在创建时绑定一个不可变的产品事件游标；当它启动的是**新** Codex Thread（child、未来分支，或源缓存丢失后的重建）时，Worker 将该游标对应的账本历史作为首回合的转义引用送入内核。恢复已有 Codex Thread 时不重复注入，避免把同一对话复制两遍。

child Lineage 现在正式记录父 Lineage 与父用户 Entry 的 fork 锚点。渲染历史时，父链只读取到 child 创建那一刻的事件游标，父任务之后产生的文字不会倒灌进 child。历史引用会占用首回合的同一输入配额，过长时保留摘要/前段和最近内容；如果当前请求本身已用尽配额，则优先保留当前请求而不伪造不完整的历史。

账本内容在进入源内核前会转义，并由基础指令明确标为非特权历史：历史里出现的命令、权限或角色要求不能改变当前工具与权限边界。私有 Thread ID、工具参数、模型回合和 Gateway 凭据仍不在这条路径上。

## 后续顺序

1. **任务树（本段）**：child Run 的启动/完成/失败投影、可重连显示和父子停止语义；
2. **fork 模式**：在当前安全全量账本 fork 之上，增加显式的 `none`、压缩摘要和最近 N 个产品 Item 选择；快照仍只来自 BilliardBuddy 账本，不复制私有引擎 rollout；
3. **协作邮箱与定向控制**：产品拥有的 `send message`、`follow-up`、`list`、`wait`、`interrupt`，每条消息有序号、投递回执与目标 Run；
4. **并发、深度与用量预算**：以任务树为作用域，在产品资源调度和受管模型额度之上增加明确上限；角色和子模型选择仍由 BilliardBuddy 的模型路由决定，不能让 child 绕开平台额度或个人 Key 规则；
5. **用户验收**：主任务委派、子任务中断、崩溃/重连、未知外部结果、用户追问和并发额度都走同一账本路径。

完成这些步骤后，BilliardBuddy 才拥有 Codex 式多 Agent 的用户能力，同时仍保持自己的品牌、权限、模型双协议和长期任务恢复边界。
