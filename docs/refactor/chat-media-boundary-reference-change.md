# 聊天与媒体工作台解耦：参考—改动表

本文只服务于 `BilliardBuddy-重构合同.md` 第一轮聊天 Harness 的一次落地，不是第二份产品合同。产品方向、边界和完成标准仍只由重构合同裁决。

## 施工结论

聊天 Harness 只保留聊天附件的 `VisualEvidence`、文字 Brief、普通 Tool/MCP、权限和持久事件。生图与视频工作台继续作为独立 `MediaProject` 产品面存在，但聊天不能发现、创建、绑定、打开、查询或修改工作台项目，也不能通过 Skill 间接获得这些命令。

现有 `MediaWorkbench` Agent Tool、媒体工作台聊天 Skills、`ProductTaskMediaService`、task-scoped MediaProject API、聊天媒体 Dock/内联草稿和 `product_task` 媒体 owner 构成同一条错误执行链。本次改动以停止新写入和迁移既有 owner 为先，完成消费者迁移后物理删除聊天侧链路；普通聊天附件仍由 ProductTask 附件领域进入 MiMo VisualEvidence，不受影响。

## 参考—改动

| 参考文件 / commit | 证据等级与直接证据 | 要解决的用户问题 | BilliardBuddy 当前代码路径 | 唯一状态源 | 最小改动 | 失败 / 恢复行为 | 测试与真实旅程 |
|---|---|---|---|---|---|---|---|
| OpenAI Codex commit `62fd410384cca008446c2d64a4f2b3f915f4906e`：`codex-rs/core/src/session/turn.rs`、`codex-rs/app-server/README.md`；Apache-2.0 | 直接证据。一个 Turn 内模型返回 tool call 后执行工具并把结果送回下一次采样；App Server 以 `thread/start|resume|fork`、`turn/start|interrupt`、`item/started|completed` 和审批请求形成聊天权威事件。 | 聊天必须能持续执行、恢复并展示真实结果，但不能从聊天 DOM 或另一个业务项目推断完成。 | `ts/src/server/agent-worker/*`、`ts/src/server/product/task*`、`ts/desktop/src/product/*`；当前额外存在 `MediaWorkbench`、task-scoped media API 和媒体 Dock。 | `ProductTask / TaskRun / Item/Event` 是聊天真相；`MediaProject` 只属于工作台。 | 不移植 Codex 品牌或 bundle；保留已有聊天事件链，移除所有让聊天写入/拥有 MediaProject 的入口。 | Tool 失败仍落为同一 Turn 的 durable Item；媒体工作台失败只落在其自己的 Operation/Job，不投影成聊天项目状态。重启后两域分别恢复。 | 服务端验证聊天工具目录无 `MediaWorkbench`，产品 API 对旧 task-media 路由返回 404，现有聊天附件与 cursor/resume 测试继续通过。 |
| Pi commit `5bc1c2c0a6f07e00e8c240304182f213ab8d311f`：`packages/agent/src/agent-loop.ts`；MIT | 直接证据。内循环只处理 tool call、tool result 和 steer；外循环只处理 follow-up；每一步经事件 sink 输出。 | 用户追加消息、工具继续和最终回答应在一个清晰 Harness 内完成，不能把图片/视频项目变成第二种 follow-up 或隐式 Agent 子循环。 | `ts/src/tools/MediaWorkbenchTool/*`、`ts/src/skills/bundled/mediaWorkbenches.ts`、`ts/src/skills/bundled/billiardsOperations.ts` 把工作台命令暴露给聊天 loop。 | Harness 上下文与聊天事件；媒体项目状态不进入 loop。 | 从 base tools 和聊天 Skill allowlist 删除 `MediaWorkbench`；相关 Skill 只允许给出文字 Brief/建议，或从聊天发现面移除。 | 已在运行的旧会话即使残留历史 tool item，也只能作为历史 activity 读取；新 Turn 不再发现或调用该工具。未知旧工具调用显式失败，不能转发到媒体 API。 | 工具发现、Skill 发现、旧 transcript 投影和新 Turn 可用工具测试；真实聊天请求确认不会创建媒体项目。 |
| Claude Managed Agents 公开 Session/Tools 合同（2026-07-26 核对）：`/docs/en/managed-agents/sessions`、`/tools`；核心 Claude Code 执行器未公开 | 直接协议证据；不对未公开实现作推断。Session 保存会话历史并由事件启动；custom tool 只发结构化请求，应用执行后把结果送回；Tool/MCP 权限独立配置。 | Tool 回执必须可验证且受宿主权限控制，但不能用一个 Tool 偷渡独立工作台的项目所有权。 | `MediaWorkbenchTool` 直接请求本机 `/api/media/*`，绕过两个工作台的独立用户入口；聊天 Skill 还主动指示 Agent 创建项目。 | Product Server 对各领域分别授权；聊天 Tool 不能成为媒体领域写入口。 | 删除该 Tool 和对应聊天命令，不新增兼容转发层。 | 旧调用不会被静默映射到新工作台；返回不支持/未知工具，用户仍可复制聊天产生的文字 Brief 后自行进入工作台。 | Agent-worker 实际工具清单与 Host 路由测试；工作台 API 自身的创建、编辑、取消和恢复测试保持独立。 |
| 本地 Codex 前端参考 `codex-frontend-reference/26.721.41059`：`README.md`、raw `queued-message-list-CJCiiVt0.js` / `local-conversation-thread-Bj5uKwgs.js`、reverse-readable 同名文件与 `thread-side-panel-tabs-B3tKzciM.js` / `artifact-tab-content.electron-_vNcbcn-.js`、host bridge `build/main-DXmJ7M03.js` | 直接 bundle 证据与有限交叉推理。队列支持编辑、删除、Steer、失败暂停/重试和侧边任务；线程侧栏按 Diff、Artifact、Browser 等任务成果分面；host bridge 调用真实 App Server 的 `thread/start`、`turn/start`、`item/*`，并校验 IPC sender。Source map 未提供，不推断未读算法。 | 右侧应展示当前聊天 Turn 的附件、Diff、网页和运行状态，而不是提供“关联媒体项目并打开工作台”。 | `ProductTaskPage.tsx`、`ProductTaskMediaDock.tsx`、`ProductTaskInlineMedia.tsx` 当前把 MediaProject 绑定和资产代理嵌入聊天。 | renderer 只消费 ProductTask Item/Event 投影；工作台 renderer 只消费 MediaProject/Job/Event。 | 删除媒体 Dock、内联项目草稿、绑定按钮和轮询；保留现有 Review、Browser、Terminal、Run Inspector 以及聊天附件预览。 | 切换任务或重启不会再触发媒体项目轮询；聊天附件读取失败显示附件失败，不尝试寻找/绑定工作台项目。 | ProductTask 页面、协议解析和任务切换测试；真实 UI 旅程确认聊天无工作台入口，图片/视频一级入口仍能独立打开。 |
| BilliardBuddy 当前生产链（2026-07-26）：`ts/src/tools.ts`、`ts/src/tools/MediaWorkbenchTool/*`、`ts/src/skills/bundled/mediaWorkbenches.ts`、`ts/src/server/api/product.ts`、`ts/src/server/product/taskMediaService.ts`、`ts/shared/contracts/media.ts`、`ts/shared/product/taskMedia.ts`、`ts/desktop/src/product/api/tasks.ts`、`ProductTaskPage.tsx`、`ProductTaskMediaDock.tsx`、`ProductTaskInlineMedia.tsx` | 直接当前代码事实。Agent 可创建/修改 MediaProject，聊天可列出、绑定、代理读取工作台资产；MediaProject 持久化 `product_task_id`/`owner.kind=product_task`。 | 同一个媒体作品不能既由工作台项目管理，又被聊天任务拥有；用户不应在聊天里误以为一条模型回复已经创建或操作了作品。 | 上述完整链路及对应测试。 | `MediaProjectService` 是媒体唯一写入口，当前工作台项目统一为独立 owner；`ProductTask` 只保存自己的附件和事件。 | 停止 `product_task` owner 新写入；把受支持旧项目一次迁为 standalone；删除所有正式消费者、路由、类型、Tool、Skill 和 UI；迁移 reader 只处理旧持久记录。 | 迁移前备份；中途失败回滚原字节。未来 schema fail closed。历史聊天中的媒体 tool activity仍可作为无 payload 的普通 activity 投影，但不能恢复执行或重新绑定。 | 旧 owner fixture 迁移、重复迁移、故障回滚、未来 schema、API 404、工具目录、桌面构建；之后再做安装包删除审计。 |

## 不采用的做法

- 不把 `MediaWorkbench` 改名或包一层新 Tool；这会保留同一条错误执行链。
- 不让聊天只读查询 MediaProject；项目 ID、状态和资产代理仍会继续形成跨域消费者，并诱导后续恢复绑定入口。
- 不删除普通聊天图片/视频附件；它们属于 ProductTask 附件和 VisualEvidence，不是 MediaProject。
- 不把工作台结果复制进 ProductTask Store；成果比较、版本和恢复继续只由 MediaProject 管理。

## 本次验收边界

本次完成只证明“聊天不再操控媒体工作台”这一合同边界，不宣称聊天 Harness 第一轮或整体重构已经完成。完整 Harness 仍需继续核验连续模型—工具循环、steer/follow-up、compact、resume、权限、扩展发现和安装包用户旅程。
