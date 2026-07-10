# 前端架构盘点 — 现状 + 前后端边界缺口(为 WorkBuddy 长相 + cc-haha 交互融合重设计打底)

> 只读盘点,基于工作树现状(未提交改动已计入)。核对时间:本次会话。
> 判据:「真做了」= 有真实数据流(接后端/WS/IPC 且有交互结果);「占位」= 组件存在但无 onClick/无数据源;「死」= 完全没有对应代码。

---

## 1. 前端模块现状表(renderer-react)

### 1.1 stores/
| 文件 | 行数 | 状态 | 说明 |
|---|---|---|---|
| `stores/chatStore.ts` | 420 | **真做了(核心地基,风险最高)** | 唯一吃满 `/agent/ws` 协议的地方;6 型 ChatBlock;`reduceEvent` switch 里 `default` 分支明确注释「tool_progress / todo_update / ask_question 等本切片先不渲染」——**3 类后端事件被静默吞掉** |
| `stores/sessionStore.ts` | 24 | 真做了(最小) | 只对接 `GET /sessions`,无分页/无项目分组/无删除/无重命名 |
| `stores/settingsStore.ts` | 24 | **半成品** | 纯前端内存态(`defaultPermissionMode`/`enabledPacks`/`workspaceRoot`),**从不读写后端 `/api/settings`**(vanilla app.js 有 `loadSettings()`,React 没有);`workspaceRoot` 无任何 UI 能设置它(见 1.4) |
| `stores/tabStore.ts` | 50 | 真做了(最小) | 只有 `session`/`settings` 两种 tab 类型,`settings` 类型打开后 ContentRouter 仍回退渲染 `EmptySession`(见 1.2) |
| `stores/uiStore.ts` | 52 | 真做了 | 主题(light/dark/system)+ localStorage 持久化,完整 |

### 1.2 layout/ 与路由
| 组件 | 状态 | 说明 |
|---|---|---|
| `AppShell.tsx` | 真做了 | bootstrap 顺序(IPC 拿地址→health→刷会话→自恢复/开新会话)对齐 cc,含 connecting/error 兜底页 |
| `Sidebar.tsx`(8 板块) | **7/8 是死按钮** | 只有「新建任务」`onClick={openNewConversation}` 真做;「助手/项目/专家/自动化/更多」5 个 `NavItem` 无 `onClick`;顶部搜索/筛选、底部通知铃铛都是无绑定的 `ToolBtn`;任务列表/空间列表是真数据(接 sessionStore),但空间列表(`sidebar.spaceGuide`)是写死一条静态按钮无点击效果 |
| `TabBar.tsx` | **写好但未接线** | 组件本身逻辑完整(切换/关闭),但 `AppShell.tsx` 里**根本没有 `<TabBar/>`**,永远不渲染(架构文档已标注此点) |
| `ContentRouter.tsx` | **占位路由** | 只有 `case 'session'` 真分发;`case 'settings'` 显式注释"Block F 接管"、当前回退 `EmptySession`;无 `scheduled`/`trace`/`workbench` 分支(tabStore 的 `TabType` 目前也只声明了 `session`/`settings` 两种,加新页面要先扩类型) |
| `TopBar.tsx` | **4 个按钮全死** | 搜索/分享导出/历史/预览面板(`IconPanelRight`)四个 `IconBtn` 均无 `onClick`——**右侧预览面板的开关入口本身就是摆设** |

### 1.3 chat/ 组件
| 组件 | 状态 | 说明 |
|---|---|---|
| `Composer.tsx`(273 行,当前实际输入框) | **半成品** | 自增高/权限菜单/发送-插话/中断 真做;`ModelMenu` 写死只显示「自动」一项,无真实模型切换;`/` 斜杠面板**硬编码 3 项**(`/台球` `/帮助` `/清空`),不调 `GET /api/v1/agent/commands`(该端点后端已存在且 vanilla app.js 有完整动态加载+排序+缓存实现);`@` 面板固定显示「即将支持」,纯占位;附件按钮 `IconPlus` 无 `onClick`(无文件/图片上传通道);麦克风按钮无 `onClick`(无语音输入,后端已有 `/api/v1/voice/transcribe`) |
| `ChatInput.tsx`(79 行) | **死代码** | 全仓库 grep 无任何引用点(`App.tsx`→`AppShell`→`ActiveSession`→`Composer`,链路里从未 import `ChatInput`);是被 `Composer.tsx` 取代后遗留的旧文件 |
| `MessageList.tsx` | 真做了(最小) | 渲染 6 种 block;`scrollIntoView` 每次变化都触发,**没有 vanilla 那套"仅在贴底时才跟随+上滚即停+回到最新药丸"的智能滚动**(vanilla `app.js` 完整实现,React 未搬) |
| `ToolCallCard.tsx` | **半成品** | 只有折叠+状态图标+纯文本 `<pre>` 输出;**不解析 `<file_change path="...">` 标签**(fileWriteTool/fileEditTool/spreadsheetTool/notebookEditTool 的工具结果里都嵌了这个标签),**不渲染 diff**(vanilla `diffFromArgs`/`renderUnifiedPatch` 完整实现,React 无对应物) |
| `ApprovalCard.tsx` | 半成品 | what/why/impact + warning + rememberable 三态齐全,但**审批卡内无 diff**(vanilla 有,是 CLAUDE.md §6.5 铁律"审批卡内 diff"明确要求的) |
| `MessageActions.tsx` | 真做了(样式级) | 复制/点赞/点踩/朗读 有真实行为;分享(`IconShareUp`)、更多(`IconMoreHorizontal`)两按钮无 `onClick`,纯装饰 |
| `MarkdownRenderer.tsx` | **最小版,组件自注释"Block A 会替换"** | 只有 `marked + DOMPurify`;无代码高亮(cc 用 shiki,vanilla app.js 有手写代码卡片+复制按钮+行数/语言/文件名);无 mermaid/katex/diff 渲染。`package.json` 里确认**没装 shiki/mermaid/katex/react-diff-viewer** |
| `StreamingIndicator.tsx` | 未细读,17 行小组件 | 对齐 vanilla 的运行指示 pill(动词+计时+token 估算),需核实是否有计时器逻辑,规模判断是简化版 |

### 1.4 8 个组件目录纯占位
`components/{browser,controls,plugins,settings,skills,tasks,workbench,workspace}/placeholder.ts` — **每个文件都只有两行 `// 占位… export {}`**,无任何真实组件。对应能力现状:
- **workbench/workspace**(右侧预览面板):TopBar 的开关按钮是死的,组件目录是空的 → **整个右侧预览面板 = 0%**,而 vanilla app.js 反倒有完整实现(见 §2)
- **settings**(设置页):`ContentRouter` 的 `settings` tab 分支占位回退,组件空 → 无设置页,`/api/settings` 读写、BYOK、模型选择、权限持久化全部无 UI
- **tasks**(后台任务/自动化/定时任务):无 UI,`GET /tasks`、`/api/v1/scheduled-tasks` 均无消费方
- **skills/plugins**(技能市场/MCP 连接器):无 UI,`/api/v1/agent/skills`、`/api/v1/agent/mcp*`、`/api/v1/agent/plugins*` 均无消费方
- **browser**(预览面板里的原生浏览器 surface,点选就地改):无 UI,对应 `docs/plans/cc-haha右侧预览面板-对标与落地方案.md`(task#17,🚧进行中)整份方案尚未落地为代码
- **controls**(如"模式选择器"之类,导航规划文档 `pages/EmptySession + controls/ModeSelector` 提到):无 UI

### 1.5 lib/ 与 desktop 集成
| 文件 | 状态 |
|---|---|
| `desktopHost.ts`/`desktopRuntime.ts` | 真做了(地址发现+health 轮询) |
| `desktopHost.pickWorkspace` / `onMenu` / `preventSleep` | **契约已定义、Electron 侧已实现 IPC,但 React 端 0 处调用**(`grep` 全仓库确认无引用)。等价能力:原生文件夹选择器、菜单「选择工作区…」快捷键 Cmd+O、防休眠。vanilla app.js 三者都用了(`pickWorkspace()`、`host.onMenu(...)`) |
| `conversations.ts`/`sessionRecovery.ts`/`previewSeed.ts`/`dragRegion.ts` | 真做了,小工具函数,逻辑完整 |
| `i18n/` | 真做了(极简点分路径 + zh-CN 单语言表,101 行词条) |

---

## 2. 前后端边界缺口清单

### 2.1 后端已发,前端(React)不消费 —— Top 明细
| 能力 | 后端证据 | React 现状 | vanilla 现状 |
|---|---|---|---|
| `ask_question` 事件(结构化提问,含 options/fields/多选/自由输入) | `types/events.ts` AgentEvent 联合类型 | chatStore `default` 分支吞掉,不渲染 | 同样吞掉(注释里承认) |
| `todo_update` 事件(任务清单) | 同上 | 吞掉不渲染 | 吞掉不渲染 |
| `tool_progress` 事件(工具执行中的流式输出/进度) | 同上 | 吞掉不渲染 | 吞掉不渲染 |
| `usage_update.context_percent`(上下文占用百分比,§4.5 压缩相关) | `UsageUpdateEvent` | 只用于算 `_lastTotalTokens` 差值显示"消耗 N tokens",**从不显示 context_percent 本身**——用户看不到"要满了"提示 | 同样未用 |
| `<file_change path="..." snapshot_id="...">` 标签(写文件类工具结果里嵌的结构化标记) | `fileWriteTool.ts`/`fileEditTool.ts`/`spreadsheetTool.ts`/`notebookEditTool.ts` | ToolCallCard 原样把整段 output 当纯文本 `<pre>` 显示,**不解析、不做"改动文件"列表、无 diff** | **完整实现**:`noteFileChange()` 正则抽取 + 变更文件角标 + 点击预览 + `diffFromArgs` 渲染彩色 unified diff |
| `GET /api/v1/agent/commands`(动态斜杠命令清单,按 conversationId+enabledPacks 过滤) | `server/index.ts:3459` | Composer 硬编码 3 条 | **完整实现**:懒加载+缓存+排序(getSlashCommandMatchRank 端口)+来源角标(内置/技能/台球) |
| `GET /tasks?conversationId=`(后台任务列表) | `server/index.ts:4447` | 无消费方 | `showTasks()` 有完整右侧面板渲染 |
| `GET /api/v1/agent/fs/list` `/fs/read`(工作区文件树/文件预览) | `server/index.ts:3940/3958` | 无消费方 | 完整文件树(懒加载子目录)+ 文件内容预览面板 |
| `GET /api/settings`(默认权限档等后端持久设置) | `server/index.ts:3972` | 无消费方,settingsStore 全内存态,重启回默认 | `loadSettings()` 读回 `defaultPermissionMode` |
| `GET /api/v1/agent/packs`(可挂领域包列表) | `server/index.ts:3451` | 无消费方(设置里没有挂载/切换领域包的 UI,`enabledPacks` 只能靠输入 `/台球 ` 文本猜测唤起) | `<select id="expert">` 下拉真选 |
| `desktopHost.pickWorkspace` + IPC `desktop:pickWorkspace`(选工作区文件夹) | electron `main.ts:303`,preload 已注入 | 0 处调用,`settingsStore.workspaceRoot` 永远是 `null` | 完整(按钮 + 菜单「文件→选择工作区…」双入口) |
| `ASSET_WS_TOPIC`(资产静默下载进度广播,CLAUDE.md 铁律③要求的"正在准备组件 x%") | `server/index.ts:4678` 全连接自动订阅 | 无消费方,无任何进度 UI | 无消费方(vanilla 也没做) |
| `POST /api/v1/voice/transcribe`(语音转写) | `server/index.ts:3303` | Composer 麦克风按钮是死的 | 未见调用 |
| `/api/v1/canvas/*`、`/api/v1/studio/*`(表格编辑/生图工作台后端 API) | `server/index.ts:2710/3057` | 无消费方,无对应页面 | 无消费方 |
| `/api/v1/video-edit/*`(视频剪辑:auto_plan/auto_plan_v2/inventory) | `server/index.ts:3104-3197` | 无消费方 | 无消费方(video-use 是自家产品,尚未包装成前端工作台,与架构文档 §2.5 一致) |
| `/api/v1/agent/scheduled-tasks`、定时任务运行记录 | `server/index.ts:3321` | 无消费方 | 无消费方 |
| `/api/v1/notifications` | `server/index.ts:3392` | Sidebar 铃铛按钮是死的 | 无消费方 |
| `/api/v1/agent/recent-artifacts`、`/saved-artifacts`、`/deleted-items*` (产物库/回收站) | `server/index.ts:4116-4204` | 无消费方 | 无消费方 |

### 2.2 前端假数据 / 写死清单(反向:前端展示但不真实)
| 位置 | 问题 |
|---|---|
| `Composer.tsx` `TokenPanel`(`/` 面板) | `slashItems` 硬编码 3 条(`/台球` `/帮助` `/清空`),与后端真实命令清单(可能几十条,含技能/领域包命令)完全脱节 |
| `Composer.tsx` `ModelMenu` | 硬编码只有「自动」一个选项 + 一个 `✓`,没有真实的模型/供应商切换(即便白标要求不暴露底层模型,至少该有"更快/更强"这类代称档位,现在连档位选择都没有) |
| `Sidebar.tsx` `taskCount` | `Math.max(sessions.length, 1)` 只是"至少显示 1"的凑数逻辑,不是真实统计 |
| `Sidebar.tsx` 空间(spaces)区块 | 固定一条 `sidebar.spaceGuide` 静态按钮,点了没反应,不接任何真实"空间/项目"数据源 |
| `previewSeed.ts` | 仅 `?preview=1` 触发,生产路径不触发,**不是缺口**(明确标注的设计走查工具,合理) |

---

## 3. 前后端应该怎么分层(现状评估 + 目标结构)

**现状**:vanilla(`desktop/renderer/app.js`,768 行单文件)与 React(`desktop/renderer-react/`)**两套前端并存**,由 Electron `main.ts:loadRenderer()` 按环境变量 `QF_UI_REACT` 二选一加载,互不共享代码。vanilla same-origin 直连 sidecar(`/agent/ws` 相对路径);React 经 IPC `runtime:getServerUrl` 拿地址后 fetch/WS(前端与 sidecar 解耦,为将来 H5/远程访问铺路)。**矛盾点**:vanilla 功能更全(右侧预览/文件树/后台任务/动态斜杠面板都在这),React 架构更对但功能更空——这是这次重设计要正面解决的核心矛盾,不能只抄 React 的壳、丢 vanilla 已验证的机制。

**目标结构建议**(按 cc-haha 范式,已在架构文档里定调,以下是落地要点):
1. **状态管理**:继续 Zustand 按域拆 store(cc 43 个 store 的路子),但 `chatStore.ts` 420 行已是"上限级"文件——`reduceEvent`(switch 20+ 分支)、token 记账、WS 生命周期三块职责混一处,建议拆成 `chatStore`(纯 UI 状态)+ `chatEventReducer.ts`(纯函数 reducer,便于给 ask_question/todo_update/tool_progress/file_change 加分支时不再让单文件继续膨胀)+ `tokenAccounting.ts`。
2. **WS 事件消费**:`AgentEvent` 联合类型是唯一契约,但目前"后端定义了但前端 switch 里 default 吞掉"是最大风险——新加事件类型不会报类型错(TS 的 exhaustive switch 检查没打开/没利用),容易一直"发了没人接"。建议给 `reduceEvent` 补 `never` 兜底断言,强制新增事件类型必须显式决定渲染还是显式吞掉(现在的隐式吞掉让人不知道是"故意"还是"忘了")。
3. **REST**:`api/client.ts` 单例可变 baseUrl 的设计是对的,继续用;但目前只有 `sessionStore` 真正用它,应该把 §2.1 列的十几个已存在端点逐个配上 store(settingsStore 接 `/api/settings`、新建 packsStore 接 `/api/v1/agent/packs`、tasksStore 接 `/tasks`、workspaceStore 接 `fs/list`+`fs/read`+`pickWorkspace`)。
4. **桌面 IPC 边界**:`desktopHost.ts` 契约设计合理(渲染层只经此访问原生能力),问题不在设计,在**没人调用**——`pickWorkspace`/`onMenu`/`preventSleep` 是"建好没通车"的典型,重设计时应该在设置页/工作区选择器/长任务(生图当中)三处分别接上。
5. **路由**:`tabStore.TabType` 目前只有 `session | settings` 两种,`ContentRouter` 要扩到 `session | settings | scheduled | trace | workbench`(对齐 cc `ContentRouter` 5 分支),这是加设置页/后台任务页/右侧预览页之前的地基工作,得先做。

---

## 4. 前端该有哪些模块(目标清单,按现状打分)

| 模块 | 现状 | 说明 |
|---|---|---|
| 对话主屏(消息流+输入框) | **齐**(带内部半成品) | 见 §1.3,骨架完整但斜杠/模型菜单/markdown 富渲染/diff 都是简化版 |
| 右侧预览面板(工作台:文件/diff/markdown 选段/图片/网页/点选就地改) | **缺(0%)** | 组件目录纯占位,TopBar 开关按钮是死的;vanilla 有基础版(改动文件列表+文件预览),React 连这个基础版都没有;task#17 方案已写但未落地代码 |
| 生图工作台(海报预览+保存/基于此调整/重新生成+点选迭代) | **缺** | 后端 `/api/v1/studio/*`、`/api/v1/canvas/*` 已有;前端无消费方;这是 owner 特别点名的"我们特有"能力(cc 没有的部分),优先级应较高 |
| 视频剪辑工作台 | **缺** | 后端 video-edit 路由已有(auto_plan/auto_plan_v2),尚未包装成 agent 工具也未包装成前端页面(架构文档 §2.5 已知缺口) |
| 设置页(权限默认档/BYOK/模型/MCP/记忆/技能开关) | **缺** | `ContentRouter` 占位回退;`/api/settings`、BYOK 相关端点均无 UI |
| 会话列表(侧栏任务区) | **半成品** | 基本列表+切换有,缺重命名/归档/删除/hover 操作(架构文档"导航拆解"蓝图里点名要做) |
| 后台任务/自动化(定时任务面板) | **缺** | `components/tasks` 占位;后端 `scheduledTaskRunner`、`/tasks`、`/api/v1/scheduled-tasks` 都已就绪 |
| 计划模式 UI(plan permission mode 的可视化,比如"计划确认卡") | **缺** | `PermissionMode` 类型里有 `'plan'` 档位可选,但选中后没有对应的"计划展示/确认"UI,和其余 4 档一样只是文本菜单项 |
| 权限档切换 | **半成品** | Composer 里的 `PermissionMenu` 下拉可切 4 档(`default/acceptEdits/plan/bypassPermissions`),UI 有,但**不持久化**(不读也不写 `/api/settings`、`/api/v1/agent/permissions/persist`、`/api/v1/agent/permissions/rules` 三个后端端点均未接) |
| 技能/专家/连接器市场 | **缺** | `components/skills`、`components/plugins` 占位;后端 skills/mcp/plugins 系列端点已就绪 |
| 通知中心 | **缺** | Sidebar 铃铛是死按钮;后端 `/api/v1/notifications` 已就绪 |
| 资产静默下载进度提示("正在准备组件 x%") | **缺** | CLAUDE.md 明确铁律,`ASSET_WS_TOPIC` 后端已在广播,前端 0 消费 |
| 多标签会话(TabBar) | **写好未接线** | 组件代码存在但 `AppShell` 未挂载,等于不存在 |
| 领域包挂载入口(挂/取消挂"台球运营专家") | **半成品** | 只能靠打 `/台球 ` 文本猜测触发(而且 Composer 硬编码斜杠面板里确实放了这一条),没有正式的下拉/开关 UI;vanilla 至少有 `<select id="expert">` |

---

## 5. 引擎之外的架构缺口(软件工程整体视角)

| 缺口 | 现状证据 | 影响 |
|---|---|---|
| **自动更新完全未接** | `electron-updater` 不在依赖里,无 publish 配置(架构文档 §2.4 已确认,task#13) | 无法远程推送修复/新功能,只能手动分发新安装包 |
| **Windows P0 未闭环** | `WindowsJobObjectLauncher` 占位桩恒 null → `run_command` 在 Win 走明文 `cmd /c` 无写围栏;危险命令红线在 Win 靠正则非结构化解析(架构文档 §2.4 已列为"唯一出包目标"的 P0 缺口) | 目前唯一目标出包平台的安全护栏名存实亡 |
| **两套前端并存的技术债** | vanilla(768 行)+ React 长期并行,`QF_UI_REACT` 环境变量切换,打包时"两套前端都打"(架构文档确认) | 双份维护成本,且当前是"新架构功能不足、老架构将被淘汰"的尴尬期;task#42 定的退出条件(React 达 parity 删 vanilla)按 §1/§2 的差距看还早 |
| **dataeye 数据回传上报器未重接** | 架构文档 §3④明确:"TS 内核尚无 /ingest 上传器"(task#16),且重接时必须补脱敏层(当前无) | 无法做用户数据聚合分析看板(owner 关注的运营数据能力缺失) |
| **媒体工作台未包装成 agent 工具/前端页面** | 生图只有 `make_poster`/`generate_image` 两个工具暴露给模型,视频剪辑(`video-use`)只有 HTTP 路由无工具封装(架构文档 §2.5 task#37/#40);前端更是完全没页面(见 §4) | 用户没法在对话之外独立打开"生图工作台"/"剪辑工作台"做精细调整,只能靠对话来回描述 |
| **分发前 scrub + 知识加密未做**(开发期允许明文) | task#22(白标 scrub 去 cc/Claude 痕迹)、task#23(台球知识 prompts.enc 加密)均标注"打包前才做" | 若现在直接打包分发会泄露白标底细和 PPT 底本知识明文,是发布前必须补的闸,不是当前开发期问题 |
| **安全红线输出侧未接线** | 架构文档 §5 明确:"通用红线块未无条件注入系统提示(只在挂台球包时生效)"、"`guardText` 句柄无 loop 消费方" | CLAUDE.md 铁律①"安全红线永远注入"在代码层面有落差,通用 Agent 模式下红线可能缺失 |
