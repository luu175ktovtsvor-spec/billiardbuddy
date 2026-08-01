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

- **普通提交入口**：`POST /api/product/tasks/:id/runs` 只校验公开输入并调用 `submitTaskRun()`；后者在 `ProductTaskAuthorityRepository.transactSubmit()` 的一次事务中冻结模型/权限、写入 Thread entry、TaskRun、dispatch record、公开 user event 和幂等 receipt，提交后才请求 Supervisor 派发。
- **派发与隔离**：`AgentWorkerSupervisor` 先以 Run/代际申请共享资源租约，再 claim 同一份 Authority dispatch；Worker 只接受带运行 ID、代际、fencing token 和权限摘要签名的 start。`createProductAgentHarness()` 目前只有 worker entrypoint 构造，`StandardProductAgentHostRuntime` 目前只有 server-private factory 构造。
- **模型、工具与投影**：Harness 只接收冻结的 model context、Host model port 和 Host tool port；实际 `runProductModel()` 只由 Host runtime 调用，普通 `runProductTools()` 也只在 Host runtime/工具执行模块内。Worker 的安全消息经 ingress application 和 task service 写回 Authority event ledger；桌面协议按 `event_sequence` 白名单解析并保存 resume cursor。
- **当前结论**：R2 的静态退出条件已闭合。普通提交、续写、停止、恢复、协作、审阅与重放均回到同一 Authority；Worker、Host、Renderer 与 Provider 没有直接写 ProductTask/TaskRun/event 的旁路。`check:server`、`audit:source`、`check:desktop`（生产构建）和相关文档 whitespace audit 已通过。桌面构建仍只有既存 `::highlight(...)` CSS 兼容性 warning。
- **续写、停止、恢复与终态**：续写先经 Authority receipt 创建分支；恢复只接受 `recovery_required` Run，未知效果必须显式确认，才会轮换 session 与递增 dispatch generation。停止在未 claim 前以条件终态结算；已 claim 的 Worker 必须先停 Host/子进程并持久化 terminal，缺少该证据就记为 `recovery_required`。`ProductTaskWorkerMessageSink` 串行处理 Worker 消息，terminal 以同一 Authority 事务补齐未结束 activity、assistant item、terminal event 与队列推进，重复 terminal 必须签名一致。
- **权限与 Host 边界**：Worker 只能通过 IPC 请求 model、tools、compaction 持久化和 approval；IPC Host 只允许对应的窄 operation。Harness 即使先作权限判定，实际工具仍由 Host 在冻结权限信封和 operation scope 下重新判定并执行；当前扫描未发现 Harness/Worker 直接改写 `task_runs`、`dispatch_records`、`thread_entries` 或 `task_events`。
- **协作、审阅与重放**：协作工具只调用 `ProductAgentCollaborationPort`，该端口把 spawn、邮箱、follow-up、wait 和 interrupt 落到 `ProductTaskService` 的 Authority transaction；它不在父工具调用中直接运行子 Harness。审阅编译为受限的普通 TaskRun，Host 对审阅工具再次限制为本地只读。WebSocket 先以 Authority `event_sequence` 回放事件和当前 Run snapshot，再以高水位过滤缓存的 live event；桌面仅保存 resume cursor，并用白名单协议解析事件。
- **未验证/待处理**：没有运行软件、模型、工具、协作或设备，因此实际模型质量、真实副作用、中断时的进程树清理和多窗口网络时序仍是最终软件验收事实，不能由本静态结论替代。
- **下一项**：R3.1 模型执行端口与使用权控制面回溯核验。

## R3 模型执行与使用权控制面

- **冻结路由与同一执行端口**：`ProductTaskService` 只在 Authority 中持久化非秘密 `provider/model` binding、thinking mode 与 route fingerprint；claim 时以 `restoreProductTextReasoningRoute()` 在受信 Product Server 恢复 profile 并逐项核对 digest。`StandardProductAgentHostRuntime.model()` 是 `runProductModel()` 的唯一正式调用点，托管与个人分支都从同一 Harness/Host model port、同一工具循环和同一 provider-operation receipt 流转，不存在按模型来源分叉的 Agent loop。
- **凭据边界**：Electron Main 的 `ProviderCredentialService` 仅向受信本地 sidecar 注入完整个人 profile；其 IPC `summary()` 明确去除 `api_key`。sidecar 启动后 `personalModelRuntimeState` 立即从环境捕获并删除该配置，更新接口另由 Main 持有的一次性 capability 保护。`IpcAgentWorkerLauncher` 启动隔离 Worker 前通过 `stripHostOnlyGatewayEnv()` 移除 Gateway token、个人模型配置及 capability；model route 只交给 server-private Host factory，不进入 child identity。桌面公开 route/protocol 仅含 model、source、thinking。
- **托管与个人的费用/操作权威**：托管 `TextReasoning` 在 Gateway 的 `/v1/chat/completions` 中先验证安装主体、创建 stable operation 与 fencing token、预留用量，再进入视觉桥接或上游；完整流写入 Gateway operation ledger 后才以真实/保守 usage 结算。个人模型不经 Gateway，`personalModelOperationStore` 以本地私有 SQLite 对同一稳定 operation 管理 reservation、结果回放、fencing 与 consumer ACK。两种来源均把 receipt 附到已持久化的 Harness 消息，再由 `acknowledgePersistedProviderOperation(s)` 进行幂等清理，receipt 不投影给 Renderer。
- **未知结果与配置漂移**：两条分支都把网络异常、无效/截断流和非明确失败置为 `outcome_unknown`；只有 Authority 传入的 `confirmUnknownRetry` 才能重新取得 reservation，未发现自动重投。明确未接受请求的状态才释放 reservation。个人 profile、API key、模型、能力和视觉辅助 route 都进入 fingerprint，恢复时任何漂移都会失败关闭；媒体服务与媒体 API 的当前源码不导入或读取个人模型运行配置。
- **当前结论**：R3 的静态退出条件已闭合。Key 不进入 Renderer 或隔离 Agent Worker；托管调用在 Gateway 上游前完成准入，个人调用保持在受信 Host/本地 operation store；模型来源只改变凭据与计费归属，不改变 Harness 行为。未发现需要在本单元改写的生产缺口。
- **未验证/待处理**：没有调用模型、Gateway、Relay 或任何付费上游，因此实际供应商响应、远端账本、网络中断和用户配置轮换的真实效果仍属最终软件验收事实，不能由静态结论替代。
- **下一项**：R4.1 Agent 桌面客户端事件投影回溯核验。

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
