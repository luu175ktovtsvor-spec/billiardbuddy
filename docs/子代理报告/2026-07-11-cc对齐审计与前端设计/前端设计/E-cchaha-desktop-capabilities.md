# cc-haha 官方桌面前端 — 能力全集盘点

> 读码范围:`~/Desktop/cc-haha-ref/desktop/src`(React+Zustand+Tailwind v4,405 文件)。只读不改,不下"该砍"结论,供 owner 综合决策"接什么"。

## 1. 顶层信息架构

单窗口壳(`AppShell.tsx`)= 左侧 `Sidebar`(会话列表,可收合)+ 右侧 `main` 区(`TabBar` 顶部标签栏 + `ContentRouter` 内容路由)。**多标签页模型像代码编辑器**:`tabStore.ts` 管理 `TabType = 'session'|'settings'|'scheduled'|'terminal'|'trace'|'traces'|'workbench'`,标签可持久化(重启恢复,终端/workbench 标签不持久化)。`ContentRouter` 按 `activeTabType` 切页,终端标签用绝对定位叠层保活(不销毁 PTY)。

顶层"屏"共 7 类:①会话对话页(`ActiveSession`/`EmptySession`)②设置页(`Settings.tsx`,内部 15 个二级 tab,见下)③定时任务页(`ScheduledTasks`)④独立终端标签⑤Trace 调试页(单会话 `TraceSession` / 列表 `TraceList`,可弹独立窗口 `traceLaunch.windowMode`)⑥Workbench 标签(文件工作区+浏览器,从右侧面板"展开"而来)⑦移动端响应式壳(同一套 React 代码兼容窄屏,`useMobileViewport`,侧栏变抽屉)。

另有 H5 远程配对页 `H5ConnectionView`(手机浏览器扫码连桌面同一会话)、启动错误页 `StartupErrorView`。

Settings 内 15 个二级 tab(`pages/Settings.tsx` L202-219):providers / general / h5Access / adapters / terminal / mcp / agents / skills / memory / plugins / computerUse / activity / trace / diagnostics / about。

## 2. 能力全集清单(核心产出,含分类标注)

标注:①通用产品能力 ②编码agent专属 ③SaaS/账户体系(冲突) ④WorkBuddy重合(未核实,见文末说明)

### 对话核心(components/chat, 55 文件)
- **消息流渲染**①:`MessageList`/`AssistantMessage`/`UserMessage`——虚拟高度缓存(`virtualHeightCache.ts`)优化长会话滚动。
- **工具调用可视化**①:`ToolCallBlock`/`ToolCallGroup`(同轮多个工具调用折叠分组)/`ToolResultBlock`——工具执行过程结构化展示,不是黑箱转圈。
- **思考过程**①:`ThinkingBlock.tsx`——模型 reasoning/thinking 内容独立可折叠区块(项目 memory 里"待抄"的那个)。
- **流式指示器**①:`StreamingIndicator.tsx`。
- **权限审批弹窗**①:`PermissionDialog.tsx`——工具执行前的允许/拒绝/编辑弹窗(对应我们的审批闸)。
- **Plan Mode 预览卡**①②:`PlanModePreview.tsx`——`EnterPlanMode`/`ExitPlanMode` 工具触发时,把模型写的计划渲染成卡片(标题+计划正文+"请求的权限"列表),用户看完再放行执行;`PlanModePermissionDialog` 是其审批变体。
- **结构化反问(elicitation)**①:`AskUserQuestion.tsx`——模型可发起单选/多选题式提问(非纯文本追问),渲染成可点选的选项卡片,支持多题批次。
- **逐轮变更卡 + 一键撤销**①②:`CurrentTurnChangeCard.tsx`——每轮对话结束展示"这轮改了哪些文件"(超过5个可展开),点击文件走 `OpenWithMenu` 用外部程序打开,**"Undo"按钮可回滚整轮的文件改动**(checkpoint 机制,`SessionTurnCheckpoint`)。
- **上下文用量指示器**①:`ContextUsageIndicator.tsx`——可视化当前会话上下文占用百分比+分类明细,压缩(compact)后强制刷新一次(避免显示压缩前的旧数字)。
- **Diff/Code 查看器**①②:`DiffViewer.tsx`/`CodeViewer.tsx`——语法高亮+行号,工具结果里内嵌展示代码/差异。
- **Mermaid 图渲染**①:`MermaidRenderer.tsx`——模型输出的 mermaid 代码块自动渲染成图。
- **附件与媒体画廊**①:`AttachmentGallery`/`InlineImageGallery`/`InlineVideoGallery`/`ImageGalleryModal`——生成的图片/视频内嵌画廊+全屏查看,`ComposerDropOverlay`+`useComposerFileDrop` 支持拖拽上传。
- **@ 文件搜索菜单**①②:`FileSearchMenu.tsx`——composer 里 @ 触发项目文件名模糊搜索,选中即引用文件路径。
- **本地斜杠命令面板**①:`LocalSlashCommandPanel.tsx`——纯前端命令(不过模型):`/mcp` `/skills` `/help` `/status` `/cost` `/context`。
- **任务清单(TodoWrite)栏**①:`SessionTaskBar.tsx`+`InlineTaskSummary.tsx`+`cliTaskStore.ts`——模型自己维护的 todo 列表,以吸底条形式展示当前轮"正在做的子步骤",完成后可整体清空重来。
- **后台任务栏**①②:`BackgroundTasksBar.tsx`+`lib/backgroundTasks.ts`——子代理在后台异步跑的任务(不阻塞当前对话),显示运行中/已完成+耗时。
- **Computer-Use 权限弹窗**②:`ComputerUsePermissionModal.tsx`——桌面控制能力(屏幕点击/输入)的一次性授权弹窗,细粒度到剪贴板读写、系统组合键。
- **终端风格外壳**②:`TerminalChrome.tsx`——把某些工具输出(如 shell 命令)套上终端观感的容器。
- **消息操作栏/复制**①:`MessageActionBar.tsx`、`clipboard.ts`。
- **输出目标卡**①:`AssistantOutputTargetCard.tsx`+`assistantOutputTargets.ts`——把助手产出的文件/图片和"用什么程序打开"关联起来。

### 布局与窗口(components/layout)
- **自定义窗口铬**②/①:`TitleBar`/`WindowControls`(自绘最小化/最大化/关闭,配合无边框窗口)、`useElectronWindowDragRegions`(可拖拽区域)。
- **状态栏**①:`StatusBar.tsx`。
- **打开项目菜单**②:`OpenProjectMenu.tsx`——最近项目/选择文件夹开会话。
- **移动端响应式**①:`useMobileViewport`,侧栏变全屏抽屉+顶部会话头。

### 会话/项目管理(Sidebar,~2000行)
- **项目分组会话列表**①:按项目(workDir)分组、可拖拽排序/置顶/隐藏/恢复,三种组织方式(project/recentProject/time)+两种排序(createdAt/updatedAt),偏好存本地+同步服务端(`desktopUiPreferencesApi`)。
- **批量管理模式**①:多选会话批量删除(Cmd+A全选/Shift连续选/Esc退出)。
- **重命名/删除/右键菜单**①,**新建会话**(空白或选现有文件夹,走原生目录选择器)①②。
- **全局搜索(Cmd+K)**①:`GlobalSearchModal.tsx`——跨会话全文搜索,防抖+可中断请求,展示匹配片段预览+最近会话(无搜索词时)。

### Workbench 右侧面板(components/workspace + browser + workbench)
- **统一 Workbench**①②:`WorkbenchPanel.tsx`——单一面板内用 tab 切换"工作区文件"/"浏览器"两种模式,可从侧面板"展开"成独立主标签(`WorkbenchTab`)。
- **工作区文件树+Diff**②:`WorkspacePanel.tsx`(752行支撑 store)——changed/all 两种视图,文件状态徽标(M/A/D),多标签预览(文件/diff 混开,可关闭当前/其他/左侧/右侧/全部),文本选中即可"加入对话上下文"(`workspaceChatContextStore` 引用:文件/代码片段/代码选区/对话选区)。
- **原生浏览器面板**①②:`BrowserSurface.tsx`——地址栏+前进后退+刷新+缩放+截图,本地预览(`/preview-fs/`)会先探活等就绪再跳转,过滤本地文件 vs 外链走不同渲染策略。

### 任务与自动化
- **定时任务(Cron)**①:`ScheduledTasks`页+`taskStore.ts`+`components/tasks/*`——`NewTaskModal`(含 `DayOfWeekPicker` 星期选择器、`PromptEditor`)、`TaskList`/`TaskRow`、`TaskRunsPanel`(运行历史)、桌面通知(任务跑完系统通知,点击可跳回对应会话/tab,`useScheduledTaskDesktopNotifications`)。

### 团队协作(疑似原型/半成品)
- **Agent Teams**②:`teamStore.ts`(345行,真实实现——轮询团队成员 transcript、映射历史消息、合成 `team-member:<agentId>` 伪会话)+ `TeamStatusBar.tsx`,但**页面 `pages/AgentTeams.tsx` 用的是 `mocks/data` 假数据**,UI 尚是设计原型未接活 store——多代理并行开发集群("session-dev cluster")的雏形,值得关注但当前非成品。

### 技能与插件生态
- **技能市场**①:`SkillList.tsx`/`SkillDetail.tsx`+`skillStore.ts`——按来源分组(user/project/plugin/mcp/bundled),搜索,展示估算 token 消耗。
- **插件市场**①:`PluginList.tsx`/`PluginDetail.tsx`+`pluginStore.ts`——按状态分桶(需关注有错误/已启用/已禁用),批量启用/禁用,插件市场源(marketplaces)管理,reload。
- **MCP 服务器管理**①:`McpSettings`页+`mcpStore.ts`——CRUD(创建/编辑/详情),支持 stdio/http/sse 三种传输,8 种作用域分组(plugin/user/project/local/managed/enterprise/claudeai/dynamic),连接状态(connected/checking/needs-auth/failed/disabled),**敏感字段自动脱敏正则**(API key/token/密码等,含 sk- 前缀识别)。
- **子代理(Agents)管理**②:`agentStore.ts`+ Settings 内 AgentsSettings——列出 active/all agent 定义。

### 模型/Provider(BYOK,与我们"全内置key网关"路线冲突较大)
- **多 Provider 管理**③:`ProviderSettings`(Settings.tsx 里最大一块)——增删改查+拖拽排序+连通性测试(含代理测试)、预设(presets)、官方 Claude OAuth 登录 ③(`ClaudeOfficialLogin`)、官方 ChatGPT OAuth 登录 ③(`ChatGPTOfficialLogin`)、per-slot 模型映射(main/haiku/sonnet/opus)、1M 上下文标记、`auto_compact_window` 阈值配置、`ENABLE_TOOL_SEARCH` 开关、实验性 betas 禁用开关、三种鉴权策略(api_key/auth_token/dual等)。**OAuth 官方登录属账户体系,与我们免登录单用户铁律直接冲突,不建议照搬。**

### 终端与开发者工具(强编码属性)
- **完整 PTY 终端**②:`TerminalSettings.tsx`(xterm.js)——多终端标签(每个独立 runtime,可后台保活)、shell 选择、状态机(idle/starting/running/exited/error/unavailable)。
- **Trace 调试器**②:`TraceList`/`TraceSession`/`TraceTree`/`TraceDetail`(+ detail 子组件:`LlmCallDetail`/`ToolDetail`/`MessageBlocks`/`SessionOverview`)——按 LLM调用/工具调用/错误过滤搜索的调用树,可展开查看每次 LLM 请求/响应原始体、工具输入输出,支持独立窗口打开(开发者观测/调试专用)。
- **Computer-Use 设置**②:`ComputerUseSettings.tsx`——依赖 Python 环境检测、屏幕录制/辅助功能系统权限引导(macOS Privacy pane 直达)、按 App 授权白名单(安装应用列表+搜索)、剪贴板/系统组合键开关——即桌面 GUI 自动化能力的完整配置面。
- **Doctor 自愈面板**①:`DoctorPanel.tsx`——一键检测+修复本地配置损坏(`doctorRepair.ts`),区分"安全可修复的 key"。
- **诊断日志**①:`DiagnosticsSettings.tsx`——日志事件列表(按 error/warn 筛选)、导出诊断包、打开日志目录、清空日志(带二次确认)。

### 记忆与使用分析
- **记忆文件浏览器/编辑器**①:`MemorySettings.tsx`——按项目分组的 MEMORY.md/CLAUDE.md 文件树(`buildMemoryFileTree`)、搜索、markdown 预览与编辑双态、Front-matter 自动剥离预览、脏值检测(未保存提示)。
- **使用量热力图**①:`ActivitySettings.tsx`——GitHub-contributions 风格日历热力图(daily/weekly/cumulative 三模式,52周)、会话数/消息数/工具调用数/token 汇总、插件与技能使用排行(`PluginRankItem`)、个人资料卡(展示名/副标题/头像上传)。

### 远程接入(与免登录/单机铁律相关,需留意)
- **IM 多渠道桥接**①:`AdapterSettings.tsx`——Telegram(bot token+白名单)、飞书(app id/secret/加密key/验证token,可创建多智能体机器人)、微信(扫码登录轮询)、钉钉(注册轮询)、WhatsApp(扫码登录轮询),各自解绑(unbind)——**让用户从外部聊天软件远程指挥桌面管家**,是"通用产品能力"里少见的强能力,且不涉账户体系冲突(是用户自己的IM账号)。
- **H5/移动端远程配对**①:Settings 的 `h5Access` tab——生成二维码(局域网地址识别/固定端口/断连宽限期配置),手机浏览器扫码即可连上同一桌面会话继续对话。

### 系统级
- **自动更新**①:`UpdateChecker.tsx`+`updateStore.ts`(465行,全仓库最大 store 之一)——更新代理模式、网络代理模式配置,应是完整的检查/下载/安装流程。
- **桌面通知**①:`lib/desktopNotifications.ts`+导航联动(点通知跳回具体会话/tab)。
- **Toast 提示系统**①:`shared/Toast.tsx`。
- **应用内缩放**①:`lib/appZoom.ts`(区别于浏览器面板自己的缩放)。
- **快捷键**①:`useKeyboardShortcuts.ts`——Cmd+N 新会话、Cmd+K 全局搜索、Esc 关弹窗、Cmd+. 停止生成、Cmd+/- 缩放。

### 疑似设计原型(非活接口,读码时注意甄别)
- `pages/SessionControls.tsx`(独立默认导出,用 `mocks/data`)——一整页"权限模式+模型选择器+效果强度(Effort)"的设计稿,展示 ask/auto/plan/bypass 四种权限图标方案+opus/sonnet/haiku 模型图标方案,**是设计参考不是活代码**。
- `pages/ToolInspection.tsx`(用 `mocks/data`)——"Revert Change/Apply to All"+split/unified diff tab 的工具审查页设计稿,同样是原型。
- `pages/AgentTeams.tsx`——如上,店面是原型但背后 `teamStore` 是真实实现。
这三处提示 cc-haha 仓库里**混有"设计意图"和"已上线代码"**,抄的时候要认它是不是真跑的。

## 3. 状态管理架构

Zustand,共 **25 个业务 store**(不含 test):`adapterStore agentStore browserPanelStore chatStore cliTaskStore hahaOAuthStore hahaOpenAIOAuthStore mcpStore memoryStore openTargetStore overlayStore pluginStore providerStore sessionRuntimeStore sessionStore settingsStore skillStore tabStore taskStore teamStore terminalPanelStore uiStore updateStore workspaceChatContextStore workspacePanelStore`。**切分原则 = 按功能域(feature domain)一 store 一域**,不是按数据类型;每个 store 通常配一个同名 `api/*.ts` 客户端。

规模分布(行数):`chatStore.ts` 3566行遥遥领先(对应测试 4970行)——是绝对核心,其余最大的是 `settingsStore`784、`workspacePanelStore`752、`updateStore`465、`teamStore`345、`tabStore`327、`sessionStore`305、`providerStore`296。多数小 store(<200行)聚焦单一设置面。

`chatStore` 组织方式:**以 `sessionId` 为 key 的 `Record<sessionId, SessionState>`**,单 store 内并发承载多个会话各自独立的:消息数组、chatState(idle等)、connectionState、streaming文本/工具输入、活跃 toolUseId/thinkingId、pendingPermission/pendingComputerUsePermission、tokenUsage、耗时计时器、slashCommands、后台子代理任务表(`agentTaskNotifications`)。这种"每会话一份状态、全塞进一个大 store 的 map"的模式也用在其它面板 store 上(`workspacePanelStore`/`browserPanelStore`/`workspaceChatContextStore` 都是 `bySession`/`referencesBySession` 形态),**保证多标签并发跑多个会话时互不干扰,是这套多标签架构的关键支撑模式**——供我们前端状态分层参考:如果要做"同时开多个会话标签"就得照此 by-session 分片,不能是单一全局状态。

`uiStore` 承担跨会话的全局 UI 态(modal/toast/activeView/activeSettingsTab/sidebarOpen/pendingXxx 待办跳转)。`tabStore` 单独管窗口/标签生命周期+持久化(仅 session/settings/scheduled/traces/trace 落盘,terminal/workbench 不落盘)。

## 4. 主题/Token 架构(theme/globals.css)

**三层法,和我们 workbuddy-tokens.css 的三层思路对得上**:
1. **调色板层**(原始色值):`--color-primary: #8F482F` / `--color-surface-container-low` 等,命名沿用 Material Design 3 词汇(primary/primary-container/primary-fixed/on-primary/surface/surface-container-{low,high,highest,lowest}/on-surface/outline/secondary/tertiary/error/success/info/warning)。
2. **语义层**(引用调色板拼出用途化变量):如 `--color-surface-hover: var(--color-surface-container-high)`、`--color-surface-selected: var(--color-surface-container)`、`--color-surface-sidebar: var(--color-surface-container-low)`。
3. **组件专属层**:`--color-memory-*`(记忆页专属配色)、`--color-goal-*`(直接等于 memory 的别名)、`--color-activity-heat-{0..4}`+`--color-activity-tooltip-*`(热力图专属)、`--color-model-option-selected-*`、`--settings-zoom-*`(缩放控件轨道/滑块专属,还随主题重新赋值)。

**多主题切换机制**:不是只有 light/dark 两态,是 **`[data-theme="light"|"dark"|"white"]` 三套**属性选择器整体覆写变量(第三套 "white" 疑似高对比纯白特殊主题),挂在 `:root` 上一次性切换,无需 JS 逐个改样式。字体走**自托管 woff2 + unicode-range 分片**(Inter/Manrope/JetBrains Mono/Material Symbols Outlined),不依赖 Google Fonts CDN——离线优先场景的好实践。

Tailwind v4(`@import "tailwindcss"`)只当排版/布局工具用,**颜色一律走 `bg-[var(--color-xxx)]` 任意值语法直接引用 CSS 变量**,不进 Tailwind theme() 配置——这样运行时切主题不需要重新构建 Tailwind,只要属性选择器命中即可,值得我们对照自己 tokens.css 是否也做到"颜色只在一处定义、组件层不重复硬编码"。

## 5. 备注 / 局限

- 本次只读 cc-haha 官方桌面前端源码,**未交叉核对 WorkBuddy(腾讯 CodeBuddy)的实际功能面**,"④WorkBuddy重合项"这一分类因此基本没标——如果 owner 需要这项对比,需要另开一轮针对 WorkBuddy 截图/文档的核实,不能凭印象断言重合。
- `SessionControls.tsx`/`ToolInspection.tsx`/`AgentTeams.tsx` 三处是 `mocks/data` 驱动的设计原型,不代表已上线行为,抄之前建议先用 native-devtools/Playwright 在 cc-haha 真机上跑一遍确认它到底有没有连上真实 store。
