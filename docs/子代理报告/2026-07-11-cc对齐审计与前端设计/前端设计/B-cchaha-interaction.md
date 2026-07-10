# cc-haha 交互设计规格(供桌面 GUI 前端对齐)

> 来源:`~/Desktop/cc-haha-ref/desktop/src/`(React+Zustand+Tailwind 桌面壳,非 ink TUI——这是 cc-haha 官方自带的桌面 GUI 参考实现,比 ink 更直接可抄)+ `~/Desktop/cc-haha-ref/src/`(ink TUI,仅用于确认"终端范式"边界)+ 项目内 `docs/references/cc-haha主对话框展示逆向.md` + 竞品拆解 01/04。
> 结论先行:**cc-haha 桌面 GUI 本身信息编排"克制、低动效"**,大部分状态转场是**颜色/文字/图标变化,不是位移/缩放动画**;唯一持续动画是三个 1.5s CSS keyframe(shimmer 呼吸、spin 转圈、pulse-dot 呼吸点)+ 50ms 节流的文字流。**没有消息进场动画**(`activity-reveal` keyframe 定义了但只用在设置页,主对话框消息列表不用)。

---

## 1. 工具调用展示(进行中→完成/失败)

单卡 = 一行折叠头(按钮)+ 可选展开体,`ToolCallBlock.tsx`:

**折叠头从左到右**:① 工具图标(material-symbols,按工具类型固定映射) ② 工具名(11px 粗体) ③ 主摘要(有文件路径显示文件名,否则按工具类型取摘要模板,如 Edit→"N lines changed") ④ **右侧状态区(互斥优先级,决定"进行中/完成/失败"怎么显示)**:
- pending → `LoaderCircle` 转圈图标 + 进行时动词("Preparing edit"/"Generating content")+ 实时字数(边流边数,liveStats)
- stopped(用户中断) → `CircleStop` 图标 + "Stopped"
- 有结果(成功) → 过去式摘要(`getToolResultSummary`,如"N lines output";**Bash 结果摘要故意留空**,不刷屏)
- 有结果(失败) → 红色 `error` 图标 + 错误首行(截断 72 字)
⑤ 展开箭头(`expand_more/less`,仅 expandable 才显示)

**状态转场机制**:不是"进行中卡片消失、完成卡片重新出现",是**同一张卡片的右侧状态区原地替换**(图标+文案换掉),折叠头其余部分(图标/名称/摘要)保持不动,只有摘要文字可能从"预览态"变成"结果态"。**没有卡片级的位移/缩放/淡入淡出**,纯内容替换,视觉上是"稳"的。

**折叠/展开**:`expandable = hasEditPreview || hasWritePreview || hasResultDetails || (isPending && partialInput)`;**默认折叠**(仅 ExitPlanMode 默认展开)。展开体渲染 diff(Edit/Write)、终端块(Bash)、结果输出(带 Copy 按钮,错误红字 `<pre>`、正常走 CodeViewer plaintext 无行号)。**关键取舍**:Bash 的 stdout 和 Read 的文件正文默认不显示正文,只给"N lines output"这类摘要,正文只在**出错**时才显示——这是 cc 保持对话整洁的核心手法,不是遗漏。

**编组**(`ToolCallGroup.tsx`,`MessageList.buildRenderModel`):连续多个 tool_use 折成一组卡,不是每个工具单独一张卡平铺。组头显示汇总动词(`generateSummary`,如"Read 3 files, ran 2 commands, edited a file")+ 状态图标(成功 check / 错误 error / 运行中品牌色 pulse-dot 闪点)。**运行中或含嵌套子调用自动展开,跑完自动收起**——这是唯一一处"状态变化触发折叠态自动切换"的地方。tool_result 不单独占一行,内联进对应 tool_use 卡片。

---

## 2. 流式(正文/thinking/逐 token 节奏)

**打字机手感的真正来源不是逐字,是节流批量渲染**:`content_delta` 事件不会每来一个字符就触发一次 React 状态更新,而是**per-session buffer + 50ms `setTimeout` flush**——50ms 内到达的所有增量攒成一批,一次性 append 到 `streamingText`。工具入参的流式增量(如 Write 边写边显示)用独立的另一条 50ms 节流通道。**这个 50ms 阈值是必抄项**,不抄的后果是长回复逐字符触发整棵组件树重渲染、明显卡顿。

**正文流式**:`AssistantMessage` 组件接收 `streamingText`,末尾渲染一个闪烁竖条光标(`animate-shimmer`,1.5s 呼吸)。流式期间**不渲染图片画廊、不抽取"产物文件"卡片**(这些是终态才做的后处理,流式中途做没意义还浪费性能)。

**thinking 块**(`ThinkingBlock.tsx`):默认折叠的一行按钮,三角 `▸/▾` + 斜体 label。`isActive`(还在增长)时 label 是"Thinking"(现在时)+ 后缀 `.thinking-dots`(`::after` 循环 `. .. ...`,1.4s);写完后 label 变"Thought"(过去式),dots 消失。**进行时→过去式动词的切换是 cc 的核心叙事手法,不止 thinking,工具摘要、状态动词全都是这个模式**。展开体(默认折叠,300px 内滚动)流式时**自动滚到底**(`scrollTop = scrollHeight`),末尾有独立的闪烁竖条光标(`thinking-cursor-blink`,1s step-end,和正文光标视觉不同——thinking 更"打字机"、正文更"呼吸")。

**忙碌指示器 StreamingIndicator**(工具执行中,或已发消息但还没等到第一个 thinking delta 的空窗期才挂载):胶囊 `rounded-full` 内含 `✦`(品牌色,`animate-shimmer`)+ 动词("{Thinking/Compacting/Running/Working}...",服务器可下发自定义动词覆盖默认)+ 秒表(<60s 显示"Ns",否则"Xm Ys")+ token 估算("· ↓ {chars/4}")。**api_retry 单独一种横幅**(琥珀色警示,`RefreshCw` 转圈图标 + 重试次数 + HTTP 状态 + 倒计时),和"降级为非流式"的 `streaming_fallback`(中性灰胶囊,非警示)是两种不同严重度的视觉语言,不能混用同一个样式。

---

## 3. 关键交互流

**审批卡 PermissionDialog**:内联渲染在消息流里(不是弹窗遮罩)。结构 = Header(工具类型色块图标 + 标题"Allow [助手] to {action} {target}?" + 右侧状态徽章:pending 琥珀"Awaiting approval"+闪烁点,responded 灰"Responded")+ 详情区(**Edit → 内联 DiffViewer 完整 diff;Write → 全绿新增 diff;Bash → 终端块 `$ 命令`**;审批阶段就把要改的内容摆出来,不是等确认完才显示)+ 动作按钮(仅 pending 显示:`Allow` / `Allow for session`(记住,`rule:'always'`)/ `Deny`)。**两态视觉**:pending 亮色可交互,responded(历史审批卡)整体降到 `opacity-70` 只读,不会重复弹出。ExitPlanMode 走同一套组件但换皮:标题"Ready to code?"、body 是 `PlanPreviewCard`(见下)、按钮换成"Approve plan"/"Keep planning"。

**计划模式**:进入靠 `EnterPlanMode` 工具(无对应展示细节,静默切态);写计划阶段模型调 `ExitPlanMode` 工具触发上面这张审批卡,`PlanPreviewCard` 展示——文件图标+标题+文件路径(mono)+ 计划正文(markdown,compact 变式,最高 520px 滚动)+ 底部"请求的权限"区(每条 `工具 · 描述` 一行小卡)。批准后plan 内容原样出现在对话历史里(不额外做转场动画)。

**AskUserQuestion 多题**:一张卡,多问题时顶部横向 tab 栏(每个 tab 显示"已答"绿勾图标),当前 tab 下渲染单选/多选选项卡片(圆形/方形选择指示器区分单选多选)+ 底部自由文本框(可替代选项作答,Cmd/Ctrl+Enter 提交)。**submitted 后整卡降级为只读**(选项/输入框全部 disabled),底部换成一行"已答:{答案摘要}"。所有题都要有答案(选或填)才能点提交。

**斜杠命令菜单**:`LocalSlashCommandPanel.tsx` —— 命令面板不是简单下拉列表,是**按命令类型分派成不同的定制面板**:`/mcp`→MCP 服务器列表(按 scope 分组,状态色点+徽章);`/skills`→技能列表;`/status` `/cost` `/context`→"会话检查器"面板(三个 tab:状态/用量/上下文,每个 tab 有专门的可视化,如 context 用堆叠进度条按类别分色显示 token 占比);`/help`→分组命令帮助(按"上下文/项目/桌面"三组+"更多"折叠)。所有面板统一 `PanelShell` 外壳:从输入框正上方 `absolute bottom-full` 弹出、圆角卡片、标题+副标题+右上角关闭按钮,内容区独立滚动(不撑爆输入框上方空间)。

**@ 提及(文件搜索)**:`FileSearchMenu.tsx`,同样从输入框上方弹出。顶部面包屑显示当前浏览路径;列表区分"浏览模式"(文件夹图标蓝色+文件描述图标+右侧 FILE/FOLDER 标签+hover 才出现文件夹的"进入"箭头按钮)和"搜索模式"(纯路径文本,更紧凑);底部固定快捷键提示条(↑↓ 导航/Enter 选择/→ 进入文件夹/Esc 关闭)。键盘全导航(不依赖鼠标)。

**todo 清单更新**:两处呈现,语义不同——① `SessionTaskBar`(会话级常驻栏,`sticky` 挂在消息列表上方):折叠头永远可见(进度条+完成数/总数+展开箭头),点击展开显示逐项(状态图标+编号+标题,`in_progress` 项额外显示当前动作文字+黄色呼吸点);**全部完成后不自动消失,但用户继续聊天后自动隐藏**(`completedAndDismissed`)。② `InlineTaskSummary`(对话历史里的一张静态快照卡,不可交互,记录"当时"的任务完成情况)。两者都用相同的图标语义:空心圆(pending)/`pending`图标(进行中,配黄色)/绿色实心勾(完成,配删除线)。

**后台任务**:`BackgroundTasksBar.tsx` —— 输入框上方一行小按钮(不占主视觉),运行中显示黄色转圈图标+"运行中 N 个",全部完成后变绿色勾+"已完成 N 个"。点击展开成**右侧抽屉面板**(`absolute inset-y-0 right-0`,360px 宽,不是模态弹窗,不阻塞主对话),分"运行中/已完成"两组,每行显示标题+类型标签+状态+耗时+token 数,运行中的行左侧有一个呼吸小圆点(`animate-pulse-dot`)。已完成任务可一键"清除"。

**diff 展示**:`DiffViewer.tsx`,统一复用于三处(工具卡展开预览/审批卡预览/其他 diff 场景)。单栏(非左右分屏)+ 词级对比高亮(不是整行标记)+ 默认显示行号+ 头部文件路径 + 绿色"+N"/红色"-N" 徽章统计。**这是主对话框里唯一稳定出现"行号"的地方**——Bash 输出、Read 文件正文默认都不带行号(见第 1 节取舍)。

**右侧预览拾取**:`preview-agent/picker.ts` + `popover.ts` + `editBubble.ts` —— 这是给**网页/HTML 渲染预览**用的可视化元素选择器:Shadow DOM 浮层画高亮框跟随 hover 元素、点击锁定选中态、"climb/descend" 沿 DOM 树上下选择父子元素、选中后弹出编辑气泡(改文字/颜色/背景/透明度/字体,记录 from→to 的 diff)。**这明确是"预览一个正在渲染的网页/HTML产物、点选其中元素微调"的机制**,依赖 DOM/Shadow DOM,是网页开发场景专属,与我们桌面通用助手的产物类型(文件/图片/文案)不直接对应,除非我们做"HTML/网页产物"的可视化编辑面板才用得上这套思路。

---

## 4. 动效专项(owner 点名判断)

**cc-haha(桌面 GUI 参考实现,非 ink TUI)自身的动效清单**(全仓搜到的持续/触发动画,已穷举):
- `shimmer`(1.5s ease-in-out 呼吸,0.4↔1 透明度)——用于品牌色 `✦` 图标(忙碌指示器)、流式正文光标
- `spin`(1s linear 360°)——所有 loading 转圈图标(LoaderCircle、面板 loading 态、api_retry 图标)
- `pulse-dot`(1.5s 呼吸,1↔0.3 透明度)——审批"待批准"徽章闪点、后台任务运行中小圆点、工具组"运行中"状态点
- `thinking-cursor-blink`(1s step-end 硬闪,ThinkingBlock 内联定义)+ `thinking-dots`(1.4s 循环 `. .. ...`)——thinking 块专属
- `activity-reveal`(位移+淡入,`translateY(8px)→0`)——**只用在设置页(ActivitySettings),主对话框消息列表完全不用**,新消息直接原地出现、无进场动画
- `composer-drop-fade`/`composer-drop-pulse`——仅拖拽文件到输入框时的接收区反馈,与消息/工具流无关
- 折叠/展开箭头旋转(`transition-transform duration-200`,`rotate(180deg)`)——纯 CSS transition,不是 keyframe 动画
- 进度条填充(`transition-all duration-300`,width 变化平滑过渡)

**评估结论:这套桌面 GUI 是"克制信息型"路线,不是"GUI 型"路线** —— 没有卡片弹入/滑出、没有列表 stagger 交错进场、没有面板缩放开合动效、没有消息气泡的 spring 弹性动画。它的"动效预算"几乎全部花在**表达"正在进行中"这一个语义**上(呼吸/转圈/闪点三件套 + 打字机),状态切换(折叠展开、面板开合)用的是最基础的 CSS transition(位移/旋转/宽度渐变,150-300ms),没有更复杂的编排。

**对我们这款桌面 GUI 软件的推荐:整体贴 cc-haha 的克制型,但作为独立 GUI 桌面软件(非终端衍生物),允许在"面板级容器过渡"上比 cc 稍微多给一点 GUI 质感,不必逐帧照抄 0 动效——逐场景给结论**:

| 场景 | 推荐 | 理由 |
|---|---|---|
| 消息进入(新消息出现在列表) | **cc 型:无进场动画,直接出现** | cc 主对话框实测无 reveal 动画;高频事件(每条消息都放大招)加动效只会显得"抢戏"、拖慢长会话滚动手感 |
| 流式打字(正文/thinking) | **cc 型:50ms 节流批量 + 呼吸/闪烁光标**,原样照抄阈值 | 这是"手感"核心,唯一必须精确复刻的性能+动效组合,自创节流值大概率不如 cc 调过的顺滑 |
| 工具卡状态转场(pending→完成) | **cc 型:原地内容替换,不做卡片级动效** | 折叠头保持稳定、只换右侧状态区图标文字,避免"卡片跳动"打断阅读连续性 |
| 工具卡折叠/展开 | **可以比 cc 稍加 GUI 感**:cc 是纯箭头旋转+瞬间展开(无高度动画迹象);我们可加一个 150-200ms 的 `max-height`/`opacity` 过渡让展开不生硬,但**不加弹性/缩放**,只做线性或 ease-out 位移级过渡 | 桌面 GUI 用户对"面板展开"有更高的动效预期,一个轻过渡不违背"低噪"原则,纯瞬间展开在鼠标/触控板操作下容易显得"卡顿" |
| 面板切换(斜杠命令菜单/文件搜索/后台任务抽屉/设置页tab) | **WorkBuddy 型:轻量淡入+位移(如 150-200ms fade+8px translateY 或抽屉滑入)** | cc 这几处面板本身就是"弹出层"(`absolute bottom-full`/`fixed right-0`),但源码未见其有入场 transition(可能是我们看漏或 Tailwind 类未含);作为独立桌面软件,弹出层类交互(下拉菜单/抽屉/模态)按 macOS/主流桌面软件惯例配轻过渡是用户预期内的基本质感,不算"抢戏"，这条超出 cc 观感、按 WorkBuddy/系统惯例补 |
| 加载态(spinner/骨架屏) | **cc 型:spin 转圈 + shimmer 呼吸**,不用骨架屏(skeleton) | cc 全仓没有骨架屏(shimmer 用于呼吸透明度而非行块占位动画),小面板用简单转圈够用;骨架屏是"预判内容形状"的更重设计投入,不匹配我们工具流"结果形状不可预知"的特点 |
| 审批卡/AskUserQuestion 出现 | **cc 型:随消息流内联出现、无特殊入场** | 它和普通消息一视同仁地出现在流里，特殊化反而打破"这只是对话的一部分"的心智 |
| 后台任务完成通知(小圆点/胶囊变色) | **cc 型:胶囊内图标+文案原地切换(转圈→勾),不做 toast 弹出** | 常驻小按钮本身就在视野边缘,状态变化靠"色彩/图标切换"足够传达,不需要额外弹出提醒抢注意力(除非产品要做"完成后主动播报"，那是另一层——通知中心/toast，不是这个胶囊本身的动效) |

**一句话总结**:**打字机/工具卡状态转场/消息进场 = 严格照抄 cc 的克制信息型(尤其 50ms 节流是数值级必抄项);面板级容器(弹出菜单/抽屉/展开折叠)= 允许按桌面 GUI 惯例加轻量 150-200ms fade/位移过渡,但绝不上弹性(spring)/缩放(scale bounce)/交错(stagger)这类"抢戏"效果。**

---

## 5. cc 专属展示,不搬清单

- **preview-agent 整套(picker/popover/editBubble/treeNav/screenshot/protocol)**——网页元素选择器+可视化编辑气泡,依赖渲染中的 DOM/Shadow DOM,是"预览一个 HTML 页面产物并点选微调"的编码场景专属能力。我们没有"渲染网页给用户点选编辑"的产品场景(生图/剪辑/文档不是可点选 DOM),不搬;除非未来做"HTML 邀请函/海报网页版"类产物才考虑局部借鉴思路。
- **PTY 终端/命令行渲染细节(TerminalChrome 只是外壳,不算)**——ink TUI 那条线里的真终端渲染(vim 模式、命令行补全、trace 窗口)是"cc 面向开发者、要在终端里跑命令"的专属需求。我们审批闸只弹一次性 Bash 卡片+结果摘要,不需要交互式终端。
- **`/status` `/cost` `/context` 会话检查器面板**里的**大量开发者调试信息**(context 分类别 token 堆叠条、API duration、cache read/write 明细、按模型拆分用量表)——这是给"开发者要精算 token/费用"设计的仪表盘。我们"内置 key 不设消费上限、别提醒花钱"的产品铁律与此直接冲突,这类信息**不该暴露给店主用户**(参考项目记忆:no-money-nagging、harness-internal-not-exposed-frontend)。
- **Trace/调试详情面板(TraceList/TraceSession/LlmCallDetail/ToolDetail/MessageDetail,`showLineNumbers` 的 JSON 视图)**——面向"调试 agent 本身行为"的开发者工具,我们的用户不需要看原始 tool_call JSON。
- **MCP/Skills 管理面板里的"scope 分组(user/local/project)"**——这是多项目开发者工作流的概念,我们单工作区场景下这层分组冗余。
- **`ComputerUsePermissionModal`(电脑操控专项审批)、`AwsAuthStatusBox`、`ConsoleOAuthFlow`、`IdeAutoConnectDialog`/`ShowInIDEPrompt`(IDE 联动)**——依赖特定云厂商登录/IDE 插件生态,我们全本地免登录不涉及。
- **虚拟化消息列表(长会话性能优化)**——是"必要时"的工程优化,不是交互设计的一部分,初版可先直接 map 渲染,量大了再补,不影响本篇的交互规格。

---

## 6. 信息密度与低噪原则(cc 怎么把"过程"翻译给用户又不刷屏)

1. **默认折叠、按需展开**——工具卡、thinking 块、任务栏详情,默认态全部是"一行摘要",只有明确 `expandable` 才给箭头,用户主动点才看细节。这是最大的降噪手段。
2. **进行时→过去式的动词切换,而非"新增一条状态消息"**——同一元素原地把"Thinking…"变成"Thought"、"Preparing edit"变成"3 lines changed",不用再发一条新的系统消息宣告"完成了"。避免消息列表被状态播报灌水。
3. **连续同类动作编组成一张卡,不平铺**——`buildRenderModel` 把连续 tool_use 折成一个 `tool_group`,组头一句话汇总("Read 3 files, ran 2 commands"),而不是三张独立卡片占三行。
4. **结果默认只给摘要,正文按需**——Bash stdout/Read 文件正文默认不显示,只有出错才展开正文;这是"信任但不举证"的取舍,减少视觉噪音的同时保留"出错时能看清楚"的兜底。
5. **tool_result 不单独成行**——内联进对应的 tool_use 卡片里,不产生"一问一答"两条消息的双倍行数。
6. **状态标签用小尺寸弱化排版**(10-11px、`text-tertiary` 灰、徽章圆角胶囊)——次要信息(token数/耗时/来源标签)视觉权重刻意压低,不与正文/结果内容抢注意力。
7. **面板类交互(斜杠菜单/文件搜索/任务抽屉)统一走"从触发点旁弹出的局部浮层"而非"全屏模态"**——保持用户在主对话流的上下文感,不因为查一下状态就打断整个会话视野。

---

## 盲区(诚实标注)

1. 未实际启动 cc-haha 桌面版跑一遍观察真实像素级观感/动效手感,以上时长/曲线数值均取自源码 CSS 字面值,未做真机录屏验证。
2. `composer-drop-fade`/`activity-reveal` 等 keyframe 是否有其他调用点未 100% grep 穷尽所有 `.tsx`(仅搜了 `components/` + `pages/`,`workbench/`/`teams/`/`browser/` 等子目录未逐一确认零命中)。
3. 面板级弹出层(`LocalSlashCommandPanel`/`FileSearchMenu`/`BackgroundTasksBar` 抽屉)的 className 里未见到明确的 enter/exit transition 类名,推断"cc 未做入场动效"是基于代码静态读取,不排除有全局路由级/Framer Motion 之类的包裹层做了转场而未在这几个文件里体现(未在 `App.tsx`/根布局里交叉确认)。
4. ink TUI(`~/Desktop/cc-haha-ref/src/`)侧的动效(如 `Spinner.tsx` 87KB、`Spinner/` 目录下的多种 spinner 帧)未展开细读——因为已判定"终端渲染方式要翻译成桌面 GUI、不直接搬",桌面版参考实现(`desktop/src/`)信息更直接可用,故未深入 ink 侧的帧动画字符集节流细节。
