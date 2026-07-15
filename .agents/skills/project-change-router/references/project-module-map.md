# 项目模块地图

## 部署边界

| 系统 | 路径 | 发布边界 |
|---|---|---|
| 桌面产品 | `ts/` | Electron renderer、main、Bun sidecar 同一安装包 |
| 模型、搜索与转录网关 | `gateway/`（`app.ts` 装配、`mimoChat.ts` MiMo 请求/原生搜索/重试、`modelCapacity.ts` 容量调度、`webSearch.ts` 兼容搜索 provider、`transcription.ts` 转录 provider） | 国内服务器独立发布；统一承载模型代理、联网搜索、容量池调度与可替换的语音转录 provider |
| 生图中转 | `relay/` | 美国服务器独立发布 |
| 数据服务 | `dataeye/` | receiver 与 board 独立进程 |
| 桌面组件资产 | `ts/src/assets`、`dataeye/deploy/nginx-dataeye.conf` | `zzyppz.cn` HTTPS 主入口与大陆机 HTTPS 镜像分发；Tier 1 启动后准备，Tier 2 按功能准备，客户端校验后本地执行 |

## 桌面产品责任模块

| 模块 | 当前主要路径 | 负责内容 |
|---|---|---|
| 契约与传输 | `ts/shared/contracts`、`ts/src/server`（`index.ts` 装配、`websocketHandler.ts` WS 生命周期）、renderer `api` | REST/SSE/WS/IPC Schema、边界解析和兼容入口 |
| Electron/sidecar | `ts/desktop/electron`、`desktop/sidecars`、`desktop/renderer-react` | 窗口、IPC、进程生命周期与唯一 React renderer 入口；sidecar 不提供旧静态页面 |
| 会话与事件流 | `server/services/session*`、`server/routes/sessionMetadataRoutes.ts`、`server/routes/sessionActivityRoutes.ts`、`server/routes/sessionRewindRoutes.ts`、`server/routes/sessionArchiveRoutes.ts`、renderer chat/session | 会话元数据、活动、回退与归档 REST，transcript、回放、rewind |
| Agent 循环 | `ts/src/harness` | ReAct 循环和系统提示 |
| 模型与代理 | `model`、`proxy`、`server/services/provider*`、`server/routes/providerRoutes.ts` | provider 管理 REST、协议转换、降级 |
| 上下文与记忆 | `context`、`memory`、`goals` | 压缩、记忆、目标状态 |
| 工具执行 | `tools` | 文件、命令、搜索、交互工具 |
| 工作区 | `workspace`、`sandbox`、`server/routes/workspaceRoutes.ts`、`server/routes/workspaceFileRoutes.ts`、renderer workspace | 工作区与文件预览 REST、cwd、文件树、Git、终端 |
| 权限安全 | `permissions`、`sandbox` | 权限档、审批、路径与命令护栏 |
| 扩展系统 | `skills`、`commands`、`hooks`、`packs`、`plugins`、`server/extensionRoots.ts`、扩展 routes、`shared/contracts/extensions.ts`、renderer `api/extensions.ts` 与 `PluginsPage.tsx` | 技能/命令/领域包发现与展开、启用插件贡献的统一运行时装配、插件管理 REST 和前端披露 |
| MCP | `mcp`、`server/routes/mcpRoutes.ts`、`shared/contracts/extensions.ts`、renderer `api/mcp.ts` | MCP 管理 REST、配置、信任、OAuth、工具加载和前端连接状态 |
| 任务与子代理 | `tasks`、`agents`、`server/routes/taskRoutes.ts` | 后台任务 REST 边界、子代理、团队 |
| Remote Bridge | `tasks/bridge*`、`server/routes/bridgeSessionRoutes.ts`、`server/routes/bridgeWorkerRoutes.ts` | 远程控制会话数据面、消息传输与 worker 生命周期 |
| 定时任务 | `ScheduledTaskRunner`、`server/routes/scheduledTaskRoutes.ts`、renderer scheduled | 排程、REST 边界、执行、运行历史 |
| 生图/文档 | `ts/src/media`、`ts/shared/contracts/image-workbench.ts`、studio/workbench routes、renderer `features/image-workbench`（生成编排与任务状态独立于 `ImageWorkbenchPage.tsx`，`pages/CreationPage.tsx` 仅兼容导出）、`api/studio.ts` | 图片 Brief/模型适配、候选质检、固定画布、项目资产/版本、Office 文档 |
| 视频 | `ts/src/media/video-edit`、`ts/shared/contracts/video-edit.ts`、renderer `features/video-studio` | 视频 Brief、Scene/Timeline、素材证据、规划、预览与渲染 |
| 语音与口播转录 | `ts/src/media/remoteTranscription.ts`、`ts/src/server/services/voiceTranscription.ts`、`ts/shared/contracts/voice.ts`、`gateway/transcription.ts` | 客户端录音/音轨上传、远程文本与时间戳契约、服务器 Whisper 或上游 ASR provider |
| 门店知识 | `packs/billiards`、`StoreDocsService`、`server/routes/storeDocsRoutes.ts`、assets | 门店资料、REST 边界、RAG、领域能力 |
| 设置与凭据 | settings/provider/credential services、SettingsPage | 偏好、provider、凭据 |
| 系统运维 | telemetry、backup、migrations、assets | 遥测、备份、迁移、组件资产 |

## 前端功能域

把代码逐步聚合为聊天会话、工作区、扩展管理、定时任务、生图、视频、门店设置、应用外壳八个功能域。组件、store、API 和测试应跟随功能域；跨域只通过公共入口通信。

## 依赖规则

- UI 依赖功能 API/store；功能 API 依赖共享契约；不得反向依赖。
- renderer 和后端共用 `ts/shared/contracts` 的 Zod Schema/推导类型；禁止新增两端手写镜像。
- route 依赖应用服务；应用服务依赖领域接口；adapter 实现接口。
- 跨模块不得导入对方内部文件。
- 主责模块只有一个；共享模块只放稳定且确实被多个域共同拥有的概念。

## 工程治理模块

| 责任 | 权威位置 |
|---|---|
| AI 长期规则 | 根/路径级 `AGENTS.md`、`CLAUDE.md` |
| 重复工作流 | `.agents/skills` 权威 Skill + `.claude/skills` 中文入口 |
| 机械质量门 | `scripts/quality_gate.sh`、`scripts/quality/*`；桌面用户体验另由 `verify-desktop-runtime` 真机验收 |
| 持续集成 | `.github/workflows/ts-harness-ci.yml` |
| Windows 安装包 | `.github/workflows/desktop-build-win.yml`，当前只产 artifact 不自动发布 |
