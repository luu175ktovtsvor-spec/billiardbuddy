# cc-haha 后端全对齐 · 缺口总清单

> 🚧 **审计·全抄 cc 后端补齐依据** — 只读审计,不改代码。
> 规格 = `/Users/swl/Desktop/cc-haha-ref/src`(cc-haha 源码);对照 = `/Users/swl/Desktop/球房运营AI助手-桌面版/ts/src`。
> owner 铁令:**全抄 cc 整个后端、不阉割、全部功能接进来**。四类问题:①对齐缺口 ②自研分叉 ③bug/死链/占位桩(点了没反应/改出来不对=反逻辑) ④computer use 专项。
> 诚实原则:**占位/死链绝不算"做好了"**。本清单 = 后端施工总账。

---

## 0. 总览(去重合并后)

6 区素材已去重合并(重叠项:computer use ×3、MCP OAuth ×2、插件贡献没接主回合 ×2、verification 子代理 ×2、定时调度 ×2、PDF/二进制读 ×2),合并后 **共 40 条**。

| 类型 | P0 | P1 | P2 | 小计 |
|------|----|----|----|------|
| ① 对齐缺口(cc 有我们没/半接) | 1 | 5 | 12 | 18 |
| ② 自研不符合逻辑(分叉,需掰回或标注) | 0 | 0 | 11 | 11 |
| ③ bug/死链/占位桩(点了没反应=反逻辑) | 0 | 4 | 7 | 11 |
| **合计** | **1** | **9** | **30** | **40** |

另附:**已核对对齐、无需动**的板块清单(见 §5),用于排除误报、证明覆盖面。

---

## 1. ① 对齐缺口(cc 有、我们没有或只接了一半)

### G-01 · Computer Use 全子系统 【P0 · 缺口/owner 点名④】
- **是什么**:截图 / 点击(左右中/单双三击/拖拽)/ 鼠标移动 / 滚动 / 键盘 type/key/hold_key / 光标位置 / wait,外加 `computer_batch` 批量、`teach_step/teach_batch` 示教、`request_access` 逐 app 授权;安全层有 per-app 权限分层(sentinel/denied apps)、按键黑名单、截图按 app 白名单在合成器层过滤。
- **cc 在哪**:`vendor/computer-use-mcp/`(executor/mcpServer/tools/toolCalls/subGates/deniedApps/sentinelApps/keyBlocklist/pixelCompare/imageResize.ts)+ `runtime/mac_helper.py`&`win_helper.py`&`requirements(-win).txt` + `server/api/computer-use.ts`(620 行,GET status / POST setup:自动建 venv、装 pyautogui、检权限)+ `computer-use-python.ts` + `services/computerUseApprovalService.ts` + `components/permissions/ComputerUseApproval/` + `utils/computerUse/`;`main.tsx:1604-1640` 按 darwin/win32 门控挂载为保留名 MCP,`--no-computer-use` 可关。
- **我们现状**:**0 行,连桩都没有**。`grep computer.?use / mac_helper / win_helper / pyautogui / screenshot / browser / snip` 全库 0 命中,无 vendor、无 runtime、无 status/setup 端点、无审批服务、无 UI、无 CLI 开关。
- **关键澄清**:cc `tools/` 里的 SnipTool / WebBrowserTool / TerminalCaptureTool 都是 `@generated` DCE 桩,**没有真实现**;真能力全在 `vendor/computer-use-mcp`。别去搬那几个桩。
- **平台**:cc 门控 `darwin || win32`,**Windows 也支持**——我们出包目标就是 Windows(task#35),不能用"平台不适用"豁免。
- **要补(可行动)**:整包移植 `vendor/computer-use-mcp/` + `runtime/*.py` + `server/api/computer-use*.ts` + `computerUseApprovalService` + `utils/computerUse` + `ComputerUseApproval` 面板;按我们审批闸口径(对外/不可逆动作卡审批)接入。Windows helper 需评估(pyautogui/截图路),这块是净新工作、不是纯搬 cc。
- **诚实备注**:对台球运营产品本身非核心;area5 评 P2、area1/area6 评 P0/P1。**按 owner"全抄不阉割"铁令 + Windows 目标,定 P0**;若产品侧要务实取舍,可降为 P1 单独立项。

### G-02 · MCP OAuth 认证(McpAuthTool + authProvider)【P1 · 缺口】
- **是什么**:现代远程 SaaS MCP(Notion / Linear / Sentry / Atlassian / GitHub 远程)清一色 OAuth;没有它,用户在设置里加远程 MCP → 拿不到 token → **连接静默失败**(典型"点了没反应")。
- **cc 在哪**:`services/mcp/auth.ts`(~2465 行 OAuth)+ `tools/McpAuthTool/McpAuthTool.ts`(215 行,`/mcp` 发起授权、监听回调换 token)+ `services/oauth/*`(auth-code-listener/crypto/client/getOauthProfile)。
- **我们现状**:半接。资源/prompt 工具已齐(`mcp/client.ts:552` makeMcpCapabilityTools 真实现),但 `client.ts:369` 代码注释自认"authProvider 完整 OAuth 未移植,超出本次范围";http/sse 传输只支持 `config.headers` 手贴 Authorization(`config.ts:14-18`)。
- **要补**:移植 McpAuthTool + auth.ts + OAuth 授权码回调 listener + token 落盘(复用已有凭据加密),让 http/sse 传输能挂 authProvider。

### G-03 · 定时调度(agent 面向 ScheduleCron 工具 + 真调度执行引擎)【P1 · 缺口 + 占位桩】
> 合并 area1「ScheduleCronTool 缺失」+ area6「定时任务只存不跑」两条(与 §3 D-03 是同一根,统一在此)。
- **是什么**:让 agent/用户建"每天 9 点出日报"这类定时任务并**真到点执行**。owner 认定单店老板高频刚需。
- **cc 在哪**:`tools/ScheduleCronTool/`(CronCreate/Delete/List/Update Tool + prompt.ts)。
- **我们现状**:**两头都缺**。①无 agent 面向的 cron 工具(仅 `tasks/bridgeWorkerRefreshScheduler` 是内部网关凭据刷新、非 agent 面向)。②`server/services/desktopDataStore.ts:327-341` CRUD 真落盘,但 `next_run_at` 硬编码 null、`server/index.ts:3244-3267` 只有增删改查,**全库无任何 tick/cron 循环读 scheduledTasks 到点触发**——用户建的定时任务永不执行(owner 大忌"点了没反应")。
- **要补**:移植 ScheduleCronTool 四件套 + 落地真调度执行引擎(定时唤醒 → 拼指令 → 跑 agent → 回写 next_run_at/last_run_at)。**做自动化面板(task#53)前/同时必须先补这个引擎**,否则面板一上就是死的。对应 task#53。

### G-04 · Prompt caching 断点未设(只接"检测"没接"真缓存")【P1 · 缺口,限 anthropic-format provider】
- **是什么**:owner 问的"prompt cache 齐不齐"——答案**半接**。破缓存检测子系统一字不差搬了,但它监控的"真缓存"根本没开。
- **cc 在哪**:`services/api/claude.ts:638,650,683,698,3468`(system 块/工具/最后 1-2 条消息都挂 `cache_control: getCacheControl()`)。
- **我们现状**:`model/AnthropicMessagesModel.ts:65-76` buildBody 全程无 cache_control;检测侧 `context/promptCacheBreakDetection.ts` 已完整移植。→ 走 anthropic-format provider 时缓存命中恒 0:每回合全额重付 system+工具+全历史(几万 token),成本/首字延迟每轮全付;`usage.cache_read_input_tokens` 恒 0 → checkPromptCacheBreak 在这条路永不触发(=那套检测在此路径是死代码)。
- **要补**:buildBody 给最后一个 system 块、最后一个 tool、最后 1-2 条 user 轮挂 `cache_control:{type:'ephemeral'}`(网关/不支持的 provider 下要能安全降级)。OpenAI 兼容路(ProxyModel,国产模型)靠上游前缀自动缓存、可接受、无需改。

### G-05 · 配置/工作目录不持久化(选的工作区一重启就丢)【P1 · 缺口】
- **cc 在哪**:`utils/cwd.ts`(getCwd/setCwd 持久 cwd)+ additionalWorkingDirectories 落 permissionContext + 最近项目。
- **我们现状**:①`desktop/renderer-react/src/stores/settingsStore.ts:17-24` workspaceRoot 纯内存、无 zustand persist/localStorage(同目录 uiStore 主题却写了 localStorage)→ app 一重启选的文件夹就没了;②`server/services/userSettings.ts:13-18` 只存权限档+主题,无"上次工作区/最近项目";③sessionService 虽按 session 存了 workspaceRoot 且能 listRecentProjects,但前端启动不回灌 settingsStore。对应 task#19。
- **要补**:settingsStore 加 persist(workspaceRoot),或服务端 userSettings 增 lastWorkspaceRoot/recentWorkspaces,启动时回填;首启引导选工作目录。

### G-06 · cc 95 斜杠命令搬运进度低(13 命令 + 10 skill vs cc 95)【P1 · 缺口】
- **cc 在哪**:`src/commands/`(95 个子目录)+ `commands.ts`。
- **我们现状**:`ts/commands/` 仅 13 个(agents/compact/context/cost/doctor/help/mcp/memory/model/output-style/permissions/plugins/skills);bundled skill 10 个;builtinCommands 仅 fork。明显缺的用户面命令:`/add-dir`(加工作目录,类型 AdditionalWorkingDirectory 已有但没斜杠入口)、`/hooks`、`/config`、`/export`、`/resume`、`/clear`、`/rewind`、`/vim`、`/theme`、`/status`、`/release-notes`、`/login-logout`。对应 task#24(早期)。
- **要补**:按白标口径逐波搬运,优先 `/add-dir /hooks /config /export /resume /clear`。

### G-07 · PDF 读通道完全缺失(pages 声明了却被忽略)【P1 · 缺口】
> 与 §3 B-01(二进制乱读)同源联动。
- **cc 在哪**:`tools/FileReadTool/FileReadTool.ts`(pages 分页、extractPDFPages 抽页成 image 块、PDF 作 DocumentBlockParam 送模型)+ `utils/pdf.ts` + `constants/apiLimits.ts`(PDF_MAX_PAGES_PER_READ)。
- **我们现状**:`tools/fileReadTool.ts:51/57` 描述明写"pages ignored for non-PDF files in this TS harness stage",PDF 无任何处理;`types/message.ts` ContentBlock 根本没有 document 块类型。→ `read_file({path:'x.pdf',pages:'1-5'})` 落到文本读路径 → 乱码。owner 大忌"给的不是那个东西"。
- **要补**:①read_file 加 PDF 分支(抽页成图或 document block);②消息层补 document content-block 类型。

### G-08 · ConfigTool(agent 读写用户 settings)【P2 · 缺口】
- **cc 在哪**:`tools/ConfigTool/`(ConfigTool/supportedSettings/prompt.ts,白名单改权限/模型等)。我们缺 agent 面向的配置编辑(有 saveMemory/projectInstructions 但不改 settings)。**要补**:移植 ConfigTool,按白标/网关口径裁掉暴露底层模型的项。

### G-09 · RemoteTriggerTool(远程触发 agent 运行)【P2 · 缺口·待核实】
- **cc 在哪**:`tools/RemoteTriggerTool/RemoteTriggerTool.ts`。我们有 `tasks/bridge*.ts` remote/bridge 底盘可能部分覆盖,但**没暴露成工具**。**要补**:核实 bridgeRemote* 是否等价;不等价则补工具。

### G-10 · verification 内置子代理【P2 · 缺口】
> 合并 area1 + area4。
- **cc 在哪**:`tools/AgentTool/built-in/verificationAgent.ts`(agentType: 'verification')。我们 `agents/bundled/` 只有 explore/general-purpose/plan;有 verifyPlanExecutionTool 但那是"计划收工验证"工具、与"独立验证子代理"不是一回事。**要补**:补 verification.md 内置代理定义。(cc 的 statuslineSetup/claudeCodeGuide 是品牌向,可跳过。)

### G-11 · 压缩后不回灌"已批准计划(plan)正文"【P2 · 缺口】
- **cc 在哪**:`services/compact/compact.ts` createPlanAttachmentIfNeeded + buildPostCompactMessages(:362-369 把 plan attachment 塞回压缩后上下文)。我们 `harness/loop.ts:414-421` maybeCompact 只恢复最近文件、无 plan 回灌 → 执行途中触发自动压缩可能把计划细节丢了(边执行边失忆)。**要补**:补 post-compact 的 plan 回灌。

### G-12 · findRelevantMemories(按 query 动态挑相关记忆)未移植【P2 · 缺口】
- **cc 在哪**:`memdir/findRelevantMemories.ts` + `memoryScan.ts`(Sonnet 侧查询挑 ≤5 个相关 topic 记忆正文喂进去)。我们 `harness/claudemd.ts:746-754` 只注入 MEMORY.md 索引,无后半段动态检索 → 攒了很多 topic 记忆但模型每轮只看得到一行索引。**要补**:补 findRelevantMemories 侧查询,或系统提示明确指示模型按索引主动读。

### G-13 · teamWatcher 活体投递缺失(运行中会话收不到新 teammate 消息)【P2 · 缺口】
- **cc 在哪**:`server/services/teamWatcher.ts`(watch inbox 文件、活体推送)。我们 `tasks/teamService.ts:388-435` inbox 只在回合起始拉一次、无文件监听 → idle 主会话不被新消息实时打断。单机单用户下优先级低。**要补**:补 inbox 文件 watcher。

### G-14 · 无 small/fast 第二模型层(廉价任务用主模型)【P2 · 缺口】
- **cc 在哪**:`utils/model/model.ts:41-42` getSmallFastModel(haiku),被 WebSearch/WebFetch/标题/压缩/摘要复用。我们 `tools/webFetchTool.ts` distill() 用主模型 → 成本更高、抢占主出口。**要补**:加可选"轻任务出口"env(ANTHROPIC_SMALL_FAST_MODEL / 第二 provider)。

### G-15 · 无超大图降采样(超预算原图直送)【P2 · 缺口】
- **cc 在哪**:`utils/imageResizer.ts`(sharp 按 token 预算缩放后再送)。我们 `tools/imageRead.ts / fileReadTool.ts:formatImageRead` 注释明写"本仓库无重采样能力",4K 截图超 8000 token 仍原图直送 → 多数 provider 有单图边长/字节硬上限,可能被 provider 端直接拒。**要补**:接纯 JS/系统工具降采样,或对超尺寸图给更强拒读提示。

### G-16 · 无 per-model 视觉能力门控(默认所有 openai_chat 出口当 vision 可用)【P2 · 缺口】
- **cc 在哪**:`utils/model/modelCapabilities.ts / modelSupportOverrides.ts`。我们 `model/providerConfig.ts:imageContentMode` 默认 'vision',纯文本模型(deepseek-chat)读图会在 provider 端报错、全靠手动设 env。**要补**:至少能力探测失败时优雅降级 text_only。

### G-17 · 插件安装无 marketplace/校验/黑名单/版本/依赖(纯 git clone,零安全扫描)【P2 · 缺口】
- **cc 在哪**:`utils/plugins/`(marketplaceManager/validatePlugin/pluginBlocklist/pluginPolicy/pluginVersioning/dependencyResolver)。我们 `plugins/pluginLoader.ts:191` installPluginFromGithub 直接 `git clone --depth 1`、无任何校验(插件的 hook/mcp 都是可执行代码,零校验 clone 任意 repo 是风险面)。对应 task#56。**要补**:至少 validatePlugin(结构/manifest 校验)+ 导入前信任确认 + 全局急停开关;marketplace 可裁剪。

### G-18 · dataeye 数据看板上报未接(新 TS 内核 0 处上报)【P2 · 缺口/自家埋点】
- **我们现状**:`ts/src` 全库无 dataeye/reportEvent/analytics 调用(claudemd.ts 明说"去 analytics")→ 运营侧看不到用量数据。非 cc 对齐项,属自家埋点缺口。对应 task#16。

---

## 2. ② 自研不符合逻辑(我们的分叉:需掰回 cc,或如实标注降级)

### S-01 · 自动压缩阈值 70% vs cc 约 92%(反而更早"失忆")【P2 · 分叉】
- **cc**:`services/compact/autoCompact.ts:62,72` 阈值 = effectiveWindow − AUTOCOMPACT_BUFFER(13k)≈92%+。**我们**:`context/compaction.ts:5` AUTOCOMPACT_RATIO=0.7。→ 我们更早、更频繁把细粒度历史压成摘要,对 owner"不失忆"是负面。**建议**:对齐 cc 的"固定预留缓冲(窗口−约 13k)",把摘要推迟到真临近上限。

### S-02 · 自动压缩加了 30s 冷却闸(cc 没有)【P2 · 分叉】
- **cc** 靠消息数增长 + 连续失败熔断、无 wall-clock 冷却;我们 `compaction.ts:9` AUTOCOMPACT_COOLDOWN_MS=30_000。安全性没问题(force 路径绕过),仅对齐性偏差。**建议**:最终掰回时改用 lastCompactedMessageCount 消息数增长。

### S-03 · 破缓存"TTL 过期"分支是死代码(消息无 timestamp)【P2 · 分叉·低危】
- 我们 Message 不带 timestamp,`promptCacheBreakDetection.ts:91-96` lastAssistantAgeMs 永远 0 或 null → "5min/1h TTL 过期"两条原因分支走不到。纯监控精度问题,记录以免误判已对齐。

### S-04 · plan 不落盘 + 验证门(pendingPlanVerification)不跨 resume 持久化【P2 · 分叉/隐性反逻辑】
- **cc**:`tools/ExitPlanModeV2Tool.ts:243-261` + `utils/plans.ts`(计划写盘,VerifyPlanExecution/Read 可复读、跨压缩/resume 存活)。**我们**:`harness/loop.ts:960-971` exit_plan 把 plan 塞内存 ctx、不写文件 → 会话打断再 resume 后 ctx.pendingPlanVerification 丢了 → 收工验证门静默消失,模型可能不验证就总结("批了计划、resume 后门没了")。**要补**:plan 文本+待验证标记写进 session meta/transcript,resume 时重建门。(退出档位固定切 acceptEdits 是 owner 有意选择,不算 bug。)

### S-05 · memdir 记忆按 workspace.root 分区,未做 cc 的 git root 归一【P2 · 分叉】
- **cc**:`memdir/paths.ts:203-235` getAutoMemBase = findCanonicalGitRoot(...) ?? projectRoot。**我们**:`harness/memoryNames.ts:128-135` 直接拿 workspace.root 做 slug → 同仓库选父目录 vs 子目录、或子代理跑隔离 worktree 时各自派生不同记忆池、记忆不通,worktree 清理后写进 <worktree>/.claude 的记忆直接丢。**要补**:sanitizePath 前先 findGitRoot 归一,拿不到再回退 workspace.root。

### S-06 · 无 folder 时默认工作目录 = Electron userData(不透明内部目录)【P2 · 分叉】
- **我们**:`desktop/electron/main.ts:63-65` sidecar cwd = userData(规避了 cwd='/' 写不下的真坑,这点对);副作用:用户没选文件夹时默认工作区=app 内部目录,且所有"未选文件夹"会话共用一份记忆池,与 cc"默认在启动项目目录干活"不一致。**要补**:首启引导选目录或默认到 ~/Desktop 等可见目录。

### S-07 · hooks 事件只覆盖 13/20;#32"hook 事件 27"口径不实【P2 · 分叉/台账纠错】
- **cc** HOOK_EVENTS(`coreSchemas.ts:355`)共 20 个。**我们** `hooks/hooks.ts:10-24` 有 13 个,缺 7:PermissionRequest、PermissionDenied、Setup、TeammateIdle、TaskCreated、TaskCompleted、Elicitation(前二属权限区、供审批自动化/审计;Task* 供任务生命周期;Elicitation 供 MCP 表单)。已覆盖的 13 个 call site 都真接线、四种执行器齐全、信任门到位(这部分是好的)。**建议**:补 7 个事件 + 纠正台账 #32 口径(实为 13/20)。

### S-08 · lspTool 是正则假 LSP(cc 是真 vscode-languageserver 语义)【P2 · 分叉/反逻辑】
- **cc**:`tools/LSPTool/LSPTool.ts` import 'vscode-languageserver-types' 真 LSP。**我们**:`tools/lspTool.ts` 只 import node:fs,169/224/283-292 全靠正则 + `\bsymbol\b` 文本匹配,无 spawn/无 LSP client;却对模型声明 goToDefinition/findReferences/hover/implementation。→ 跨文件/重载/类型解析场景给出错误结果(把同名文本当引用)。**要补**:补真 LSP,或 description 里如实降级说明"文本级近似"。

### S-09 · store-docs 检索是关键词匹配,不是宣称的嵌入 RAG【P2 · 分叉/自欺】
- **我们**:`server/services/storeDocsService.ts:200-451` search 用 `doc.text.includes(term)` + 人工同义词组,无 embedding/vector/cosine;但 CLAUDE.md 自称"即时检索 RAG(嵌入走 Node sidecar)"。对应 task#57(#12 RAG 语义待核)。**要补**:补 embedding(transformers.js/onnx sidecar),或把"语义 RAG"表述改成"关键词检索"避免自欺。

### S-10 · WebSearch 只走自家网关,未接 cc 的 native/tavily/brave 三档 + 降级【P2 · 有意分叉·低】
- **cc**:`tools/WebSearchTool/backend.ts`(auto/anthropic/tavily/brave/disabled + native 失败降级)。**我们**:`tools/webSearchTool.ts` 只认 QF_GATEWAY/QF_WEBSEARCH,未配即整体 unavailable。属白标"收敛自家网关"的有意分叉,风险仅在网关未配时 web 搜索整体不可用。

### S-11 · Provider 层无预置(presets)【P2 · 有意分叉·低】
- **cc**:`server/config/providerPresets.json`(deepseek/kimi/glm/qwen/minimax/anthropic)。**我们** `providerService.ts` 已覆盖 BYOK 多 provider 保存/激活/加密/测试/fallback(对齐度高),唯独缺预置清单。因白标要隐藏真实模型名、预设价值本就低。

---

## 3. ③ bug / 死链 / 占位桩(点了没反应 / 改出来不对 = owner 反逻辑大忌)

### D-01 · 插件的 命令/技能/MCP 工具没接进主流式回合(装了插件在对话里用不了)【P1 · 死链/反逻辑】
> 合并 area3 + area6,同一 bug。
- **现状**:主回合(`server/index.ts:1506` loadLayeredSkills / `:1508` loadCommandsForWorkspace / `:1581/1736` loadMcpToolsFromFile)只加载**非插件**来源;`resolveEnabledPluginContributions` 全项目**只在 `:2243` buildExecutionRegistry(审批放行执行路径)被调用**。更露馅:插件 HOOKS 反而在主回合并了(`:1572-1575`),独漏 commands/skills/mcp。→ 用户经 `/plugins/install`+toggle 装并启用插件后,模型在正常对话里**看不到插件的斜杠命令/技能/MCP 工具、也调不到**(敲插件的 /foo 都解析不到),只有某工具恰好走到审批-再执行那条路才短暂出现 → buildExecutionRegistry 的并入形同虚设。owner 大忌"点了没反应"。对应 task#63。
- **要补**:把 resolveEnabledPluginContributions 的 skillsDirs/commandsDirs/mcpConfigPaths 并进主回合的 skills/commands/mcpTools(照 `:2244-2268` 合并逻辑抄到 startQuery 段)。

### D-02 · Anthropic 出口不接 extended thinking(深度思考),但前端显示"增强(深度思考)"【P1 · 反逻辑】
- **cc**:`services/api/withRetry.ts`(thinking:{type:'enabled',budget_tokens})+ `claudeEffort.ts`(effort→reasoning_effort)。**我们**:openai_chat 路 reasoning_effort 已透传,唯独 Anthropic 路径把 reasoningEffort 整个丢弃、从不发 thinking(`modelFactory.ts:34-46` 不传、`AnthropicMessagesModel.ts:10-27+66-73` config 无字段/buildBody 无 thinking);而 `publicModelNames.ts` reasoningEffort==='high' → 显示"增强(深度思考)"。Anthropic 扩展思考默认关闭、必须显式开。→ 网关是 Anthropic 格式时,用户选"深度思考"→ Claude 出口实际不思考,**UI 承诺与后端行为不符**("改出来不对")。
- **要补**:AnthropicMessagesModel 接 reasoningEffort → thinking:{type:'enabled',budget_tokens},不支持的 provider 安全降级。

### D-03 · 定时任务只存不跑(next_run_at 恒 null,无调度器)【P1 · 占位桩/反逻辑】
> **已合并进 §1 G-03**,此处仅交叉引用。用户建"每天 9 点出日报"永不执行。做自动化面板前必须先补真调度引擎。

### D-04 · read_file 对非图二进制(PDF/docx/xlsx/zip/字体)当 UTF-8 读成乱码【P1 · bug/反逻辑】
> 与 §1 G-07(PDF 缺失)同源联动。
- **cc**:`FileReadTool.ts:474-483` hasBinaryExtension 命中即报"This tool cannot read binary files" + `constants/files.ts:BINARY_EXTENSIONS` + isBinaryContent(空字节/不可打印比例)。**我们**:`tools/fileReadTool.ts` 只对 isImageExtension 特判,其余一律 buffer.toString('utf8');`fileIoSafety.ts` 无 binary/null-byte 守卫。→ 老板让读 PDF 价目表/合同/.docx,模型收到一坨 mojibake 而非"这是二进制文件,请用别的工具"。
- **要补**:加 hasBinaryExtension + 空字节/不可打印比例检测,二进制文件明确报错而非乱读。

### D-05 · .mcp.json 工作区信任闸有后端无审批 UI(被打开仓库的 .mcp.json 永久静默跳过)【P2 · 占位桩】
- **现状**:McpTrustStore + resolveTrustedMcpConfig 实现完整、安全默认正确(未信任=不自动连+回灌警告);但授予信任只有 `POST /api/v1/agent/mcp/trust` 或启动 opts.trustedWorkspaceRoots 两条路,`mcpTrust.ts:11` 自注"审批 UI 待 ts-desktop"。→ 桌面壳打开带 .mcp.json 的用户仓库时,除非预信任,那些 MCP 永远连不上且**用户没任何按钮批准**——功能半死。**要补**:桌面壳出"此工作区 .mcp.json 是否信任"确认卡,点确认后 POST /mcp/trust。

### D-06 · MCP_PRESETS 是空数组占位(/mcp/presets 端点返回空)【P2 · 占位桩】
- `mcp/configStore.ts:5` MCP_PRESETS = [];`server/index.ts:3804` /presets 端点永远返回空 → "一键添加常用 MCP"是空壳,前端若渲染"推荐 MCP"是空面板。**要补**:填几个常用 stdio preset(filesystem/git/fetch)或前端隐藏该入口。

### D-07 · canvas/edit 是 local_fallback 桩(不调模型,把 instruction 拼在 content 后返回)【P2 · 占位桩】
- `server/index.ts:2631-2638` mode:'local_fallback',content + '\n\n' + instruction。同块 doc/sheet/excel-edit/doc-blocks/doc-save 都是真实现,独 edit 是桩。目前无调用方=死端点;但 task#17"右侧预览点选改"若接上,用户选文字让 AI 改 → 拿到"原文\n\n指令"字面拼接而非 AI 改写("改出来不对")。**接线前必须换成真模型改写。**

### D-08 · fork 子代理机制全建好却默认休眠、产品里从不激活【P2 · 占位桩】
- 链路完整正确(buildForkRunContext 继承父对话/工具池、resumeBackgroundAgentTask 重建合成 AgentDefinition、buildWorktreeNotice 处理隔离 worktree——本区做得最扎实的);但 `agents/forkSubagent.ts:15-17` isForkSubagentEnabled 只认 env DESKTOP_AGENT_FORK_SUBAGENT/CC_HAHA_FORK_SUBAGENT,**全仓库无处设置该 env**,系统提示也无"default to forking"指示 → 模型永远不会隐式 fork(装了没插电)。**要补**:给设置/env 默认开 + 系统提示补 fork 指引;否则明确标注为实验特性。

### D-09 · 提交进树的构建产物 main.mjs 与源码 main.ts 不同步(缺 4 个 IPC handler)【P2 · bug】
- `desktop/electron/main.mjs`(旧)vs `main.ts`(新):main.mjs 缺 desktop:pickWorkspace / preventSleep:start / preventSleep:stop / runtime:getServerUrl。package.json main 指向 main.mjs。正常出包 desktop:dist 会重生 main.mjs、不受影响;但任何直接 `electron desktop/electron/main.mjs`(E2E 骨架、手测)会跑到旧壳 → 选工作目录/防休眠/取 serverUrl 全失效。**要补**:构建产物别提交进树(加 .gitignore),或 dist/E2E 前强制重建校验。

### D-10 · 本地视频出方案两条路并存(createLocalPlan 占位 vs v2 真引擎)【P2 · 反逻辑/待清理】
- task#43 已把 B-Roll 五步引擎(buildBrollOps 真实现)做出;但老 `media/videoEditProjects.ts:794-985` createLocalPlan 仍在,对 broll 路仍输出"占位初剪、五步下一轮"过时话术、used_vlm 恒 false。端点 `index.ts:3045 auto_plan` / `3054 auto_plan_v2`。若 v1 仍映射 createLocalPlan,用户走 v1 拿到占位初剪+"引擎还没做"的自相矛盾报告。**要补**:media 侧确认 v1/v2 各映射到哪,退掉过时 createLocalPlan(并入 task#59 废弃代码清理)。

### D-11 · hooks.ts 头部注释过时(SessionEnd/Notification/StopFailure 标"待接线"实际已接)【P2 · 文档漂移】
- `hooks.ts:6-8` 注释说三者"call site 待宿主接线",实际已真接线(SessionEnd@`server/index.ts:428`、Notification@`loop.ts:1032`、StopFailure@`loop.ts:314`)。easy fix,更新注释即可,免得后人误判未生效。

---

## 4. Computer Use 专项结论

- **cc 有没有?** 有,而且是**真·完整**子系统(不是 tools/ 里那几个 DCE 桩,真能力在 `vendor/computer-use-mcp/` + Python helper + setup API + 审批服务 + 审批面板 + CLI 开关),动作全集见 §1 G-01。cc 门控 `darwin || win32`。
- **我们接没接?** **完全没接,零代码**,连桩都没有(全库 0 命中)。
- **要不要接?** owner 铁令"全抄不阉割"+ 点名④ + **出包目标就是 Windows(cc 支持 win32)**→ 属真缺口,**建议接,定 P0**。诚实提醒:对台球运营产品本身非核心,若产品侧务实取舍可降 P1 单独立项;Windows helper 是净新工作(pyautogui/截图路)、不是纯搬 cc,需单独评估工时。
- **怎么接**:整包移植 vendor/computer-use-mcp + runtime/*.py + server/api/computer-use*.ts + computerUseApprovalService + utils/computerUse + ComputerUseApproval 面板,按我们审批闸口径(对外/不可逆动作卡审批)接入。

---

## 5. 已核对对齐、无需动(排除误报 · 证明覆盖面)

- **工具核心批**(全真实现已注册,无桩):Bash(runCommand)/PowerShell/WebFetch/WebSearch/Glob/Grep/LSP*/NotebookEdit/TodoWrite/ToolSearch/Skill/Plan/Worktree/AskUserQuestion/Brief/StructuredOutput/REPL/StoredToolResult;FileReadMany(超出 cc,额外批量读);读图 vision 真回灌(task#46)。*LSP 见 S-08 降级说明。
- **后台任务族 + Team 多代理 + MCP 资源/prompt**:TaskCreate/Get/List/Output/Stop/Update、TeamCreate/Delete/SendMessage/ListPeers、makeMcpCapabilityTools(list/read resource+prompt)全真实现已注册。
- **我们超出 cc 的增值自研工具**(非分叉):git 状态/历史、codeOutline、spreadsheet(真改 xlsx/csv)、listDir、文件历史回滚、诊断、saveMemory、backgroundCommand。
- **上下文"不失忆"核心机制**:autocompact 触发/PTL 收缩重试/连续失败熔断/工具结果落盘预算裁剪/resume 重建/max_tokens 两级续写(8k→64k)/UI 独立 append-only 事件日志——真接线非空壳。cc 的 reactiveCompact/contextCollapse/TOKEN_BUDGET 属 ant 实验 DCE 桩、正确地"没抄"。
- **权限/沙箱/审批/危险命令**:权限五档 + forceConfirm 旁路 + fatal 硬拒、真包 @anthropic-ai/sandbox-runtime、dangerousCommand.ts(4284 行,比 cc 更全)、HMAC 审批令牌、addDirectories 权限更新——已对齐甚至超出。
- **hooks 已覆盖的 13 事件**:四种执行器 + 信任门到位(缺的 7 个见 S-07)。
- **桌面 plumbing**:SidecarSupervisor(退避/重启封顶/Win taskkill /T)、crashGuard、singleInstance/keychain/credentialKey/preventSleep 已装。cc 的 daemon/self-hosted-runner/ssh 属云端 CI 形态,与本地单机桌面定位不同,判有意范围差异。
- **fork 续跑链路 + 主会话 transcript 持久化/resume**:已接通核对通过(fork 默认休眠问题见 D-08)。
- **providerService**:BYOK 多 provider 保存/激活/加密/测试/fallback 已覆盖(缺 presets 见 S-11)。
- **cc 的 DCE 桩工具**(SnipTool/WebBrowserTool/TerminalCaptureTool/MonitorTool/SleepTool/PushNotification/ReviewArtifact/SubscribePR/等):cc 里就是占位桩、无真实现可抄,**不构成缺口**;截图/浏览器真能力在 computer-use-mcp(G-01)。ListPeers 我们反而有真实现,WorkflowTool 我们用 commands 替代。

---

## 6. P0 阻断清单(最该先补的)

按"owner 点名 + 点了没反应/改出来不对(反逻辑大忌)"口径,以下 5 件为真阻断(其中仅 G-01 素材共识 P0,其余 4 条素材标 P1、但同属 owner 大忌反逻辑、影响核心 UX,**建议提到 P0 优先波次先止血**):

| # | 项 | 类型 | 症状 |
|---|-----|------|------|
| P0-1 | **Computer Use 全子系统**(G-01) | 缺口/owner④ | 完全没接,owner 点名最大缺口 |
| P0-2 | **插件贡献没接进主回合**(D-01) | 死链 | 装了插件在对话里用不了(点了没反应) |
| P0-3 | **定时任务只存不跑**(G-03/D-03) | 占位桩 | 建的定时任务永不执行(点了没反应) |
| P0-4 | **Anthropic 出口不接深度思考但 UI 显示**(D-02) | 反逻辑 | 选深度思考实际不思考(改出来不对) |
| P0-5 | **read_file 二进制乱读 + PDF 缺失**(D-04/G-07) | bug/缺口 | 读 PDF/合同得到乱码(给的不是那个东西) |

> 紧随其后的 P1:MCP OAuth(G-02,远程 MCP 静默失败)、Prompt caching(G-04,成本每轮全付)、工作目录不持久化(G-05)。

---

## 7. 补齐路线(一波波推,后端先)

**波次 0 — P0 止血(反逻辑/死链优先,后端)**
把"点了没反应/改出来不对"先清零:D-01 插件接主回合 → G-03 真调度引擎 → D-02 Anthropic thinking → D-04+G-07 二进制/PDF 读通道。多为后端小改+接线,先做。

**波次 1 — Computer Use 整包移植(G-01)**
独立大块:vendor/computer-use-mcp + runtime/*.py + setup API + 审批服务/面板 + Windows helper 评估。工作量最大、单独排。

**波次 2 — 远程连通 + 成本(后端)**
G-02 MCP OAuth(McpAuthTool + auth.ts + 回调 listener)、G-04 Prompt caching cache_control、D-05 .mcp.json 信任审批卡、G-05 工作目录持久化。

**波次 3 — 上下文对齐 cc(掰回分叉,后端)**
S-01 压缩阈值 70%→缓冲式、S-04 plan 落盘跨 resume、G-11 压缩回灌 plan、S-05 memdir git root 归一、G-12 findRelevantMemories、S-02/S-03 冷却与 TTL 掰回/标注。

**波次 4 — 工具补齐(agent 面向)**
G-03 ScheduleCronTool 四件套(接波次 0 的引擎)、G-08 ConfigTool、G-10 verification 子代理、G-09 RemoteTrigger 核实、S-07 补 7 个 hook 事件、G-14 small/fast 模型层、G-15/G-16 图像降采样+视觉门控。

**波次 5 — 生态 + 命令 + 桩清理**
G-06 斜杠命令逐波搬(/add-dir /hooks /config /export /resume /clear)、G-17 插件安全扫描+全局急停、D-06 MCP_PRESETS、D-07 canvas/edit 真模型改写、D-08 fork 激活决策、S-08 真 LSP、S-09 store-docs embedding、D-10 退 createLocalPlan、D-09 构建产物出树、D-11 注释更新、G-18 dataeye 埋点、S-06 默认目录引导、G-13 teamWatcher。

---

_审计口径:诚实——占位/死链/桩绝不算"做好了";每条已指到 cc 文件 + 我们文件 + 类型 + 优先级 + 可行动补法。_
