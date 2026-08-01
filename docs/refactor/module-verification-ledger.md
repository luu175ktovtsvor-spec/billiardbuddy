# 重构模块回溯核验账本

## 使用方式

本账本不把历史“已完成”、提交、构建成功或代码数量当作模块完成证明。每个模块必须以当前正式源码核对合同中的 Outcome、Constraints 和 Verification，并记录：

- 实际生产入口、唯一状态权威与消费者；
- 已被当前源码直接证明的结果；
- 只能由真实使用、设备或外部服务确认的未验证事实；
- 已确认缺口及其所属模块。

结论只能是“已由当前源码证明”“仅静态可证”“存在缺口”或“证据不足”。没有逐项记录时，不得推进到 R10/R11，也不得把历史阶段记录当作发布许可。

## R0 文档与架构收口

- **合同目标**：合同、路线图和当前模块总纲提供同一模块顺序、同一当前工作单元和同一下一步。
- **当前证据**：合同和根 `AGENTS.md` 已将当前游标唯一指向路线图；路线图曾同时出现 R2 与 R11.3 两个“当前”表述，现以 R0.1 纠正。Agent 总纲和专题参考文档已改为仅在路线图选中 Agent 模块时适用。
- **当前结论**：已由当前文档静态证明。全库扫描只保留路线图中的一个 `Active work unit`；合同和根规则不再保存第二份当前模块，Agent 总纲与专题证据不再宣称自身是当前主线。
- **未验证/待处理**：R1--R9 的历史完成声明仍必须逐模块替换为可追溯的当前源码证据或明确的缺口；R0 不以此替代产品行为核验。

### R0.2 模块施工与提交收口

- **实际入口与权威**：路线图的 active work unit 是唯一施工游标；模块总纲定义局部边界；正式源码定义当前实现；专题文档和账本只保存证据。当前脏工作树不拥有“已完成重构”状态。
- **当前证据**：`docs/refactor/module-commit-protocol.md` 固定了权威顺序、施工单、差异块归属、暂存门禁和提交语义；`worktree-module-inventory.md` 记录了当前 454 个状态项及其候选模块地图；服务端类型检查、桌面生产构建、源码可达性审计和 `git diff --check` 仅作为当前混合树的基线，不被写成模块完成证据。
- **当前结论**：R0.2 由当前文档和工作树盘点证明；后续模块必须从该协议取得唯一游标，并只提交已核验的模块文件。
- **未验证/待处理**：现有代码差异尚未按 R1--R11 逐块审阅；原工作树中的代码、锁文件和删除项均不因本提交获得完成或发布资格。
- **下一项**：R1.1 共享产品内核的权威边界回溯核验。

## R1 共享产品内核

### R1.1 Shared Kernel 资源与执行合同

- **实际入口与唯一权威**：`ts/shared/kernel/resourceScheduler.ts` 是跨进程合同；`ts/src/server/product/resourceScheduler.ts` 是唯一持久调度实现；`ts/src/server/product/resourceProfiles.ts` 是桌面 Host 的 profile 来源。`ts/shared/product/resourceScheduler.ts` 仅转发到 Kernel，不保存第二套定义。
- **当前源码证明**：资源 claim、lease、fencing、队列、重复 operation、结果未知和 process generation 都从 Kernel 合同进入同一 JSON journal；服务端 scheduler 通过进程内 mutation tail 串行化同进程调用，再用跨进程文件锁保护持久状态；profile 将 Agent 和媒体资源限制集中到同一 Host 资源池。
- **当前结论**：R1.1 静态边界已闭合；旧 import 仍可编译，但不存在第二个资源状态机或第二个实现入口。本模块的服务端类型检查、桌面类型检查、桌面生产构建、源码可达性审计和差异空白检查均已重新通过。
- **未验证/待处理**：真实设备峰值、进程崩溃后的实际租约回收和多窗口压力仍未运行验证；身份、能力、设置、凭据和迁移属于 R1.2，不由本单元提前宣称完成。
- **下一项**：R1.2 共享身份、能力目录、设置与迁移入口。

### R1.2 共享身份、能力目录、设置与迁移入口

- **实际入口与唯一权威**：Electron Main 保有稳定 installation id、加密 installation session、MCP OAuth 主密钥和一次性 Gateway bearer capability；Gateway 的 `installationAuth.ts` 以 installation id 建立匿名主体和可轮换 session；本地 Product Server 只持有短期 bearer，收到 capability 更新后立即从启动环境删除该 capability。
- **当前源码证明**：首次启动仅以随机 installation id 请求 `/v1/auth/bootstrap`；失效或损坏 session 清理后静默重建，网络失败只安排恢复而不阻断本地工作台。Gateway 以 SQLite 事务持久化匿名主体与 refresh token 哈希，并以速率限制保护 bootstrap。Renderer 和 Agent Worker 不接触 refresh proof；Main 以一次性 capability 向本机 Server 热更新 access bearer。旧 License、bootstrap credential、授权文件及其生产实现已退出该调用链。
- **当前结论**：R1.2 的静态边界已闭合。服务端类型检查、桌面类型检查、桌面生产构建、源码可达性审计和差异空白检查均已通过；本模块直接替代的 License/身份测试资产已删除，未运行任何测试。
- **未验证/待处理**：真实 Gateway 网络中断、系统凭据损坏和跨版本磁盘迁移仍须在最终软件验收确认；个人模型、托管用量和模型执行留给 R3，旧的打包验收脚本与其测试依赖留给 R8 清理。
- **下一项**：R2.1 Agent Harness Authority 与 Worker/Host 生产调用链。

- **权限合同**：`shared/kernel/permissionExecutionEnvelope.ts` 只定义跨进程不可变信封；创建、摘要和校验集中在 `server/product/permissionExecutionEnvelope.ts`，Worker 协议、Host 与 sandbox 都只消费该合同。当前源码未出现第二个信封写入者。
- **资源调度**：`shared/kernel/resourceScheduler.ts` 只公开 claim、lease、fencing 和 `ProductResourceSchedulerPort`；唯一的持久调度实现是 `server/product/resourceScheduler.ts`。本轮发现媒体本地进程原先有独立的内存队列，已移除：`MediaProjectService` 只能从启动点注入该端口，FFmpeg、FFprobe 和流式逐帧解码都先取得同一 desktop-host 租约；媒体 API、能力快照和路由也不再各自构造服务实例。
- **跨工作台持久化**：媒体项目由 `MediaProjectStore` 在单个 repository 写锁内校验 writer fence、资产不可变性与 CAS 后写入；图片与视频只通过各自的 mutation 串行队列进入该存储。遗留 `product_task_id` 仅在迁移 reader 中被转换为 standalone media owner，当前 Agent 不写媒体项目状态。
- **能力、设置、凭据与迁移**：能力快照只由启动点传入当前媒体服务和调度任务服务；设置写入集中在带文件锁和原子替换的 `ProductSettingsRepository`；个人模型与 Gateway token 都由 Main 传入的一次性 capability 保护，启动时从环境移除；`ProductStorageMigrationCoordinator` 是产品任务、媒体、语音和计划存储的单一启动迁移编排器，并在回滚前保留备份 journal。
- **当前结论**：旧 R1 总体记录只能作为历史候选证据；当前 R1.1 与 R1.2 已按独立源码和提交边界核验，不把后续 R2/R3/R7 改动计入 R1。
- **未验证/待处理**：真实设备、磁盘回滚和凭据轮换仍不能由静态检查替代；Agent Authority/Worker、个人模型执行、额度和桌面壳体验必须由后续模块各自证明。
- **下一项**：R2.1 Agent Harness Authority 与 Worker/Host 生产调用链。

## R2 Agent Harness

- **实际入口与唯一权威**：公开 API 的 create/continue/submit/recover 命令都由 `ProductTaskService` 进入 `ProductTaskAuthorityRepository` 事务，原子持久化 TaskRun、dispatch record、thread entry、用户可见事件和幂等 receipt。Worker 只通过 `ProductTaskWorkerMessageSink` 交付消息；它先调用 Task Service 写入 Authority，再经运行时投影发布。
- **当前源码证明**：`createProductTaskRunComposition()` 是 Server 唯一的 Supervisor、Scheduler、IPC Launcher 与 Host factory 装配点；Worker entrypoint 是 Harness 唯一构造点。Harness 仅接收模型、工具、策略和投影端口，Host 才执行模型与工具。私有 Harness session、资源租约、进程瞬态状态和 Renderer view 都各自有恢复边界，不能替代 Authority。
- **当前结论**：R2 的静态边界已闭合。Run 的提交、恢复、Worker ingress、Host model/tool、事件账本和 WebSocket/desktop projection 形成一条无旁路生产链；类型检查、桌面生产构建、源码可达性审计和差异空白检查均已重新通过。
- **未验证/待处理**：未运行模型、工具、协作、设备或多窗口真实路径；模型输出质量、外部副作用、进程树清理与网络时序仍须在最终软件验收确认。R3 才负责模型来源、凭据与用量控制面。
- **下一项**：R3.1 模型执行端口与使用权控制面回溯核验。

## R3.1 模型端口、个人凭据与冻结路由

- **当前源码证明**：Electron Main 的 `ProviderCredentialService` 使用系统加密凭据存储个人 profile，启动和更新只通过 Main 生成的一次性 capability 注入本机 Product Server。`personalModelRuntimeState` 捕获后立即从进程环境删除配置；隔离 Worker 继承的是剥离过 Host/Gateway 凭据的环境。
- **执行与恢复边界**：TaskRun 在取得派发权时写入非秘密 `provider/model` 和 route digest。Core binding 只传递这三项非秘密信息；server-private factory 用当前受信 profile 重建并比较 digest，端点、模型、能力或 API Key 漂移均拒绝恢复。两种来源都进入 `StandardProductAgentHostRuntime → runProductModel`，个人模型直连已冻结的 OpenAI-compatible、Responses 或 Anthropic endpoint。
- **个人 operation**：个人请求使用本机权限收紧的 SQLite operation store；成功 assistant 先写入该 store，重复 operation 只回放结果，明确未请求失败释放 reservation，其余中断保留 unknown 围栏。模型运行时不自行 ACK；R3.3 才为主 Harness 定义结果持久化后的消费回执。Renderer、Task Authority 与 Worker 不读取 Key 或 operation payload。
- **当前结论**：R3.1 已完成 Model Port 与个人来源的最小闭合；服务端类型检查、桌面 lint/生产构建和差异空白检查通过，未运行测试或真实模型请求。
- **未验证/待处理**：真实供应商协议兼容性仍未运行。Gateway 托管 TextReasoning 的 stable operation、远端结果回放、ACK 与严格额度结算尚未重构，作为 R3.2 单独施工。
- **下一项**：R3.2 Gateway 托管 TextReasoning operation ledger 与额度结算。

## R3.2 Gateway 托管 TextReasoning operation ledger、回放与额度结算

- **当前源码证明**：`gateway/app.ts` 在文本请求进入 DeepSeek 前以已验证 installation principal、stable operation id、`TextReasoning` 请求指纹和 result-store fencing 裁决结果。成功 result 以原始 SSE 字节、内容类型和精确 usage 写入 `gateway_operation_results_v4`；相同 binding 只回放已保存数据，in-progress 和 outcome-unknown 不能隐式成为第二次请求。
- **额度与失败边界**：Gateway 对同一 TextReasoning operation 只有一份预算 reservation。成功流优先持久 result，再用 `completion_tokens`（或在缺失时保留 reservation）结算；客户端取消、上游/stream 不确定和 ledger 写入失败都会保留 outcome unknown，明确未受理的错误才释放。不会从回放结果重新调用上游。
- **消费边界**：共享 Gateway 协议把 result receipt 绑定到 operation、capability 与请求 fingerprint。R3.2 只提供 receipt 与有界 backlog；主 Harness 的 durable-consumer ACK 时点由 R3.3 单独持久化，不能把模型生成器 yield 当作结果已消费。
- **当前结论**：R3.2 已完成托管 TextReasoning 的最小 result/usage 闭环。Gateway Bun 生产 bundle、服务端 TypeScript 检查、源码可达性审计（496 个源文件、0 个缺失 import、322 个生产源可达）、桌面 lint/生产构建和差异空白检查通过；未运行测试、smoke、模拟请求、真实模型调用或发布。
- **未验证/待处理**：真实上游断流、进程重启、ACK 网络失败与 provider 不返回 usage 仍未运行。R3.3 单独收口主 Harness receipt 的 durable-consumer 边界；unknown 的显式新 attempt 留给 R3.4，不能自动重试任何已围栏模型调用。
- **下一项**：R3.3 主 Harness 私有 receipt 持久化与 ACK。

## R3.3 主 Harness 私有 receipt 持久化与 ACK

- **当前源码证明**：`ProductAssistantMessage` 可携带仅用于私有 Harness trajectory 的 operation receipt，`ProductHarnessSessionRepository` 与其 parser 原子保存该 receipt 和 assistant。`ProductAgentLoop` 只在 `onMessageState` 成功后请求 ACK；恢复 active Turn 会从持久消息读取 receipt、先 ACK、后交付已保存的完成结果。
- **失败与恢复边界**：ACK 不可达或拒绝会使主 Harness 保持 recovery_required，不重发模型；同一 receipt 的 ACK 可安全重复。Task event 与 Renderer 只消费文本/活动投影，不接触 operation receipt。
- **当前结论**：R3.3 已完成主 Harness 的 durable-consumer ACK 闭环。服务端 TypeScript 检查、源码可达性审计（496 个源文件、0 个缺失 import、322 个生产源可达）、桌面 lint/生产构建和差异空白检查通过；未运行测试、smoke、模拟请求、真实模型调用或发布。
- **未验证/待处理**：Subtask、Plugin agent 与 Hook 的嵌套模型消费尚无同一 private-session receipt handoff；托管 unknown 也尚未具备用户显式的新 attempt 账本。两者进入 R3.4，不能用即时 ACK 或自动重试规避。
- **下一项**：R3.4 嵌套模型消费者 receipt handoff 与托管 unknown 的显式新 attempt 设计。

## R4 Agent 桌面客户端事件投影与动作回执

- **事件和 snapshot hand-off**：`ProductTaskSocketManager` 只保存每个 task 的 WebSocket、连接状态与 durable `resumeCursor`；每次连接先发送 `resume`，在收到 `resume_cursor` 前拒绝所有 socket 命令。服务端 `taskWebSocket` 在同一 socket 上依次回放 Authority `event_sequence` ledger、读取当前 Run snapshot、重放待处理 approval、过滤不高于回放高水位的缓冲 live event，最后才发送 `resume_cursor` 并切换为 live。断线重连复用 cursor，Renderer 不以旧 socket 的状态继续审批或停止。
- **公开协议与 Renderer 状态**：`taskProtocol` 对每个公开事件严格限制字段、枚举、长度、时间和 replay sequence；Run snapshot 与 model route 仅含公开状态。`productTaskRuntimeStore` 只把结构化事件投影成可丢失的线程、activity、approval、队列和交互 pending，并在 terminal/snapshot 后从服务端刷新 thread、queue、task index。源码扫描确认产品任务本体、Thread/Run、权限、provider、凭据和 receipt 不写入 localStorage；持久化内容限于草稿、面板/工作区布局和通知偏好等 UI 辅助状态。
- **动作与幂等边界**：普通提交、Review、队列修改/转向/恢复以及任务生命周期动作都携带稳定 `client_operation_id`、预期 revision 或 lineage revision；HTTP 结果不明时 store 保留同一 envelope/operation identity，而非生成第二个 Turn。approval/question/stop 仅在当前 socket 的 replay/snapshot hand-off 完成后发送，服务端再以 Authority request ID 或 active Run 围栏处理。terminal、snapshot、error 和断线都会清除仅代表 Renderer 交互的 stop/approval pending，不把旧窗口的本地按钮状态提升为业务状态。
- **当前结论**：R4 的静态退出条件已闭合。桌面没有第二份任务权威；公开协议不泄漏 Host/provider 私有状态；replay、snapshot 和 live hand-off 有固定顺序，动作通过 Authority receipt、request ID 或 generation/active-run 围栏进入服务端。未发现需要在本单元改写的生产缺口。
- **未验证/待处理**：没有启动桌面、浏览器或真实任务，因此真实多窗口网络时序、页面卸载重连和用户交互体验仍属最终软件验收事实，不能由静态结论替代。
- **下一项**：R5.1 图片工作台的提交、任务与不可变资产回溯核验。

## R5 图片工作台提交、任务与不可变资产

- **受理与未知结果围栏**：`ImageProjectCommandService` 在项目 mutation 内创建稳定 operation/idempotency key，并先持久化 Task 与 project pointer，才交给 `ImageSubmissionCoordinator`。已有未确认 operation 只能同步同一任务；需要重新创建远端操作时必须显式 `confirm_unknown_retry`，不能把网络不确定性自动变成第二次付费提交。`ImageRemoteTaskCoordinator` 对 Relay task ID、receipt hash、状态和 acknowledgement 分别验证；结果已落盘但 ACK 暂不可用时只重试 ACK，不重提生成。
- **候选物化和不可变 Version**：远端成功结果先按该 Task 已冻结的 `output_count` 校验，再由 `ImageResultMaterializer` 对每个候选校验可识别 MIME、尺寸、内容哈希并原子落盘；失败会清理本次候选而不是发布半成品。`ImageArtifactRepository` 在读取 asset、输出或 Version 前校验普通文件、非符号链接、路径归属、哈希、MIME 和尺寸；`ImageVersionService` 选择 current version 前再次读取已校验的版本字节，不能把损坏、被替换或未发布资产设为当前版本。
- **已修复的合同断点**：Gateway 与共享图片合同允许每次最多 20 个候选，但 Gateway 结果 URL、桌面可信 URL 解析及直传领取仍只接受索引 `0..3`。现统一为 `0..19` 和最多 20 条 URL，仍逐张串行获取，避免合法的第 5--20 个已提交候选被错误标为未知结果或一次性放大内存。
- **当前结论**：R5 的静态退出条件已闭合。图片提交、未知结果、远端回执、候选物化、资产校验和 current-version 选择都有唯一状态链；Renderer 不拥有可替换资产或 receipt 权威。本轮发现的候选上限不一致已修复。
- **未验证/待处理**：没有提交付费生成、调用 Gateway/Relay、导入图片或启动桌面，因此实际供应商结果、超大候选下载、磁盘异常和用户编辑体验仍属最终软件验收事实，不能由静态结论替代。
- **下一项**：R6.1 视频工作台的导入、证据、时间线与导出回溯核验。
