# 权限模块 cc-haha 对齐差异审计(代码级 · 只读)

- spec = `~/Desktop/cc-haha-ref`(当前源码,非文档)
- 现状 = `/Users/swl/Desktop/球房运营AI助手-桌面版/ts`(工作树,含未提交改动)
- 方法:两边源码逐行对读,不采信既有矩阵文档的"已完成"记录

## 发现表

| # | 行为点 | cc 行为 + file:line | 我们 + file:line(或"缺") | 分类 | 优先级 | 工作量 |
|---|---|---|---|---|---|---|
| 1 | 规则持久化落盘路径/来源优先级 | `permissionsLoader.ts`(loadAllPermissionRulesFromDisk/addPermissionRulesToSettings)读写 `SETTING_SOURCES`(userSettings/projectSettings/localSettings/policySettings/flagSettings),按 `getSettingsFilePathForSource` 解析各自目录 | `ts/src/permissions/permissionsSettings.ts:134-168`(`loadPermissionRules`/`loadUserPermissionRules`)读 `~/.billiardbuddy/settings.json`(userSettings)+ `<workspace>/.billiardbuddy/settings.json`(projectSettings)+ `settings.local.json`(localSettings);`persistPermissionRule`(187-202)写 localSettings | **intentional-delta**(白标目录名,行为等价) | — | — |
| 2 | 工作区级 allow 规则信任门(防恶意仓库 RCE) | cc 用会话前置 **TrustDialog** 硬阻断(未信任目录整个会话跑不起来) | `permissionsSettings.ts:58-132` `applyPermissionTrustGate`:未受信工作区丢弃 projectSettings/localSettings 的 **allow**,deny/ask 始终生效;无阻断弹窗,是"定向门" | **intentional-delta**(CLAUDE.md 明确"本产品尚无 trust 授予 UI",裁剪版设计,产品自己承认) | — | — |
| 3 | **plan 模式对写/执行类工具的拦截方式** | 中央瀑布 `permissions.ts:233-241` `shouldBypassToolPermissions` 只在 `mode==='plan' && isBypassPermissionsModeAvailable`(默认关)时给 bypass 待遇;否则 plan 模式**不特殊分支**——`checkWritePermissionForTool`(`utils/permissions/filesystem.ts:1225-1435`)全程无 `mode==='plan'` 判断,写请求落到第 5 步默认 `ask`(1418-1434,消息与 default 模式一字不差);`BashTool/modeValidation.ts:72-109` `checkPermissionMode` 只识别 `acceptEdits`,同样无 plan 分支。**结论:cc 的 plan 模式是纯 prompt/约定层("システムがplanモード中は書くな"+ExitPlanModeTool 引导),权限层对写照样弹标准审批卡,用户可当场点"允许"放行** | `ts/src/permissions/resolve.ts:169-177`:`mode==='plan' && !readOnly` → **直接 `deny`**(`PLAN_SKIP_MSG`),唯一例外是写本会话计划文件(`isPlanFileWrite`);此 deny 在瀑布最前部(fatal 之后、规则匹配之前),模型收到拒绝文案后**没有任何路径能让用户在同一次请求里点头放行**(除非切模式) | **deviation** | **P1** | M |
| 4 | 同族工具绕过(Read/Edit/Write 内部名 vs 规范名) | `filesystem.ts` `getPatternsByRoot`/`matchingRuleForInput` 按 `FILE_READ_TOOL_NAME`/`FILE_EDIT_TOOL_NAME` 家族分派 + "edit allow 隐含 read allow" | `ts/src/permissions/filePathRuleMatch.ts:80-115`(`READ_RULE_TOOLNAMES`/`EDIT_RULE_TOOLNAMES`/`WRITE_RULE_TOOLNAMES` + `fileRuleAppliesToTool`)、`resolve.ts:83-101`(`TOOL_RULE_ALIASES`)—— **已修复并 re-review 通过**(commit `9558aa6`,`filePathRuleMatch.ts` 系该提交新增),测试见 `filePathRuleMatch.test.ts` 461-540(patch_files/restore_file/code_outline/read_many_files/NotebookEdit/edit_excel 全覆盖) | **aligned**(已核实对齐) | — | — |
| 5 | 复合命令 deny/ask 绕过(`true && rm x`) | `bashPermissions.ts` `matchingRulesForInput` 对 deny/ask 用 `stripAllEnvVars`+子命令逐条匹配 | `ts/src/permissions/permissionRules.ts:395-418`(`shellCommandMatchesDenyOrAskRule` 拆子命令逐条匹配,commit `dec3057`) | **aligned** | — | — |
| 6 | permissionExplainer(小模型解释审批风险 LOW/MEDIUM/HIGH) | `src/utils/permissions/permissionExplainer.ts` 全文件:`generatePermissionExplanation` 调 Haiku 输出 `{riskLevel, explanation, reasoning, risk}`,默认开启(`isPermissionExplainerEnabled`) | 全仓 `grep -rl "riskLevel\|permissionExplain"` **无命中**;`ts/src/permissions/types.ts:92-97` 的 `ApprovalReason{what,why,impact}` + 各工具的 `approvalReasonFor`(`resolve.ts:36`)是**工具作者手写的确定性文案**,不是 LLM 现算,机制不同 | **gap** | P2 | S(若要做:接一次 sideQuery 调小模型;权衡=多一次延迟/成本,产品"无花钱味"倾向可能故意不做) |
| 7 | destructiveCommandWarning(审批卡纯信息性警告,不影响判定) | `src/tools/BashTool/destructiveCommandWarning.ts` 全文件(17 条 git/rm/SQL/k8s/terraform 正则) | `ts/src/tools/destructiveCommandWarning.ts:16-51` 逐条移植 + 额外补了 Windows/PowerShell 12 条(cc 该文件本身没有,cc 的 Windows 版在姊妹文件 `PowerShellTool/destructiveCommandWarning.ts`) | **aligned**(我们覆盖面更大) | — | — |
| 8 | ask 规则对"整工具"沙箱豁免(`autoAllowBashIfSandboxed`) | `permissions.ts:1107-1123`(`checkRuleBasedPermissions`)与 `1204-1224`(`hasPermissionsToUseToolInner`):tool-level ask 规则命中时,若 `SandboxManager.isSandboxingEnabled() && isAutoAllowBashIfSandboxedEnabled() && shouldUseSandbox(input)` 则跳过 ask、交给 Bash 自己的 checkPermissions 处理(sandbox 内自动放行) | 全仓 `grep -rl "autoAllowBashIfSandboxed"` **无命中**;`resolve.ts:188-189` 的 askRule 分支无沙箱豁免 | **gap** | P2/P3(已在迁移矩阵 P3"OS 沙箱网络白名单"路标里,非新发现) | M |
| 9 | headless/后台子代理无人可弹卡时的自动拒绝兜底 | `permissions.ts:939-962`:`shouldAvoidPermissionPrompts` 时先跑 `PermissionRequest` hook,无 hook 决策则 `deny`(`AUTO_REJECT_MESSAGE`),避免后台任务卡死等一个不存在的人 | 全仓 `grep -rl "shouldAvoidPermissionPrompts"` **无命中**;`ts/src/tasks/taskTools.ts` 未见对 `ask` 的后台专用兜底,后台任务的 `ask` 走的应是与前台同一条 `loop.ts:1137` 审批卡逻辑 | **gap**(潜在:后台/子代理任务遇到需要审批的动作可能挂起等人,而非安全兜底 deny) | P2 | M(需先确认本产品是否已有"后台任务无人值守"场景;若暂无则风险为 0,建计入路标) |
| 10 | 中央瀑布结构:tool 级规则(中央) vs content 级规则(委托各工具 checkPermissions) | cc 分两层:`getDenyRuleForTool`/`getAskRuleForTool`(仅裸 `Bash`/`Read` 这种无 `ruleContent` 的规则)在中央瀑布判;`Bash(npm install)`/`Read(.env)` 这类带内容的规则由各工具自己的 `checkPermissions`(`bashToolCheckPermission`/`checkWritePermissionForTool`)判 | `ts/src/permissions/resolve.ts:135-137`(`matchingRule`)把**裸规则 + 带内容规则统一在中央 `ruleMatchesInput`** 判定(`resolve.ts:103-133`),不委托给各工具自身实现 | **intentional-delta**(架构不同、非 cc 排除清单里的条目,但只要 `permissionRules.ts`/`filePathRuleMatch.ts` 忠实复刻了 cc 各工具的内容匹配算法,对外行为等价——已用大量边界测试锁住,视为架构差异非功能缺口) | — | — |
| 11 | 危险命令/只读判定:cc AST(tree-sitter)分析器 vs 我们的正则分类器 | `src/utils/bash/ast.ts` 全文件是 tree-sitter 方案,但 **`parser.ts:51,65,108`** 三处门在 `feature('TREE_SITTER_BASH')`;`bashPermissions.ts:230`(注释原文)明确 **"In external builds TREE_SITTER_BASH is off"** —— 即 cc 对外发行版实际生效路径是正则回退 `bashSecurity.ts`(2592 行,`bashCommandIsSafe_DEPRECATED` 等) | `ts/src/tools/dangerousCommand.ts`(4284 行)是对 `bashSecurity.ts` 正则回退路径的移植,函数名一一对应(`hasShellExpansionRisk`/`hasShellParserRisk`/`hasBraceExpansionRisk`/`hasZshDangerousCommand`/heredoc-substitution 等),且额外并入了 cc 分散在别处的只读命令分类(`GIT_READ_ONLY_COMMANDS`/`READ_ONLY_COMMANDS`) | **aligned**(比对对象选对了:tree-sitter 是 cc 自己都没对外开的内部能力,不该拿它当缺口) | — | — |
| 12 | Bash `Bash(...)` 参数级 allowedTools(prefix/wildcard/exact + 安全包装剥离) | `bashPermissions.ts` `filterRulesByContentsMatchingInput`/`stripSafeWrappers`/`stripAllLeadingEnvVars`/`matchWildcardPattern` | `ts/src/permissions/permissionRules.ts` 全文件(`stripSafeShellWrappers`/`stripAllLeadingEnvVars`/`matchWildcardPattern`/`shellCommandMatchesPermissionRule`)—— 常量表(`SAFE_ENV_VARS`/`SAFE_WRAPPER_PATTERNS`)与 cc 逐条一致 | **aligned** | — | — |
| 13 | 文件工具 path-scoped allowedTools(`~/`、`//`、`/`、相对、gitignore glob 引擎) | `filesystem.ts` `patternWithRoot`+ vendored `ignore` 库 | `ts/src/permissions/filePathRuleMatch.ts:223-290`(`fileGlobMatchesPathForRule`/`patternWithRoot`)+ 同款 vendored `ignore@7.0.5`(`ts/src/permissions/vendor/ignore.js`) 代码逻辑对齐;**但测试覆盖有缺口**:`filePathRuleMatch.test.ts` 有根锚定 `/`、工作区外穿越、家族隔离、嵌套数组路径等用例,**未见 `~/` home 前缀、UNC、大小写不敏感的专项用例** | **gap(测试覆盖,非已知行为 bug)** | P2 | S(补测试用例即可,代码路径已存在) |
| 14 | denial 语义(拒绝到什么程度自动降级/停问) | cc 的 `DENIAL_LIMITS`/`denialTracking.ts` 仅服务 **auto 模式分类器**(TRANSCRIPT_CLASSIFIER,ant-only、feature-flag) | `ts/src/permissions/denialTracking.ts` 全文件:`DENIAL_FALLBACK={perAction:2,global:20}`,服务我们自己的"拒够了别再烦老板"语义,与 cc 的 auto-mode 分类器无关 | **intentional-delta**(范围外:auto/bubble 权限模式;我们这套是独立设计,不对标) | — | — |
| 15 | dontAsk 模式的 ask→deny 转换时机 | `permissions.ts:513-527`:在 `hasPermissionsToUseTool` 顶层收口转换(唯一入口,不可被内部分支绕过) | `ts/src/permissions/approval.ts:41-58`(`denyForDontAsk`/`finalizeDecision`)—— `ask()` 助手函数与 `resolvePermission` 顶层各自都做了 dontAsk 检查,双保险,行为等价 | **aligned** | — | — |

## 已知待办核对结果(逐条)

1. **规则持久化落盘(dd57f6e)** —— **已做**,现状读写路径是 `~/.billiardbuddy/settings.json`(userSettings)+ `<workspace>/.billiardbuddy/{settings.json,settings.local.json}`(projectSettings/localSettings),**不是** `.claude/settings.json`(commit 消息里的 `.claude` 措辞是历史遗留,实际代码已白标)。rule source 优先级：加载顺序 user→project→local(`permissionsSettings.ts:157-167`),与 cc `getEnabledSettingSources()` 的多源合并顺序语义等价;信任门(`applyPermissionTrustGate`)是我们自己叠加的安全加固,cc 用整会话 TrustDialog 达到类似目的,两者手段不同但都堵住"恶意仓库 allow:['Bash(*)'] 静默放行"这条洞。**分类:intentional-delta,已核实对齐。**

2. **plan 模式:硬拒绝 vs 软拦截** —— **确认为真实 deviation**(见发现表 #3)。cc 的 plan 模式对写/执行类工具走标准 `ask` 审批卡(与 default 模式消息一字不差),用户可在卡片上直接点"允许"当场放行;我们的 plan 模式在权限瀑布最前部直接 `deny`(`PLAN_SKIP_MSG`),模型收到的是"跳过、继续规划"的拒绝文案,**没有审批卡、用户没有当场点头放行的路径**(唯一豁免是写本会话计划文件)。这是本次审计确认度最高的一条行为分叉,标 **P1**。

3. **permissionExplainer** —— **确认无等价物**(见发现表 #6)。我们有 `ApprovalReason{what,why,impact}` 机制但由工具作者手写确定性文案,不是运行时调小模型现算 LOW/MEDIUM/HIGH 风险等级。标 **gap/P2**(是否要做取决于 owner 对"多一次 LLM 调用换审批卡说人话"的取舍,产品当前"无花钱味"倾向可能是有意不做,但代码层面确实缺失)。

4. **同族工具绕过修复(§3.405 #4)** —— **已修复、已过 re-review**。commit `9558aa6`("kernel: cc-haha P0 alignment rework passed re-review (permissions path-deny + hooks trust gate)")首次引入 `ts/src/permissions/filePathRuleMatch.ts`,把 Read/Edit/Write 三个家族(含内部工具名 `read_file`/`edit_file`/`patch_files`/`code_outline`/`NotebookEdit`/`restore_file` 等)统一按 cc `getPatternsByRoot` 语义分派,测试用例逐个补齐了此前"漏网"的 `patch_files`/`restore_file`/`code_outline`/`read_many_files`/`NotebookEdit` 场景(`filePathRuleMatch.test.ts:461-540`,注释自称"原漏网洞")。迁移矩阵文档(`docs/plans/TS-cc-haha-v0.4.5-...md:3557`)仍标"🔁rework 中"是**文档滞后**,代码现状已完成。**分类:aligned,文档待同步(建议顺手把该行状态改成 ✅)。**

5. **中央瀑布形状差异(刁钻边界枚举)**:
   - **plan 模式**(见 #2)—— 唯一会改变最终决策结论的输入(mode='plan' + 非只读工具)。
   - **沙箱内 ask 规则豁免**(`autoAllowBashIfSandboxed`,发现表 #8)—— cc 在"已启用沙箱 + 命令会被沙箱化"时让 tool-level ask 规则失效、转交 Bash 自己判;我们没有这个豁免,同输入下我们更保守(仍会 ask)。**方向是我们更严,不是漏洞,但与 cc 不同**,已在迁移矩阵标为 P3 路标,非新发现。
   - **../escape、`~`、UNC、通配、大小写**:两边的路径匹配算法(`patternWithRoot`/`fileGlobMatchesPathForRule`)是逐行移植,推理上行为一致(`..` 越界跳过、`~/` 归 home、`//` 归文件系统根、末尾 `/**` 剥离都照抄),**但我们侧缺专项测试锁定**(发现表 #13),不排除未测到的实现细节漂移,标测试覆盖 gap/P2。
   - **同族**(见 #4)—— 已修复。
   - 除以上,未发现其它会导致"同输入不同最终决策"的分叉点。

6. **cc Bash tree-sitter 安全分析器 vs 我们的命令分类器** —— **比对对象需要澄清**:cc 源码里确实有 `src/utils/bash/ast.ts` 全套 tree-sitter 方案,但被 `feature('TREE_SITTER_BASH')` 门控,且 cc 自己的代码注释明确写"In external builds TREE_SITTER_BASH is off"(`bashPermissions.ts:230`)——即**对外发行的 cc 本身也不跑 tree-sitter**,真正生效的是正则回退路径 `bashSecurity.ts`。我们的 `dangerousCommand.ts` 正是对这条正则回退路径的移植(函数名逐一对应),且规模更大(4284 行 vs 2592 行,因为额外并入了只读命令分类逻辑)。**分类:aligned**,不算缺口——用 tree-sitter 版本当基准会得出"我们缺全套 AST 引擎"这种误判,但那不是 cc 对外用户实际吃到的行为。

## 分类计数

- aligned:7(#4/#5/#7/#11/#12/#13代码路径本身/#15;注:#13 拆成"代码 aligned + 测试 gap"两半分别计)
- gap:4(#6/#8/#9/#13测试覆盖)
- deviation:1(#3 plan 模式硬拒绝,已知待办#2)
- intentional-delta:4(#1/#2信任门/#10架构/#14)

## P0/P1 Top5(按本次审计实际产出,只有 1 条够格 P1,无 P0)

1. **P1 · plan 模式硬拒绝 vs cc 软拦截**——用户在 plan 模式下想临场批准一个写操作时,我们没给他这个按钮,cc 有。
2. P2 · permissionExplainer 缺失——审批卡没有"这条命令风险多高"的人话解释。
3. P2 · 沙箱内 ask 规则豁免未做——我们比 cc 更保守(不是安全洞,是能力差)。
4. P2 · 后台任务无人值守时的兜底 deny 未做——理论上后台任务可能卡死等一个不存在的审批人。
5. P2 · `~`/UNC/大小写路径规则测试覆盖缺口——代码看似对,没测试锁定,有漂移风险。
