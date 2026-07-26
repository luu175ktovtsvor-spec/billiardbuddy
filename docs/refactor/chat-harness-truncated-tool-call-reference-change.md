# 聊天 Harness 截断工具调用：参考—改动表

本文只记录“模型输出达到 token 上限时不得执行可能被截断的工具调用”这一项改动证据。产品边界和最终验收仍由 `BilliardBuddy-重构合同.md` 裁决。

## 施工结论

当前 OpenAI Chat 流适配器只要收到了任意 tool call，就会把上游 `finish_reason: "length"` 覆盖成 `stop_reason: "tool_call"`。随后唯一的 BilliardBuddy 模型—工具循环会照常运行 PreToolUse、Host tool 和 PostToolUse。JSON 能成功解析并不证明参数完整：输出可能恰好在一个合法对象边界停止，也可能缺少模型原本准备继续补充的约束。此时执行文件写入、命令或远程工具会产生不可接受的错误副作用。

本次保留现有 ProductTask、agent-worker、Host tool 和权限链，只修正两处语义：适配器优先保留上游截断终态；loop 为该 Assistant Message 中的每个 tool call 生成配对、可持久化的错误 `tool_result`，不进入 Hook 或 Host 执行，再把结果交回下一次模型采样，使模型可以重发完整调用。

## 参考—改动

| 参考文件 / commit | 直接证据或推理等级 | 要解决的用户问题 | BilliardBuddy 当前生产路径 | 唯一状态源 | 最小改动 | 失败 / 恢复行为 | 测试与真实旅程 |
|---|---|---|---|---|---|---|---|
| Pi commit `cee5ff7520d8828bed9955ef00419e995d1f91e0`：`packages/agent/src/agent-loop.ts`；MIT | 直接证据：当 Assistant Message 的 `stopReason === "length"` 时，loop 不调用任何工具，而是为每个调用生成 error tool result，随后继续模型循环。 | 模型输出被截断时，即使参数看似是合法 JSON，也不能拿不完整意图去执行有副作用的工具。 | `productModelRuntime.ts` 聚合 SSE tool call 并覆盖 stop reason；`productAgentLoop.ts` 对所有 tool call 直接进入 Hook/Host 执行。 | Assistant Message 的 `stop_reason` 记录上游采样终态；私有 Harness message history 持有配对 tool result，ProductTask 只投影公开 Item/Event。 | 保留 `length`；在 loop 的工具执行分支最前面短路，生成同一 `tool_call_id` 的结构化错误结果。 | 不运行 PreToolUse、Host tool 或 PostToolUse；错误结果先持久化，再继续采样。模型可重发；达到既有 128 轮上限仍按现有终态失败。 | 单测证明适配器不覆盖 `length`，并证明参数合法时 Host tool 仍为 0 次、下一采样能看到 error tool result 后正常完成。真实 DeepSeek 长输出工具旅程待最终软件验收，不由合成流测试冒充。 |
| OpenAI Codex commit `61a44880a85d2fd0d8770908dea5733495e571c8`：`codex-rs/protocol/src/error.rs`、`codex-rs/core/src/responses_retry.rs`、`codex-rs/app-server/README.md`；Apache-2.0 | 直接证据：协议保留语义化错误类别和 retryable 属性；Responses 重连状态会作为事件反馈 UI。该实现依赖可恢复的 Responses 流语义。 | 用户需要得到准确、可恢复的失败，而不是工具被静默误执行或所有故障都变成同一句“未完成”。 | 当前聊天主链是 Gateway 后的 OpenAI Chat SSE，没有 response id 续流；本次只处理截断工具调用，通用错误分类另开一轮。 | ProductTask/TaskRun 是公开终态权威；Harness history 是当前 Turn 的私有模型轨迹。 | 采用“保留语义、向模型回送结构化失败”的原则；不复制 Codex 的中途续流重试。 | 不在缺少续流标识时自动重放整个流，避免重复 tool call 或重复副作用。 | 本次定向故障注入覆盖截断；认证、限流、上下文、网络、沙箱等错误分类和前端恢复动作仍明确登记为下一项，不能声称已经完成。 |
| 本地 Codex 前端参考 `codex-frontend-reference/26.721.41059`：`README.md`、raw/reverse-readable `queued-message-list-CJCiiVt0.js`、host bridge `build/main-DXmJ7M03.js` | 直接证据：失败队列项保持可见并给出 retry/edit/delete 恢复动作；host bridge 以会话/消息/锁标识保护发送。该前端证据不定义模型截断算法。 | 运行失败必须保留准确状态与恢复入口，不能只显示泛化错误。 | `ProductTaskPage` 已消费 ProductTask 终态和恢复动作，但本次截断在 Harness 内自动回送模型，不新增一套 renderer 状态。 | renderer 仍只读 Product Server 投影，不保存模型私有轨迹。 | 本次不改前端；后续通用错误分类再映射到现有运行检查器和恢复动作。 | 如果模型重发后成功，用户只看到正常连续运行；如果循环最终失败，仍走现有 ProductTask 失败/恢复链。 | 本次无假 UI；后续前端失败语义必须再次读取 raw、reverse-readable、host-bridge 后单独验收。 |
| BilliardBuddy 当前生产链（2026-07-26）：`productModelRuntime.ts`、`productAgentLoop.ts`、`productToolExecution.ts`、`productAgentHarness.ts`、`agentWorkerSupervisor.ts`、现有对应测试 | 直接证据：`calls.size ? "tool_call" : ...` 会抹掉 `length`；loop 只按 tool call 是否存在决定执行，没有截断防线。 | 防止 Read/Write/Bash/MCP/Plugin 等任何工具在模型意图不完整时被调用。 | Gateway SSE → `runProductModel` → `runProductAgentLoop` → Hook → Host tool → 私有 session 持久化 → ProductTask Event。 | 上游采样终态和配对 tool result 进入同一私有消息序列；Host tool 仍是唯一真实副作用入口。 | 两个生产文件、两个现有测试文件；不新增执行器、不改变 IPC、权限或公共 API。 | 所有截断调用都生成错误结果，顺序与原 tool call 一致；持久化失败则不会进入下一采样；abort 与 loop limit 保持原规则。 | Bun 定向测试、相关 agent-worker/service 组合测试、server 门禁与 diff 检查；真实上游与安装包旅程留到软件整体闭环后，打包仍在最后。 |

## 明确不采用

- 不因为参数能通过 JSON/Zod 校验就推断模型已经完整表达意图。
- 不只拦截写工具；截断时所有工具都不执行，避免读取错误对象、向外发送错误请求或依赖不完整前置条件。
- 不在 OpenAI Chat SSE 缺少可靠续流标识时自动重放整次请求。
- 不新增另一套 Agent loop、错误队列或 renderer 临时状态。
- 不把这项安全闭包描述成整个聊天 Harness 已完成；通用错误分类、重试反馈和最终真实旅程仍需后续迭代。

## 施工后证据

- `runProductModel` 先保留上游 `length`，只有非截断且实际存在 tool call 时才规范化为 `tool_call`。
- `runProductAgentLoop` 只拦截属于截断 Assistant Message 的调用；每个调用得到同 id 的 error `tool_result`，并在下一次模型采样前进入既有私有 session 持久化回调。
- 合成流故障注入使用“参数是完整合法 JSON、终止原因仍为 length”的反直觉场景；Host tool 调用次数为 0，第二次采样收到错误结果并正常结束。
- 定向两个测试文件共 12 项通过；服务端类型检查和完整服务端门禁共 567 项通过；`git diff --check` 在提交前另行执行。
- 以上没有验证真实 DeepSeek 是否会主动重发，也没有验证认证、额度、网络、上下文和沙箱错误的产品提示；这些仍是后续软件层工作，不能据此进入打包。
