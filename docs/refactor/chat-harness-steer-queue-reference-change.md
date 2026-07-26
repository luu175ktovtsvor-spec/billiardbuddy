# 聊天 Harness steer/follow-up 队列：参考—改动表

本文只服务于 `BilliardBuddy-重构合同.md` 第一轮聊天 Harness 的 steer/follow-up 单元，不是第二份产品合同。产品结果、边界与完成标准仍只由重构合同裁决。

## 施工结论

当前提交路径在已有运行时立即创建另一个 `TaskRun`，再由 FIFO 等前一运行终态后启动。它能保住输入和顺序，但把“尚未决定注入当前 Turn 还是下一 Turn”的队列意图提前写成了未来 Turn；正在运行的 worker 也没有 steer 入口，`createServerPrivateNativeCorePort.input()` 在模型循环存在时直接忽略第二次输入。因此当前实现只有 follow-up 的近似结果，没有合同要求的受控 steer/follow-up 队列。

本次只保留一份产品队列：运行中输入先成为 Product Server 的持久队列项，不提前创建第二个 TaskRun。纯文本队列项可由当前 worker 在模型—工具循环的安全停点按 FIFO 注入；Product Server 收到持久消费回执后，才把它写成当前 Turn 的用户 Item。未被当前 Turn 消费的队列项在当前 Turn 持久终态后提升为下一 TaskRun；带附件的队列项固定走下一 Turn，避免在模型请求或工具结果之间并发改变附件快照。

## 参考—改动

| 参考文件 / commit | 直接证据 | 要解决的用户问题 | BilliardBuddy 当前生产路径 | 唯一状态源 | 最小改动 | 失败 / 恢复行为 | 验证 |
|---|---|---|---|---|---|---|---|
| OpenAI Codex commit `62fd410384cca008446c2d64a4f2b3f915f4906e`：`codex-rs/core/src/session/turn.rs`、`codex-rs/app-server/README.md`；Apache-2.0 | App Server 区分 Thread、Turn 与 Item；同一 Turn 的输入与工具结果按事件顺序进入运行，客户端以 Turn/Item 通知恢复。 | 用户在 Agent 工作时补充约束，不能开启第二条并发模型循环，也不能刷新后丢失。 | `submitTaskRun()` 总是创建新 run；`AgentWorkerSupervisor` 只有初始 input、approval、stop。 | Product Server 的持久输入队列与 `task_events`；worker 内存队列只是在途投递缓存。 | 新增有界队列项和消费状态；Supervisor 只把队首纯文本送入当前 generation；消费回执落盘后才投影用户 Item。 | 终态 fence 拒绝晚到消费；未消费项保留 queued，终态后提升为下一 Turn；重启不猜测已注入。 | 队列 FIFO、幂等提交、晚到回执、终态竞态、重启提升和 cursor 测试。 |
| Pi commit `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`：`packages/agent/src/agent-loop.ts`；MIT | Agent loop 在 assistant 与 tool result 之间有顺序明确的下一次模型输入边界；事件 sink 与 loop 同序。 | steer 必须出现在合法模型输入边界，不能插进未配对的 tool call/tool result 中间。 | `query.ts` 已只在工具结果完成后读取 queued command，但使用进程全局队列；Product worker 可并行运行多个任务，不能共享该全局队列。 | 每个 Server-private Core port 自己的有界在途队列；持久真相仍在 Product Server。 | 给 Query loop 注入实例级 queue port；默认 REPL/CLI 仍使用既有全局队列，Product Core 不跨任务串消息。 | 当前模型直接给出终答、没有安全停点时不消费；队列项由下一 Turn 接手。 | 两个并行 Core 不串消息、tool result 前不注入、终答时不误确认消费。 |
| Claude Managed Agents 公开 Session/Tools 合同（2026-07-26 核对）：`/docs/en/managed-agents/sessions`、`/tools`；核心执行器未公开 | Session 保存连续历史；宿主按结构化 tool request/result 驱动后续模型调用。公开材料没有证明可在任意 token 流中注入用户输入。 | 产品不能把“消息已收到”误报成“模型已在本 Turn 消费”。 | worker `input()` 当前没有接收/消费回执，调用成功与模型消费没有区分。 | 队列状态由 Host 持久化；worker 只回传 opaque queue item id 和 `consumed`。 | 把“已投递”和“已在安全停点消费”分开；只有 consumed 才改变公开 Item/Turn 投影。 | child/Host IPC 断开时保持 queued；未知结果不自动创建第二次 steer。 | 故障注入覆盖 IPC 断开、重复回执和 worker 退出。 |
| 本地 Codex 前端参考 `codex-frontend-reference/26.721.41059`：raw 与 reverse-readable `queued-message-list-CJCiiVt0.js`（SHA-256 均为 `3c5613ea73a6a3874dd54663aa176c0a03c55dc787843533984470058faa4d7a`），`local-conversation-thread-Bj5uKwgs.js`；host bridge `build/main-DXmJ7M03.js` | 队列是独立可见列表；单项可显式 `Steer`，说明文案为不中断当前模型；失败项暂停并可恢复。host bridge 用 conversation/message/lock 三元组保护一次发送。 | 用户需要看见输入仍在排队、已经 steer，还是因失败等待处理，而不是仅看 Composer 清空。 | 桌面只把运行中提交文案改成“加入队列”，没有权威队列列表；提交结果仍是未来 TaskRun。 | renderer 只消费 Product Server 队列投影；不自己保存或猜测队列状态。 | 本轮保留 Codex 的“可见状态、显式 steer、失败不丢”行为；不复制拖拽、侧聊、编辑/删除等非合同硬要求。 | 中断后未消费项仍可恢复；失败项不越过队首；重复点击由 `client_operation_id` 与队列 item id 去重。 | ProductTaskPage 队列状态、显式 steer、重连与失败测试；真实长工具 Turn 后续验收。 |
| BilliardBuddy 当前生产链（2026-07-26）：`taskService.ts#submitTaskRun`、`agentWorkerSupervisor.ts`、`agentWorkerService.ts`、`framedProtocol.ts`、`ipcLauncher.ts`、`cli/print.ts#createServerPrivateNativeCorePort`、`query.ts`、桌面 `ProductTaskPage` | 当前代码直接证明：每次提交新建 run；Supervisor 仅初始 input；Core 活跃时丢弃第二次 input；Query 的全局 queued command 只能在 tool result 后注入；UI 没有持久队列投影。 | 需要把现有 FIFO 的可靠部分留下，同时删除“未来 run 充当队列”的重复概念。 | 上述完整生产路径与 authority validator、worker 协议、桌面 API/store。 | `turn_input_queue`（名称可按实现收紧）是唯一排队事实；TaskRun 只在 Turn 真正建立时存在。 | 复用现有 authority transaction、generation fence、TaskEvent cursor 和 Query 安全停点；不复制另一个 Agent loop。 | 队列上限继续为 8；附件、无安全停点、approval 等待和终态竞态均不得并发注入；未消费项可在重启后提升。 | server/desktop 定向测试、完整 `check:server`、`check:desktop`、`git diff --check`；真实 DeepSeek 工具旅程另列。 |

## 明确不采用

- 不把未来 `TaskRun` 继续当队列节点；TaskRun 只表示已经建立的 Turn。
- 不把 Product worker 接回进程全局 command queue；并行任务必须实例隔离。
- 不在模型 token 流、未完成 tool call 与 tool result 之间注入用户文本。
- 不因 Codex 参考里存在编辑、删除、拖拽或侧聊就把它们扩成合同硬要求。
- 不用 worker “收到 IPC”冒充模型已消费；消费状态必须由安全停点产生并先持久化。

## 本次验收边界

本单元只证明运行中输入的持久排队、当前 Turn 安全 steer、下一 Turn 提升、失败与重连。它不证明 compact、完整审批 Item/Event、右侧成果预览或整个 Harness 已完成。

## 施工后证据

- Product Authority revision 5 持久化 `turn_input_queue`，以不可变 `queue_sequence` 裁决 FIFO；相同毫秒内连续提交不会按随机 UUID 重排。
- 第二次输入不再提前创建 TaskRun。队首纯文本只有收到 worker 的 `steer_consumed` 后才在同一 run 中追加 durable user Item；带附件输入固定晋升到下一 Turn。
- completed 终态自动晋升一个队首；stopped 终态保持队列暂停，用户通过带 CAS 和幂等 operation id 的“继续队列”恢复；后来的新提交不能越过暂停队首。
- renderer 从 `/api/product/tasks/:id/queue` 恢复队列快照，严格拒绝额外私有字段；queued 回执不再伪造已经进入对话的用户消息。
- 服务端定向验证：56 个 authority/worker 队列测试通过；扩展后的相关服务端组合验证 108 个通过。桌面 Vitest 定向验证 68 个通过；桌面 TypeScript lint 通过。现有 ProductTaskPage 测试仍输出既有 React `act(...)` 警告，但不影响通过结果。
- 根目录裸 `tsc -p tsconfig.json` 不是仓库认可的门禁，并会把 reverse/reference 源、双份 Vite/React 类型和缺失的构建期宏一起编译，当前产生大量既有错误；本单元以 `check:server`、`check:desktop` 作为后续完整门禁。
