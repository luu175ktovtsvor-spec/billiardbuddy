# cc-haha 对齐审计 · Skills/Commands 系统

规格源:`~/Desktop/cc-haha-ref`(当前源码,src/skills/**、src/commands/**、commands.ts、SkillTool)
现状:`/Users/swl/Desktop/球房运营AI助手-桌面版/ts`(工作树现状,src/skills/**、src/commands/**)
方法:两边源码亲读,不采信既有文档。只读审计,未改任何源文件、未跑 bun test。

---

## 发现表

| # | 行为点 | cc(file:line) | 我们(file:line 或"缺") | 分类 | 优先级 | 规模 |
|---|---|---|---|---|---|---|
| 1 | `!`反引号/```! 内嵌 shell 执行(正文里嵌 bash 命令、结果回填正文) | `utils/promptShellExecution.ts:1-183`(BLOCK_PATTERN/INLINE_PATTERN);接线在 `skills/loadSkillsDir.ts:374-396`(createSkillCommand.getPromptForCommand 里对非 mcp 技能调 `executeShellCommandsInPrompt`) | 缺——全仓无 `promptShellExecution` 等价文件,`grep executeShellCommandsInPrompt\|BLOCK_PATTERN\|INLINE_PATTERN` 零命中 | gap | P1 | M |
| 2 | `${CLAUDE_SKILL_DIR}` / `${CLAUDE_SESSION_ID}` 模板变量替换 | `skills/loadSkillsDir.ts:356-369`(getPromptForCommand 里对 baseDir/sessionId 做全局替换) | 缺——`ts/src/skills/skillLoader.ts:170-173` 的 getPrompt 只在正文前拼一行"基础目录: {baseDir}" 文本提示,不做正文内 `${...}` 占位符替换;`grep '\${'` 全仓零命中任何白标等价变量 | gap | P1 | S |
| 3 | `$ARGUMENTS`/`$ARGUMENTS[n]`/`$n`/具名参数 `$foo` 替换 | `utils/argumentSubstitution.ts:94-145` | `ts/src/commands/argumentSubstitution.ts:80-116` —— 算法与常量(具名先行→索引→简写→全量→无命中追加)逐行对齐,已有 9 条单测覆盖(`argumentSubstitution.test.ts`) | aligned(边界见下) | — | — |
| 3a | 参数切词:cc 用 `shell-quote` 库,遇到 shell 操作符(`&&`/`\|`等)会被解析成独立 token 并被过滤掉(`.filter(token => typeof token==='string')`),即操作符不会进最终参数数组 | `utils/argumentSubstitution.ts:24-40` | `ts/src/commands/argumentSubstitution.ts:20-57` 手写字符级分词,不识别 shell 操作符语义,`&&`/`\|` 会被当普通字符收进 token —— 罕见输入下与 cc 结果不同(如 `/skill "foo && bar"` 两边都会把 `&&` 当引号内文本,一致;但裸 `foo && bar` 不加引号时,cc 丢弃 `&&`,我们保留 `&&` 作为参数) | deviation | P2 | S |
| 4 | @file 附件引用系统(`@path/to/file`、`@path:L1-L20` 行范围、`@dir/` 目录列举、权限拒读判定) | `utils/attachments.ts:1890-1960`(`processAtMentionedFiles`/`parseAtMentionedFileLines`),经 `getAttachments()` 接入通用消息管线(`utils/attachments.ts:773-816`) | 缺——全仓 `grep -rn "atMention\|AtMention\|extractAtMentioned\|@-mention\|at_mention"` 零命中(后端 `ts/src`、前端 `ts/desktop/renderer` 均无);模型要读文件只能自己调 Read/Grep 工具,用户在输入框打 `@file` 没有任何特殊处理 | gap | P1 | L |
| 5 | frontmatter `paths` 条件化激活(按触碰的文件路径动态挂载技能) + 配套的运行时目录发现(`discoverSkillDirsForPaths`/`addSkillDirectories`,沿文件路径向上找嵌套 `.claude/skills`) | `skills/loadSkillsDir.ts:159-178`(`parseSkillPaths`)、`:771-797`(挂起 conditionalSkills)、`:997-1058`(`activateConditionalSkillsForPaths`)、`:861-975`(动态目录发现) | 缺——`grep "paths"` 相关 frontmatter 解析、`discoverSkillDir\|dynamicSkill\|addSkillDirector"` 全仓零命中;`ts/src/commands/types.ts` 的 `PromptCommand` 类型里没有 `paths` 字段 | gap | P2 | M |
| 6 | frontmatter `hooks` 注册(技能调用时把 hooks 并入会话) | `utils/hooks/registerSkillHooks.ts:20-64`;调用点 `utils/processUserInput/processSlashCommand.tsx:892` | 落了——`ts/src/skills/skillLoader.ts:66-70`(`registerSkillHooks`),调用点 `server/index.ts:1690` / `skillLoader.ts:395`;`normalizeHookRegistry` 在加载时就解析 `doc.frontmatter.hooks`(`skillLoader.ts:148`) | aligned | — | — |
| 6a | hooks `once: true` 语义(执行一次后失效) | `registerSkillHooks.ts:36-43` 用 `onHookSuccess` 回调把该 hook 从 AppState 会话 hooks 物理移除 | `ts/src/hooks/hookConfig.ts:125-134`(`onceHandler`)用闭包 flag 让 handler 首次成功后永久 no-op,但**不从 registry 移除**——若有代码枚举 `ctx.sessionHooks` 展示"当前已注册 hooks"会看到失效的残留项 | deviation(观感;调用方角度行为一致) | P2 | S |
| 6b | 技能 hooks 跨轮/跨压缩存活(会话内注册后持续生效) | cc `AppState.sessionHooks` 是进程内长驻状态,不随压缩重置 | `ts` 的 `sessionSkillHooks`(`server/index.ts:1108`)是按 `conversationId` 键的进程级 Map,同一服务器进程内跨轮存活,机制对等 | aligned | — | — |
| 6c | 技能*内容*(非 hooks)压缩后恢复,防止模型忘记已执行技能的说明 | `bootstrap/state.ts:1526-1585`(`invokedSkills` 进程内 Map)+ `services/compact/compact.ts:1526-1566`(`createSkillAttachmentIfNeeded` 直接读 Map 生成 attachment 消息写回 transcript) | `ts/src/skills/invokedSkills.ts` 同样是进程内 Map(`addInvokedSkill`/`getInvokedSkillsForScope`),但用 `restoreInvokedSkillsFromMessages`(`invokedSkills.ts:70-82`)在**每轮**从历史消息里正则重新解析 `<invoked_skill>` 标签重建 Map(`harness/loop.ts:258`),而不是像 cc 那样让 Map 天然跨轮存活——因为 ts 的 runLoop 是每轮重新加载 transcript 的执行模型;`createInvokedSkillsMessage`(`invokedSkills.ts:54-68`)与 cc 的 `createSkillAttachmentIfNeeded` 语义等价(按 token/字符预算截断,最近优先) | aligned(机制不同、可观察行为等价) | — | — |
| 7 | `disable-model-invocation` frontmatter(技能只能用户手敲 `/name`,模型不可主动调) | `skills/loadSkillsDir.ts:255-257`(解析)+ `tools/SkillTool/SkillTool.ts:411-418`(validateInput 里拒绝) | 缺——`grep "disable-model-invocation\|disableModelInvocation"` 全仓零命中;`PromptCommand` 类型无此字段,`use_skill` 对任何技能都放行模型调用 | gap | P1 | S |
| 8 | `user-invocable` frontmatter(技能只给模型用,不出现在用户 `/` 选择器) | `skills/loadSkillsDir.ts:216-219` | 缺——同上未解析;不过 ts 目前也没有"用户 `/` 选择器"读取此类元数据的 UI 消费点,影响面小于 cc | gap | P2 | S |
| 9 | `model` frontmatter 覆盖当轮模型(如 `model: opus`) | 解析:`skills/loadSkillsDir.ts:221-226`;生效:`tools/SkillTool/SkillTool.ts:810-821`(`contextModifier` 里 `resolveSkillModelOverride` 真正切换 `mainLoopModel`) | **半落**——`ts/src/skills/skillLoader.ts` 解析了 `model` 字段挂到 `PromptCommand.model` 上(`skillLoader.ts:145,162`),但 `grep "skill.model\|command.model"` 在 `server/index.ts`/`loop.ts` 全仓零命中——没有任何代码读这个字段去切模型,是个死字段,技能作者写 `model: opus` 会被静默忽略 | gap(看似支持、实际不生效,比"缺"更隐蔽) | P1 | M |
| 10 | `effort` frontmatter(技能覆盖当轮推理力度) | 解析:`skills/loadSkillsDir.ts:228-235`;生效:`tools/SkillTool/SkillTool.ts:823-836` | 缺——全仓无 `effort` 相关 frontmatter 解析,`PromptCommand` 类型无此字段 | gap | P2 | S |
| 11 | `context: 'fork'` 执行语义:同步阻塞跑一个隔离子代理,拿到完整结果文本后作为 `tool_result` 直接回灌当轮 | `tools/SkillTool/SkillTool.ts:122-289`(`executeForkedSkill`)——`for await` 收完 `runAgent` 全部消息,`extractResultText` 抽取最终文本,`return { data: { status:'forked', result: resultText } }` | **行为分岔**——`ts/src/server/index.ts:1685-1715`(`executeSkill`)对 `context==='fork'` 走 `startBackgroundAgentRun`,**立即返回** `<background_task_started id=... status=...>` 标记,不等子代理跑完;模型要拿结果得另外查后台任务状态,不是同一轮拿到完整结果 | deviation | P1 | M |
| 12 | 命名空间:`plugin:skill`(插件贡献技能按插件名前缀去重)+ 目录前缀(legacy `/commands/` 下嵌套目录 `foo/bar.md` → 命令名 `foo:bar`) | `skills/loadSkillsDir.ts:523-559`(`buildNamespace`/`getSkillCommandName`/`getRegularCommandName`) | 缺——`ts/src/plugins/pluginLoader.ts:108-127`(`resolveEnabledPluginContributions`)把各插件的 `skills/`、`commands/` 目录直接丢给通用 `loadSkillsDir`/`loadCommandsDir` 加载,**不做插件名前缀**,两个插件同名技能会互相覆盖(先加载者/后加载者顺序决定,无警告);`ts/src/commands/commandLoader.ts:70-107`(`loadCommandFile`)+`:109-125`(`walkMarkdown` 递归子目录)也**不做目录前缀**,`stripMd` 只取 basename,嵌套目录里同名文件会静默 `byName` 覆盖丢失 | gap | P1 | M |
| 13 | 三层加载:policySettings(managed 强制)/ userSettings / projectSettings(cwd 向上走到 home 的每级 `.claude/skills`) | `skills/loadSkillsDir.ts:638-804`(`getSkillDirCommands`) | 对应白标三层:bundled(=managed,app 内置)/ user(`~/.billiardbuddy/skills`)/ workspace(`<root>/.billiardbuddy/skills`)——`ts/src/skills/skillLoader.ts:220-271`(`loadLayeredSkills`);**workspace 层只读单一目录**,不像 cc 的 projectSettings 那样沿 cwd 向上遍历到 home 收集每级目录;policySettings(组织强制策略)在单用户桌面产品里无对应,属产品边界 | intentional-delta(policy 层)+ deviation(project 层单目录) | P2 | S |
| 14 | 传统 `/commands/` 目录:目录格式(`SKILL.md`)与单文件格式(`.md`)混合支持,`SKILL.md` 视同该目录技能 | `skills/loadSkillsDir.ts:484-521`(`isSkillFile`/`transformSkillFiles`) | `ts/src/commands/commandLoader.ts:109-125`(`walkMarkdown`)显式排除 `entry.name==='SKILL.md'`——嵌套 commands 子目录里若混入 `SKILL.md`,cc 会把它当该目录的技能加载,我们直接跳过、什么都不加载 | gap | P2 | S |
| 15 | legacy `/commands/` 目录里的 `.md` 文件是否解析 `hooks` frontmatter | cc `parseSkillFrontmatterFields`(`skills/loadSkillsDir.ts:185-265`)是 skills 与 legacy commands **共用**的同一份解析函数,两边字段能力完全一致(含 hooks/paths/effort/disableModelInvocation 等) | `ts/src/commands/commandLoader.ts:70-107`(`loadCommandFile`)是 `skillLoader.ts:loadSkillFile` 的**手工复制体**,唯独不解析 `hooks` 字段(对比两份代码,skillLoader 多一行 `normalizeHookRegistry`,commandLoader 没有)——commands 目录来源的命令无法带 hooks,与 skills 目录能力不对等,cc 里两者对等 | gap | P2 | S |
| 16 | MCP 服务器暴露的 prompts 作为"技能"并入统一发现/调用体系(`SkillTool` 能直接 `Skill(mcp__server__promptname)` 调用、纳入 skill listing) | `skills/mcpSkills.ts`+`skills/mcpSkillBuilders.ts`,`commands.ts:549-561`(`getMcpSkillCommands`)、`tools/SkillTool/SkillTool.ts:81-94`(`getAllCommands` 合并 mcp skills) | 缺统一入口——`ts/src/mcp/client.ts:613-660` 把 MCP prompts 包成**独立的两个通用工具** `list_mcp_prompts`/`read_mcp_prompt`,不进入 `list_skills`/`use_skill`/技能发现清单(`skillListing.ts` 的 `collectDiscoveryEntries` 只收 `CommandLibrary`+`SkillLibrary`,不含 mcp connections);功能可用但走的是平行路径而非统一技能体系 | gap | P2 | M |
| 17 | SkillTool 调用形态:单一工具 `Skill({skill,args})`,`validateInput`→`checkPermissions`→`call` 三段式,`call()` 返回 `newMessages`(插入 conversation 的新消息)+`contextModifier`(改 allowedTools/model/effort) | `tools/SkillTool/SkillTool.ts:331-869` | 拆成三个独立通用工具 `list_skills`/`read_skill`/`use_skill`(`ts/src/skills/skillLoader.ts:304-399`),`use_skill.execute()` 走通用 `Tool.execute(): Promise<string>` 契约,把展开的技能正文**当作 tool_result 字符串**直接返回,而非像 cc 那样插入独立的 user/attachment message;`allowedTools`/`hooks` 通过直接写 `ctx.sessionAllowedTools`/`ctx.sessionHooks` 而非 contextModifier 函数式修改——效果等价但实现路径整体重写 | intentional-delta(架构级,已有审批闸补强,见下) | — | — |
| 18 | SkillTool 的 checkPermissions:deny 规则匹配 → allow 规则匹配 → 安全属性自动放行 → 默认 ask | `tools/SkillTool/SkillTool.ts:432-578`(`skillHasOnlySafeProperties`/`SAFE_SKILL_PROPERTIES` 白名单) | `ts/src/skills/skillLoader.ts:80-127`(`SAFE_SKILL_PROPERTIES`/`skillHasOnlySafeProperties`/`skillRequiresApproval`/`useSkillAllowRuleMatches`)——白名单字段集合、"未知字段默认需审批"的从严策略、"已记忆 allow 规则二次免审批"逻辑均对齐;deny 规则由 ts 通用权限引擎(非 skill 专属代码路径)统一处理,未在本次范围内逐行核对(跨模块) | aligned(skill 专属部分) | — | — |
| 19 | bundled skills 注册机制:程序化 `registerBundledSkill()`,内容编译进二进制,`files` 字段声明的附加参考文件在**首次调用时**运行时安全提取到磁盘(O_EXCL/mode 0o600 防符号链接攻击) | `skills/bundledSkills.ts:1-221` | `ts/src/skills/skillLoader.ts:220-227`(`bundledSkillsRoot`)——10 个 bundled 技能(commit/commit-push-pr/debug/init/pr-comments/review/security-review/simplify/skillify/verify)都是磁盘上的 `SKILL.md` 目录,走与 user/workspace 技能相同的 `loadSkillsDir` 加载路径,天然支持同目录下的参考文件(不需要运行时提取,因为本来就在磁盘上);无程序化注册 API、无编译进二进制、无运行时提取步骤——机制整体不同但对当前 10 个技能功能等价;**打包分发时这些 md 如何塞进 DMG/EXE 是已知独立待办**(项目自己代码注释 `skillLoader.ts:217-218` 已承认) | intentional-delta(与已知打包待办同一件事,不重复计) | — | — |
| 20 | 命令 API:命令列表端点 | cc 是 CLI/TUI,无 HTTP 命令列表端点(REPL 内 `/help` 等本地渲染) | `ts/src/server/index.ts:3452-3474`(`GET /api/v1/agent/commands`)——产品自身架构需要(前端要拉命令面板),本身不对标 cc,范围外 | N/A(产品边界) | — | — |
| 21 | 命令 hooks(command 级 hook,非技能级) | cc 命令(builtin `local`/`local-jsx` 类型)本身没有独立"命令 hooks"概念,hooks 只挂在技能/skill 上 | 同——ts 也只在技能/PromptCommand 层面挂 hooks,没有独立的"命令级 hook" | aligned(概念本就只有一层) | — | — |
| 22 | `getPrompt`/`getPromptForCommand` 动态注入:调用时展开为完整正文,支持参数替换+shell执行+模板变量 | `skills/loadSkillsDir.ts:344-399` | `ts/src/skills/skillLoader.ts:170-173`——展开逻辑本身工作(参数替换),但比 cc 少了 shell 执行(#1)和模板变量替换(#2),见上 | 部分对齐(见 #1/#2) | — | — |

---

## 已知待办核对结果

**1. P4:`!`内嵌 bash 执行 + `${VAR}` 替换——仍缺**
- `!`/```! 内嵌 shell 执行:确认**仍缺**。全仓搜索 `executeShellCommandsInPrompt`/`BLOCK_PATTERN`/`INLINE_PATTERN`/`promptShellExecution` 零命中(见表 #1)。当前 10 个 bundled SKILL.md 均未用到该语法,尚未造成实际断裂,但任何未来技能作者(内置或用户自建)写 `!\`date\`` 之类语法会被原样当文本发给模型,不会执行、不会报错——静默降级。
- `${CLAUDE_SKILL_DIR}`/`${CLAUDE_SESSION_ID}` 替换:确认**仍缺**(见表 #2)。`getPrompt` 只拼一行"基础目录: {baseDir}"提示文案,不做正文内 `${...}` 占位符替换,也没有任何白标等价的模板变量机制。

**2. `$ARGUMENTS`/`$1..N`(据称 6189cb4 已做)——核实:已做,基本对齐**
`ts/src/commands/argumentSubstitution.ts` 与 cc `utils/argumentSubstitution.ts` 逐段比对:具名参数替换顺序、`$ARGUMENTS[n]`、`$n` 简写、`$ARGUMENTS` 全量替换、无命中时追加参数原文——五步顺序和正则模式几乎逐行一致,`ts/src/commands/argumentSubstitution.test.ts` 有 9 条单测覆盖含"具名参数不误伤更长同前缀变量名"等边界。唯一差异:cc 用 `shell-quote` 库分词、遇到裸露(未加引号)的 shell 操作符(`&&`/`|`等)会整体丢弃;ts 手写字符级分词器不识别操作符语义、会把它们当普通字符收进参数——S 级边界差异(表 #3a),不影响正常使用场景。

**3. @file 附件系统——确认缺**
全仓(`ts/src` 后端 + `ts/desktop/renderer` 前端)搜索 `atMention`/`AtMention`/`extractAtMentioned`/`@-mention`/`at_mention` 零命中。cc 的 `@path/to/file`、`@path:L10-L20` 行范围引用、`@dir/` 目录列举完全没有对应实现(表 #4)。这是本次审计里体量最大的单项缺口(cc 侧约 100+ 行专属逻辑,横跨 attachments.ts 主管线),虽然任务范围标注为 Skills/Commands 但实际是通用消息输入层能力,建议后续独立立项而非归进技能窗口顺手做。

**4. `${CLAUDE_SKILL_DIR}` 模板变量——我们无白标等价物**
确认没有任何形式的等价机制(既没有白标变量名如 `${BILLIARDBUDDY_SKILL_DIR}`,也没有原名保留)。`baseDir` 只用于拼接提示文案前缀,技能正文里若写 `${CLAUDE_SKILL_DIR}/scripts/foo.sh` 这种相对路径引用,会原样字面量透传给模型,模型只能靠"基础目录: xxx"这行提示自己拼路径,不如 cc 的显式变量替换直给。

**5. skill frontmatter hooks 注册/恢复/once(矩阵§4声称已落)——核实:真落了,基本对齐**
- 注册:落了。`skillLoader.ts` 加载时解析 `doc.frontmatter.hooks` → `normalizeHookRegistry`;调用技能时 `registerSkillHooks()` 把 hooks 并入 `ctx.sessionHooks`(`server/index.ts:1690`、`skillLoader.ts:395`),与 cc `registerSkillHooks.ts` 的调用时机(技能被实际执行时)一致。
- 跨轮存活:落了。`sessionSkillHooks`(`server/index.ts:1108`,按 conversationId 键的进程级 Map)在同一服务器进程内跨轮持续生效,与 cc `AppState.sessionHooks` 的进程内长驻语义等价。
- once:落了但机制不同(表 #6a)。cc 执行一次后把该 hook 从会话 hooks 列表**物理移除**;ts 用闭包 flag 让 handler 首次成功后**永久 no-op 但不移除**——对"这个 hook 还会不会再触发"这个问题两边答案一致(不会),但对"枚举当前注册的 hooks 列表"这类调试/展示场景两边结果不同(ts 会看到一个僵尸条目)。因为 ts 目前没有枚举展示 sessionHooks 的用户可见界面,这个差异当前不可观测,标 P2。
- 压缩后内容恢复:落了但实现路径不同(表 #6c)。cc 让 `invokedSkills` Map 本身进程内跨轮存活,压缩时直接读 Map 生成 attachment;ts 的 Map 同样进程内跨轮存活,但额外在每轮 `runLoop` 开头用 `restoreInvokedSkillsFromMessages` 从历史消息重新解析补全(因为 ts 的执行模型是每轮重新加载 transcript)——双保险,可观察行为等价甚至更稳(即使 Map 因某种原因清空,历史消息里的 `<invoked_skill>` 标签仍能重建)。

**6. paths 条件化(按文件路径激活 skill)——确认缺**
frontmatter `paths` 字段解析、挂起态 `conditionalSkills`、`activateConditionalSkillsForPaths` 按 gitignore 语义匹配触碰文件路径动态激活技能、以及配套的"沿文件路径向上找嵌套 `.claude/skills` 目录"动态发现机制(`discoverSkillDirsForPaths`/`addSkillDirectories`)——全套在 ts 里都不存在(表 #5)。`PromptCommand` 类型里没有 `paths` 字段,技能只能是"全程可见"或"完全不加载",没有"打开某类文件时才浮现"这一档。

---

## 分类计数

- **aligned**:8(#3 参数替换主干、#6 hooks 注册、#6b hooks 跨轮存活、#6c 压缩恢复、#18 审批闸安全属性白名单、#20/#21 概念对齐或产品边界内已一致)
- **gap**:12(#1 shell 执行、#2 模板变量、#4 @file、#5 paths 条件化、#7 disable-model-invocation、#8 user-invocable、#9 model 覆盖死字段、#10 effort、#12 命名空间、#14 legacy SKILL.md 混合、#15 commands 目录缺 hooks、#16 MCP 技能未统一)
- **deviation**:4(#3a 参数分词边界、#6a once 机制、#11 fork 同步/异步分岔、#13 project 层单目录)
- **intentional-delta**:3(#13 policy 层产品边界、#17 SkillTool 三工具拆分架构、#19 bundled 机制/打包已知待办)
- **N/A(产品边界/范围外)**:1(#20 命令 HTTP 端点)

## P0/P1 Top 5(按影响面排序,无 P0)

1. **#9 `model` frontmatter 静默失效**——技能作者写 `model: opus` 期望切强模型,ts 解析了字段却从没读它去真的换模型,看着支持实际是死字段,比"直接不支持"更容易埋坑。
2. **#11 `context: fork` 同步变异步**——cc 的 fork 技能阻塞等子代理跑完、结果直接回灌当轮;ts 改成后台任务立即返回"已启动"标记,模型拿不到同轮结果,技能作者若照抄 cc 语义写技能会踩空。
3. **#4 @file 附件引用系统整体缺失**——cc 一整套 `@path`/`@path:L1-L20`/`@dir/` 引用完全没有,是本次审计体量最大的单项缺口,用户没法用 `@` 快捷引用文件,只能指望模型自己调 Read。
4. **#1 `!`内嵌 shell 执行 + #2 `${CLAUDE_SKILL_DIR}` 模板变量**——技能正文里的动态 shell 输出和自引用路径变量两个能力都缺,目前 10 个内置技能没用到还不痛,但会限制未来技能作者写更强的技能(如需要读当前 git 分支名嵌进 prompt)。
5. **#12 命名空间缺失(plugin:skill、目录前缀)**——两个插件或嵌套 commands 目录出现同名技能/命令时会静默互相覆盖、无警告,插件生态一旦有多个来源就有踩雷风险。
