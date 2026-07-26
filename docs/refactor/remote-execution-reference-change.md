# 远程执行去逐操作确认：参考—改动表

本文只服务于 `BilliardBuddy-重构合同.md` 对远程能力正常执行路径的一次落地，不是第二份产品合同。产品方向、边界和完成标准仍只由重构合同裁决。

## 施工结论

DeepSeek 文本推理、MiMo 视觉/媒体推理、Fun-ASR 语音转写和图片生成是 BilliardBuddy 已配置的正常远程能力。远程调用继续受安装身份、能力注册、任务权限、操作身份、幂等、超时、取消、额度和安全错误约束；删除的是每次运行前额外生成并传递的 consent receipt、header、弹窗、设置开关和“付费操作”文案。

工具对本机文件、Shell、浏览器和开放网络的权限确认仍由 Harness 工具权限边界处理。删除逐操作数据出境回执不扩大任一 Tool 权限，也不允许 renderer 接触供应商密钥。

## 参考—改动

| 参考文件 / commit | 证据等级与直接证据 | 要解决的用户问题 | BilliardBuddy 当前代码路径 | 唯一状态源 | 最小改动 | 失败 / 恢复行为 | 测试与真实旅程 |
|---|---|---|---|---|---|---|---|
| OpenAI Codex commit `62fd410384cca008446c2d64a4f2b3f915f4906e`：`codex-rs/core/src/session/turn.rs`、`codex-rs/app-server/README.md`；Apache-2.0 | 直接证据。授权请求属于具体 Tool/Item，Turn 的模型请求、恢复和事件不依赖一张通用的逐回合“远程数据同意回执”。 | 用户应在需要文件、Shell、网络副作用时看到准确授权，而不是在每次正常模型调用前重复确认同一产品基础能力。 | `remoteDataEgressConsentService`、Product consent API、桌面全局 Gate、代理 handler 当前在真正的 Turn/Tool 权限之外又增加一层 receipt。 | ProductTask Turn/Item 保存工具授权与终态；安装能力快照保存远程能力是否可用。 | 删除通用 consent 状态、API、UI 和代理前置 428；保留工具授权、安装身份、provider protocol 和安全失败。 | 未配置 Gateway、安装身份缺失、上游超时或 Tool 权限被拒时仍显式失败；不再把“未点同意”当作远程服务故障。 | 聊天代理请求无 consent header 仍能到达已配置 Gateway；工具授权、取消、resume 和错误测试继续通过。 |
| Pi commit `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`：`packages/agent/src/agent-loop.ts`；MIT | 直接证据。loop 以模型事件、tool call/result、steer/follow-up 继续执行；宿主控制 Tool，而非给每次采样附加产品自创 consent receipt。 | 正常 Agent 循环不能因一张与 Turn 无关的全局回执被阻断或进入第二套状态机。 | `ts/src/server/proxy/handler.ts` 在模型请求转换前查询全局 receipt 并返回 428。 | Harness 的权限快照和 provider 能力绑定。 | 代理只附加 provider protocol、安装 client identity 和必要操作 identity；删除 receipt 查询与 header。 | 失去 receipt 不再改变重放身份；幂等键、operation id 和 provider receipt 仍决定可安全恢复的外部操作。 | 同一 Turn 的 tool loop、重试和网络失败测试；请求头断言确认不再发 consent。 |
| Claude Managed Agents 公开 Session/Tools 合同（2026-07-26 核对）：`/docs/en/managed-agents/sessions`、`/tools` | 直接协议证据。Session、Tool/MCP 和客户端 tool result 是独立合同；授权与工具执行绑定，没有要求为每次基础模型请求创建产品自定义“付费操作”。 | 权限说明要与用户正在允许的动作一致，不能把供应商基础调用包装成通用审核流。 | Product consent API/UI、图片提交 `confirmedDataEgress`、语音 `consentReceiptId` 把基础能力变成额外确认流程。 | Session/TaskRun、MediaJob/Operation 和 VoiceOperation 各自保存运行真相。 | 删除确认参数和 receipt 字段；保留 Job/Operation 的 operation identity、结果回执、取消和终态。 | 旧持久 Job 中的 receipt 字段只在迁移时被剥离，不继续参与执行或重放判断；未来 schema 仍 fail closed。 | 旧媒体/语音 fixture 迁移、重复迁移、崩溃恢复和迟到结果测试。 |
| BilliardBuddy 当前 Gateway/Relay 与桌面链（2026-07-26）：`gateway/app.ts`、`relay/app.ts`、`ts/shared/product/dataEgress.ts`、`ts/src/server/proxy/handler.ts`、`MediaProjectService`、`videoAnalysis.ts`、`productVoice.ts`、`RemoteDataEgressConsent.tsx` | 直接当前代码事实。Gateway 五条能力路由都要求 `X-BB-Data-Egress-Consent`；Relay 将 consent hash 写入任务幂等绑定；桌面启动和设置提供全局 Gate；图片与语音另有单次确认/receipt。 | 同一正常操作被多层确认和多份状态阻断，用户看到“付费操作/出境”而非能力可用性与真实任务状态。 | 上述 schema、header、数据库列、路由、UI、IPC 参数、负载测试和部署 manifest。 | Gateway 能力注册与安装身份；Relay 用 owner + operation/idempotency + input fingerprint；本地领域用 TaskRun/MediaJob/VoiceOperation。 | 先停止产生新 receipt；迁移本地旧字段；Gateway/Relay 向后读取旧数据库列但不再写入或比较；删除 header 要求、UI/API 和测试消费者。 | 旧 Relay 行可继续查询/完成；新提交只按 owner、operation identity 与 input fingerprint 判断冲突。部署失败、上游未知结果和 blob 对账逻辑不变。 | Gateway/Relay 纵向测试、旧 SQLite schema fixture、新旧客户端兼容、桌面构建、服务端套件与最终部署/真实上游旅程。 |

## 不采用的做法

- 不把 consent 改名为“首次授权”“账户确认”或隐藏弹窗；这仍会保留第二套阻断状态。
- 不删除 Tool 权限、网络开放边界或浏览器/本机敏感动作确认；它们保护的是具体副作用。
- 不删除 operation id、idempotency key、provider receipt、结果确认或 Relay blob 对账；它们保护的是不可安全重放的外部动作。
- 不把旧 receipt 继续作为 Relay 幂等键的一部分；同一逻辑操作不能因升级后缺少无关 header 被误判为另一项操作。

## 本次验收边界

本次完成只证明逐操作 consent 链被删除且远程执行仍受真正的权限、身份和恢复边界约束。供应商线上额度、账号级保留期限与生产容量仍需用部署状态和真实上游证据单独验证。
