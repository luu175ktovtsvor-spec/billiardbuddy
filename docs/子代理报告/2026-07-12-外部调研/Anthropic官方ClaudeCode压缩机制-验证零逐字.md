# Anthropic 官方 Claude Code 压缩机制 · 验证"零逐字"改法

> 📌 状态:🚧调研 · 2026-07-12 调研员出品,来源全程标注

## 查了哪些来源、怎么复核

**官方一手**(逐字抓取原文,非转述):`code.claude.com/docs/en/how-claude-code-works`、`code.claude.com/docs/en/context-window`(含"What survives compaction"表格原文)、`code.claude.com/docs/en/commands`、`code.claude.com/docs/en/model-config`(Sonnet 5 上下文窗口章节)、`code.claude.com/docs/en/env-vars`、`code.claude.com/docs/en/troubleshooting`、`platform.claude.com/docs/en/build-with-claude/compaction`(Messages API 层的压缩原语,注意这是给第三方开发者用的通用组件,不完全等同于 Claude Code CLI 产品自己的压缩实现)。

**官方仓库 issue(一手信源,但非 Anthropic 官方定论)**:`github.com/anthropics/claude-code` 的 issue #18595(用户请求"/compact --keep-last=N 保留最近消息原文",被自动机器人判重复关闭,无 Anthropic 员工回复)、issue #42542(用户逆向出源码里三种压缩机制的具体文件名/行号,多个独立用户在评论区交叉验证同一批 GrowthBook 配置项,无 Anthropic 员工回复)——用 GitHub REST API 直接拉了 issue 正文和全部评论,不是网页摘要。

**权威二手(社区逆向)**:Mario Zechner 等人的技术对比 gist、justin3go.com、barazany.dev(被墙,通过网页搜索摘要+dev.to转载间接拿到关键段落)、codex.cadences.app、finisky.github.io、decodeclaude.com、okhlopkov.com、myweirdprompts.com。这些全部标注为"作者自称读了反混淆后的 CLI bundle源码",没有一篇是 Anthropic 官方发布或经 Anthropic 确认,但其中"文件重贴 5 个文件/5万token预算""9 段式摘要结构""tool 输出保留最近 5 条"等具体数字被 4~5 篇独立文章交叉印证,可信度较高;"Session Memory Compact 保留约 40K token 消息尾巴"这条只有 1 篇博客 + 1 个 GitHub issue 提及,且 issue 里多个用户实测该功能开关当前是关闭状态,标为弱证据。

复核方法:所有二手结论都尽量找第二个独立来源交叉验证,数字不一致时如实写出分歧、不强行调和;官方页面能拿到原文的都整页读完(不只看搜索摘要),GitHub issue 直接用 API 拉正文和评论(不是让工具转述)。

---

## 一句话结论(先说答案)

**官方 Claude Code 的"完整压缩"(手动 `/compact` 和自动触发是同一套机制)确实是全量摘要——把包括最近几轮在内的整段对话历史揉成一个结构化摘要块,不在摘要之外单独保留任何一条逐字的历史消息。** 这一点有 Anthropic 官方文档原话("It replaces the verbatim conversation")+ 一个被关闭的官方 GitHub 功能请求(证明"保留最近N条"目前不存在、用户在要)+ 4 篇以上独立技术分析共同印证,可信度高。

所以:**KEEP_RECENT_MESSAGES=0(压缩时不额外保留一批逐字最近消息)这个大方向,是对齐官方 Claude Code 的,不是走偏。**

但官方做法比"零逐字"这四个字更精细,有两处关键设计原样照抄"零逐字"的国产实现容易漏掉,建议补上(见文末"结论与推荐"):
1. 官方那个"一个摘要块"内部,专门留了一节叫"All User Messages"(所有用户消息),明确要求"逐字引用、一条都不能漏"——即摘要不是把用户原话也模糊化,而是摘要里专门有一段近乎逐字保留用户说过的话。这和"整段揉碎、一句原话都不留"不是一回事。
2. 官方"压缩后重贴近况"靠的是"重新读取最近 4~5 个被读写过的文件"(社区一致公认的数字),这是**为写代码场景设计的**——文件是这类 agent 的状态锚点。台球运营问答这种没有文件可读写的纯对话场景,天然没有这个锚点可用,照搬"文件重贴"会落空,需要用别的东西顶替(比如结构化的"近期用户诉求/门店当前诉求"摘要段落,类似官方的"All User Messages"设计)。

---

## 逐题作答

### 问题1:自动压缩保不保留最近若干条逐字消息?

**不保留独立的逐字消息**,这是官方"完整压缩"这一步的设计。

【官方一手】`context-window` 页面里,官方自己写的示例讲解原文(这是 Anthropic 官方文档页面里用来解释 `/compact` 效果的说明文字,不是我推断的):

> "All \[N\] conversation events condensed into one structured summary. The summary keeps: your requests and intent, key technical concepts, files examined or modified with important code snippets, errors and how they were fixed, pending tasks, and current work. **It replaces the verbatim conversation: full tool outputs and intermediate reasoning are gone.** Claude can still reference the work but won't have the exact code it read earlier."

同页正文("What survives compaction"表格上方)另一段官方原话:

> "When a long session compacts, Claude Code summarizes the conversation history to fit the context window... What happens to your instructions depends on how they were loaded" ——下面的表格里,"System prompt"、"CLAUDE.md"、"Auto memory"是靠"重新从磁盘注入"存活的,唯独**对话消息本身没有"重新注入"这一说,只有摘要**。

【官方仓库 issue,证据力强】issue #18595 标题就是`[FEATURE] /compact --keep-last=N to preserve recent messages verbatim`,正文原话:

> "Compacting long threads loses nuance from recent messages even with summary hints... Recent exchanges often have the most actionable context (latest error, current approach, exact code snippet) and summarization flattens it."

这是一个真实用户在 2026-01-16 提的功能请求,说明**截至提交时,官方产品里没有"保留最近N条"这个开关**——如果已经有,用户不会来要。它被 GitHub 自动机器人判定重复关闭(还有另外 3 个类似的重复请求 #7919、#6390、#14176 存在),说明**不止一个用户观察到同样的行为并提过同样的诉求**,不是个例误解。

【权威二手,4篇独立交叉印证】justin3go.com 的对比表格明确写:"User Messages: Summarized"(Claude Code 这一栏),并且专门拿 OpenAI Codex CLI 做对比——"Codex 物理删除所有 assistant 回复和 tool 相关消息,但完整保留所有用户消息原文",反过来印证 **Claude Code 和 Codex 在这一点上刻意选择了不同的路**:Codex 选择"保留用户消息、丢assistant/tool"，Claude Code 选择"整段一起摘要"。codex.cadences.app、decodeclaude.com、myweirdprompts.com 三篇独立文章各自复述了相同结论。

**但有一个重要例外(细节,不是推翻结论)**:codex.cadences.app 这篇给出的摘要模板显示,那"一个摘要块"内部有专门一节叫"All User Messages",原话:

> "MUST NOT OMIT ANY user messages. All user instructions, questions, and clarifications are preserved in full... **Everything is formatted as verbatim quotes.**"

也就是说:用户说过的原话,官方压缩逻辑确实想办法留了下来——**但留在"摘要文本的其中一节"里,不是留在"对话消息数组里的独立消息"里**。这个区分很关键,决定了要不要在国产实现的摘要 prompt 里补一节"逐字保留用户原话"。

### 问题2:手动 /compact 和自动触发是一回事吗?

【官方一手】`context-window` 页面原话:

> "Claude Code compacts automatically as you approach the limit, so a full context window doesn't end your session. **The automatic pass works the same way as the `/compact` step in the timeline.**"

结论:**是同一套压缩机制**,唯一区别是触发方式(手动敲命令 vs 到阈值自动触发)和手动能带一个可选的"聚焦指令"参数(如 `/compact focus on the auth bug fix`),自动触发没有这个人工指令、由模型自己判断保留什么。

### 问题3:压缩后靠什么恢复近况?

**摘要 + 重新从磁盘读取状态,不是靠保留逐字消息。** 具体两条腿走路:

**第一条腿(官方一手确认)**:压缩后,几类"设置类"内容会从磁盘重新加载回上下文——这是 `context-window` 页面"What survives compaction"表格的原话摘录:

| 机制 | 压缩后 |
|---|---|
| System prompt / output style | 不受影响(本来就不在消息历史里) |
| 项目根目录 CLAUDE.md、无路径限定的 rules | **重新从磁盘注入** |
| Auto memory(MEMORY.md) | **重新从磁盘注入** |
| 带 `paths:` 路径限定的 rules | 丢失,直到再次读到匹配文件才重新加载 |
| 子目录里的嵌套 CLAUDE.md | 丢失,直到再次读该子目录文件才重新加载 |
| 已调用过的 skill 正文 | 重新注入,单个 skill 上限 5000 token、总预算 25000 token,超了就丢最早调用的 |

**第二条腿(权威二手,4篇独立文章数字高度一致,但官方文档未给出这个具体数字)**:压缩后自动重新读取"最近读过/改过的文件"补回工作状态。四篇独立技术文章给出几乎一致的数字:decodeclaude.com"最多5个文件、总预算5万token";justin3go.com"最多5个文件、总预算5万token";myweirdprompts.com播客"最多五个文件、总预算五万token、单文件五千token上限";codex.cadences.app给出更细分的预算表——"5个最近读写的文件、每个最多5000token(共约25000)"+"技能预算25000token"=合计5万token。**这四个数字互相印证、内部还能对上账(5×5000+25000=50000),可信度较高,但没有一篇官方页面写出这个具体数字**,标注为【权威二手】。

也就是说:官方产品的"重贴文件"这条腿,和用户描述的国产 agent 做法("压缩后重贴 agent 读过的文件当前内容")**几乎是同一个思路**——这条不是走偏,是抄对了。

### 问题4:多少 token / 占用率触发 auto-compact?

这条官方有明确数字,但因模型/上下文窗口大小不同而不同,没有一个统一的"95%"官方铁律——"95%"是社区文章的近似说法,不是官方原话。

【官方一手,最精确的一条】`model-config` 页面"Sonnet 5 context window"章节原话:

> "On the Anthropic API, Sonnet 5 always runs with the 1M context window... **Sessions auto-compact before the window fills, at about 967K tokens by default**; set `CLAUDE_CODE_AUTO_COMPACT_WINDOW` to choose a different threshold. Two configurations budget the window at 200K instead and auto-compact at that boundary."

967K / 1M ≈ 96.7%,这是官方原文写死的具体数字(针对 Sonnet 5、1M 上下文这一种配置)。

【官方一手,环境变量原文】`env-vars` 页面:

> `CLAUDE_CODE_AUTO_COMPACT_WINDOW`:"Set the context capacity in tokens used for auto-compaction calculations. Defaults to the model's context window, 200K for standard models or 1M for extended context models, except on Sonnet 5..."
>
> `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`:"Set the percentage (1-100) of the auto-compaction window at which auto-compaction triggers... The override can only lower the threshold, so values above the default have no effect."

说明官方触发机制本质是"**上下文窗口大小 × 一个百分比阈值**",且这个阈值可以被用户往低调、不能往高调(保护性设计:防止用户把阈值调到贴着上限爆掉)。

【权威二手,3篇独立文章数字一致但和 967K 对不上,存在版本/口径差异,如实呈现分歧】justin3go.com、myweirdprompts.com、finisky.github.io 三篇文章都给出同一个公式:"有效上下文窗口 − 13,000 token 缓冲区",对 200K 窗口约合 167K(83.5%);codex.cadences.app 给出的是另一套常量:`MAX_INPUT_TOKENS=180,000`(90%,针对200K窗口)。这几个数字彼此不完全一致(83.5% vs 90% vs 96.7%),**大概率是因为不同文章基于不同版本/不同窗口大小(200K vs 1M)观察到的结果,缓冲区数值本身可能也随版本迭代变过**(`claudefa.st` 的一篇文章提到"缓冲区从 4.5万token/22.5%降到约3.3万token/16.5%,且这个改动没写进官方 changelog"——这条我只抓到搜索摘要、没有整页复核,标【未完全核实的二手】)。如果缓冲区固定在约 3.3 万 token,套到 1M 窗口正好是 1,000,000 − 33,000 = 967,000,和官方 Sonnet 5 页面的 967K 精确吻合——这是我能拼出的最自洽的解释,但"3.3万token"这个具体数字本身没有官方页面直接确认,标【推断,基于二手数字反推,与官方967K数字吻合但缓冲区数值未见官方原文】。

**结论**:没有一个"放之四海而皆准的95%",官方给出的唯一精确数字是 Sonnet 5 在 1M 窗口下的 **967K token(约96.7%)**,其他模型/窗口大小下,触发点在"上下文窗口的 80%~90% 区间"浮动,可以用 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`(改分母)和 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`(改百分比,只能往低调)两个官方环境变量调。

---

## 完整机制全景(比"一句话结论"更细,决定要不要照抄细节)

这部分是从 GitHub issue #42542(用户逆向出源码文件名/行号,多人在评论区交叉核对同一批服务端 GrowthBook 配置项)+ 5 篇独立技术博客拼出来的分层图景,**全部是社区逆向、无 Anthropic 官方确认**,但内部逻辑自洽、多方独立印证,列出来供参考:

1. **微压缩(microcompact,两种)**:每次 API 调用前都可能跑,只清理**工具输出**(文件读取内容、bash 输出、grep 结果等),不碰对话文字本身。清理方式是把内容替换成占位符 `[Old tool result content cleared]`,保留最近约 5 条工具结果、更老的清空。issue #42542 里多个用户从 `~/.claude.json` 的 `cachedGrowthBookFeatures` 字段里实测拉出配置(如 `tengu_slate_heron: {"keepRecent": 5}`),和 barazany.dev 独立给出的"保留5条"数字对上了。
2. **工具输出总预算控制**:issue #42542 里新发现的一层,和"完整摘要压缩"是两回事——所有工具结果加起来超过约20万字符(`tengu_hawthorn_window`)、或单个工具类型超过各自上限(如 Grep 2万、Bash 3万字符,`tengu_pewter_kestrel`),就会被裁剪,且**不受 `DISABLE_AUTO_COMPACT` 环境变量控制**,多名用户反映这层缺乏任何通知、用户毫无感知。这层只影响工具结果,不影响对话消息。
3. **Session Memory Compact(会话记忆压缩,存在争议、证据较弱)**:issue #42542 原话——"runs before autocompact, keeps only ~40k tokens of recent messages. Gated by `tengu_session_memory` GrowthBook flag"。这条如果是真的、且处于开启状态,就意味着官方确实有一层"保留最近若干消息"的机制,和用户最初的疑问("官方到底留不留最近逐字消息")直接相关。**但**同一个 issue 的评论区里,三个不同用户(不同机器、不同账号)在 2026年4月各自实测,拉出来的这个开关值都是 `tengu_session_memory: false`、`tengu_sm_compact: false`——即**这个机制虽然存在于代码里,但当时对这几位用户是关闭的**。所以这条只能算"代码里预留了这个能力,但抓取到的样本显示未必对所有用户生效",不能当成"官方现在稳定保留最近消息"的证据。
4. **完整压缩(Full Compact,对应 `/compact` 和最终触发的 auto-compact)**:上面 1~3 都不够用时才轮到这一步,把当时还剩下的整段对话一次性丢给一次独立的摘要调用,产出固定的 9 段结构摘要(Primary Request / Key Technical Concepts / Files & Code / Errors & Fixes / Problem Solving / **All User Messages** / Pending Tasks / Current Work / Optional Next Step),然后**这个摘要块替换掉此前所有对话**——这一步和"一句话结论"里说的"零逐字"完全对应,也是官方文档《context-window》页面原话描述的那个 `/compact` 效果。

对国产 agent 的启发:官方的"零逐字"只发生在最后一步(第4层),前面还有 2~3 层专门"先省着花、能拖就拖"的缓冲机制,让真正走到"整段摘要"这步的频率尽量低。如果国产实现是"一步到位、直接整段摘要",相当于**跳过了官方 1~3 层的缓冲垫**,会比官方更频繁地触发"整段揉碎",这本身不算错,但意味着"多久压缩一次""压缩频率高不高"要单独关注,不能只看"压缩时保不保留逐字"这一个维度。

---

## 结论与推荐

**核心结论**:官方 Claude Code 的 auto-compact(自动)和 /compact(手动)是**同一套机制**,最终产出**一个覆盖全部历史对话的结构化摘要**,官方文档原话确认"replaces the verbatim conversation"——**不额外保留一批独立的逐字最近消息**。这一点有 Anthropic 官方文档原文 + 一个被关闭的官方 GitHub 功能请求(证明现在没有、用户在要)+ 4 篇独立技术分析共同印证,来源等级为【官方一手 + 官方仓库 issue + 权威二手交叉印证】,可信度高。

**所以**:这个国产 agent 把 KEEP_RECENT_MESSAGES 改成 0(压缩时不再单独保留一批逐字消息)、近况靠"压缩后重贴文件当前内容"重建——**大方向是对齐官方 Claude Code,不是走偏**。官方在"完整压缩"这一步确实是全量摘要;"重贴文件"这条恢复近况的路子也和官方"重新读取最近文件"的做法一致。

**但建议补两个官方有、国产实现容易漏掉的细节,而不是走回"保留最近N条原始消息"的老路**:

1. **摘要 prompt 里补一节"逐字保留用户原话"**,对标官方"All User Messages"那一节("MUST NOT OMIT ANY user messages... formatted as verbatim quotes")。官方压缩虽然不留独立消息,但摘要文本内部专门有一段几乎原样引用用户说过的话——这是"全量摘要"和"信息真的没丢"能同时成立的关键设计,不是"越揉越糊"。如果当前摘要 prompt 只是笼统写"提炼要点",没有强制"用户原话逐字引用"这一条硬性要求,建议加上。
2. **给纯对话场景补一个"文件重贴"的替代锚点**。官方"压缩后重贴文件"是给写代码场景设计的,文件是天然的状态锚点;台球运营问答这种没有文件读写的场景,压缩后没有等价的"锚点"可重贴。建议在摘要结构里显式加一节类似"当前门店诉求/近期关键决策"(这个项目本身架构里已有"门店画像+店脑记忆"层,可以复用这层做"重贴"的替代物,而不需要另造)。这条不是"官方怎么做我们就必须照做",而是"官方能这样做是因为它有文件可读,我们没有,得单独补"。

**一句话总结给非技术背景的人听**:官方 Claude Code 压缩记忆的时候,确实是"整段揉成一份总结,不额外留一堆原话",这点国产 agent 学得对;但官方那份总结里,专门留了一格"原封不动抄用户说过的话"，压缩后还会自动把工作用的文件重新翻出来看一眼——这两个"补丁"是官方没让"揉碎"变成"揉丢"的关键,建议这两点也补齐,而不是走回"保留最近几轮原话"的老办法。

---

## 来源清单

**官方一手**
- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works) — "When context fills up"章节:先清工具输出、再摘要
- [Explore the context window](https://code.claude.com/docs/en/context-window) — "What survives compaction"表格原文 + `/compact`效果的官方讲解文案
- [Commands](https://code.claude.com/docs/en/commands) — `/compact [instructions]` 命令定义
- [Model configuration](https://code.claude.com/docs/en/model-config) — "Sonnet 5 context window"章节:967K token 触发数字
- [Environment variables](https://code.claude.com/docs/en/env-vars) — `CLAUDE_CODE_AUTO_COMPACT_WINDOW`、`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 官方定义
- [Troubleshooting](https://code.claude.com/docs/en/troubleshooting) — "Auto-compaction stops with a thrashing error"
- [Compaction(Messages API)](https://platform.claude.com/docs/en/build-with-claude/compaction) — 官方 API 层压缩原语(`compact-2026-01-12` beta),默认丢弃压缩块之前的全部内容、`pause_after_compaction` 可选保留最近消息

**官方仓库 issue(用 GitHub API 直接拉正文+评论)**
- [anthropics/claude-code#18595](https://github.com/anthropics/claude-code/issues/18595) — 功能请求"/compact --keep-last=N 保留最近消息原文",判重复关闭,证明该功能当前不存在
- [anthropics/claude-code#42542](https://github.com/anthropics/claude-code/issues/42542) — 用户逆向出三层压缩机制的源码文件名/行号,多人交叉验证 GrowthBook 配置

**权威二手(社区逆向,已尽量交叉验证,单独标注置信度)**
- [Context Compaction Research(badlogic gist)](https://gist.github.com/badlogic/cd2ef65b0697c4dbe2d13fbecb0a0a5f) — Claude Code / Codex CLI / OpenCode / Amp 对比
- [Shedding Heavy Memories(justin3go.com)](https://justin3go.com/en/posts/2026/04/09-context-compaction-in-codex-claude-code-and-opencode) — 明确写"Claude Code: User Messages = Summarized",与 Codex 对比
- [Claude Code's Compaction Engine(barazany.dev / dev.to 转载)](https://dev.to/johnib/claude-codes-compaction-engine-what-the-source-code-actually-reveals-2o4) — 自称读源码,tier1/2/3 划分
- [Context Compression in Claude Code(codex.cadences.app)](https://codex.cadences.app/en/blog/claude-code-context-compression/) — 9段摘要结构原文、"All User Messages"逐字引用原话
- [Context Compaction in Claude Code(finisky.github.io)](https://finisky.github.io/en/claude-code-context-compaction/) — 五层级划分,"Session Memory Compact 保留约40K token"说法的来源之一(弱证据,见正文)
- [Inside Claude Code's Compaction System(decodeclaude.com)](https://decodeclaude.com/compaction-deep-dive/)
- [Claude Code /compact: What It Does, What Survives(okhlopkov.com)](https://okhlopkov.com/claude-code-compaction-explained/)
- [How Claude Code's Conversation Compaction Actually Works(myweirdprompts.com,AI生成播客,标注可信度较低)](https://www.myweirdprompts.com/episode/claude-code-conversation-compaction/)
- Claude Code Context Buffer(claudefa.st,仅抓到搜索摘要未整页复核,压缩缓冲区从4.5万降到3.3万token的说法未完全核实)

**未找到 / 未能核实**
- Anthropic 官方是否有一篇专门讲"compact 内部 9 段摘要模板"的一手文档——没找到,这个模板只在社区逆向文章里出现,彼此高度一致但无官方原文佐证
- "Session Memory Compact"这一层在当前版本、当前用户群体中的真实启用比例——GitHub issue 里的样本量只有 3~4 台机器,不能代表全量
