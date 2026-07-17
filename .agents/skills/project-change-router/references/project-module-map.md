# 项目模块地图

## 部署边界

| 系统 | 路径 | 发布边界 |
|---|---|---|
| 桌面产品 | `ts/` | Electron renderer、main、Bun sidecar 同一安装包 |
| 模型、搜索与转录网关 | `gateway/`（`app.ts` 装配、装机公平调度(X-QF-Client-ID)、`/v1/models` 目录与三模型路由、`qwenChat.ts` Qwen、`mimoChat.ts` MiMo(视觉桥接上游)、`deepseekChat.ts` DeepSeek V4 Flash(产品默认,注入 opaque user_id)、`visionBridge.ts` 图片→MiMo 视觉桥接(非原生多模态模型带图时先读图成结构化文本,有界+TTL 内存缓存,失败关闭)、`modelCapacity.ts` 容量调度、`webSearch.ts` 独立 `/v1/web_search`、`transcription.ts` Fun-ASR 转录） | 国内服务器独立发布；承载 Qwen/MiMo/DeepSeek 三模型代理(绝不跨供应商回退)、装机公平调度、独立联网搜索、容量池调度与 Fun-ASR 语音转录 |
| 生图中转 | `relay/`(SQLite 持久化 + 幂等 + 归属绑定 + 队列上限 + 重启恢复) | 美国服务器独立发布;仅大陆 qfgw 出口 IP 经 nginx 可达,客户端不得直连 |

## 桌面产品责任模块

> 事实源:当前 `ts/` 已整体是导入的 CC-Haha(Claude Code)内核,REST 边界在 `ts/src/server/api/*`(由 `ts/src/server/router.ts` 分发),WS 事件契约在 `ts/src/server/ws/events.ts`;历史台球产品域(门店知识/招聘/经营工作流/生图/视频工作台)尚未在内核之上重建,见下方"产品业务层"。

| 模块 | 当前主要路径 | 负责内容 |
|---|---|---|
| 契约与传输 | `ts/src/server`（`router.ts` REST 分发、`ws/events.ts` WS 事件契约、`ws/handler.ts` WS 生命周期、`middleware` 本地控制面身份）、`ts/src/server/api/*` | REST/WS 边界解析、每次启动的本地控制令牌与兼容入口 |
| Electron/sidecar | `ts/desktop/electron`（`main.ts`、`services/serverRuntime.ts`、`services/sidecarManager.ts`、`services/productConfig.ts`、`services/installationId.ts`）、`ts/desktop/src` renderer、`ts/src/entrypoints` sidecar 入口 | 窗口、IPC、Bun sidecar 生命周期与产品身份/数据根隔离；main 生成控制令牌并经 preload 交付可信 renderer；生成 installationId 并只注入 server sidecar(BB_INSTALLATION_ID→X-QF-Client-ID),CLI/adapter/renderer/providers.json 一律剥离 |
| 会话与事件流 | `ts/src/server/api/sessions.ts`、`ts/src/server/api/conversations.ts`、`ts/src/server/sessionManager.ts`、`ts/src/server/services` | 会话元数据、transcript、活动与回放 REST；CLI 子进程会话装配与事件流 |
| Agent 循环 | `ts/src/query`、`ts/src/assistant`、`ts/src/tools` | ReAct 回合、系统提示、工具调用与上下文压缩(内核,不改内部) |
| 模型与代理 | `ts/src/server/api/models.ts`、`ts/src/server/api/providers.ts`、`ts/src/server/services/provider*`、`ts/src/server/services/qfGatewayProvider.ts`、`ts/src/server/proxy` | provider 管理 REST、Anthropic↔OpenAI 协议转换、托管 qf-gateway 自动激活与凭据边界 |
| 上下文与记忆 | `ts/src/context`、`ts/src/memdir`、`ts/src/goals`、`ts/src/server/api/memory.ts` | 压缩、记忆、目标状态 |
| 工作区与文件 | `ts/src/server/api/filesystem.ts`、`ts/src/server/api/localFile.ts`、`ts/src/server/api/previewFs.ts` | 工作区、文件树/预览 REST |
| 权限与安全 | `ts/src/server/api/settings.ts`、`ts/src/server/services`、`ts/src/server/middleware` | 权限档、审批、路径与命令护栏；控制面身份与失败关闭写入 |
| 扩展系统 | `ts/src/skills`、`ts/src/commands`、`ts/src/hooks`、`ts/src/plugins`、`ts/src/server/api/skills.ts`、`ts/src/server/api/plugins.ts` | 技能/命令/hook/plugin 发现与运行时装配、扩展管理 REST |
| MCP | `ts/src/server/api/mcp.ts`、mcp 相关 services | MCP 管理 REST、配置、信任、OAuth 与工具加载 |
| 任务与子代理 | `ts/src/tasks`、`ts/src/server/api/agents.ts`、`ts/src/server/api/teams.ts` | 后台任务、子代理与团队 REST 边界 |
| 远程桥接 | `ts/src/bridge`、`ts/src/remote` | 远程控制会话数据面、消息传输与 worker 生命周期(默认托管模式不后台连接私有端点) |
| 定时任务 | `ts/src/server/api/scheduled-tasks.ts`、`ts/src/jobs` | 排程、REST 边界、执行与运行历史 |
| OAuth 与设置 | `ts/src/server/api/settings.ts`、`ts/src/server/api/haha-oauth.ts`、`ts/src/server/api/haha-openai-oauth.ts` | 偏好、Agent 权限上限、官方能力 OAuth(仅用户显式开启才连) |
| 诊断与运维 | `ts/src/server/api/diagnostics.ts`、`ts/src/server/api/doctor.ts`、`ts/src/server/api/status.ts`、`ts/src/migrations` | 诊断、Doctor 默认拒绝修复、迁移与运行状态 |
| IM 适配器 | `ts/adapters`（telegram/feishu/wechat/dingtalk/whatsapp）、`ts/src/server/api/adapters.ts` | IM 适配器 sidecar 与绑定 REST；可选依赖(如 baileys)懒加载,不阻断 server 启动 |
| 语音与口播转录 | `gateway/transcription.ts`(Fun-ASR provider)、桌面端录音/音轨上传与远程文本+时间戳契约 | 客户端录音/音轨上传、远程文本与时间戳契约、网关 Fun-ASR-Flash 转录 provider(Whisper 已退役) |
| 产品网关边缘 | `gateway/`(`app.ts` 装机公平调度+`/v1/models`+三模型路由 + `qwenChat.ts`/`mimoChat.ts`/`deepseekChat.ts`/`webSearch.ts`/`transcription.ts`/`modelCapacity.ts`)、`relay/`(幂等+归属+队列上限+重启恢复) | Qwen/MiMo/DeepSeek 三模型代理、装机公平调度、独立联网搜索、图片中转(受信 owner+幂等);真上游密钥只在服务器 |

## 产品业务层(Phase-2 重建目标)

历史台球产品域——门店知识 RAG、招聘事实源、经营工作流、生图/视频工作台——在导入的 CC-Haha 内核中尚不存在,属于在内核之上重建的目标,不在当前模块地图内以既有模块声明。重建时新增责任模块须同次更新本地图与相关 Skill,并优先落在 `ts/src/server/api` 边界 + `ts/src/server/ws/events.ts` 事件契约。

## 依赖规则

- UI 依赖功能 API/store；功能 API 依赖共享契约；不得反向依赖。
- 跨层契约没有独立 `shared` 目录，靠三条手写镜像缝：WS 事件以 `ts/src/server/ws/events.ts`（`ServerMessage`/`ClientMessage`）为单一事实源，renderer 侧 `ts/desktop/src/types/chat.ts` 镜像并注明来源；REST 契约由 `ts/src/server/api/*` handler 定义、`ts/desktop/src/api/*` 消费；IPC 契约在 `ts/desktop/electron/ipc/channels.ts` + `ts/desktop/src/lib/desktopHost/types.ts`。改契约先改事实源再同步镜像端，不得只改一侧。
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
