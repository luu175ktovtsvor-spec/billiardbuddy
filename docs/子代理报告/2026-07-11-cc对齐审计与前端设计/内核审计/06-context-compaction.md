# 上下文压缩/恢复 — cc-haha 对齐差异审计(代码级,只读)

规格源:`~/Desktop/cc-haha-ref`(当前源码)。现状:`/Users/swl/Desktop/球房运营AI助手-桌面版/ts`(工作树现状)。
核心读过的文件:
- cc:`src/services/compact/{autoCompact,compact,prompt,microCompact,postCompactCleanup,sessionMemoryCompact,grouping}.ts`、`src/commands/compact/compact.ts`、`src/utils/{tokens,context}.ts`、`src/query.ts`、`src/screens/REPL.tsx`(query() 调用点)。
- 我们:`ts/src/context/{compaction,recentFileContext,toolResultStorage}.ts`、`ts/src/harness/loop.ts`(maybeCompact)、`ts/src/skills/invokedSkills.ts`、`ts/src/hooks/hooks.ts`(PreCompact/PostCompact)、`ts/src/commands/commandLoader.ts`、`ts/commands/compact.md`、`ts/src/server/index.ts`。

## 发现表

| 行为点 | cc(file:line) | 我们(file:line) | 分类 | 优先级 | 修复量 |
|---|---|---|---|---|---|
| token 自动压缩阈值公式(有效窗口=窗口−min(maxOutput,20k);阈值=有效窗口−13k) | `services/compact/autoCompact.ts:33-49`(getEffectiveContextWindowSize)、`:62`(BUFFER=13_000)、`:72-91`(getAutoCompactThreshold) | `context/compaction.ts:201-229`(getEffectiveContextWindowTokens/getAutoCompactTokenThreshold,常量同值) | aligned | — | — |
| 1M 窗口→967K 阈值边界 | `utils/context.ts:76-79`(has1mContext→1_000_000)+ 上式代入 | 同公式代入 contextWindowTokens=1_000_000,`compaction.ts:201-229`;已由提交 e303ac6 从早期"per-model 700K 自造"revert 回纯公式 | aligned | — | — |
| CLAUDE_CODE_AUTO_COMPACT_WINDOW / CLAUDE_AUTOCOMPACT_PCT_OVERRIDE 覆盖语义(pct 只会更早不会更晚) | `autoCompact.ts:40-46,79-88` | `compaction.ts:204-207,220-227` | aligned | — | — |
| 摘要请求自身超限(PTL)重试次数上限=3 | `compact.ts:227` MAX_PTL_RETRIES=3 | `compaction.ts:23` MAX_COMPACT_SUMMARY_RETRIES=3 | aligned(计数) | — | — |
| PTL 重试的**收缩策略**(丢多少) | `compact.ts:243-291` truncateHeadForPTLRetry:按 API round 分组,解析错误里的精确 tokenGap 累加丢刚好够的组;解析不出退化丢 20% 分组 | `compaction.ts:178-191` shrinkOldMessagesForRetry:**无脑腰斩** old 段的一半(不看实际超限多少),仅避免孤儿 tool_result | deviation(注释里承认简化) | P2 | M |
| 摘要空文本 → 判失败不判成功 | `compact.ts:525-538` throw('...did not contain valid text content') | `compaction.ts:303-306` throw('摘要模型未返回可用文本…') | aligned | — | — |
| 摘要调用禁工具 | `services/compact/prompt.ts:19-26`(NO_TOOLS_PREAMBLE,纯 prompt 提醒) | `compaction.ts:288` 直接 `tools: []` 结构性禁止 | intentional-delta(更硬,非缺口) | — | — |
| 压缩计数/冷却跨"请求"持久化 | `query.ts:271-282` state.autoCompactTracking 每次 `queryLoop()` 调用**重新初始化为 undefined**;`screens/REPL.tsx:2794` 证实 query() 是每次用户提交(每 turn)重新调用一次 | `harness/loop.ts:394-398` compactionFailures/lastCompactionAtMs/lastCompactedMessageCount/lastInputTokens 均为 runAgentLoop 局部 `let`,每次调用(=每个用户回合)重置 | aligned(cc 本身也不跨 turn 持久化,已知待办#4 的假设有误,见下) | — | — |
| 九段结构化摘要 prompt — 整体骨架 | `services/compact/prompt.ts:66-77` 9 项:1 Primary Request/2 Key Tech Concepts/3 Files&Code/4 Errors&fixes/5 Problem Solving/6 All user messages/7 Pending Tasks/8 Current Work/9 Optional Next Step | `compaction.ts:24-41` COMPACTION_SYSTEM_PROMPT 9 项(中文):1 用户目标与硬约束/2 技术概念/3 文件与代码状态/4 错误失败修复/5 已完成事项/6 用户原话要点/7 待办清单/8 当前工作现场/9 下一步建议 | deviation | P1 | S |
| 第 6 段:"List **ALL** user messages that are not tool results"(逐条全量,防意图漂移) | `prompt.ts:73`("List ALL user messages…critical for understanding…changing intent") | `compaction.ts:35` "保留会影响后续决策的用户指令或偏好,不要泛化丢失语气强度" — **降级为"要点"而非"全部"**,未强制逐条列出 | deviation | P1 | S |
| 第 5 段:Problem Solving(已解决问题+仍在排障) | `prompt.ts:72` | 我们第 5 段是"已完成事项"(语义偏向验收通过的功能点,不等价于"排障过程") | deviation | P2 | S |
| 手动 /compact 是否真的执行压缩(裁剪历史、发 boundary、可反复继续) | `commands/compact/compact.ts:40-` call() → `compactConversation(...)` 真裁剪 messages,写 SystemCompactBoundaryMessage,跑 postCompactCleanup/hooks,返回真实 compactionResult | `ts/commands/compact.md`(纯 prompt 模板)——`server/index.ts:1599-1607` 命中 `matchedCommand.getPrompt()` 只是把这段 markdown 当**普通用户消息文本**发给模型,要求模型口头写一份摘要;**从未调用 `compactPipeline`**,原始 messages 一条不少地留在上下文里,不产生任何 token 节省,也没有 boundary/hooks/文件恢复。desktop 命令面板(`desktop/renderer/app.js:632`)文案却写"压缩上下文,给长对话瘦身"——对用户是假承诺 | **gap** | **P0** | M(loop.ts 里 `maybeCompact(true)` 全部基础设施已现成,只需把 /compact 派发改成调它+落 transcript,而不是走 prompt 模板) |
| 压缩后恢复:最近文件 | `compact.ts:1447-1496` createPostCompactFileAttachments(按 readFileState 时间戳倒序、maxFiles、token 预算、去重已在 preserved tail 出现的路径,重新 FileReadTool 读取拿新鲜内容) | `context/recentFileContext.ts` buildRecentFileContextMessage(按 ctx.fileReads 倒序、maxFiles=5、总字节预算 40k/单文件 12k,直接读磁盘+ mtime/size 判 changed_since_read) | aligned(目标一致,量纲用字节非 token,机制简化但可用) | — | — |
| 压缩后恢复:子目录项目指令(CLAUDE.md 类) | `compact.ts:31-34` postCompactCleanup 清 `getUserContext.cache`+`resetGetMemoryFilesCache`,下一轮触发 SessionStart 式全量重扫全部项目指令(含子目录) | `recentFileContext.ts:26-33` 调 `loadProjectInstructionsForTargets`,但**只**为"最近读过的文件所在目录"逐一收集指令,不等价于 cc 的"全项目子目录指令一次性重扫" | aligned(窄化但达成目标;范围比 cc 更保守,不算缺口) | — | — |
| 压缩后恢复:已调用技能(invoked skills) | `compact.ts:1526-1566` createSkillAttachmentIfNeeded(按 invokedAt 倒序、单技能截断、总 token 预算) | `skills/invokedSkills.ts` createInvokedSkillsMessage(char 预算 MAX_SKILL_CONTENT_CHARS=16k/MAX_SKILLS_TOTAL_CHARS=48k)+`restoreInvokedSkillsFromMessages` 在会话重建时从历史里解析回填 | aligned | — | — |
| PreCompact / PostCompact hooks | `compact.ts:445`(executePreCompactHooks 在真压缩前)、`:755`(executePostCompactHooks 压缩后带摘要) | `hooks/hooks.ts:420-447` applyPreCompactHooks/applyPostCompactHooks,`harness/loop.ts:441-467` 只在 `compactionWillRun` 为真时触发 Pre、压缩成功后触发 Post(带摘要文本) | aligned | — | — |
| 大工具结果落盘(避免硬截断) | `utils/toolResultStorage.ts`(PERSISTED_OUTPUT_TAG,阈值/预览可配置,按工具名分类) | `context/toolResultStorage.ts`(`<stored_tool_result>`,阈值 24_000 字符/预览 2_000 字符,`DEFAULT_STORABLE_TOOLS` 覆盖 run_command/grep/glob/list_dir 等),`harness/loop.ts` 里 `applyAggregateToolResultBudget()` 接线 | aligned(不同实现细节,目标一致) | — | — |
| microcompact(只读工具结果折叠)覆盖范围 | `services/compact/microCompact.ts:39-48` COMPACTABLE_TOOLS 含 FileRead/**Bash**/Grep/Glob/WebSearch/WebFetch/**FileEdit**/**FileWrite**(不限只读) | `compaction.ts:117-140` microcompactReadOnlyToolResults **仅**扫 `readOnlyToolNames`(isReadOnly=true 的工具),run_command/文件编辑类结果不会被这条折叠,只能靠上面"大工具结果落盘"兜底(阈值不同、机制不同) | deviation | P2 | S-M |
| 分段压缩(partial compact,from/up_to 两个方向,用于 fork/cache 复用场景) | `services/compact/prompt.ts:145-267`(PARTIAL_COMPACT_PROMPT / PARTIAL_COMPACT_UP_TO_PROMPT) | 无对应概念,只有"整段 old 摘要 + recent 原样保留"一种切法 | gap(范围外倾向) | P2 | L(牵连 fork/cache 复用架构,非孤立改动) |
| session memory 压缩(EXPERIMENT,抽取结构化记忆替代纯摘要) | `services/compact/sessionMemoryCompact.ts:1-3` 明确标"EXPERIMENT",受 GrowthBook 实验开关控制 | 未实现 | gap(但 cc 自己也是实验态,非稳定行为) | P2(低) | L |
| 压缩后其它恢复项(plan 文件/plan_mode 提醒/异步子代理状态/deferred tools delta/agent listing delta/MCP 指令 delta) | `compact.ts:1502-1631` 五个 createXAttachmentIfNeeded | 未实现(任务范围明确只要求最近文件/项目指令/技能三项,其余未覆盖) | gap(范围外,题面未要求) | P2 | M |
| 字符估算 vs 真实 token 的触发关系 | `utils/tokens.ts:244-279` tokenCountWithEstimation:**单一 token 口径**——取最后一条带真实 usage 的响应值,再 + 之后新消息的**token 估算**(`roughTokenCountEstimationForMessages`,非字符);从未存在独立的"字符阈值"分支 | `compaction.ts:231-250` shouldAutocompact:`lastInputTokens`(仅最近一次的单值,非"真实值+增量估算")判过阈值就 true;**没过**阈值时**继续往下**执行**完全独立、字符单位**的 `estimateMessagesChars(全部消息) >= thresholdFor(contextWindowChars)`(0.7 比例/48k reserve) | deviation | P1(结构性) | M |
| 上条的直接后果:token 未超但字符可能提前触发 | 不存在此路径(单口径) | `contextWindowChars` 在生产链路里从未被真实客户端填过(`server/index.ts:1966` 只认 `rawBody.contextWindowChars`,desktop `app.js`/无任何调用点会发送这个字段,只有 smoke 脚本会传)→ **当前生产环境该分支是死代码,不会真的提前触发**;但只要将来任何调用方(比如新 smoke/新前端选项)把这个字段接上,`lastInputTokens` 说"还早"时 char 分支仍可能独立判"到了",逻辑上没有互斥保护 | gap(latent,生产休眠) | P1 | S(在 lastInputTokens+hasWindow 都具备时,直接跳过 char 分支,不再"继续往下判") |

## 已知待办核对结果

1. **P7:AUTOCOMPACT_RATIO=0.7 字符兜底与 token 公式是否冲突** —— **确认存在潜在冲突,但生产环境目前休眠**。`shouldAutocompact()`(`compaction.ts:231-250`)是"token 判 → 若为 true 立即 return;若为 false **不 return**,继续往下判 char"的写法,不是真正的互斥/取大。只要 `lastInputTokens` 存在但**没到**它自己的 token 阈值,只要同时又传了 `contextWindowChars`,char 分支仍会独立生效、可能提前触发。目前生产链路里没有任何真实调用方(desktop 客户端 `app.js`)会传 `contextWindowChars`(只有 `scripts/smoke/*.smoke.ts` 会传),所以线上暂时不会触发,但这是一处未加固的接口地雷,不是"设计上不会冲突"。建议修复:token 路径的前提(`lastInputTokens>0 && hasWindow`)满足时,直接跳过 char 分支(而不是继续往下判),把"谁先超"改成真正的"token 存在就只信 token"。

2. **token 触发"字符估算 vs 真实 usage 取大"(据称 1abb851)** —— **原始描述不准确,当前代码也不是"取大"**。commit `1abb851` 引入的确实是"token 路径优先于字符"(注释写"与字符估算取谁先超"),不是数值上的 max();而 cc 本身根本没有"字符估算"这个独立分支——cc 的 `tokenCountWithEstimation()` 全程都是 token 口径(真实 usage + token 估算增量),我们额外维护了一条平行的字符口径分支,这是结构性偏离(见上表"deviation(结构性)"行),不是简单的"谁大用谁"。

3. **收缩重试(据称 7806175)** —— **重试次数(3)对齐,收缩策略不对齐**。`MAX_COMPACT_SUMMARY_RETRIES=3` 精确匹配 cc `MAX_PTL_RETRIES=3`。但 cc 按"API round 分组 + 解析错误里的精确 token 差值,只丢刚好够的组"(`compact.ts:243-291`),我们是"不管超多少,old 段无脑砍一半"(`compaction.ts:178-191`)。后果:小幅超限时我们会比 cc 丢掉多得多的历史;大幅超限时我们可能 3 次腰斩都不够(0.5³=12.5% 剩余量,某些极端场景仍收敛不到能过审的大小),而 cc 一次就能算准该丢多少。这一差异代码注释里已如实写明是简化(未采纳分组概念),属已知的 intentional-delta,但实际效果有差距,建议列入 P2 观察。

4. **压缩计数跨 HTTP 请求持久化** —— **重新核实后:cc 自己也不跨"请求"(用户回合)持久化,已知待办的前提假设有误**。读 `query.ts:271-282` 可见 `state.autoCompactTracking` 在每次 `queryLoop()`(=`query()`)调用时都重新初始化为 `undefined`;`screens/REPL.tsx:2794` 证实 `query()` 是每次用户提交新消息时重新调用一次(不是整个会话生命周期只调一次)。也就是说 cc 的"连续失败熔断器(3 次)"和我们一样只在**单个用户回合内部**的多次工具循环迭代间生效,回合与回合之间同样会重置。我们 `loop.ts:394-398` 的 `compactionFailures`/`lastCompactionAtMs`/`lastCompactedMessageCount` 同样是每次 `runAgentLoop` 调用(=每个用户回合)重新声明的局部变量,行为与 cc 一致。**结论:这条不是缺口,是已对齐**;此前"需要跨请求持久化"的待办可以关闭。（我们还额外加了 cc 没有的 30s 冷却期`AUTOCOMPACT_COOLDOWN_MS`,是我们自己加的保险,intentional-delta,不算问题。）

5. **九段结构化摘要 prompt —— 逐段对比** —— 骨架对齐(都是 9 段),但两段内容有实质偏离:① 第 6 段 cc 要求"List **ALL** user messages that are not tool results"(逐条全量列出,原文强调这对防止"意图漂移"至关重要),我们写成"用户原话**要点**"(只保留影响决策的要点,不要求逐条全列)——这是信息保真度的真实下降,不只是措辞;② 第 5 段 cc 是"Problem Solving"(已解决问题 + 仍在排障的过程),我们替换成"已完成事项"(偏向验收通过的功能清单),语义窄化。其余 7 段(用户目标/技术概念/文件代码/错误修复/待办清单/当前工作现场/下一步建议)语义基本对应。建议:至少把第 6 段改回强调"全部",这是对续接质量影响最大的一处。

6. **compact 后恢复(最近文件/项目指令/skill)—— 逐项对比** —— 三项都有对应实现且目标达成:最近文件(`recentFileContext.ts`,字节预算 40k/单文件 12k、mtime/size 变化标记)、子目录项目指令(同一函数内 `loadProjectInstructionsForTargets`,范围限定在"最近读过文件所在目录"而非 cc 的"全项目重扫",更保守但不算缺口)、已调用技能(`invokedSkills.ts`,token/char 预算截断 + 历史消息回填恢复)。均判定 aligned。**但发现题面未列出的更大缺口**:手动 `/compact` 命令本身在我们系统里完全没有走上述这套"真压缩 + 恢复"流程——它是一份纯 prompt 模板(`ts/commands/compact.md`),只会让模型口头写一份摘要文字回复用户,**不裁剪 messages、不省 token、不发 boundary、不触发上面这些恢复机制**,而 auto-compact(`maybeCompact`)才是真的走完整链路。desktop 命令面板文案对用户承诺"压缩上下文,给长对话瘦身",但用户手动敲 `/compact` 时实际什么都没发生,这是本次审计发现的最大缺口(P0)。

## 分类计数

- aligned:12
- gap:6(其中 1 个 P0,1 个 P1 latent,4 个 P2/范围外)
- deviation:6(2 个 P1,3 个 P2,1 个已重新定性为结构性 P1)
- intentional-delta:3(均不计入问题)

## P0/P1 缺口 Top5(每条一句话)

1. **P0** 手动 `/compact` 是假的:`ts/commands/compact.md` 只是让模型口头写摘要,从不调用 `compactPipeline`,messages 一条没删、token 没省、UI 却宣传"给长对话瘦身"——需要把 `/compact` 派发改接 `loop.ts` 里现成的 `maybeCompact(true)` 全链路(压缩+hooks+恢复),而不是走 prompt 模板。
2. **P1** 触发逻辑结构性偏离 cc:cc 全程单一 token 口径(真实 usage+token 估算增量),我们额外维护一条独立的字符口径分支(`AUTOCOMPACT_RATIO=0.7`),`lastInputTokens` 判"未到"时代码仍会继续往下判字符,两条线没有互斥——生产目前因为没人传 `contextWindowChars` 而休眠,但这是未加固的地雷,建议 token 前提满足时直接跳过字符分支。
3. **P1** 九段摘要 prompt 第 6 段"全部用户消息逐条列出"被我们弱化成"用户原话要点",丢掉了 cc 特别强调的"防止后续意图漂移"的保真度,建议改回"全部列出"。
4. **P2**(降级观察)PTL 收缩重试策略:cc 按精确 token 差值/API round 精准丢刚好够的量,我们无脑腰斩 old 段一半,小超限多丢、大超限可能 3 次都收敛不了,代码注释已如实承认是简化。
5. **P2** microcompact 覆盖面比 cc 窄:cc 连 Bash/FileEdit/FileWrite 结果都参与折叠,我们的 inline 折叠只认"只读工具",非只读大结果只能靠另一套"落盘"机制兜底,两套机制阈值口径不同,存在缝隙。

（已知待办 #4"压缩计数跨请求持久化"经核实是**已对齐**,不是缺口——cc 自身同样按用户回合重置,不跨回合持久化;原待办的前提假设有误。）
