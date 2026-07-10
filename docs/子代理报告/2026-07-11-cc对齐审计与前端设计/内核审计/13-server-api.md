# 后端服务层/API 面/连接协议 — cc-haha 对齐审计(第三批·只读)

- spec 源:`~/Desktop/cc-haha-ref/src/server/**`(当前源码,读的是真文件不是文档)
- 现状:`/Users/swl/Desktop/球房运营AI助手-桌面版/ts/src/server/index.ts`(4802 行单体)+ `services/**`
- 方法:两边源码亲读,逐条给 file:line 证据。分类:aligned / gap / deviation / intentional-delta

---

## 0. 关键架构澄清(读代码后才明确,影响下面所有判断)

1. **cc-haha 的"server.ts"、"src/daemon/**"、"src/self-hosted-runner/**"、"server/lockfile.ts" 全是 `@generated stub from scan-missing-imports`**——ant-internal(Anthropic 内部)gated 功能在这份公开参考仓库里的占位符,不是真实可读的实现(`~/Desktop/cc-haha-ref/src/server/server.ts:1-25`、`src/daemon/main.ts:1-25`、`src/daemon/workerRegistry.ts:1-5`、`src/server/lockfile.ts:1-25` 四个文件内容几乎一样,都是同一个 Proxy stub 生成器)。这几块**不能**当规格用。cc 真正的"daemon/生命周期"就是 `src/server/index.ts` 里的 `startServer()` + `SIGTERM/SIGINT/exit` 优雅关闭,以及桌面壳 `desktop/electron/services/sidecarManager.ts` + `serverRuntime.ts`。
2. **cc-haha 的真实运行模型**:桌面 Electron 进程 spawn 一个 Bun server 子进程(sidecar),该 server 对每个会话再 spawn 一个真实 `claude` CLI 子进程,用一条**内部 loopback WebSocket**(`/sdk/:sessionId?token=...`,`src/server/index.ts:246-278`)双向通信;桌面 UI 与 server 之间也是 WebSocket(`/ws/:sessionId`),协议是 `ClientMessage`/`ServerMessage`(`src/server/ws/events.ts`),server 把 CLI stdout 的 JSON 消息翻译成 `ServerMessage` 转发(`translateCliMessage`,`src/server/ws/handler.ts:1434+`)。
3. **我们的运行模型完全不同**:没有"spawn 真实 CLI 子进程"这一层——agent 循环(harness)直接在同一个 Bun 进程内跑(in-process),会话状态是 JSONL 事件日志(`sessions.appendEvent`/`loadEvents`,带全局递增 `seq`)。WS 协议因此是**自建的事件溯源协议**(`type:'run'/'replay'/'interrupt'/'steer'/'approve'/'reject'/'ping'`,`ts/src/server/index.ts:4684-4771`),不是 cc 的 CLI-passthrough 协议。这是**架构级 intentional-delta**,不是没抄对——两边协议形状必然不同,已在代码注释里逐处标注"对齐 cc XXX 语义"(如 4698 行/4727 行/4749 行注释)。

---

## 1. 路由组织 + middleware(P5 分层重构规格)

cc-haha 分组清单(`src/server/router.ts:1-135`,switch-case 按资源分发到 `api/*.ts`):

| 分组 | cc 文件 |
|---|---|
| sessions/conversations | `api/sessions.ts` + `api/conversations.ts` |
| settings/permissions(permissions 挂在 settings 下) | `api/settings.ts` |
| models/effort | `api/models.ts` |
| scheduled-tasks | `api/scheduled-tasks.ts` |
| search | `api/search.ts` |
| agents/tasks | `api/agents.ts` |
| status | `api/status.ts` |
| teams | `api/teams.ts` |
| providers/adapters | `api/providers.ts` / `api/adapters.ts` |
| skills / mcp / plugins | `api/skills.ts` / `api/mcp.ts` / `api/plugins.ts` |
| computer-use | `api/computer-use.ts` |
| haha-oauth / haha-openai-oauth | `api/haha-oauth.ts` / `api/haha-openai-oauth.ts` |
| diagnostics / doctor | `api/diagnostics.ts` / `api/doctor.ts` |
| h5-access / activity-stats / open-targets / memory / desktop-ui / traces | 各自一个文件 |
| filesystem | `api/filesystem.ts`(独立分发,不走 router switch) |

middleware 清单(`src/server/middleware/`):`cors.ts`(`resolveCors`,按 H5 开关决定是否放行任意 origin)、`auth.ts`(`requireAuth`/`requireH5Token`,Bearer token)、`errorHandler.ts`(`ApiError` 类 + `errorResponse()` 统一错误响应)。三者在 `src/server/index.ts:127-436` 的 `fetch()` 里按路径前缀顺序应用(WS 升级 / `/sdk/` / `/callback` / `/preview-fs/` / `/local-file/` / `/api/` / `/proxy/` / `/health` / 静态 H5)。

**我们现状**:`ts/src/server/index.ts` 单体 4802 行,路由是几百个 `if (url.pathname === ...)` / `url.pathname.match(...)` 顺序判断(证据:`grep url.pathname` 命中 ~150 处,`ts/src/server/index.ts:2705-4802` 全段)。无独立 middleware 文件;CORS 内联 `withLocalCors`(单函数,免登录场景够用);无 `ApiError` 类,每条路由各自手写 `Response.json({error...}, {status})`。

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | 规模 |
|---|---|---|---|---|---|
| 路由按资源分组到独立文件 | `router.ts:32-135` | 单体 `index.ts` 全文件 | **gap**(P5 未做,已知待办) | P1 | L |
| CORS middleware | `middleware/cors.ts:83-123`(H5 origin allowlist) | `withLocalCors`(内联,单用户本地场景简化) | intentional-delta(无 H5 远程访问功能,不需要复杂 allowlist) | — | — |
| Auth middleware | `middleware/auth.ts`(Bearer/H5 token) | 无(免登录单用户,产品边界排除) | intentional-delta(例外②) | — | — |
| 统一错误类型 `ApiError`/`errorResponse` | `middleware/errorHandler.ts:7-53` | 无统一错误类,各路由手写 `Response.json`/`jsonError` 各种形状 | **gap**(错误响应形状不一致,调试/前端对接成本) | P2 | M |

**P5 重构规格结论**:若要做 P5,目标形态 = 按 cc 的资源分组(sessions/settings/models/mcp/skills/tasks/permissions/...)把 4802 行拆成 `ts/src/server/api/*.ts` + `ts/src/server/router.ts` 分发 + `middleware/{cors,errorHandler}.ts`(auth 不需要抄,免登录场景跳过)。**这是 L 级重构,未开工,维持已知待办状态。**

---

## 2. Sessions API

| 端点 | cc + file:line | 我们 + file:line | 分类 | P | 规模 |
|---|---|---|---|---|---|
| GET/POST 会话列表/创建 | `api/sessions.ts:71-83,239-253,349-380` | `GET/POST /sessions`,`index.ts:4414-4429` | aligned | — | — |
| GET 单会话详情 | `api/sessions.ts:217-219,255-261` | `GET /sessions/:id`,`index.ts:4508-4518` | aligned | — | — |
| GET 会话消息 | `api/sessions.ts:109-117,263-269` | `GET /sessions/:id/messages`,`index.ts:4519-4525` | aligned(我们多了 `after`/`limit` 分页,cc 是一把梭全量) | — | — |
| DELETE 单会话(硬删除) | `api/sessions.ts:217-229,450-462` | **缺**——只有 `action==='archive'`(软隐藏,`index.ts:4551-4559`),无真正 DELETE | **gap**(会话管理基本功能缺失:用户没法真删会话) | **P1** | M |
| PATCH 重命名会话 | `api/sessions.ts:222,992-1006` | **缺**——搜索确认无 PATCH/rename 路由(`grep renameSession` 无命中) | **gap**(重命名会话标题是聊天类产品的标配 UX,前端也未见对接) | **P1** | M |
| POST 批量删除 `batch-delete` | `api/sessions.ts:86-94,464-513` | **缺** | gap | P2 | S |
| GET 会话级模型调用 trace(`/trace`、`/trace/calls/:id`) | `api/sessions.ts:119-129,271-317` + `services/traceCaptureService.ts` | **缺**——无对应 REST(我们有 `cost-tracker.ts`/模型调用记录但未暴露查询端点) | gap(调试/审计能力缺口,非核心功能) | P2 | M |
| GET `/git-info`(分支/仓库名/改动文件数) | `api/sessions.ts:131-139,796-873` | **缺** | gap(桌面 UI 若要显示 git 分支状态,目前拿不到) | P2 | S |
| POST `/rewind`(+`turn-checkpoints`、`turn-checkpoints/diff`) | `api/sessions.ts:141-149,161-171,875-990` + `services/sessionRewindService.ts` | 有:`rewindMatch`(`index.ts:4563+`)+ `SessionRewindService`(`ts/src/server/services/sessionRewindService.ts`,本会话刚被修改过) | aligned(我们的存储走 append-only branch 模型,cc 走 git-worktree diff,底层机制不同但对外行为对齐) | — | — |
| POST `/branch`(从某条消息 fork 出新会话) | `api/sessions.ts:151-159,897-947` | `POST /sessions/:id/fork`(`index.ts:4432-4441`,注释明写"对齐 cc --fork-session") | aligned | — | — |
| GET `/slash-commands`(单会话可用命令) | `api/sessions.ts:173-181,549-562` | **缺** 专用端点(命令清单走全局 `/commands`,非会话态) | deviation-low(我们的命令是静态技能包而非 CLI init 动态上报,场景不同) | — | — |
| GET `/inspection`(usage/context/mcp/tools 综合探针) | `api/sessions.ts:183-191,564-708` | **缺** | gap(桌面"会话详情/用量"面板若要做,目前没有单一探针端点,得拼好几个) | P2 | M |
| GET `/workspace/{status,tree,file,diff}`(浏览会话工作区文件树+读文件+diff) | `api/sessions.ts:193-201,319-347,415-440` + `services/workspaceService.ts` | 部分覆盖:`/api/v1/agent/fs/list`+`/fs/read`(`index.ts:3936-3963`,纯扁平目录列表,无 git diff、无按 session 沙箱限定)+ `/api/v1/agent/file-diff`/`file-restore`(`index.ts:4200-4209`,基于自动备份而非 git) | **gap**(cc 的"浏览这个会话改过哪些文件+diff"是完整树形浏览器,我们只有扁平 ls + 单文件 diff,树浏览缺失) | P1 | M |
| GET `/recent-projects` | `api/sessions.ts:96-99,1036-1147`(30s 缓存) | `GET /sessions/projects`(`index.ts:4409-4412`,`sessions.recentProjects`) | aligned | — | — |
| GET `/repository-context`(git worktree 启动上下文) | `api/sessions.ts:101-104,382-393` | **缺**(我们没有"从已有 git 仓库启动会话"这个产品功能) | intentional-delta(我们无 git-worktree 会话启动特性,产品未做这个) | — | — |
| GET `/preview-fs/:sessionId/*`(把会话工作区当静态站点预览,浏览器里直接渲染 agent 写的网页) | `server/index.ts:291-318` + `api/previewFs.ts` | **缺** | gap(如果台球/通用 Agent 产出 HTML 之类想直接预览,目前没有这条通道) | P2 | M |
| GET `/local-file/*`(把任意本机绝对路径文件当静态资源服务,给 `file://` 链接用) | `server/index.ts:320-342` + `api/localFile.ts` | **缺**专用端点(有 `/uploads/` 静态服务但只服务 App 自己生成的产物目录,非任意本机路径) | gap(agent 若引用本机任意文件路径,前端打不开预览) | P2 | S |

---

## 3. Messages/Chat REST(conversations.ts)

cc 的 REST chat 端点是 WS 之外的"入队+轮询状态"备用通道:`POST /api/sessions/:id/chat`(入队,202)、`GET .../chat/status`、`POST .../chat/stop`(`api/conversations.ts:1-147`)。

我们没有对应的"REST 入队"三件套,但有功能等价的 **`POST /agent/run`**(`index.ts:4638-4658`,SSE 流式返回一整个回合,`server.timeout(req,0)` 关闭空闲断连)。

| 行为点 | 分类 | 说明 |
|---|---|---|
| REST 发消息(非 WS) | intentional-delta | cc 是"入队+WS 单独推流",我们是"POST 即拿 SSE 流"——都不依赖 WS,但形状不同,前端目前走的是 WS(`type:'run'`),`/agent/run` 更像是给非浏览器 API 消费者(未来 CLI/脚本化)用的旁路,尚不确定是否已接前端。 |
| chat status 轮询 | gap | 无独立 status 查询端点;我们的状态靠 WS 推送或读 session meta(`sessions.get`)里的字段,没有 cc 那种显式 idle/thinking/compacting 状态机查询点。 | 

---

## 4. Approvals(审批)

| 行为点 | cc + file:line | 我们 + file:line | 分类 |
|---|---|---|---|
| WS 权限请求/响应 | `ClientMessage: 'permission_response'`(`ws/events.ts:14-22`)+`handlePermissionResponse`(`ws/handler.ts:619-634`) | WS `type:'approve'`/`'reject'`(`index.ts:4749-4769`) | aligned(动词不同,语义一致:放行执行 / 拒绝并记拒绝追踪) |
| Computer-use 权限(应用授权弹窗) | `computer_use_permission_response`(`ws/events.ts:23-27`) | 无(我们没有"电脑控制/授权特定 App 权限"这个 macOS Computer Use 特性) | intentional-delta(产品未做 computer-use) |
| REST 审批端点 | **cc 没有**——审批只能走 WS | 我们**多一条** REST 路:`POST /api/v1/agent/execute`(`index.ts:4065-4071`,与 WS `approve` 共用同一 `runApprovedTool`)+ `POST /api/v1/agent/reject`(`index.ts:4071-4077`) | aligned-plus(我们比 cc 多一条 REST 通道,双通道共用同一核心函数,无重复实现) |
| 权限模式切换(session 级 default/plan/acceptEdits/bypassPermissions) | WS `set_permission_mode`(`ws/handler.ts:652-730`,决定是否需要重启 CLI 子进程) | body 参数 `permissionMode`(各路由,如 `index.ts:2122,2174,2522`)+ 无子进程可重启(in-process 循环,无需重启逻辑) | aligned(语义等价,机制因架构不同而简化——我们没有子进程重启这个成本) |
| 全局默认权限模式 GET/PUT | `GET/PUT /api/permissions/mode`(`api/settings.ts:9-10,191-208`) | **缺**——我们的 `/api/v1/agent/permissions/persist`(POST,`index.ts:4038-4048`)+`/permissions/rules`(GET,`index.ts:4048-4053`)是"规则持久化"而非"单一全局默认档位" | gap/deviation(功能上被规则持久化部分覆盖,但没有一个"当前默认模式是什么"的简单读点) | P2 | S |

---

## 5. Settings

| 行为点 | cc + file:line | 我们 + file:line | 分类 |
|---|---|---|---|
| 合并设置 GET | `GET /api/settings`(`api/settings.ts:62-65`) | `GET /api/settings`(`index.ts:3968+`) | aligned |
| user/project 分层设置 | `GET/PUT /api/settings/{user,project}`(`api/settings.ts:67-71,93-122`) | **缺**分层——我们是单一 `userSettings` 存储(`services/userSettings.ts`),无"project-scoped 设置覆盖"概念 | intentional-delta(我们是单租户桌面 App,没有 cc 那种"每个 git 项目独立配置"的多项目模型) |
| output-style(s) | `GET/PUT /api/settings/output-style(s)`(`api/settings.ts:73-77,124-189`) | `/api/v1/agent/output-styles`(`index.ts:3441-3447`) | aligned(需 GET/PUT 双向确认,粗看只见 GET,PUT 未逐字核实——标记待核实) |
| cli-launcher 状态 | `GET /api/settings/cli-launcher`(`api/settings.ts:79-81`) | 不适用(我们无"桌面外还能装一个命令行版"的双装形态) | intentional-delta(产品形态不同,我们只有桌面壳无独立 CLI 分发) |

---

## 6. MCP

cc:`GET /api/mcp`(列表)、`GET /api/mcp/project-paths`、`GET /api/mcp/:name/status`、`POST /api/mcp`(新建)、`PUT /api/mcp/:name`(更新)、`DELETE /api/mcp/:name`、`POST /api/mcp/:name/toggle`、`POST /api/mcp/:name/reconnect`(`api/mcp.ts:624-677`)。

我们:`GET /api/v1/agent/mcp`(`index.ts:3476`)+ `mcp/presets`(`3895`)+`mcp/trust`(`3900`,GET/DELETE)+`mcp/add`(`3912`)+`mcp/remove`(`3918`)+`mcp/toggle`(`3924`)。

| 行为点 | 分类 | 备注 |
|---|---|---|
| 列表/新增/删除/开关 | aligned | 动词形状不同(cc 走 REST 语义 PUT/DELETE + path 参数,我们走扁平 POST + body 参数),行为覆盖一致。 |
| `reconnect` 单动作 | gap | 未见对应端点,可能靠 toggle off→on 顶替,未逐字确认。 | 
| `project-paths`(按项目路径分域显示私有 MCP) | intentional-delta | 我们无多项目模型(同上 settings 结论),这个维度不适用。 |

---

## 7. Commands(斜杠命令)

cc:没有独立顶层 `/api/commands`;命令清单来自 CLI `system/init` 消息上报的 `slash_commands` 字段(运行时动态,`ws/handler.ts:1315-1318`)+ `skills.ts` 里技能贡献的命令兜底(`sessions.ts:522-562` 的 `mergeSessionSlashCommands`)。

我们:`(?:api/)?commands(?:/expand)?`(`index.ts:4369`)+ `/api/v1/agent/commands`(`index.ts:3455`)——静态技能包驱动(bundled 技能 md → 命令清单),与"斜杠 = 技能底座"架构一致(CLAUDE.md 已有此设计)。

| 分类 | 备注 |
|---|---|
| intentional-delta | 两边"命令从哪来"的模型完全不同(cc 是运行时 CLI 上报,我们是静态技能包扫描),但对外都是"给一个可展示的命令列表",行为目标一致,不是缺口。 |

---

## 8. Models

| 行为点 | cc + file:line | 我们 + file:line | 分类 |
|---|---|---|---|
| GET 模型列表 | `GET /api/models`(`api/models.ts:166-221`) | 未见独立"全部可选模型列表"端点,`/model` GET 返回的是"当前状态"(`index.ts:3403-3406`) | gap(前端切模型下拉框若要展示可选项,需另一条路,未核实来源) | P2 | S |
| GET/PUT 当前模型 | `GET/PUT /api/models/current`(`api/models.ts:223-321`) | `GET/POST/PATCH /model`(`index.ts:3403-3425`,按 `providerId` 切换而非 `modelId`) | deviation(我们是"切换 provider 档位"而非"切换具体模型 id + context tier",与我们自己的 BYOK/provider profile 架构一致——intentional-delta 更准确) |
| effort(思考强度档位 low/medium/high/max) | `GET/PUT /api/effort`(`api/models.ts:323-346`) | **缺** | intentional-delta 倾向(该概念绑定 Claude/Anthropic API 的 extended thinking 预算字段,"永不接 Claude"铁律下,是否有等价 MiMo 概念未核实;若某模型确有类似档位,才算真 gap) | P2 | S |
| 清模型健康度缓存 | 无对应 | `POST /model/health/clear`(`index.ts:3393-3401`) | 我们独有(aligned-plus,处理多 key/多网关健康探测,cc 无此层) |

---

## 9. Files(文件系统)

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | 规模 |
|---|---|---|---|---|---|
| 目录浏览(DirectoryPicker) | `GET /api/filesystem/browse`(`api/filesystem.ts`,含 `.gitignore` 过滤) | `GET /api/v1/agent/fs/list`(`index.ts:3936-3950`,纯 `readdir`,过滤隐藏文件,无 gitignore) | deviation(功能子集,gitignore 过滤缺失,大仓库浏览体验会差一些) | P2 | S |
| `@`-触发文件名/内容搜索(ripgrep) | `GET /api/filesystem/browse?...`(用 `ripGrep` 工具,`api/filesystem.ts` 引入 `../../utils/ripgrep.js`) | **缺**——我们无 `@` 文件搜索弹窗对应后端能力 | **gap**(输入框 `@` 提及文件是常见 coding-agent UX,目前后端没有搜索原语) | **P1** | M |
| 服务图片文件(`/api/filesystem/file`) | `api/filesystem.ts:87-105` | **缺**专用端点(`/fs/read` 只读文本,遇图片会当文本读坏) | gap | P2 | S |
| 全局工作区文本搜索 | `POST /api/search`(`api/search.ts`) | **缺**通用版(有 `/api/v1/store-docs/search`,但那是台球领域 RAG 检索,非通用工作区搜索) | gap(通用 Agent 场景下"搜一下这个项目里哪里提到 X"目前没有端点) | P2 | M |
| 会话历史全文搜索 | `POST /api/search/sessions`(`api/search.ts`) | **缺** | gap(想在几十个历史会话里关键词找一条,目前只能前端拉全量自己搜) | P2 | M |

---

## 10. Tasks(后台任务)

| 行为点 | cc + file:line | 我们 + file:line | 分类 |
|---|---|---|---|
| 列表/详情/取消 | `GET /api/tasks`,`/api/tasks/lists/*`(`api/agents.ts:122-182`) | `GET /tasks`,`GET/POST /tasks/:id(/events|cancel|background)`(`index.ts:4443-4501`) | aligned(我们多一个 `background`前台转后台的动作,cc 无对应——aligned-plus) |
| Agent(subagent 定义)CRUD | `GET/POST/PUT/DELETE /api/agents(/:name)`(`api/agents.ts:32-120`,桌面 UI 可视化增删改自定义 subagent) | **缺**——`loadAgentsDir`(`ts/src/agents/agentLoader.ts:134`)只读加载 `.claude/agents/*.md`,**无 REST CRUD**,只能手改文件 | **gap**(如果产品打算让用户在 UI 里新建/编辑自定义子代理,目前后端完全没有这层;若产品不打算做这个 UI,则是 out-of-scope 而非 gap——需 owner 确认产品意图) | **P1**(若在路线图内)/ 不适用(若不在) | M |

---

## 11. Permissions(权限规则)

cc:权限规则本身(allow/deny/ask 列表)不是通过顶层 REST 管理的,是通过 CLI 的 `permissionUpdates`(WS `permission_response` 带的 `permissionUpdates` 字段,`ws/events.ts:19-21`)持久化进 `settings.json`;顶层 REST 只暴露"当前默认模式"(见第 4 节)。

我们:`POST /api/v1/agent/permissions/persist`(`index.ts:4038-4048`)+ `GET /api/v1/agent/permissions/rules`(`index.ts:4048-4053`),配合 `ts/src/permissions/permissionsSettings.ts` 的 `loadPermissionRules`/`persistPermissionRule`。

| 分类 | 备注 |
|---|---|
| aligned-plus | 我们把规则管理做成了显式 REST 端点(cc 是"顺带在 WS 响应里捎带更新"),更透明、更易测试;是我们比 cc 更规范的一处。 |

---

## 12. 连接协议细节

### 12.1 WS 消息类型对照

| cc `ClientMessage`(`ws/events.ts:11-31`) | 我们对应(`index.ts:4684-4771`) | 备注 |
|---|---|---|
| `user_message` | `type:'run'` | 语义等价:发起/继续一个回合 |
| `permission_response` | `type:'approve'`/`'reject'` | 拆成两个动词,更明确 |
| `set_permission_mode` | body 参数走 `run`/其它请求(无独立 WS 消息类型) | deviation-low:cc 有专门消息+"是否要重启子进程"的复杂判定(`shouldRestartForPermissionMode`,`ws/handler.ts:691-697`);我们无子进程重启成本,所以没有对应复杂度——**不是缺口,是架构简化后的合理省略** |
| `set_runtime_config`(切 provider/model,决定是否重启) | `/model` REST(见第 8 节)+ 会话内 body 参数 | 同上,机制因架构不同而简化 |
| `stop_generation` | `type:'interrupt'` | aligned |
| `prewarm_session`(预热 CLI 子进程,省首条消息等待) | **缺** | intentional-delta(我们无子进程可预热;in-process 循环启动成本可忽略,这项优化对我们不适用) |
| `ping` | `type:'ping'` → `pong` | aligned(注释明写"对齐 cc ws/handler ping/pong",`index.ts:4698-4701`) |
| （无对应,cc 没有） | `type:'steer'`(运行中插话纠偏)、`type:'replay'`(seq+after 重放) | **我们独有** |

### 12.2 断连重放(seq+after)

- **cc:没有通用的"任意 seq 之后重放"机制**。WS `open()` 只做一件重放相关的事:`replayPendingPermissionRequests(ws, sessionId)`(`ws/handler.ts:212`,只重放"断连时还悬着的权限请求卡片",不重放完整消息历史);完整历史靠客户端另发 `GET /api/sessions/:id/messages` REST 请求全量拉取。
- **我们:一等公民的 seq+after 重放**——`ws.data.after`(连接时可带 URL 参数,`index.ts:3195-3196`)+ `type:'replay'` 消息(`index.ts:4707-4713`)+ `replayWsEvents()`(`index.ts:2024-2033`,读 JSONL 事件日志按 `seq` 游标增量重放)。事件本身也支持走 SSE(`GET /sessions/:id/events?format=sse`,`index.ts:4532-4537`)。

| 分类 | 备注 |
|---|---|
| aligned-plus | 我们的事件溯源架构(JSONL + 全局 seq)天然支持通用断点续传重放,比 cc 的"REST 全量 + WS 只重放权限卡片"更完整、更省流量。这是架构差异带来的优势,不是对齐缺口。 |

### 12.3 断连宽限期(disconnect grace)——**发现真实行为偏差**

- **cc(`ws/handler.ts:277-308`)**:客户端断连时,若回合仍在跑,**永不中止该回合**——只是"记下来,等回合自然跑完后再启动空闲宽限计时器去杀掉已经空闲的 CLI 子进程"(`watchTurnCompletionForCleanup`)。宽限期只用来回收**空闲**资源,从不打断**进行中**的生成。这是 cc 明确修过的 bug(代码注释提到 issue #764:不能因为"手机锁屏"就杀掉正在跑的任务)。
- **我们(`ts/src/server/turnConsumerTracker.ts:29-47`)**:客户端断连后,消费者计数归零则起一个 `graceMs`(默认 5 分钟,`index.ts:1076-1084`,`QF_TURN_ABANDON_GRACE_MS` 可配)定时器;**若宽限期到时回合仍在跑,直接 `abort` 中止该回合**(`turns.interrupt(id)`)。
- 代码注释写的是"对齐 cc disconnectGrace"(`index.ts:1075`),但实际语义是反的:cc 从不因断连宽限杀活跃回合,我们会。5 分钟默认值缓解了大部分短暂断连场景,但断连超过 5 分钟(合上笔记本盖、手机切后台被系统杀死网络等)会导致我们**主动打断用户正在跑的任务**,而 cc 在同样场景下**永远让它跑完**。

| 分类 | P | 规模 |
|---|---|---|
| **deviation**(注释声称对齐,实际语义相反;5 分钟默认值是缓解但不是修复) | P1 | S(改法:sessions 断连后只清理"已完成/空闲"的资源,不再对**运行中**的回合下 `abort`,对齐 cc 的"永不打断活跃回合"原则) |

---

## 13. Daemon / 生命周期(桌面壳侧)

对比对象:cc `desktop/electron/services/sidecarManager.ts`(404 行,真实文件,非 stub)+ `serverRuntime.ts` vs 我们同路径同名文件(232 行)。

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | 规模 |
|---|---|---|---|---|---|
| 端口选择(优先复用) | `reserveServerPort`(`sidecarManager.ts:93-103`) | `reserveServerPort`(`sidecarManager.ts:36-42`) | aligned(逻辑同构:优先复用→随机兜底) |
| **端口跨重启粘滞落盘**(sticky port state file) | `readLastServerPort`/`writeLastServerPort` + `SERVER_STATE_FILE='desktop-server-state.json'`(`sidecarManager.ts:134-165`,与 Tauri 壳共享同一状态文件,issue #767) | **无**——我们代码注释自认:"首选端口(固定/上次)优先,全占了回落随机——起步版,**sticky 落盘是 W13**"(`sidecarManager.ts:35`) | **gap(已知待办,W13 未开工,今日确认仍未做)** | **P1** | S |
| 就绪探测(waitForServer) | 真实 `fetch('/health')` + 校验 `Content-Type: application/json` + `body.status==='ok'`(`sidecarManager.ts:167-208`) | 仅原始 TCP `net.connect` 探测端口是否可连(`sidecarManager.ts:44-60`),不验证进程是否真正就绪可处理请求 | **gap**(端口能连≠服务器已初始化完成,存在"连上了但请求打过去还没准备好"的窗口期风险) | P2 | S(改法:直接把我们已有的 `/health` 端点接进来,和 cc 一样做 JSON 校验,工作量很小) |
| 启动失败时的诊断日志 | `pushStartupLog`/`formatStartupError`(`sidecarManager.ts:214-226`)+ `serverRuntime.ts:144-162` 的 `captureLogs` 把 sidecar stdout/stderr 缓存起来,启动失败时整段附进错误消息给用户看 | **无**——搜索确认我们代码库里没有 `pushStartupLog`/`captureLogs`/`formatStartupError` 等价物 | **gap**(sidecar 起不来时用户/开发者拿不到"最近日志"辅助定位,只能看一句笼统报错) | P2 | S/M |
| 系统代理透传(HTTP_PROXY 合并 + loopback NO_PROXY 排除) | `mergeProxyEnv`/`proxyUrlFromElectronProxyRules`(`sidecarManager.ts:228-283`) | 未在 `sidecarManager.ts` 中发现同名逻辑(可能在别处实现,未逐一排查全部 desktop 目录) | 待核实(不确定是否已用其它方式覆盖) | — | — |
| 崩溃自动重启(带退避) | **cc 没有**——`serverRuntime.ts:144-162` 的 `captureLogs` 只记录 exit 事件,**不重启**主 server 子进程(只有用户手动触发的 `restartAdaptersSidecars` IPC,针对 IM adapter 子进程) | **有**——`SidecarSupervisor` 类(`sidecarManager.ts:148-231`):意外退出自动按指数退避重启,滚动窗口封顶防雪崩,健康存活一段时间后重置计数 | **我们独有,aligned-plus**(这块我们比 cc 更健壮,不是缺口) | — | — |
| IM adapter 子进程(飞书/Telegram/企微/钉钉/WhatsApp) | `createAdapterPlan`+`startAdaptersSidecars`(`sidecarManager.ts:345-368`,`serverRuntime.ts:112-136`) | 无 | intentional-delta / out-of-scope(我们的产品定位不做多 IM 平台适配器,不是缺口) | — | — |
| 绑定地址 | `SERVER_BIND_HOST='0.0.0.0'`(配合 H5 远程访问功能) | `SERVER_BIND_HOST='127.0.0.1'`(仅本机回环) | intentional-delta(我们无 H5 远程访问功能,绑回环更安全,符合"全本地"产品边界) | — | — |
| 优雅关闭(SIGTERM/SIGINT/exit 杀会话子进程) | `index.ts:466-521`(`stopServerRuntimeForShutdown`,等所有 CLI 子进程退出或强杀) | 未在 `server/index.ts` 内发现顶层 SIGTERM/SIGINT 处理(推测在 Electron 主进程/`app.stop()` 回调里做等价清理,`index.ts:4785-4800` 的 `app.stop` 覆写会 stop scheduledTasks/assets/bridge 等) | 大体 aligned,但未在 sidecar 二进制自身找到信号处理,**信号处理层级待核实**(可能由 Electron 主进程发信号杀 sidecar 子进程,而非 sidecar 自己监听 SIGTERM) | 待核实 | — | — |

---

## 14. UDS 跨会话 IPC ——第三批遗留题结论

### 事实

1. **cc-haha 完全没有基于 UDS(Unix Domain Socket)的跨会话/跨进程 IPC**(`grep node:net` 命中的 5 个文件——`upstreamproxy/relay.ts`、`utils/ide.ts`、`chromeNativeHost.ts`、`ssrfGuard.ts`、`oauth/auth-code-listener.ts`——均与"跨会话消息"无关)。
2. cc 的"team"(多 agent 协作)跨进程通信靠**两条路**:
   - 同一 server 进程内直接管理的会话:`teamService.sendMemberMessage()` 走**同进程函数调用**(`api/teams.ts:50-59`),因为该 server 进程本来就持有所有它 spawn 出来的 CLI 子进程的引用(`conversationService` 的 session map)。
   - server 没有 spawn、用户在终端里独立跑起来的外部 `claude` CLI(team 成员可以是这种):靠**文件系统**——写入共享 JSONL(`~/.claude/teams/<team>/...`)+ `teamWatcher.ts` 用 `fs.watch` 轮询变化再推 WS,不用任何 socket。
   - 唯一真正跨进程的 socket 通信,是 server ↔ 它自己 spawn 的 CLI 子进程之间的**loopback WebSocket**(`/sdk/:sessionId?token=...`,`server/index.ts:246-278`),不是 UDS,是普通 TCP loopback + 一次性 token 鉴权。
3. **我们有一整套 UDS 机制**:`ts/src/tasks/udsPeerRegistry.ts`(JSON 文件锁存的 peer 注册表,含 socket 存在性探活)+ `udsInbox.ts`(每个会话可选起一个 `node:net` Unix socket server,把收到的文本包成 `<cross-session-message>` 塞进 steering inbox)+ `udsClient.ts`(拨号发送)+ `teamTools.ts` 的 `send_message` 工具用 `parsePeerAddress` 区分 `uds:`/`bridge:` 两种 target scheme。这套机制显然是在实现 **Claude Agent SDK 的 SendMessage 工具语义**(让一个 agent 会话能给另一个——可能是后台/分离的——agent 进程发消息),对标对象其实不是 cc-haha 的 team 功能,而是 Agent SDK 本身的跨代理通信原语。

### 评估:该收敛还是保留?

**倾向收敛,但不紧急**,理由:

1. cc 证明了"同机跨进程 agent 通信"根本不需要裸 socket——loopback WS(带一次性 token)就够用,而且我们自己的 server **本来就已经在跑一个 HTTP+WS 服务**,给它加一个"给指定 conversationId 推一条 steering 消息"的 token 门控端点,和现有 UDS inbox 做的事完全一样,却不用多维护一个 socket 监听器 + 一份独立的 JSON peer 注册表(文件锁、探活、序列化)。
2. 我们目前是**两套并行的 peer 注册/寻址机制**同时存在——`udsPeerRegistry`(本地 socket)和 `bridgePeerRegistry`(看 `teamTools.ts:36-43` 的 `TeamToolsOptions`,`bridgePeers`/`sendBridgeMessage` 是我们自己的跨设备/远程桥接系统)——两者都在解决"往一个 target 发消息"这同一件事,只是覆盖的物理拓扑不同(本机 vs 远程)。这是可辨认的重复维护面:两份注册表、两套探活逻辑、`send_message` 工具里要同时认 `uds:`/`bridge:` 两种 scheme。
3. 保留 UDS 的合理理由也存在,不能一刀切:Unix socket 文件权限(0700 目录 + socket 文件)是比"loopback WS + URL 里的 token"更强的本机专属边界(不会因为端口被其它本机进程扫到就有可乘之机);且 UDS 不占用 TCP 端口,不受"端口被占用/防火墙拦截回环端口"这类环境问题影响。

**建议**:不是"必须现在就改"的紧急项,但下次真的要动"后台/分离子进程"这块时,建议评估把 UDS 收敛进 bridge 体系(bridge 本来就是我们自己的通用 peer 抽象),对内网本机 peer 复用 bridge 的同一套注册/寻址 API,底层传输层再选择"本机走 loopback WS token 通道"还是"继续用 UDS 文件权限"——**核心是别让 `udsPeerRegistry` 和 `bridgePeerRegistry` 两份互相不知道对方存在的注册表长期并存**,这是真实的重复代码/维护面,cc 的证据(它完全不需要独立 socket 层)支持这个收敛方向。

---

## 15. 已知待办核对结果

| 待办 | 状态 | 证据 |
|---|---|---|
| **P5 分层重构**(单体 index.ts 拆分) | **未做,规格已给出(第 1 节)** | `ts/src/server/index.ts` 仍是 4802 行单体,~150 处 `url.pathname` if 判断,无 `api/*.ts` 拆分、无 `router.ts`、无独立 middleware 文件 |
| **UDS 评估**(收敛回 in-process+bridge 还是保留) | **评估完成,倾向收敛但不紧急(第 14 节)** | cc 无 UDS 等价物;我们有 `udsPeerRegistry`+`bridgePeerRegistry` 两套并行注册表,存在重复维护面 |
| **双前缀路由**(裸 `/sessions` 与 `/api/sessions`) | **确认存在,范围比预想小,标 deviation-low** | 只找到 2 处显式双前缀正则:`(?:api/)?commands`(`index.ts:4369`)、`(?:/api)?/sessions/:id/(turn-checkpoints|rewind)`(`index.ts:4563`)。注意:我们**没有**通用的 `/api/sessions` 前缀——绝大多数 session 端点只有裸 `/sessions` 一种形状(`/sessions`、`/sessions/:id`、`/sessions/:id/fork` 等),只有 rewind/turn-checkpoints 这两个端点显式同时接受两种前缀,commands 也一样。不是"到处都双前缀",是两处历史遗留的兼容层,风险很低,可以不用专门治理。|

---

## 附:分类计数

- **aligned**:~18 条(sessions CRUD 核心、fork/rewind、tasks、mcp 增删改查、approvals 语义、ping/pong、recent-projects 等)
- **aligned-plus**(我们比 cc 更完整/更规范):~6 条(REST 审批双通道、seq+after 通用重放、权限规则显式 REST、SidecarSupervisor 自动重启、后台任务 background 动作、模型健康度清理)
- **gap**:~20 条(见上表,集中在:会话管理 DELETE/PATCH/batch-delete、workspace 文件树浏览、`@`文件搜索、通用工作区/会话历史搜索、trace/git-info/inspection 探针、subagent CRUD、sticky port、健康检查深度、启动失败诊断日志)
- **deviation**:3 条(断连宽限期语义相反、fs/list 无 gitignore 过滤、models 切换维度不同)
- **intentional-delta**:~15 条(架构级:WS 协议整体、多项目/project-settings、H5 远程访问、IM adapter、computer-use、git-worktree 会话启动等)

## P0/P1 清单(供快速排期)

- **P0**:无(本次审计未发现"当前会崩/数据丢"级别的 P0)
- **P1**(6 条):① 断连宽限期语义反了(第 12.3 节,S) ② 会话 DELETE/PATCH/batch-delete 缺失(第 2 节,M) ③ workspace 文件树浏览缺失(第 2 节,M) ④ `@`文件搜索缺失(第 9 节,M) ⑤ sticky port 未落地/W13 仍未开工(第 13 节,S) ⑥ subagent CRUD 缺失,待 owner 确认是否在产品路线图内(第 10 节,M)
