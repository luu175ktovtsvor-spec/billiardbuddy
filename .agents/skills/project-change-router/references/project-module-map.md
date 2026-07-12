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
| 契约与传输 | `ts/src/types`、`ts/src/server`、renderer `api/types` | REST/SSE/WS/IPC 数据边界 |
| Electron/sidecar | `ts/desktop/electron`、`desktop/sidecars` | 窗口、IPC、进程生命周期 |
| 会话与事件流 | `server/services/session*`、renderer chat/session | 会话、transcript、回放、rewind |
| Agent 循环 | `ts/src/harness` | ReAct 循环和系统提示 |
| 模型与代理 | `model`、`proxy`、`server/services/provider*` | provider、协议转换、降级 |
| 上下文与记忆 | `context`、`memory`、`goals` | 压缩、记忆、目标状态 |
| 工具执行 | `tools` | 文件、命令、搜索、交互工具 |
| 工作区 | `workspace`、`sandbox`、renderer workspace | cwd、文件树、Git、终端 |
| 权限安全 | `permissions`、`sandbox` | 权限档、审批、路径与命令护栏 |
| 扩展系统 | `skills`、`commands`、`hooks`、`packs`、`plugins` | 可发现能力与领域包 |
| MCP | `mcp` | MCP 配置、信任、OAuth、工具加载 |
| 任务与子代理 | `tasks`、`agents` | 后台任务、子代理、团队 |
| Remote Bridge | `tasks/bridge*`、server bridge routes | 远程控制与消息传输 |
| 定时任务 | `ScheduledTaskRunner`、renderer scheduled | 排程、执行、运行历史 |
| 生图/文档 | `media`、canvas/studio routes、CreationPage | 图片、canvas、Office 文档 |
| 视频 | `media/video*`、VideoStudioPage | 剪辑计划、渲染、素材分析 |
| 门店知识 | `packs/billiards`、`StoreDocsService`、assets | 门店资料、RAG、领域能力 |
| 设置与凭据 | settings/provider/credential services、SettingsPage | 偏好、provider、凭据 |
| 系统运维 | telemetry、backup、migrations、assets | 遥测、备份、迁移、组件资产 |

## 前端功能域

把代码逐步聚合为聊天会话、工作区、扩展管理、定时任务、生图、视频、门店设置、应用外壳八个功能域。组件、store、API 和测试应跟随功能域；跨域只通过公共入口通信。

## 依赖规则

- UI 依赖功能 API/store；功能 API 依赖共享契约；不得反向依赖。
- route 依赖应用服务；应用服务依赖领域接口；adapter 实现接口。
- 跨模块不得导入对方内部文件。
- 主责模块只有一个；共享模块只放稳定且确实被多个域共同拥有的概念。
