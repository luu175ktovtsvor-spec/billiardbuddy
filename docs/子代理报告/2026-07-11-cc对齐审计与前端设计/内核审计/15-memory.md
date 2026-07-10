# 持久记忆系统(AutoMem/memdir)对齐审计

规格源:`~/Desktop/cc-haha-ref`(当前源码)。现状:`/Users/swl/Desktop/球房运营AI助手-桌面版/ts`(工作树)。
范围:main-agent AutoMem(memdir)+ 四层 CLAUDE.md 家族折叠 AutoMem 索引 + 子代理记忆(agent memory)+ 后台兜底提取。
只读审计,未改任何源文件、未跑 `bun test`。

---

## 0. 结论先行

owner 2026-07-10(commit fce9910)声称"记忆三缺口"已治,其中第③条"extractMemories stop-hook 后台兜底"**核实为假**——代码里没有任何后台/兜底提取机制,`applyStopHooks` 只是用户可配置的 Stop hooks 派发器,与 cc 的 `extractMemories.ts`(独立 forked agent 安全网)完全是两回事。真正落地的只有①召回注入 ②读侧 allowedPaths 放行 ④提示词四类分类法——这三条确实做得很扎实、行为对齐度高。

本轮新发现一个之前未被提及、且已经是**当前默认行为**(不需要用户配置任何东西就会触发)的越权 bug:`save_memory` 是我们独有的一等公民工具(cc 没有,cc 靠模型自己两步写 Write/Edit),但它没有被纳入任何 subagent 的写权限收紧机制——内置的 `Explore`/`Plan` 子代理在自己的 prompt 里白纸黑字写着"READ-ONLY MODE / STRICTLY PROHIBITED from file modifications",但它们的 `disallowedTools` 名单是照 cc 的 write_file/edit_file 家族抄的,漏了 `save_memory` 这个新工具,导致这两个"只读"子代理实际仍可写盘。同时,**所有子代理**(不限于 Explore/Plan)都会通过 `baseSystemPrompt` 继承主 agent 的完整 AutoMem 指令 + 拿到 `save_memory` 工具 + 共享主项目的记忆目录读写权限——这一点 cc 明确不这样做(子代理只会拿到"自己的 agent-memory 提示",从不知道主 memdir 的存在)。

---

## 1. cc memdir/AutoMem 全景(逐条)

| # | 行为点 | cc 位置 |
|---|---|---|
| 1.1 | 目录结构:`~/.claude/projects/<slug>/memory/`,索引 `MEMORY.md` + 各主题 `.md` 文件(带 frontmatter) | `src/memdir/paths.ts:getAutoMemPath`(~180-198)、`memdir.ts:34` `ENTRYPOINT_NAME='MEMORY.md'` |
| 1.2 | frontmatter 格式:`name` / `description` / `type` 三字段 | `memdir.ts:MEMORY_FRONTMATTER_EXAMPLE`(memoryTypes.ts:261-271) |
| 1.3 | 类型:AutoMem 记忆本身分 4 类(user/feedback/project/reference,`memoryTypes.ts:14-19`);CLAUDE.md 家族另有 User/Project/Local/Managed/AutoMem/TeamMem 六种"层类型"(两套类型体系不是一回事) | `memoryTypes.ts:14-19`(记忆类型)、`utils/claudemd.ts`(层类型) |
| 1.4 | 注入时机:①**常驻**——MEMORY.md 索引经 `getUserContext()→getClaudeMds(getMemoryFiles())` 折进每次对话开头的上下文块(非 system 参数本身,是独立、按会话缓存的 userContext 对象,只在 `/compact`、`/clear` 时才刷新);②**行为指令**——四类分类法/怎么存/何时访问等,经 `systemPromptSection('memory', loadMemoryPrompt)` 作为独立可缓存 system 段落,每次都调用但走 GrowthBook-cache;③**相关性检索**——每个用户回合,拿当前问题去 `findRelevantMemories` 选 top-5 主题文件正文,当作 `relevant_memories` attachment 注入 | `context.ts:152-186`(getUserContext)、`constants/prompts.ts:495`(systemPromptSection)、`utils/attachments.ts:2191-2233`(getRelevantMemoryAttachments) |
| 1.5 | 写入工具:**没有专门工具**——模型用通用 `Write`/`Edit` 工具,分两步(先写主题文件、再手动加一行 MEMORY.md 索引指针),提示词里教这两步 | `memdir.ts:buildMemoryLines`(219-234,`howToSave` 两步版) |
| 1.6 | 更新/去重:纯提示词约束("先查有没有同名可更新的,别写重复条目"),无代码层去重 | `memoryTypes.ts` 各 type 的 `<when_to_save>` |
| 1.7 | 删除:同样纯提示词("用户说忘掉就找到对应条目删除"),无专门 forget 机制 | `memdir.ts:243` |
| 1.8 | 容量/裁剪:①扫描上限 200 个文件(`memoryScan.ts:MAX_MEMORY_FILES=20`→实为200,见20行);②MEMORY.md 索引超 200 行/25000 字节截断+警告(`memdir.ts:35-38,57-103`);③单条召回内容截断 200 行/4096 字节(`attachments.ts:269,277`);④单会话召回累计字节上限 60KB(`attachments.ts:288`);⑤单回合最多召回 5 条(`attachments.ts:2230`) | 见各行 |
| 1.9 | **后台安全网**:`extractMemories.ts` 在每个查询循环"模型给出无工具调用的最终答复"时触发一个 forked 子代理(`runForkedAgent`),用受限 `canUseTool`(只放行 Read/Grep/Glob/只读 Bash/Write-Edit 限定 AutoMem 目录)去扫描新增消息、补写遗漏的记忆;若主 agent 本轮已经手写过记忆(`hasMemoryWritesSince`),后台代理跳过、避免重复。整体被 `feature('EXTRACT_MEMORIES')`/`tengu_passport_quail` growthbook 开关闸(默认值 `false`,是否默认开取决于线上 GrowthBook 灰度,不是硬编码常开) | `services/extractMemories/extractMemories.ts` 全文件,尤其 121-148、171-222、329-523、536 |
| 1.10 | 子代理记忆(独立体系):`user`/`project`/`local` 三种 scope,各自目录(`~/.claude/agent-memory/<type>/`、`<cwd>/.claude/agent-memory/<type>/`、`<cwd>/.claude/agent-memory-local/<type>/`),走跟主 AutoMem **完全相同的** `buildMemoryPrompt()`(四类分类法+what-not-to-save+when-to-access+trusting-recall 全套,只是 displayName 换成 "Persistent Agent Memory"、外加一行 scope 说明),**不是**主 AutoMem 的精简版 | `tools/AgentTool/agentMemory.ts:52-65,138-177` |
| 1.11 | 子代理**永远不会**被告知主 AutoMem 目录的存在——`loadAgentsDir.ts` 里只在 `agent.memory` 配了 scope 时才注入 `loadAgentMemoryPrompt`,主循环的 `loadMemoryPrompt()`(main AutoMem)从不进入子代理的 system prompt | `tools/AgentTool/loadAgentsDir.ts:485,729` |
| 1.12 | 子代理记忆快照(项目级预置初始知识,首次/有更新时同步到 scope 目录) | `tools/AgentTool/agentMemorySnapshot.ts` 全文件 |
| 1.13 | 每条召回记忆的"新鲜度"提示:不只是存一个日期戳,而是计算出"N 天前"文本(模型不擅长日期算术,ISO 时间戳不会触发"这条可能过时了"的警觉),超过 1 天才附加、当天/昨天不打扰 | `memdir/memoryAge.ts` 全文件(尤其 `memoryFreshnessText`) |
| 1.14 | 压缩后记忆恢复:MEMORY.md 索引不在 transcript 里,天然不受 compact 影响;`relevant_memories` attachment 的去重靠扫描 messages 里的标记,compact 后旧消息消失、标记随之消失,同一条记忆可以被重新召回("自愈") | `utils/attachments.ts:collectSurfacedMemories` 注释 |
| 1.15 | @-提及某子代理时,召回改为只搜**该子代理自己的** memory 目录(隔离),而非主 AutoMem | `utils/attachments.ts:getRelevantMemoryAttachments`(2191-2211) |

---

## 2. 我们现状逐条对照

| # | 行为点 | 我们位置 | 结论 |
|---|---|---|---|
| 2.1 | AutoMem 目录结构、frontmatter 三字段、四类分类法 | `ts/src/tools/saveMemoryTool.ts:118-130`、`ts/src/memory/memoryPrompt.ts:33-63` | 对齐(白标路径 `~/.billiardbuddy/projects/<slug>/memory/`) |
| 2.2 | 常驻索引注入 | `ts/src/harness/claudemd.ts:746-760`(AutoMem 折进 getMemoryFiles)+`811-830`(getClaudeMds 标签 `user's auto-memory, persists across conversations`,原文照抄 cc 标签措辞) | 对齐,细节见 §4 |
| 2.3 | 行为指令(何时存/何时访问/据记忆给建议前先核实/记忆 vs 计划任务) | `ts/src/memory/memoryPrompt.ts:84-101`(何时访问+据记忆给建议前+记忆与其他持久化手段,均照 cc 语义译中文) | 对齐 |
| 2.4 | 相关性检索(scan→选 top5→注入) | `ts/src/memory/relevantMemories.ts` 全文件 + `ts/src/harness/loop.ts:470-490` | 对齐,常量(200行/4096字节/60KB会话上限/5条/200文件扫描上限)逐一核对与 cc 数值相同 |
| 2.5 | 写入工具 | `ts/src/tools/saveMemoryTool.ts` | **有意偏离(B)**:一步式工具而非 cc 的两步 Write/Edit;见 §4 对该偏离引出的连锁问题 |
| 2.6 | 更新/去重 | `saveMemoryTool.ts:memoryFileName`(同名→同文件名→物理覆盖) | **优于 cc**:同名自动去重覆盖,cc 纯靠模型自觉,ours 代码层兜底一层 |
| 2.7 | 删除(forget) | `saveMemoryTool.ts:105-116` | 对齐(cc 无此机制,靠模型直接删文件;ours 用同一工具的 forget 参数,效果等价) |
| 2.8 | 容量/裁剪 | `relevantMemories.ts:23-31`(常量)+`claudemd.ts:765-782`(索引截断) | 对齐 |
| 2.9 | **后台安全网(extractMemories)** | 全仓搜索无命中 | **缺口(gap)**,见下方发现表 F1 |
| 2.10 | 子代理记忆体系(独立 scope) | `ts/src/agents/agentMemory.ts` 全文件 | 部分对齐,但 prompt 内容比 cc 薄很多,见 F3 |
| 2.11 | 子代理是否知道主 AutoMem | `ts/src/agents/agentTool.ts:138-150`(`baseSystemPrompt` 整段继承)+`server/index.ts:1735,1760` | **偏离(deviation)**,见 F2/F2a |
| 2.12 | 每条召回记忆的新鲜度提示 | `relevantMemories.ts:233-244`(`buildRelevantMemoriesReminder` 只有静态 `saved="YYYY-MM-DD"` 日期戳) | **缺口**,见 F5 |
| 2.13 | 压缩后记忆恢复(自愈) | `relevantMemories.ts:246-249` 注释明确照抄该设计 | 对齐 |
| 2.14 | @-提及子代理时召回隔离到该子代理自己的记忆目录 | 全仓搜索无命中(loop.ts 只搜主 AutoMem) | 缺口,但影响小,见 F6 |

---

## 3. 发现表

| 行为点 | cc(file:line) | 我们(file:line 或"缺") | 分类 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| F1 后台兜底提取(extractMemories):main 循环末尾若模型没手动存记忆,forked 子代理兜底补写,防"这轮该记的漏了" | `~/Desktop/cc-haha-ref/src/services/extractMemories/extractMemories.ts`(全文件,尤其 329-523 runExtraction、171-222 受限 canUseTool、536 主循环触发点) | 缺(全仓 grep 无 extractMemor/后台抽取/forkedAgent 相关命中);仅有 `ts/src/memory/memoryPrompt.ts:103-104` 的"回合结束前自评"提示词——这是**同一个模型自己的提醒**,不是独立安全网,模型不理会时无人兜底 | gap | P1 | M |
| F2 子代理越权知晓/写入主 AutoMem:cc 子代理只会拿到自己 scope 的 agent-memory 提示,永不知道主 memdir 存在(`loadAgentsDir.ts` 只在 `agent.memory` 配置时注入 `loadAgentMemoryPrompt`,主 `loadMemoryPrompt()` 不进子代理 system prompt) | `~/Desktop/cc-haha-ref/src/tools/AgentTool/loadAgentsDir.ts:485,729` | `ts/src/agents/agentTool.ts:138-150`(`buildAgentSystemPrompt` 把 `baseSystemPrompt` 整段前置,该字符串在 `ts/src/harness/systemPrompt.ts:35,45` 已经含主 agent 的 `buildMemorySystemPrompt` 输出);`ts/src/server/index.ts:1735,1760`(`baseSystemPrompt: systemPrompt` 无差别喂给前台/后台所有子代理调用) | deviation | P1 | M |
| F2a `save_memory` 工具未随 `baseSystemPrompt` 一起被子代理隔离,且**未纳入内置只读子代理的禁用清单**:`Explore`/`Plan` 自己 prompt 写"READ-ONLY MODE / STRICTLY PROHIBITED from file modifications",但 `disallowedTools` 名单只抄了 write_file/edit_file/multi_edit_file/patch_file/patch_files/edit_excel/restore_file/NotebookEdit,漏了 `save_memory`(写盘工具,`isReadOnly:false`) | cc 无对应工具(cc 的"存记忆"就是 Write/Edit,已经在 disallowedTools 里) | `ts/src/agents/bundled/explore.md:3`、`ts/src/agents/bundled/plan.md:3`(disallowedTools 缺 save_memory);`ts/src/tools/saveMemoryTool.ts:74`(`isReadOnly: false`);`ts/src/tools/generalTools.ts:82`(saveMemoryTool 无条件进通用注册表);`ts/src/agents/agentLoader.ts:159-160`(仅当 agent 有显式 `tools:` allow-list 时才会因 memory 扫描加/减工具,Explore/Plan 用的是 denylist 路径,不吃这条逻辑) | deviation(bug 性质) | P1 | S |
| F2b worktree 隔离子代理(`isolation:'worktree'`)拿到全新 `Workspace(worktreePath)`,但继承的 `baseSystemPrompt` 里写死的 AutoMem 路径是按**主项目** root 算的字符串;真调用 `save_memory` 时按**子代理自己的** `ctx.workspace.root`(worktree 路径)重新算目录——两者不一致,写进去的记忆会落进一个基于临时 worktree 路径 slug 的孤儿目录,主项目读回时读不到 | 不适用(cc 无 save_memory 一等工具,子代理拿到的是明确 scope 目录字符串,读写用同一变量,不会有"提示词路径"和"实际执行路径"分裂) | `ts/src/agents/agentTool.ts:406-409`(worktree 时 `workspaceBase = new Workspace(agentWorktree.session.worktreePath)`)+`ts/src/tools/saveMemoryTool.ts:79`(`getAutoMemDir(ctx.workspace.root)` 按调用时 workspace 现算) | deviation | P2 | S |
| F3 子代理记忆提示词内容单薄:cc 的 `loadAgentMemoryPrompt` 复用主 AutoMem 同一套 `buildMemoryPrompt`(四类分类法+不该存什么+两步写+何时访问+据记忆给建议前先核实,全套),只是换 displayName;我们的 `buildAgentMemoryPrompt` 只有几行"存耐久事实/别存密钥/保持精简",没有四类分类法、没有 what-not-to-save 细则、没有 when-to-access/trusting-recall | `~/Desktop/cc-haha-ref/src/tools/AgentTool/agentMemory.ts:138-177`(调用 `memdir.ts:buildMemoryPrompt`) | `ts/src/agents/agentMemory.ts:75-98`(`buildAgentMemoryPrompt`) | gap | P2 | S |
| F4 命令层:cc 有 `/remember`、`/dream`(nightly 蒸馏 daily-log→MEMORY.md+主题文件,仅 KAIROS 助理模式用)等交互命令 | `~/Desktop/cc-haha-ref/src/commands/memory/*` | 缺(无斜杠记忆命令) | gap(KAIROS 场景外) | P2 | 不适用/暂不做(依赖 assistant 常驻会话形态,本产品暂无该场景) |
| F5 每条召回记忆的新鲜度提示只有静态日期戳,没有"N 天前"计算文本(cc 专门指出模型不擅长日期算术,ISO 戳不触发"这条可能过时"的警觉) | `~/Desktop/cc-haha-ref/src/memdir/memoryAge.ts`(全文件,`memoryAgeDays`/`memoryFreshnessText`/`memoryFreshnessNote`) | `ts/src/memory/relevantMemories.ts:233-244`(`buildRelevantMemoriesReminder` 只有 `saved="${saved}"` ISO 日期,无天数文案);全仓无 memoryAge 等价物 | gap | P2 | S |
| F6 @-提及子代理时召回应隔离到该子代理自己的记忆目录,而非主 AutoMem | `~/Desktop/cc-haha-ref/src/utils/attachments.ts:2191-2211`(`extractAgentMentions`分流) | `ts/src/harness/loop.ts:470-490` 只搜主 `getAutoMemDir`,无按 @提及分流的逻辑 | gap | P2 | S |
| F7 系统提示装配架构差异:cc 把"行为指令"(systemPromptSection,per-section 独立缓存)与"实际内容"(userContext.claudeMd,含 MEMORY.md 正文,按整个会话记忆化、只在 /compact //clear 才刷新)分成两条不同生命周期的通道;我们把 `buildMemorySystemPrompt`(指令)与 `loadMemoryInjection`(内容,含 AutoMem 索引正文)拼进同一个字符串,且在**每个 HTTP 回合**从头重新算(`server/index.ts:1567` 每次 `createTurnStream` 都调 `buildSystemPrompt`,无跨轮缓存) | `~/Desktop/cc-haha-ref/src/constants/prompts.ts:495` vs `src/context.ts:152-186`(getUserContext memoize,清缓存点见 `commands/compact/compact.ts:63,117,203`、`commands/clear/caches.ts:52-53`) | `ts/src/harness/systemPrompt.ts:36-49`(一个 join 数组);`ts/src/server/index.ts:1567`(每回合重建) | intentional-delta(系统级、非记忆专属) | P2(仅影响 prompt-cache 命中率,不影响正确性;反而"每轮读盘最新"比 cc 的记忆化更不容易读到旧记忆) | 不建议改——改这个是系统级 prompt-cache 项目,不该挂在记忆模块下单独做 |
| F8 存/查一致性、去重覆盖、forget 删除、200 文件扫描上限、200行/25000字节索引截断、200行/4096字节单条截断、60KB会话上限、5条/回合上限、压缩自愈 | 见 §1 各项 | 见 §2 各项 | aligned | — | — |

---

## 4. 记忆落点清单("记忆打散 5 处"核实 + 收敛建议)

逐一枚举 `ts/src` 里所有记忆相关代码落点(不含 `ts/src/memory/transcript.ts`——按任务口径归存储模块,本次不审):

| 文件 | 职责 | 对应 cc 模块 | 是否该收敛 |
|---|---|---|---|
| `ts/src/memory/memoryPrompt.ts` | 主 agent AutoMem 行为指令(四类分类法/怎么存/何时访问) | `src/memdir/memdir.ts`(`buildMemoryLines`)+`src/memdir/memoryTypes.ts` | 保留独立(cc 本身也是独立文件) |
| `ts/src/memory/relevantMemories.ts` | 相关性检索(scan/select/inject/去重/会话上限) | `src/memdir/findRelevantMemories.ts`+`memoryScan.ts`+`utils/attachments.ts` 相关片段 | 保留独立(cc 本身也拆了 3 个文件) |
| `ts/src/tools/saveMemoryTool.ts` | 写入工具(一步式,cc 无对应工具) | 无直接对应(cc 用通用 Write/Edit) | 保留(产品化的一等公民工具是合理简化),但**必须**在 `Explore`/`Plan` 等只读子代理的 disallowedTools 里补上,且要有一处统一的"哪些工具算写盘"清单,别让新增写工具每次都要挨个子代理手动补名单(建议:给 Tool 定义加 `isReadOnly` 标记后,子代理"只读模式"直接按 `isReadOnly===false` 全量拉黑,不再维护手写的 disallowedTools 清单;`saveMemoryTool.ts:74` 已经标了 `isReadOnly:false`,只是 `agentLoader.ts` 的 denylist 校验逻辑没有利用这个字段) |
| `ts/src/agents/agentMemory.ts` | 子代理独立 scope 记忆(user/project/local + 快照同步) | `src/tools/AgentTool/agentMemory.ts`+`agentMemorySnapshot.ts` | 保留独立(cc 本身也是独立子系统),但内容要按 F3 补齐四类分类法等,并且要在 `harness/systemPrompt.ts`/`agentTool.ts` 层面明确"子代理只吃 agentMemory.ts 这一份提示,不该再继承主 buildMemorySystemPrompt" |
| `ts/src/harness/claudemd.ts` | 四层 CLAUDE.md 家族(Managed/User/Project/Local)+ 折叠 AutoMem 索引 + 截断 + 渲染标签 | `src/utils/claudemd.ts` | 保留(cc 本身就是在这个文件里把 AutoMem 折进 getMemoryFiles,这是对的,不是打散) |
| `ts/src/harness/memoryNames.ts` | 白标路径命名权威(CLAUDE.md 家族 + AutoMem 共用) | `src/utils/config.ts` + `src/memdir/paths.ts` 的路径部分(cc 是两个文件,我们合成一个) | 可以保留合并,是我们自己更紧凑的组织方式,不算劣化 |
| `ts/src/harness/systemPrompt.ts` | 系统提示装配总入口(把 memoryPrompt + memoryInjection 拼进去) | `src/constants/prompts.ts:getSystemPrompt` | 保留(接线点,本身不是"记忆逻辑") |
| `ts/src/harness/loop.ts` | 主循环里触发相关性召回、拼 allowedPaths 相关变量 | `src/utils/attachments.ts` 主循环调用点 | 保留(接线点) |
| `ts/src/server/index.ts` | ①`workspaceFromBody` 里把 AutoMem 目录塞进 allowedPaths ②把 `systemPrompt`(含记忆指令)整体透传给所有子代理/后台代理的 `baseSystemPrompt` | cc 对应逻辑分散在 `context.ts`(userContext)+ `tools/AgentTool/runAgent.ts`(子代理**不**继承主 loadMemoryPrompt) | **这一处是真正该改的地方**(不是"挪文件",是"改行为"):②处不该无脑把主 `systemPrompt` 整段喂给子代理,应该把"记忆指令"从 `buildSystemPrompt` 的返回值里摘出来单独传,子代理 System Prompt 组装时只拼"通用身份+工作流+子代理专属 prompt+(可选)agentMemory 提示",不拼主 AutoMem 段 |

**收敛建议**:owner 说的"记忆打散 5 处"从组织角度看**大部分是正常的**——cc 自己的 memdir 也是拆在 5-6 个文件里(memdir.ts/paths.ts/memoryTypes.ts/findRelevantMemories.ts/memoryScan.ts/extractMemories.ts),我们现在的落点基本是逐一对应过去的,不建议为了"看起来集中"而把它们塞进一个大文件——那样反而会破坏 cc 对齐的可追溯性(以后 cc 改了某个模块,想知道对应哪块会更难找)。

真正值得动的不是"搬文件",而是**修复 F1/F2/F2a 这三个功能性问题**:
1. **F2a(S,立即做)**:把 `save_memory` 加进 `explore.md`/`plan.md` 的 `disallowedTools`,顺手把 `agentLoader.ts` 的只读子代理工具过滤逻辑改成"按 `tool.isReadOnly` 自动拉黑",一次性堵死"以后新增写工具又忘记补名单"的同类问题。
2. **F2(M)**:把 `harness/systemPrompt.ts` 的返回值拆成 `{ base: string; memorySection: string }` 两块(或者子代理系统提示组装时显式排除 memorySection),让 `agentTool.ts:buildAgentSystemPrompt`/`taskTools.ts:agentSystemPrompt` 不再把主 AutoMem 指令整段带给子代理;子代理该用的记忆一律走各自的 `agentMemory.ts`(仅当 `agent.memory` 配置时)。
3. **F1(M,可以晚做但该排进计划)**:补一个"回合结束、模型没调用 save_memory 时"的兜底——不需要照抄 cc 整个 forked-agent 机制,最低成本版本可以是:检测本轮 assistant 最终文本里若包含"用户纠正/用户明确说记住"等信号但没有 `save_memory` 工具调用,追加一次轻量侧路小模型调用(复用 `relevantMemories.ts` 里已有的 side-query 基础设施)去判断"这轮是否漏记",有则以 `save_memory` 的方式落盘。工作量中等,建议单独立项而不是顺手改。

F3/F5/F6 优先级较低(P2),可以合并进同一次"记忆模块补丁"里顺手做,工作量都是 S。
