# 聊天 Harness 运行失败语义：参考—改动表

本文只记录聊天 TaskRun 从底层故障到持久终态、重连投影和恢复提示的产品语义。它不是第二份产品合同。

## 施工结论

当前 `ProductAgentHarness` 捕获所有异常后只发出 `recovery_required`；`ProductTaskWorkerMessageSink` 再把它投影成同一个 `task_failed`。用户无法区分模型未配置、认证失败、限流/容量、网络、上下文、模型无效响应、项目自动化、附件处理、本机执行环境和未知内部故障。更严重的是，实时错误和重连后的 durable `run_terminal` 不是同一份失败语义：刷新后只剩“任务暂未完成”。

本次不透传 Error message，也不复制 Codex 的 Responses 续流实现。Worker 只把受控枚举和 `retryable` 送过私有 IPC；Product Server 在同一个 dispatch record 中持久化失败代码，并在 durable terminal replay 时重新投影；renderer 只显示本地产品文案。`retryable` 只说明故障条件是否可能在不改任务内容时消失，不代表可以无风险自动重放；任何 `recovery_required` 仍必须提示外部副作用可能重复并由用户确认恢复。

## 参考—改动

| 参考文件 / commit | 直接证据或推理等级 | 要解决的用户问题 | BilliardBuddy 当前生产路径 | 唯一状态源 | 最小改动 | 失败 / 恢复行为 | 测试与真实旅程 |
|---|---|---|---|---|---|---|---|
| OpenAI Codex commit `61a44880a85d2fd0d8770908dea5733495e571c8`：`codex-rs/protocol/src/error.rs`、`codex-rs/core/src/responses_retry.rs`、`codex-rs/app-server/README.md`；Apache-2.0 | 直接证据：协议把 context window、usage limit、HTTP/stream、unauthorized、sandbox、bad request、internal 等故障映射为稳定类别，并单独携带 retryable；重连进度通过事件反馈。 | 用户要知道应该检查配置、重新认证、稍后重试、缩短上下文还是检查本机环境。 | `productModelRuntime` 产生稳定内部错误；Harness catch 丢弃它；terminal IPC、dispatch、durable event 和 renderer 都只保留泛化失败。 | ProductTask dispatch record 与 durable `run_terminal` 是公开运行终态；Worker 原始 Error 只用于当前进程内分类，不进入产品状态。 | 增加一个穷举的产品失败枚举、一个 fail-closed 分类器、terminal 可选 failure、dispatch 持久字段的受控值和 renderer 本地标签。 | 可瞬时恢复的容量、网络、无效模型响应标 retryable；配置、认证、上下文、项目自动化、附件、执行环境和未知故障要求先处理原因。所有 recovery 重放仍由用户确认。 | 分类矩阵、IPC/消息 sink、durable replay、严格前端协议、store 重连和页面恢复文案测试。真实断网/401/429 旅程在整体软件验收执行。 |
| Codex 同 commit 的 `responses_retry.rs` | 直接证据：只有支持可靠重连的响应流才进行 backoff/恢复，并向 UI 发送重连状态。 | 不能为了“可重试”而整轮自动重放，导致已经执行的工具再次产生副作用。 | BilliardBuddy 使用 Gateway 后的 OpenAI Chat SSE，没有持久 response id 或安全的中途续流游标。 | 已持久的 ProductTask/Tool side effect 与 operation identity 是边界，模型流不是可任意重放的真相。 | 只传递 `retryable` 建议，不自动 retry 当前 Turn，不改变现有 Gateway 请求策略。 | 用户恢复前看见重复外部操作风险；可证明幂等的独立远程 operation 仍由各自领域恢复。 | 测试明确要求 retryable terminal 仍进入 `recoveryRequired`，避免前端把它当成自动安全重试。 |
| Pi commit `cee5ff7520d8828bed9955ef00419e995d1f91e0`：`packages/agent/src/agent-loop.ts`；MIT | 直接证据：Assistant error/aborted 明确终止 loop；tool result 与 assistant message 保持结构化配对。Pi 不定义本项目的 durable ProductTask 投影。 | 模型层错误不能被误报成成功，也不能遗失已经形成的结构化轨迹。 | 当前 Harness 私有 session 已持久化模型/工具轨迹，但 catch 后只给 Host 一个无原因终态。 | 私有 Harness session 保留轨迹，ProductTask 只保留安全分类和公开结果。 | 不把原始 Assistant/Error 内容复制到 ProductTask，只增加安全 terminal failure。 | 失败前已经落盘的公开 assistant text 保留；未确认副作用不会被自动重放。 | Harness 测试检查原始 Error 文本不出现在 terminal、task event 或前端协议中。 |
| 本地 Codex 前端参考 `codex-frontend-reference/26.721.41059`：`README.md`，raw/reverse-readable `queued-message-list-CJCiiVt0.js`、conversation/thread 与 error 相关 chunks，host bridge `build/main-DXmJ7M03.js` | 直接证据与交叉推理：失败状态留在所属 thread/run 工作面，队列失败不会静默越过，并提供恢复动作；host bridge 传标识和动作，不把前端变成权威状态源。 | 原因、当前终态和恢复动作应同时可见，刷新后不能变回另一句话。 | `ProductTaskPage` 已有 recovery 卡片和恢复 API，但 recovery 卡片遮住了具体 error label。 | renderer store 只消费 websocket live/replay 投影；中文说明来自枚举映射，不持久化第二份错误。 | 在现有卡片中显示具体原因，再显示重复副作用警告和恢复按钮；不新建错误中心或第二条队列。 | retryable 与否不改变已失败 Turn 的终态；刷新后恢复同一 code。未知字段继续被严格协议解析器拒绝。 | parser/store/page 现有测试文件增加分类、重放和文案断言；不以静态页面存在证明后端闭环。 |
| BilliardBuddy 当前生产链（2026-07-26）：`productAgentHarness.ts` → `agentWorker.ts`/IPC → `agentWorkerSupervisor.ts` → `taskRunDispatchBridge.ts`/`taskService.ts` → `taskWebSocket.ts` → desktop protocol/store/page | 直接证据：Harness 两处 catch 都抹掉原因；terminal 无 failure；dispatch 只存 `CORE_RECOVERY_REQUIRED`；live error 固定 `task_failed`；durable replay 不带失败；recovery 卡片只显示泛化风险。 | 一次失败在运行中、刷新后和恢复前必须保持同一可行动解释。 | dispatch record 是失败代码持久真相；durable `run_terminal` 继续只保存状态，读取时从同 run dispatch 受控投影 failure，避免复制两份持久字段。 | 修改现有共享合同和既有链路；不升级 authority schema，不向 renderer 暴露原始错误、HTTP body、URL、路径、工具参数或凭据。 | Worker/fatal 各自映射到同一安全分类；未知值落到 `task_failed`；停止仍是 stopped，不产生失败。 | 完整服务端与桌面门禁、故障注入、重连 replay；401/429/断网真实上游和安装包旅程仍在软件层整体复审后执行，打包最后。 |

## 产品失败分类

| 产品代码 | 说明 | `retryable` |
|---|---|---|
| `task_model_configuration` | 模型或 Gateway 未正确配置 | false |
| `task_authentication` | 模型服务身份/授权无效 | false |
| `task_capacity_limited` | 限流、容量或暂时额度限制 | true |
| `task_network_unavailable` | 无法连接 Gateway 或流中断 | true |
| `task_context_limit` | 上下文或压缩无法落入模型窗口 | false |
| `task_model_response_invalid` | 模型返回空、破损或无法配对的结构 | true |
| `task_project_automation_failed` | 命令、Hook、扩展或项目规则无法完成 | false |
| `task_attachment_processing_failed` | 附件不能安全读取、探测或转换 | false |
| `task_execution_environment_failed` | 权限信封、沙箱或本机执行环境不可用 | false |
| `task_failed` | 无法安全归类的内部故障 | false |

## 明确不采用

- 不把 Error message、HTTP response body、URL、本机路径、命令、工具参数或 provider 名称发给 renderer。
- 不根据英文字符串的任意子串猜测分类；只接受当前生产链产生的稳定错误代码和明确 HTTP 状态。
- 不把 `retryable: true` 当成可以自动重放整个 Turn。
- 不在 durable terminal 和 dispatch record 各存一份可能漂移的失败代码；dispatch 是代码真相，terminal replay 是读取投影。
- 不把完成本项描述成聊天 Harness、图片工作台或视频工作台已经全部完成。
