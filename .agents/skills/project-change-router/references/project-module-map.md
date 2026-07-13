# 项目模块地图

## 部署边界

| 系统 | 路径 | 发布边界 |
|---|---|---|
| 桌面产品 | `ts/` | Electron renderer、main、Bun sidecar 同一安装包 |
| 模型网关 | `gateway/` | 国内服务器独立发布 |
| 生图中转 | `relay/` | 美国服务器独立发布 |
| 数据服务 | `dataeye/` | receiver 与 board 独立进程 |

## 桌面产品责任模块

| 模块 | 当前主要路径 | 负责内容 |
|---|---|---|
| 契约与传输 | `ts/shared/contracts`、`ts/src/server`（`index.ts` 装配、`websocketHandler.ts` WS 生命周期）、renderer `api` | REST/SSE/WS/IPC Schema、边界解析和兼容入口 |
| Electron/sidecar | `ts/desktop/electron`、`desktop/sidecars` | 窗口、IPC、进程生命周期 |
| 会话与事件流 | `server/services/session*`、`server/routes/sessionMetadataRoutes.ts`、`server/routes/sessionActivityRoutes.ts`、`server/routes/sessionRewindRoutes.ts`、`server/routes/sessionArchiveRoutes.ts`、renderer chat/session | 会话元数据、活动、回退与归档 REST，transcript、回放、rewind |
| Agent 循环 | `ts/src/harness` | ReAct 循环和系统提示 |
| 模型与代理 | `model`、`proxy`、`server/services/provider*`、`server/routes/providerRoutes.ts` | provider 管理 REST、协议转换、降级 |
| 上下文与记忆 | `context`、`memory`、`goals` | 压缩、记忆、目标状态 |
| 工具执行 | `tools` | 文件、命令、搜索、交互工具 |
| 工作区 | `workspace`、`sandbox`、`server/routes/workspaceRoutes.ts`、`server/routes/workspaceFileRoutes.ts`、renderer workspace | 工作区与文件预览 REST、cwd、文件树、Git、终端 |
| 权限安全 | `permissions`、`sandbox` | 权限档、审批、路径与命令护栏 |
| 扩展系统 | `skills`、`commands`、`hooks`、`packs`、`plugins`、`server/routes/pluginRoutes.ts` | 插件管理 REST、可发现能力与领域包 |
| MCP | `mcp`、`server/routes/mcpRoutes.ts` | MCP 管理 REST、配置、信任、OAuth、工具加载 |
| 任务与子代理 | `tasks`、`agents`、`server/routes/taskRoutes.ts` | 后台任务 REST 边界、子代理、团队 |
| Remote Bridge | `tasks/bridge*`、server bridge routes | 远程控制与消息传输 |
| 定时任务 | `ScheduledTaskRunner`、`server/routes/scheduledTaskRoutes.ts`、renderer scheduled | 排程、REST 边界、执行、运行历史 |
| 生图/文档 | `ts/src/media`、`ts/shared/contracts/image-workbench.ts`、studio/workbench routes、renderer `features/image-workbench`（`pages/CreationPage.tsx` 仅兼容导出）、`api/studio.ts` | 图片 Brief/模型适配、候选质检、固定画布、项目资产/版本、Office 文档 |
| 视频 | `ts/src/media/video-edit`、`ts/shared/contracts/video-edit.ts`、renderer `features/video-studio` | 视频 Brief、Scene/Timeline、素材证据、规划、预览与渲染 |
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
| 机械质量门 | `scripts/quality_gate.sh`、`scripts/quality/*` |
| 持续集成 | `.github/workflows/ts-harness-ci.yml` |
| Windows 安装包 | `.github/workflows/desktop-build-win.yml`，当前只产 artifact 不自动发布 |
