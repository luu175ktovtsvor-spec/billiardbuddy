# cc-haha 对齐审计 · 模块14:系统提示 / 项目指令文件 / 输出风格

- 规格源:`~/Desktop/cc-haha-ref`(当前源码,只读)
- 现状:`/Users/swl/Desktop/球房运营AI助手-桌面版/ts`(工作树现状,只读)
- 审计范围:`src/harness/systemPrompt.ts`、`src/harness/prompts.ts`、`src/harness/claudemd.ts`、`src/harness/memoryNames.ts`、`src/harness/projectInstructions.ts`、`src/tools/projectInstructionsTool.ts`、`src/outputStyles/outputStyleLoader.ts`、`src/memory/memoryPrompt.ts`、`src/harness/env.ts`、`src/mcp/*`、`src/agents/agentTool.ts`(subagent prompt 组装)、`src/permissions/autoEditSafety.ts`(白标 grep 命中的相邻文件)

---

## 一、CLAUDE.md → BILLIARDBUDDY.md 读取路径覆盖对照表

| cc 读取路径(claudemd.ts:1-26 头注 + getMemoryFiles 实现) | 我们的等价物 | 覆盖 |
|---|---|---|
| 1. Managed(`/etc/claude-code/CLAUDE.md`,策略级,最先/最低优先) | `getManagedDir()/BILLIARDBUDDY.md`(memoryNames.ts:64-75,平台相关默认目录,env `BILLIARDBUDDY_MANAGED_DIR` 覆盖) | ✅ 覆盖 |
| 2. Managed `.claude/rules/*.md` | `getManagedRulesDir()` | ✅ 覆盖 |
| 3. User(`~/.claude/CLAUDE.md`,永远允许外部 @import) | `~/.billiardbuddy/BILLIARDBUDDY.md`(`getMemoryPath('User', root)`,claudemd.ts:721 `includeExternal=true`) | ✅ 覆盖 |
| 4. User `~/.claude/rules/*.md` | `getUserRulesDir()`,同样 `includeExternal:true` | ✅ 覆盖 |
| 5. Project 逐级(root→cwd,含 `<dir>/CLAUDE.md` + `<dir>/.claude/CLAUDE.md` + `<dir>/.claude/rules/*.md`,无条件规则 eager 加载) | `<dir>/BILLIARDBUDDY.md` + `<dir>/.billiardbuddy/BILLIARDBUDDY.md` + `<dir>/.billiardbuddy/rules/*.md`(claudemd.ts:728-744) | ⚠️ **部分覆盖**——见下方 GAP-5:`cwd` 恒等于 `workspace.root`,root→cwd 退化成单目录,子目录里的 BILLIARDBUDDY.md/rules 从不被 eager 加载,也没有 cc 式的动态兜底(见下) |
| 6. Local(`CLAUDE.local.md`,逐级) | `BILLIARDBUDDY.local.md`(同样受制于 root=cwd 退化) | ⚠️ 同上 |
| 7. `--add-dir` 追加目录的 CLAUDE.md(env 开关) | 无 | ❌ 缺(P3,产品当前无 `--add-dir` 概念对等物,权限层有 `additionalWorkingDirectories` 但从未接进 claudemd 遍历——低优先级) |
| 8. AutoMem 索引(`memdir/MEMORY.md`,模型自写记忆池只读回索引,超限截断) | `getAutoMemEntrypoint`/`truncateAutoMemEntrypoint`(claudemd.ts:748-758, 763-781) | ✅ 覆盖,截断阈值(200行/25KB)与文案结构对齐 |
| 9. TeamMem | — | ✅ 正确不做(单用户产品,owner 免登录铁律) |
| 10. `.claude/CLAUDE.md` 与根 `CLAUDE.md` 都算 Project 层 | `.billiardbuddy/BILLIARDBUDDY.md` 与根 `BILLIARDBUDDY.md` 都算 Project 层 | ✅ 覆盖(claudemd.test.ts:99 有测) |
| 11. AGENTS.md 兼容 | **cc 本身也不自动加载 AGENTS.md**(只在 `/init` 命令提示词里提到"读 AGENTS.md 内容并入 CLAUDE.md",commands/init.ts:46,108) | ✅ 对齐(ts claudemd.test.ts:313 显式测"不加载 CLAUDE.md/AGENTS.md,只认 BILLIARDBUDDY.md";/init 等价技能也只泛泛提"既有贡献指南/cursor 规则",未逐一枚举 AGENTS.md/.cursorrules/copilot-instructions——P2 小缺口) |
| 12. `@import` 引用语法(`@path`/`@./path`/`@~/path`/`@/path`,深度上限5,文本扩展名白名单,代码块/行内代码/HTML注释感知,循环去重) | claudemd.ts:99-402 完整移植(无 `marked` 依赖,自写等效扫描) | ✅ 覆盖,有边界测试(claudemd.test.ts:112-170) |
| 13. 外部 @import 审批(`hasClaudeMdExternalIncludesApproved` + `ClaudeMdExternalIncludesDialog`) | `getExternalMemoryIncludes`/`hasExternalMemoryIncludes` 已定义**但零调用方、零测试** | ❌ **未接线**(见 GAP-10) |
| 14. 子目录动态注入(Read 工具触发 `nestedMemoryAttachmentTriggers`,自动补加载 Read 目标文件所在目录链上的 CLAUDE.md + 匹配的条件规则) | `loadConditionalRulesForPath`(claudemd.ts:788)已实现且有测试,但**从未被任何工具调用**(`fileReadTool.ts` 零引用) | ❌ **未接线**(见 GAP-5,P1) |
| 15. 压缩后恢复(CLAUDE.md 内容不在可压缩的对话历史里,而是每轮系统提示重新装配) | `createTurnStream`(server/index.ts:1515)每次用户消息都重新调 `buildSystemPrompt`→`loadMemoryInjection` | ✅ 对齐,天然扛压缩 |
| 16. `claudeMdExcludes` 逐层可关 + glob 排除 | `isMemorySourceEnabled`/`isMemoryExcluded` + env 开关(`BILLIARDBUDDY_DISABLE_*`) | ✅ 覆盖 |

**结论**:四层主干(Managed/User/Project/Local)+ AutoMem + @import 机制 + 各层开关,是**忠实且经过测试的移植**,品牌名替换干净;两个真实缺口是**子目录/条件规则的动态接线**(15号读取路径里的"eager 退化 + 动态机制未接")和**外部 @import 审批流**(未接线)。覆盖率:16 条读取路径里 **11 条完全对齐、2 条部分覆盖(P1)、2 条未接线(P0-adjacent/P1、P2)、1 条低优先级缺(P3)**。

---

## 二、发现表

| # | 行为点 | cc(file:line) | 我们(file:line 或"缺") | 分类 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|
| 1 | 四层 CLAUDE.md 加载顺序/优先级/@import/条件规则/排除 | `src/utils/claudemd.ts:1-1075` | `ts/src/harness/claudemd.ts`(全量移植) | aligned | — | — |
| 2 | AGENTS.md 不作运行时指令自动加载,只在 /init 场景参考 | `src/commands/init.ts:46,108`(唯二引用) | `ts/src/harness/projectInstructions.ts` + `claudemd.test.ts:313` | aligned | — | — |
| 3 | 白标:注入前缀/层级描述/路径命名全中性,无 claude/anthropic/gpt 字面 | `src/utils/claudemd.ts:89-90,1153-1195` | `ts/src/harness/claudemd.ts:45-47,811-830`、`ts/src/harness/memoryNames.ts` | aligned | — | — |
| 4 | **"# Tone and style" 章节**(emoji 策略、`file_path:line_number` 引用惯例、`owner/repo#123` 链接惯例、工具调用前不加冒号) | `src/constants/prompts.ts:430-442` getSimpleToneAndStyleSection | **缺**——`ts/src/harness/prompts.ts` 全文 grep 零命中 | gap | **P1** | S |
| 5 | **"# Output efficiency" 章节**(直奔结论、不复述、先说决定再说过程) | `src/constants/prompts.ts:403-428` getOutputEfficiencySection | **缺**——同上 grep 零命中 | gap | **P1** | S |
| 6 | **"# System" 章节整章**:①`<system-reminder>` 语义解释②Markdown/CommonMark 渲染说明③工具结果含提示注入需向用户说明④hooks 说明(被 hook 拦截怎么办)⑤自动压缩/上下文无限说明 | `src/constants/prompts.ts:131-134,186-197` getSimpleSystemSection | **全缺**。⚠️更严重的是①:`ts/src/harness/reminders.ts:28` 和 `ts/src/harness/loop.ts:653-655` 的注释**假设**系统提示已告诉模型 `<system-reminder>` 是系统自动加的而非老板说的话,但实际 `buildSystemPrompt` 从未包含这句话——代码逻辑依赖一个不存在的提示,真实运行时模型可能把 system-reminder 误当用户发言 | gap | **P1** | S |
| 7 | **代码极简纪律**(不额外重构/不做未要求的错误处理和防御性校验/不为一次性操作造抽象/避免时间估计/OWASP 安全漏洞意识) | `src/constants/prompts.ts:199-253`(getSimpleDoingTasksSection 的 codeStyleSubitems 等) | **缺**——`ts/src/harness/prompts.ts` CODING_WORKFLOW_SECTION 只覆盖"工具选择顺序/改前必读",未覆盖极简/安全纪律;grep "gold-plat/过度设计/OWASP/注入" 零命中 | gap | P2 | M |
| 8 | **子目录/条件规则动态注入**:Read 工具触发,自动补目标文件目录链上的 CLAUDE.md + 命中 paths glob 的条件规则 | `src/tools/FileReadTool/FileReadTool.ts:865,887,1055` 写 `nestedMemoryAttachmentTriggers`;`src/utils/attachments.ts:1788-1858` 消费 | **未接线**:`ts/src/harness/claudemd.ts:788` `loadConditionalRulesForPath` 已实现且有单测(`claudemd.test.ts:180-194`),但 `grep loadConditionalRulesForPath` 在 `fileReadTool.ts` 里零命中,只在测试文件里调用。且 eager 加载的 root→cwd 遍历因 `cwd` 恒等于 `workspace.root`(`systemPrompt.ts:28` 调 `loadMemoryInjection(workspace)` 不传 `cwd`)退化成单目录——子目录里的 BILLIARDBUDDY.md/规则**神经元式地从未被自动加载**,唯一入口是模型主动调 `list_project_instructions`(拉模式而非 cc 的推模式,且该工具连 `.billiardbuddy/` 点目录变体和条件规则都不查,只查 `<dir>/BILLIARDBUDDY.md` 一种文件) | gap + deviation | **P1** | M |
| 9 | MCP server 自带 `instructions` 字段注入系统提示 | `src/constants/prompts.ts:579-604` getMcpInstructionsSection + `mcpInstructionsDelta` | **缺**——`ts/src/mcp/*.ts` 全目录 grep "instructions" 零命中,MCP 客户端从未读取/转发该字段 | gap | P1 | M |
| 10 | 模型知识截止日期/身份行(白标形式亦可,用于让模型自判"这条信息可能过期该去查证") | `src/constants/prompts.ts:606-649,712-730` computeEnvInfo 的 knowledgeCutoffMessage | **缺**——`ts/src/harness/env.ts:24` 注释明写"刻意不含模型名/知识截止行——白标 + 模型身份是 W6",但目前代码库里没有任何文件承接这个"W6"承诺,搜"knowledge cutoff/模型身份"零命中 | gap | P1 | S |
| 11 | 自定义 output style 可通过 `keepCodingInstructions` **替换**(而非叠加)默认编码任务章节,用于非编码类人格 | `src/constants/outputStyles.ts:16,564-567`(getSystemPrompt 里 `outputStyleConfig.keepCodingInstructions===true` 才保留 getSimpleDoingTasksSection) | **只做加法**:`ts/src/server/index.ts:1568-1575` 把 `renderOutputStylePrompt` 结果直接拼在完整 `buildSystemPrompt` 之后,从不抑制 CODING_WORKFLOW_SECTION/VERIFICATION_SECTION;`outputStyleLoader.ts` 也未解析 `keep-coding-instructions` frontmatter | deviation | P2 | M |
| 12 | outputStyles 的 Managed 层 + 内置命名风格(Explanatory/Learning) | `src/constants/outputStyles.ts:41-135`(内置)、158-159(managed 优先级最高) | **缺** Managed 层与内置风格;`ts/src/outputStyles/outputStyleLoader.ts` 只有 user+project 两层,且与 claudemd.ts 已有的 Managed 概念不一致(同一产品两套"层级"体系,claudemd 有 Managed、outputStyles 没有) | gap | P2 | S |
| 13 | 外部 `@import`(Project/Local 层引用 workspace 之外文件)的审批弹窗 + `hasClaudeMdExternalIncludesApproved` 持久化 | `src/components/ClaudeMdExternalIncludesDialog.tsx` + `src/utils/config.ts` 的 `hasClaudeMdExternalIncludesApproved` | **未接线死代码**:`ts/src/harness/claudemd.ts:847-861` `getExternalMemoryIncludes`/`hasExternalMemoryIncludes` 已定义,`grep` 全仓库零调用方、零测试;`loadMemoryInjection` 默认 `includeExternal=false` 且从不被传 `true`,外部 @import 对 Project/Local 层永远静默丢弃(比 cc 更保守但也更没法用) | gap | P2 | M |
| 14 | "call multiple tools in parallel when independent" 的显式指令 | `src/constants/prompts.ts:310`(getUsingYourToolsSection 最后一条) | **缺该指令**,但机制层面 `ts/src/harness/loop.ts:620-660` 已经会对同一轮里的多个只读 tool_use 自动并行执行(`mapWithConcurrency`,`parallelReadOnlyLimit`)。系统提示没告诉模型"该批量发",非 Claude 系模型(MiMo/GPT等)更容易退化成一次只发一个工具调用,吃不到并行红利 | gap | P2 | S |
| 15 | `list_project_instructions` 工具应覆盖的文件面(cc 对应 attachments.ts nested 逻辑同时看 `<dir>/CLAUDE.md`、`.claude/CLAUDE.md`、条件规则三种) | `src/utils/attachments.ts:1826-1852` | `ts/src/tools/projectInstructionsTool.ts` 经 `projectInstructions.ts` 的 `PROJECT_INSTRUCTION_FILES=[MEMORY_MAIN_FILE]` **只查 `<dir>/BILLIARDBUDDY.md` 一种**,不查 `.billiardbuddy/BILLIARDBUDDY.md`、也不查条件规则——与 claudemd.ts 自己的 eager loader(会查两种文件名)口径不一致 | gap | P2 | S |
| 16 | subagent 系统提示追加"Notes"(绝对路径提醒/工具调用前不加冒号/精简结案报告) | `src/constants/prompts.ts:760-791` enhanceSystemPromptWithEnvDetails | **缺**:`ts/src/agents/agentTool.ts:138-150` `buildAgentSystemPrompt` 只拼 `baseSystemPrompt + <subagent> 包壳 + memory`,没有等价 Notes 追加(不过父级 prompt 若补上 #4/#5/#6 后大部分诉求会覆盖到子代理) | gap | P2 | S |
| 17 | 危险目录/敏感文件保护清单(acceptEdits 档自动编辑安全闸) | `src/utils/permissions/filesystem.ts` DANGEROUS_FILES/DANGEROUS_DIRECTORIES(含 `.claude`/`.claude.json`) | **白标遗留 + 功能性 bug**:`ts/src/permissions/autoEditSafety.ts:31-35` 逐字照抄 cc 清单(`.claude.json`、`.claude` 目录),从未加入 `.billiardbuddy`/`.billiardbuddy.json` 等价保护——① 我们自己产品真正的项目点目录 `.billiardbuddy` **完全不在自动编辑安全闸保护范围内**(功能性缺口,非只是命名);② `autoEditSafety.ts:130` 的确认文案 `"该路径是敏感文件/目录(.git/.vscode/.idea/.claude 或 shell/git/mcp 配置)"` 会把字面 `.claude` 显示给用户/回灌模型,是白标 grep 命中的真实泄漏点(虽不是"你是 Claude 模型"级别的直接泄露,但足以让细心用户生疑) | gap(白标)+ deviation(安全功能倒挂) | **P1** | S |
| 18 | `/init` 等价物(cc `commands/init.ts` NEW_INIT_PROMPT 8 阶段 vs OLD_INIT_PROMPT 单阶段;NEW_INIT 需 `feature('NEW_INIT')` 且 ant-only/env 开关,**多数外部用户实际吃到的是 OLD_INIT_PROMPT**) | `src/commands/init.ts:6-26`(OLD,默认生效) | `ts/src/skills/bundled/init/SKILL.md`:读清单/README/目录结构→若已存在则增补不覆盖→只写核实过的内容,**与 cc 默认生效的 OLD_INIT_PROMPT 结构基本对应**;缺 CLAUDE.local.md 等价物生成、缺 `.billiardbuddy/rules/` 拆分建议、缺对 AGENTS.md/.cursorrules/copilot-instructions 等既有 AI 配置文件的显式枚举(只泛泛提"既有贡献指南/cursor 规则") | intentional-delta(对齐默认路径)+ gap(细节) | P2 | S |
| 19 | `projectOnboardingState`(首次打开仓库时 UI 提醒跑 /init,最多提示 4 次) | `src/projectOnboardingState.ts` | 未见等价的"建议初始化"UI 提醒(桌面前端待确认,后端未见) | gap | P3 | S |
| 20 | env 块字段:`additionalWorkingDirectories` 列表注入 model 可见文本 | `src/constants/prompts.ts:630-633,683-688` | **缺**:`ts/src/harness/env.ts` 的 `computeEnvInfo` 不接受/不注入 `additionalWorkingDirectories`,尽管权限层(`Tool.ts:50`、`filePathRules.ts`)确实支持"额外允许目录"这个概念——模型看不到这些目录存在,只能靠工具调用试错发现 | gap | P2 | S |
| 21 | worktree 会话提示("这是一个 git worktree,别 cd 回原仓库根") | `src/constants/prompts.ts:679-681` | 项目确有 `worktreeTools.ts`(EnterWorktree/ExitWorktree),但 `computeEnvInfo` 未见等价 worktree 检测/提示 | gap | P2 | S |
| 22 | 工具发现/长尾工具搜索(tool_search) | `src/tools/DiscoverSkillsTool` + getDiscoverSkillsGuidance | `ts/src/harness/prompts.ts` TOOL_DISCOVERY_SECTION | aligned | — | — |
| 23 | 谨慎执行动作(可逆性/爆炸半径/授权范围) | `src/constants/prompts.ts:255-267` getActionsSection | `ts/src/harness/prompts.ts` ACTIONS_SECTION(几乎逐句翻译) | aligned | — | — |
| 24 | 工具拒绝处理(被拒不原样重试) | `src/constants/prompts.ts` getSessionSpecificGuidanceSection 相关 | `ts/src/harness/prompts.ts` DENIAL_RULE | aligned | — | — |
| 25 | 改动后验证纪律(诚实报告、别假装通过) | 分散在 getSimpleDoingTasksSection 的 ant-only false-claims 段 | `ts/src/harness/prompts.ts` VERIFICATION_SECTION(覆盖诚实报告核心诉求) | aligned | — | — |

---

## 三、按分类计数

- **aligned**:9(四层加载顺序/@import 机制/HTML 注释剥离/条件规则解析/排除设置/AGENTS.md 不自动加载/白标注入前缀/谨慎行动章/拒绝处理/验证纪律——部分合并计数见发现表)
- **gap**:约 16 条(P1×6,P2×9,P3×1)
- **deviation**:3 条(output style 只加法不替换、子目录指令拉模式代替推模式、安全闸目录清单倒挂)
- **intentional-delta**:3 条(品牌名全线替换、无 TeamMem、/init 对齐 cc 默认生效版本而非 ant-only 新版)

---

## 四、P0/P1 Top 5(按影响面排序)

1. **子目录/条件规则动态注入完全未接线**(#8):`loadConditionalRulesForPath` 有实现有测试但零调用方,`list_project_instructions` 只是模型可能不调的拉模式工具且连点目录变体都不查——任何放在子目录的 BILLIARDBUDDY.md/规则文件在真实会话里基本形同虚设。
2. **系统提示缺整个 "# System" 章**(#6):最要命的是 `<system-reminder>` 语义从未讲给模型听,而 `loop.ts`/`reminders.ts` 的代码注释却假设它讲了——这是一个真实的"承诺和实现对不上"的隐患,可能导致模型把系统提醒误判成用户发言。
3. **MCP server `instructions` 字段全链路丢失**(#9):我们真有 MCP 客户端集成,但连接上的 MCP 服务器自带的使用说明从未转发给模型,MCP 生态的可用性打了折扣。
4. **"Tone and style" + "Output efficiency" 两章全缺**(#4、#5):影响每一句回复的简洁度/引用惯例/格式规范,是最高频触达用户体验的一环,目前完全靠底层模型自己的默认风格。
5. **知识截止日期/模型身份行完全缺失**(#10)+**安全闸目录清单白标倒挂**(#17):前者让模型无法自判信息是否可能过期(与项目"查证不臆测"铁律直接矛盾);后者是本轮唯一抓到的真实白标字面泄漏(`.claude` 出现在用户可见确认文案里),且顺带曝出我们自己的 `.billiardbuddy` 项目目录没有被自动编辑安全闸保护的功能性缺口。

## 五、指令文件覆盖率结论

CLAUDE.md→BILLIARDBUDDY.md 的**静态四层加载体系**(Managed/User/Project/Local + AutoMem + @import + 各层开关)是本次审计里完成度最高的部分——移植忠实、品牌名替换彻底、测试覆盖到位,可判定为**已对齐**。但"读取路径全景"里明确要求核对的**动态/条件加载(子目录 CLAUDE.md 随 Read 工具触发)**和**外部 @import 审批**两条,在 ts 侧都是"实现了但没接线"的死代码状态,这是唯一条目录加载链路上的实质性缺口。系统提示的其余五个章节(System/Tone-and-style/Output-efficiency/Doing-tasks 的极简纪律子项/MCP instructions)则是彻底缺失而非部分覆盖,这些不属于 CLAUDE.md 加载链本身,但同属本模块审计范围,是后续优先级最高的补齐目标。
