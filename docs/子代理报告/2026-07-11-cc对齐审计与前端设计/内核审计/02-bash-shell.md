# cc-haha 对齐差异审计 · Bash/命令执行工具(只读)

> 规格源:`~/Desktop/cc-haha-ref`(当前源码)。现状:`/Users/swl/Desktop/球房运营AI助手-桌面版/ts`(工作树当前内容,含未提交改动)。
> 审计方法:两侧源码逐文件精读(非文档),配子代理分工读取 + 主代理交叉核实关键点(直接 grep/Read 复核)。

## 一、发现表

| # | 行为点 | cc 行为(file:line) | 我们(file:line 或"缺") | 分类 | 优先级 | 规模 |
|---|---|---|---|---|---|---|
| 1 | 默认 timeout | `2分钟`=120,000ms · `utils/timeouts.ts:2,12-20` | `30,000ms`(30秒)· `runCommandTool.ts:13` | **deviation** | P1 | S |
| 2 | 最大 timeout | `10分钟`=600,000ms(env `BASH_MAX_TIMEOUT_MS` 可调,且强制 ≥ default)· `utils/timeouts.ts:3,28-38` | `600,000ms` 硬编码 · `runCommandTool.ts:14` | aligned(数值巧合一致,但无 env 覆盖机制) | P2 | S |
| 3 | 输出截断阈值(默认) | `30,000 字符` · `utils/shell/outputLimits.ts`(`BASH_MAX_OUTPUT_DEFAULT`) | `64,000 字节` · `runCommandTool.ts:15`(`DEFAULT_MAX_OUTPUT_BYTES`) | **deviation**(单位口径不同+数值不同,非同输入同输出) | P1 | S |
| 4 | 输出截断阈值(硬顶) | `150,000 字符` · `outputLimits.ts`(`BASH_MAX_OUTPUT_UPPER_LIMIT`) | `1,000,000 字节` · `runCommandTool.ts:16` | **deviation** | P2 | S |
| 5 | 截断方向 | 保留**尾部**(`EndTruncatingAccumulator`,`utils/stringUtils.ts:140`) | 保留**尾部**(`StreamTailBuffer.trim()`,`runCommandTool.ts:416-432`) | aligned(方向一致,阈值不一致见#3/#4) | — | — |
| 6 | 超限输出兜底 | 整份写盘 + 结果里给预览+文件路径,模型可用 Read 拿全量(`buildLargeToolResultMessage`/`generatePreview`,`BashTool.tsx:591-600`,`toolResultStorage.ts`) | **无**——超出 `max_output_bytes` 的内容直接丢弃,`truncatedBytes` 只计数不落盘(`StreamTailBuffer.trim()`,`runCommandTool.ts:416-432`) | **gap** | P1 | M |
| 7 | 截断提示文案 | `` `${tail}\n\n... [${remainingLines} lines truncated] ...` ``(`utils.ts:158`) | `输出截断:true(保留最后 X/Y bytes,省略 Z bytes)`(`formatCommandResult`,`runCommandTool.ts:377-379`) + 实时流截断提示 `emitLiveTruncationNotice`(`runCommandTool.ts:334-346`,cc 无对应"实时片段省略"提示) | intentional-delta(文案本地化,语义等价;我们多了实时流截断提示是加分项非缺口) | — | — |
| 8 | 退出码语义豁免表 | `grep/rg`(≥2错误,=1"无匹配")、`find`(≥2错误,=1"部分目录不可访问")、`diff`(≥2错误,=1"文件不同")、`test`/`[`(≥2错误,=1"条件为假)· `commandSemantics.ts:22-99` | 同一组豁免命令 `grep/rg/find/diff/test/[` · `commandSemantics.ts:9-13`(路径同名文件、逻辑镜像) | aligned | — | — |
| 9 | 退出码基准命令提取 | 复合命令取**最后一段**首词(管道最后一段决定整体exit code)· `commandSemantics.ts:112-119` | 未逐行核实是否同样取"最后一段"逻辑(未在本轮细读范围,标记待核) | 未核实 | P2 | S(核实) |
| 10 | 超时后 exit code 记法 | 需查证(未在本轮读到具体赋值,cc 走 `onTimeout` 自动后台化而非直接置退出码,语义不完全对应) | `exitCode = code ?? (timedOut\|\|aborted\|\|signal ? -1 : 0)` · `runCommandTool.ts:202` | intentional-delta(架构不同:cc 超时默认转后台,我们超时默认杀进程返回 -1;见#16) | — | — |
| 11 | run_in_background 参数 | 是 BashTool **同一 schema** 的字段(`run_in_background: boolean`),命中后 `spawnShellTask` 立即转后台不阻塞(`BashTool.tsx:989-1001`) | **无此参数**——后台执行是完全独立工具 `run_command_background`(`backgroundCommandTool.ts:43-48`),非 run_command 的开关 | intentional-delta(两种设计都能达成同等能力,只是工具边界切法不同;模型侧调用方式不同,若严格"同输入同结构输出"审是 deviation,但产品层面是可接受的架构选择——不影响功能覆盖) | P2 | M(如需严格对齐要合并成同一 schema) |
| 12 | 自动转后台(阻塞预算) | `ASSISTANT_BLOCKING_BUDGET_MS=15,000ms`,仅在 KAIROS/assistant 模式下,命令跑够15秒自动转后台(`BashTool.tsx:57,976`) | 无——`范围外`(auto/bubble 模式排除项,KAIROS 是 cc 内部特性开关) | intentional-delta(范围外) | — | — |
| 13 | 命令跑够2秒后轮询/可手动转后台 | `PROGRESS_THRESHOLD_MS=2,000ms` 起轮询,支持 Ctrl+B 手动转后台(`BashTool.tsx:55`,`registerForeground`) | 我们没有"运行中同步命令可临时转后台"的能力(run_command 是纯同步等待到完成/超时;要后台执行必须一开始就调 `run_command_background`) | **gap**(次要,属交互体验缺口,非安全缺口) | P2 | M |
| 14 | 后台任务超时默认值 | 无独立后台超时概念(后台任务本身不超时,由 TaskStop 手动停) | `DEFAULT_BG_TIMEOUT_MS=600,000ms`(10分钟)· `backgroundCommandTool.ts:25` | intentional-delta(我们的后台工具有自己的超时口径,非坏事) | — | — |
| 15 | 停滞看门狗(卡在交互提示) | 未在本轮读到 cc 侧对应机制(cc 靠 `onTimeout`/用户手动 Ctrl+B) | 有:45秒无输出增长+尾行像交互提示(`y/n`等)才提醒(`STALL_CHECK_INTERVAL_MS=5000, STALL_THRESHOLD_MS=45000`,`backgroundCommandTool.ts:22-23,166-170`) | 我们侧**多做**的能力,非缺口 | — | — |
| 16 | 后台任务读取工具 | `TaskOutputTool`(别名 `BashOutputTool`/`AgentOutputTool`,已标 Deprecated 建议改用 Read)· `task_id/block/timeout` · `TaskOutputTool.tsx:30-34` | `TaskOutput` 工具,同参数形状 `task_id/block/timeout/limit` · `taskTools.ts:1018-1037` | aligned(接口形状/别名策略均对齐;我们额外支持 `limit` 是加分项) | — | — |
| 17 | 停止后台任务工具 | `TaskStopTool`(别名 `KillShell`,参数 `task_id` 兼容旧 `shell_id`)· `TaskStopTool.ts:40-44` | `TaskStop`,同参数含 `shell_id` 兼容别名 · `taskTools.ts:1052-1058` | aligned | — | — |
| 18 | shell 会话/cwd 跨调用持久化 | **持久**:`getCwd()/setCwd()` 模块级全局状态,`cd` 后下次调用记得;每次调用后检测"是否需要归位"(`shouldMaintainProjectWorkingDir()` 或越出允许边界)才 reset,并在 stderr 追加"Shell cwd was reset to..."提示(`utils.ts:170-192`,`BashTool.tsx:702-707`) | **不持久**:每次 `execute` 全新 `spawn`,`cwd` 只在本次调用内生效,不传 `cwd` 参数就回退 `ctx.workspace.root`(`resolveCommandCwd`,`runCommandTool.ts:114-122,221-228`) | **deviation**(架构性差异,非同输入同输出:cc 里 `cd /tmp` 之后下一条 `pwd` 会看到 `/tmp`;我们不会) | P1 | M |
| 19 | 子代理执行时 cwd 隔离 | `preventCwdChanges = !isMainThread`,子代理的 `cd` 不许污染主线程全局 cwd(`BashTool.tsx:643`) | 因为我们本身无全局 cwd 状态,这个隔离问题天然不存在(每次调用独立) | 不适用(#18 的连带结果) | — | — |
| 20 | 子命令数量上限 | `MAX_SUBCOMMANDS_FOR_SECURITY_CHECK=50`(仅 legacy/AST不可用路径生效,超限直接 `ask`,修复 CC-643 CPU 卡死)· `bashPermissions.ts:103` | **无任何上限**——`classifyCommandRisk` 用 `.reduce()` 遍历所有 segment,理论上链多长都处理(`dangerousCommand.ts:4271-4276`) | **gap**(DoS/性能防线缺失,虽然我们是纯正则非 AST,风险模型不同,但同样有"超长链拖垮"的潜在面) | P2 | S |
| 21 | 多个 cd 命令(不含 git/write)直接 ask | 命中即 ask,理由"Multiple directory changes in one command require approval"(`bashPermissions.ts:2182-2196`) | **无**独立检测——只有 `shellCdGitNeedsApproval`(cd+git)和 `shellCdWriteNeedsApproval`(cd+write)两个组合判定(`dangerousCommand.ts:3908-3916`),纯多个 cd(如 `cd /a && cd /b && ls`)不会触发审批 | **gap**(小,場景少见) | P2 | S |
| 22 | cd+git 复合命令闸(裸仓库攻击防御) | 命中即 ask,置于"逐子命令权限判断之前"以保留"前面有 cd"上下文(`bashPermissions.ts:2202-2225`) | `shellCdGitNeedsApproval` 有实现且已接入 `classifyCommandRisk`(`dangerousCommand.ts:3908-3910`,接线于 `dangerousCommand.ts:4274`)→ 经 `effectiveCommandRisk` 传导到 `runCommandTool.ts:98` | aligned | — | — |
| 23 | 裸仓库(bare repo)cwd 检测 | `isCurrentDirectoryBareGitRepo()` 检测当前目录文件系统特征(`HEAD`/`objects/`/`refs/`,非参数字符串匹配)· `readOnlyValidation.ts` 内引用 | `cwdLooksLikeBareGitRepo`(同样查文件系统特征,非 `--git-dir` 参数匹配)· `dangerousCommand.ts:4062-4093`,接线 `shellBareGitRepoCwdNeedsApproval`(`:3924-3926`)→ `runCommandTool.ts:103` | aligned(判定原理一致:目录状态检测而非参数匹配) | — | — |
| 24 | git 内部路径写入防护(`.git/HEAD`/`objects/`/`refs/`/`hooks/`) | `commandWritesToGitInternalPaths`(`readOnlyValidation.ts:1840-1864`) | `shellGitInternalWriteNeedsApproval`+`isGitInternalPath`+`segmentWritesGitInternalPath`(`dangerousCommand.ts:3918-3922,4039-4060`),接线于 `classifyCommandRisk`(`:4274`) | aligned | — | — |
| 25 | 沙箱激活时 git 换 cwd 额外审批 | 未见对应专项(cc 的沙箱是 OS 级隔离,权限判定与沙箱状态基本解耦,见#5 项 `shouldUseSandbox.ts`) | `shellSandboxedGitCwdNeedsApproval`(沙箱激活且 cwd≠root 时 git 命令要多一道审批)· `dangerousCommand.ts:3928-3932` | 我们侧**多做**的能力(intentional-delta,偏保守不算缺口) | — | — |
| 26 | Substitution(`$()`/反引号/进程替换等)风险判定方式 | **二元 AST 判定**:tree-sitter(见#31)一旦发现 `command_substitution`/`process_substitution` 等无法静态分析结构,直接整条 `too-complex`→统一转 `ask`;legacy 路径靠一组正则(`COMMAND_SUBSTITUTION_PATTERNS`)逐个模式判定,同样统一转 `ask`,**不分级** · `bashSecurity.ts:16-41`,`bashPermissions.ts:1670-1739` | **正则集合判定**,`SHELL_EXPANSION_PATTERNS`(`dangerousCommand.ts:146-159`)覆盖 `<(`/`>(`/`=(`、`=cmd`展开、`$(`、`${`、`$[`、`~[`、`(e:`、`(+`、`}always{`、`<#`,反引号单独用 `hasUnescapedChar` 处理(`:1199`);命中即统一判需审批(`outreach`级),同样不分级 | aligned(判定粒度一致:二元、命中即升级,不做"低/中/高风险"细分;正则集合逐条比对基本一致,除#27安全heredoc白名单细节外未发现遗漏模式) | — | — |
| 27 | "安全 heredoc substitution"白名单(`$(cat <<'EOF' ...EOF\n)` 判定为安全、绕过#26) | `isSafeHeredoc`/`stripSafeHeredocSubstitutions`,含"闭合定界符必须是第一条匹配行"等逐行精确匹配逻辑,防止正则跳过第一个定界符找到后面伪造的定界符(`bashSecurity.ts:317-583`) | `findSafeHeredocSubstitutionRanges`/`stripSafeHeredocSubstitutions` 系列(`dangerousCommand.ts:1413-1517`) | aligned(未逐行比对两边闭合定界符的极端 case,如"缩进`<<-`""闭合行后跟`)`同行 vs 下一行"这类,建议列为下一轮细读项;基本设计思路一致) | P2 | S(细读复核) |
| 28 | 反引号处理(转义 vs 未转义) | `hasUnescapedChar(unquotedContent, '\`')`,允许转义反引号(SQL常用),命中未转义直接 ask(`bashSecurity.ts:853-858`) | `hasUnescapedChar(exposed, '\`')`,同名函数同语义(`dangerousCommand.ts:1199`) | aligned | — | — |
| 29 | git commit -m 消息里的 substitution/flag 注入防护 | `validateGitCommit`:双引号消息含 `$(`/`` ` ``/`${` → ask;消息含反斜杠整体退回主校验链;remainder(`-m` 后剩余部分)含 shell 元字符/未加引号的 `<>` → 退回主校验链而非直接放行(`bashSecurity.ts:612-740`,大段注释解释历史踩坑) | `hasGitCommitMessageRisk`(`dangerousCommand.ts:1550-1576`) | 未逐条比对(两边都存在且思路一致,但 remainder 未加引号 `<>`/反斜杠退避这类极细节未做逐行核对,标记待核) | P2 | S(细读复核) |
| 30 | IFS 注入检测 | `/\$IFS\|\$\{[^}]*IFS/.test(originalCommand)`(`bashSecurity.ts:1023`) | 同正则 `/\$IFS\|\$\{[^}]*IFS/`(`dangerousCommand.ts:1197`,主代理已复核确认逐字符一致) | aligned | — | — |
| 31 | `/proc/*/environ` 访问防护 | `/\/proc\/.*\/environ/`(`bashSecurity.ts:1051`) | 同正则(`dangerousCommand.ts:1198`) | aligned | — | — |
| 32 | 命令解析引擎 | **看似 tree-sitter,实为纯 TypeScript 手写递归下降解析器**(`utils/bash/bashParser.ts:1-10` 自述"Pure-TypeScript bash parser producing tree-sitter-bash-compatible ASTs...Validated against a 3449-input golden corpus"),运行时**不加载任何原生 tree-sitter 依赖**,`ensureParserInitialized()` 是空操作(`bashParser.ts:39-41`);超时 `PARSE_TIMEOUT_MS=50ms`/`MAX_NODES=50,000` 防 DoS,超限 fail-closed 当 `too-complex`(非退回 legacy) | 纯正则 + 自写引号感知 tokenizer(`tokenizeShellWords`/`readShellWord`/`splitSegments`,`dangerousCommand.ts:2022-2162`),**无 AST 层**、无 too-complex 中间态 | intentional-delta(两边最终都不是"真 tree-sitter";cc 有 AST 中间表示+50ms/5万节点 DoS 防线,我们是纯正则/tokenizer 无对应 DoS 防线——若構造超长/超深嵌套命令字符串,我们的正则可能有 catastrophic backtracking 风险未经验证) | P2 | M(需 fuzz 验证 ReDoS 风险再定) |
| 33 | 读命令 PATH_EXTRACTORS——`cat/head/tail/ls`等简单命令 | `filterOutFlags`,正确处理 POSIX `--`(之后全当路径,防 `rm -- -/../.claude/...` 绕过)(`pathValidation.ts:126-139,272-298`) | `extractSimplePositionalPathArgs`,`SIMPLE_READ_PATH_COMMANDS` 覆盖同一组命令(`dangerousCommand.ts:3417-3421`),同样处理 `--` | aligned | — | — |
| 34 | 读命令 PATH_EXTRACTORS——`grep` | 吃参数 flag:`-e/--regexp,-f/--file,--exclude,--include,--exclude-dir,--include-dir,-m/--max-count,-A,-B,-C`;`-r/-R/--recursive` 无路径默认 `.`(`pathValidation.ts:313-341`) | `GREP_PATH_FLAGS_WITH_ARGS` 同一组 flag(`dangerousCommand.ts:3518-3522`),`extractGrepReadPathArgs`(`:3531-3535`) | aligned(逐条核对一致) | — | — |
| 35 | 读命令 PATH_EXTRACTORS——`rg` | 比 grep 多 `-t/--type,-T/--type-not,-g/--glob,--max-depth,-r/--replace`(`pathValidation.ts:343-369`) | `RG_PATH_FLAGS_WITH_ARGS` 同样多这5个(`dangerousCommand.ts:3523-3527`),独立于 grep 表(注释明确解释合并会导致 `-r` 语义冲突) | aligned | — | — |
| 36 | 读命令 PATH_EXTRACTORS——`sed -f`(脚本文件) | `-f`/`--file` 的下一参数当路径校验(`pathValidation.ts:397-404`) | `SED_PATH_FLAGS=Set(['-f','--file'])`,值 push 进 paths(`dangerousCommand.ts:278,3575-3580`),且有专门测试注释对比"与 grep -f 不同" | aligned | — | — |
| 37 | 读命令 PATH_EXTRACTORS——`git diff --no-index` | `--no-index` 后经 filterOutFlags 取前2个路径参数校验(`pathValidation.ts:491-508`) | `extractGitDiffNoIndexPaths`,同样跳过 flag、`--`后全当路径、最多取2个位置参数、专门表 `flagArgConsumesGitDiffValue` 跳过吃值的 flag(`dangerousCommand.ts:3242-3278`) | aligned | — | — |
| 38 | 读命令 PATH_EXTRACTORS——`find` | 全局flag不停止收集;`pathFlags`集合(`-newer*/-samefile/-path/-wholename/-ilname/-lname/-ipath/-iwholename`)吃值当路径;首个非全局flag后停止收集裸参数;`--`后保守全当路径;**无**对 `-exec`/`-delete` 的路径提取,靠独立正则拦截(`pathValidation.ts:211-269`,`READONLY_COMMAND_REGEXES`) | `extractFindReadPathArgs` 收集同一组吃值flag(`dangerousCommand.ts:3484-3511`);`-exec`/`-delete`走独立分类器 `classifyFindCommand`(`-delete`→destructive,`-exec/-execdir/-ok/-okdir`→outreach,`-fprint*`→file)(`:2216-2223`) | aligned(两边都是"路径提取"与"危险action"分离处理的设计,只是我们用分级分类器、cc用负向断言正则,效果等价) | — | — |
| 39 | `find` 只读判定用负向断言正则 vs 分类器 | `READONLY_COMMAND_REGEXES` 里 find 项:整条命令必须匹配"find+token串,任何token不能是 -delete/-exec/-execdir/-ok/-okdir/-fprint(0)?/-fls/-fprintf",允许转义括号分组(`readOnlyValidation.ts:1565-1569`) | `classifyFindCommand` 直接按 token 存在性分级(见#38),逻辑等价但实现形态不同(分类器 vs 单条大正则) | intentional-delta(等价实现,非缺口) | — | — |
| 40 | `jq` flag guard | `system()`调用、`-f/--from-file/--rawfile/--slurpfile/-L/--library-path` → ask;文件参数本身放行交路径校验(`bashSecurity.ts:742-780`) | `classifyJqCommand`:`system()`、`env`/`$ENV`、`-f/--from-file/--rawfile/--slurpfile/--run-tests/-L/--library-path` → outreach(`dangerousCommand.ts:2225-2246`) | aligned(我们多判了 `env`/`$ENV`/`--run-tests`,是加固不是缺口) | — | — |
| 41 | UNC 路径拦截 | `containsVulnerableUncPath`,**仅 Windows 平台**(`getPlatform()!=='windows'`直接false),8层检测(反斜杠UNC/正斜杠UNC排除URL/混合分隔符/WebDAV SSL端口/DavWWWRoot/IPv4/IPv6显式UNC),3处独立调用点(`isCommandReadOnly`/`checkReadOnlyConstraints`/`validatePath`)· `utils/shell/readOnlyCommandValidation.ts:1561-1637` | `isVulnerableUncPath`,**仅 win32**(`platform!=='win32'`直接false),4条核心正则(反斜杠UNC/正斜杠UNC排除URL/混合分隔符两方向)覆盖 cc 前4层,**未覆盖** WebDAV SSL/端口模式、`DavWWWRoot`、显式IPv4/IPv6 UNC 这4层子模式 · `workspace/pathValidation.ts:11-18,42-46,73-90` | **gap**(部分对齐,少4条子模式;权威实现单一化这点是对的,已有专门回归测试锁住"UNC正则不留在dangerousCommand.ts里"这个架构决策) | P2 | S |
| 42 | UNC 附加防线:Windows 剔除 `xargs`(防UNC藏在文件内容里绕过命令行正则) | `getCommandAllowlist()` Windows平台整体剔除 `xargs`(`readOnlyValidation.ts:1201-1215`) | 未发现对应处理(`dangerousCommand.ts` 未见 xargs 平台专项剔除逻辑) | **gap** | P2 | S |
| 43 | Windows/PowerShell 支持形态 | 独立 `PowerShellTool`,**仅 win32 平台**注册(`isPowerShellToolEnabled()`先判 `getPlatform()!=='windows'`直接false)· `utils/shell/shellToolUtils.ts:17-22`;**外部(非ant)用户默认关闭**,需显式设 `CLAUDE_CODE_USE_POWERSHELL_TOOL=true` 才开;`BashTool` 本身在 Windows 上走 Git Bash/WSL 类 POSIX shell 层,不直接 spawn cmd/powershell | 独立 `powerShellTool`(注册名 `PowerShell`),**无任何平台判断,在 `buildGeneralRegistry` 里无条件注册**(`generalTools.ts:7,77`,已核实全文件无 `isEnabled`/`platform` 前置门),macOS/Linux 用户工具列表里也会看到这个工具,调用后走 `findPowerShellExecutable()` 探测 `pwsh/powershell`(`powerShellTool.ts:316-320`) | **gap**(平台门缺失——cc 对外部用户默认关、且严格限 Windows;我们既不限平台也不限默认开关,虽非安全洞但是明确的行为不对齐,且与本仓库 `dangerousCommand.test.ts` 注释"唯一发版平台是Windows"的产品前提也不一致——非Win平台注册这个工具是纯噪音) | P1 | S(加一行平台判断即可) |
| 44 | `run_command` 本身在 Windows 上路由 | 无(cc 的 BashTool 走 POSIX shell 兼容层,不检测切换到 cmd/powershell) | `isWin` 二元判断,win32 恒定 `spawn('cmd', ['/c', command])`,非win32恒定 `spawn('sh', ['-c', command])`(`runCommandTool.ts:157-165`),**无** pwsh/powershell.exe 自动探测切换 | intentional-delta(架构选择不同:cc是"Windows也用POSIX兼容shell、PowerShell是可选叠加工具";我们是"Windows直接cmd、PowerShell也是叠加工具"——两边思路相似,均属合理设计,非缺口) | — | — |
| 45 | 环境变量清洗(密钥/网关key不传入子进程) | 未在本轮读到 cc 侧对应机制细节(未展开 `childEnv`/env 白名单逻辑) | 有专项测试"strips model and gateway secrets from child environment"(`runCommandTool.test.ts`) | 我们侧**多做**(未核实cc是否也做,标记待核) | P2 | S(核实) |
| 46 | 沙箱包裹(OS级隔离)与命令安全校验的关系 | 并行独立两套机制:`shouldUseSandbox`只决定"要不要用OS沙箱包裹执行",跟 `bashSecurity.ts`/`bashPermissions.ts` 静态命令分析完全解耦;结合点仅在 `isAutoAllowBashIfSandboxedEnabled` 时跳过弹窗(`shouldUseSandbox.ts:130-153`,`bashPermissions.ts:1831-1843`) | `ctx.sandbox.wrapCommand` 在 execute 阶段包裹 argv(`runCommandTool.ts:89`),`isOsSandboxActive()` 状态只影响 `shellSandboxedGitCwdNeedsApproval` 这一处审批分类(`runCommandTool.ts:100-104`) | aligned(设计思路一致:沙箱是执行期隔离,权限判定是执行前静态分析,两者解耦) | — | — |
| 47 | 沙箱默认开关 | 未在本轮核实 cc 默认值(未读 `SandboxManager.isSandboxingEnabled()` 默认配置) | `Sandbox` 类默认 `enabled:false`(opt-in)· `sandbox.ts:24` | 未核实(标记待核,产品边界项——本仓库沙箱本就属"范围外/W3b"独立施工线,memory索引显示Windows沙箱是JobObject占位状态) | — | — |
| 48 | 不完整命令片段检测(以tab/flag/操作符开头) | `validateIncompleteCommands`:trim后以tab开头/以`-`开头/以`&&\|\|;><`开头 → ask(`bashSecurity.ts:244-286`) | `hasIncompleteShellFragmentRisk`(`dangerousCommand.ts:1325`,函数存在,主代理未逐条比对三个子分支正则是否完全一致,标记待核) | 未核实(函数存在,细节待核) | P2 | S(细读复核) |
| 49 | 花括号展开(brace expansion)风险检测 | `validateBraceExpansion`:反引号计数不匹配/引号包裹单花括号/深度匹配扫描含`,`或`..`(`bashSecurity.ts:1751-1892`) | `hasBraceExpansionRisk`(`dangerousCommand.ts:1858`,函数存在) | 未核实细节(函数存在,标记待核) | P2 | S(细读复核) |
| 50 | Zsh 特殊危险命令(`zmodload`/`emulate`/`zpty`等18个) | `ZSH_DANGEROUS_COMMANDS` 18项集合(`bashSecurity.ts:45-74`) | `ZSH_DANGEROUS_COMMANDS` 同名集合(`dangerousCommand.ts:166-185`),`hasZshDangerousCommand`(`:1897-1909`),主代理确认覆盖同一组18个命令+`command`/`builtin`/`noglob`/`nocorrect`修饰词剥离+`fc -e`判定 | aligned | — | — |
| 51 | 混淆flag检测(ANSI-C引号/locale引号/空引号拼接/多重引号) | 多层检测(`validateObfuscatedFlags`,`bashSecurity.ts:1130-1537`,约400行,7+子模式) | `hasObfuscatedFlagRisk`(`dangerousCommand.ts:1584`,函数存在) | 未核实细节完整度(函数存在,标记待核——cc这块是全文件里最复杂的单个validator,值得单独一轮细读) | P1 | M(细读复核,复杂度高误判/漏判风险都大) |

---

## 二、已知待办核对结果(逐条)

**1. P6 行为对齐:默认timeout、输出截断阈值与文案、错误返回格式、退出码语义——同输入是否同结构输出**

**仍缺 / 部分对齐,非同输入同输出。** 具体:
- 默认 timeout:cc=120,000ms,我们=30,000ms——**不一致**(见发现表#1)。同一条不带 `timeout_ms` 的慢命令,cc 等2分钟才判超时,我们30秒就杀。
- 最大 timeout:两边都是600,000ms,数值巧合一致,但 cc 支持 `BASH_MAX_TIMEOUT_MS` 环境变量覆盖、我们是硬编码常量,机制不同(见#2)。
- 输出截断阈值:cc默认30,000字符/硬顶150,000字符(字符数),我们默认64,000字节/硬顶1,000,000字节(字节数)——**单位与数值都不一致**(见#3/#4)。同一段命令输出,截断点完全不同。
- 截断文案:两边都保尾部但措辞不同(英文 vs 中文,见#7),语义等价但**不是同结构输出**(cc格式`[N lines truncated]`按行数,我们按字节数)。
- 错误返回格式:cc的"BashTool.tsx"退出码语义有专门 `commandSemantics.ts` 映射表,我们同名文件同一组豁免命令(grep/rg/find/diff/test/[)且逻辑镜像,这条**基本对齐**(见#8)。但 command-not-found/权限拒绝这类 spawn 级错误,我们统一走 `child.on('error')` 吐一句纯文本(`runCommandTool.ts:195-197`),未做结构化字段区分,cc侧本轮未细读spawn错误处理是否有更细分类,标记待后续核实。
- **结论:P6"同输入同结构输出"这条硬闸目前不达标**,timeout默认值、输出截断阈值/单位都是硬性数值分叉,不是文案措辞层面的小事——同一条命令在两边会跑出不同的截断结果和不同的超时时机。

**2. PowerShell 支持与 OS 沙箱接线**

**部分做了,但平台门缺失(gap,见#43)。** 我们有独立 `powerShellTool.ts`(明确标注"Ported from CC-Haha PowerShellTool"),接口/风险分类/destructive警告表跟着抄了,这部分做得对。**但缺了 cc 最关键的一道门:平台判断。** cc 的 `isPowerShellToolEnabled()` 先判断 `getPlatform()!=='windows'` 直接返回 false,只有 Windows 平台才可能启用;我们的 `buildGeneralRegistry` 无条件注册这个工具,macOS/Linux 用户的工具列表里也会看到"PowerShell"这个工具,调用时才会去 `findPowerShellExecutable()` 找不到可执行文件而失败。这不是安全洞,但是明确的行为不对齐,且修复成本很低(加一行 `process.platform === 'win32'` 判断)。
沙箱接线本身(`shouldUseSandbox`思路 vs `ctx.sandbox.wrapCommand`)设计思路对齐(见#46),但 Windows 原生沙箱(JobObject)按 memory 索引是"W3b 占位"状态,本轮未重新核实是否已推进,不在本次审计范围内(沙箱模块归属另一个 W3/W3b 专项)。

**3. UNC 路径拦截**

**部分对齐,权威实现单一化正确,但检测模式少4条(gap,见#41/#42)。** 好消息:架构决策是对的——UNC判定被收敛到 `workspace/pathValidation.ts` 单一权威实现,`dangerousCommand.test.ts` 里有专门回归测试锁住"命令内UNC正则已删、不能在dangerousCommand.ts又加回一份"这个决策,防止两处实现漂移,这个纪律性做得比很多地方都好。**但覆盖的正则模式比cc少**:cc有8层检测(反斜杠UNC/正斜杠UNC/混合分隔符×2方向/WebDAV SSL端口模式/DavWWWRoot标记/IPv4显式UNC/IPv6显式UNC),我们只做了前4层(反斜杠UNC/正斜杠UNC/混合分隔符×2方向),**WebDAV SSL/端口伪装、DavWWWRoot重定向标记、显式IP形式UNC这3类攻击面没覆盖**。另外cc有"Windows平台整体剔除xargs工具"这道附加防线(防UNC路径藏在文件内容而非命令行里绕过正则检测),我们没有对应处理。两条都是P2小修复。

**4. 读命令路径工作区边界(据称 9a83ac8 已做)——核实与 cc PATH_EXTRACTORS 逐命令等价**

**基本属实,逐命令核对下来质量相当高。** 主代理逐条核对了 cat/head/tail等简单命令、grep、rg、sed -f、git diff --no-index、find 六大类(见#33-38),**flag表覆盖基本与cc逐字符一致**,包括容易漏的细节都做对了:
- POSIX `--` 处理正确(之后全当路径,防`rm -- -/../.claude/...`绕过)
- grep 和 rg 用**两份独立的flag表**而非合并表(cc这么做是为了防止grep的`-r`(recursive,不吃参数)和rg的`-r`(replace,吃参数)语义冲突导致误吞路径参数——我们同样分开了两份表,说明理解了cc这么设计的原因,不是照抄字面)
- sed -f 的脚本文件正确计入路径(区别于grep -f的模式文件不计入),两边逻辑一致且都有专门测试/注释强调这个"反直觉"点
- git diff --no-index 的"最多取2个路径参数+跳过吃值flag"逻辑一致
- find 的"路径提取"与"危险action(-exec/-delete)"分离处理的设计思路一致,只是实现形态不同(cc用一条大的负向断言正则,我们用显式分类器`classifyFindCommand`)——效果等价,不算缺口

**未逐字符比对的边角**:grep/rg 少见flag(`--exclude-from`/`-D/--devices`/`-d/--directories`)不在两份path-flags表里,会被当路径token误收——这是"多提"不是"漏提",偏保守方向的误差,风险可接受。

**5. Bash 子命令上限/substitution风险分类/重定向路径护栏/find只读守卫/jq flag guard/bare-repo git安全门(矩阵§4声称已落)——抽查5条**

抽查结果(逐条):
- **子命令上限**:**未落地**(gap,见#20)。cc有`MAX_SUBCOMMANDS_FOR_SECURITY_CHECK=50`防CPU卡死(修复真实历史bug CC-643),我们的`classifyCommandRisk`对任意长度的`&&`链都逐段处理,无上限。这是矩阵文档"声称已落"里**没有兑现**的一条,应予纠正。
- **substitution风险分类**:**判定粒度已对齐**(aligned,见#26)——两边都是"二元AST/正则判定,命中即统一升级,不做风险分级",不是"声称的分级没做出来"的情况,而是cc本身就没做分级,我们的判定方式(不分级)反而是对的。
- **重定向路径护栏**:**已落地**(aligned)——`shellOutputRedirectionNeedsApproval`/`redirectionTargetNeedsApproval`(`dangerousCommand.ts:3901-3906,4095-4100`)判越出workspace root、含展开语法(`$%*?[]{}=~`)、含cd都要审批,逻辑跟cc的`validateRedirections`思路一致(cc是"见`<`/`>`就ask"的更粗粒度硬闸,我们是"越界才ask"的更细粒度——这是**我们比cc更宽松**的一处,cc对所有input/output redirection一律ask不管目标在哪,我们只在目标越界/含展开语法时ask,workspace内的普通重定向直接放行。这是一处**值得留意的行为分叉**,不在原发现表单独列,但影响面是"我们对`echo x > workspace内文件`更宽松",建议下一轮细读时补一条,目前先记录在此)。
- **find只读守卫**:**已落地**(aligned,见#38/#39)——`-exec/-delete`等危险action有独立分类器覆盖,判定效果与cc等价。
- **jq flag guard**:**已落地**(aligned,见#40)——覆盖`system()`、`-f/--from-file/--rawfile/--slurpfile/-L/--library-path`,我们还多判了`env`/`$ENV`/`--run-tests`,是加固。
- **bare-repo git安全门**:**已落地**(aligned,见#22-24)——目录状态检测(非参数字符串匹配)+cd&git复合闸+git内部路径写入防护三件套都对齐了cc的设计原理。

**小结:5条抽查里4条属实已落地且质量不错,1条(子命令上限)矩阵文档声称但实际未做,需要更正记录或补上实现。**

**6. cc完整tree-sitter安全分析器 vs 我们正则/AST方案的判定差异**

**关键反转发现:cc本身也不是真tree-sitter。** 主代理深挖后发现,cc代码里到处叫"tree-sitter"(变量名、日志文案),但运行时实际调用的是`utils/bash/bashParser.ts`——一个纯TypeScript手写的递归下降解析器,自称"产出tree-sitter-bash兼容的AST,用3449条真实tree-sitter WASM解析器生成的黄金语料验证过",但**运行时完全不加载任何原生tree-sitter依赖**,初始化是空操作。所以"cc有AST、我们没有"这个认知本身需要修正——cc有的是"一个不依赖外部parser库、自证语法兼容的手写解析器+50ms/5万节点DoS超时防线",不是真正调用C原生tree-sitter库。

**真实差异**:
- cc:有独立AST中间表示层,超时(50ms)/超节点数(50,000)会**fail-closed**成`too-complex`直接ask,不退回legacy正则(这个fail-closed纪律是从真实bug修复来的——早期曾经把超时panic当`parse-unavailable`退回legacy,导致legacy路径漏检`trap`/`enable`/`hash`这类危险内建命令)。
- 我们:纯正则+自写引号感知tokenizer(`tokenizeShellWords`/`splitSegments`),**没有AST中间态**,也就没有"too-complex直接拒绝"这个中间档位——我们要么正则命中判危险,要么放行,没有cc那种"太复杂看不懂就统一保守拒绝"的第三态。

**刁钻例逐条核实**:
- 命令注释引号脱同步(`# ' " <<'MARKER'`场景):**两边都有对应检测**——cc是`validateCommentQuoteDesync`(`bashSecurity.ts:1990-2074`),我们是`hasCommentQuoteDesyncRisk`(`dangerousCommand.ts:1806-1856`),函数存在且已被主代理确认接入`hasShellParserRisk`主链条(`:1210`)。
- 不完整片段(`-rf /tmp`裸参数注入等):cc有`validateIncompleteCommands`三分支(tab开头/flag开头/操作符开头),我们有`hasIncompleteShellFragmentRisk`(`:1325`),函数存在但**逐条子分支正则未做字符级核对**(标记#48待核)。
- `cd x && git ...`:见#22,已对齐,cc把这类复合命令的裸仓库风险放在"逐子命令判断之前"以保留上下文,我们通过`splitSegments`+`isCdLikeCommand`+`isGitLikeCommand`的组合判定也是同样思路(检测跨segment的cd+git共现,不是逐段独立判断)。

**结论**:判定方式上我们和cc"实际实现"(都是手写解析,非真原生tree-sitter)比想象中更接近,主要差距是cc有正式的AST中间层+DoS超时防线+`too-complex`第三态,我们是纯正则+无这条防线。这不是"抄漏了功能",而是架构层面的简化,**主要风险点是ReDoS(catastrophic backtracking)未经验证**(见#32),建议后续做一轮fuzz测试。

**7. shell会话/工作目录跨调用保持:cc行为 vs 我们**

**明确的架构性差异(deviation,见#18)。** cc:`getCwd()/setCwd()`是模块级全局共享状态,`cd /tmp`之后下一次`run_command`调用(不传cwd参数时)会记得在`/tmp`;但每次执行完会检查是否需要"归位"(要么强制配置`shouldMaintainProjectWorkingDir()`每次都归位,要么cwd被cd挪到工作区允许边界之外时自动弹回),归位时会在stderr追加提示"Shell cwd was reset to..."。子代理执行时(`preventCwdChanges=true`)完全不许改变全局cwd,防止污染主线程状态。

我们:**完全无状态**。每次`execute`都是全新`spawn(...)`,`cwd`只在本次调用范围内生效,不传`cwd`参数就默认回退到`ctx.workspace.root`——不存在"上一次cd去哪、这一次记不记得"的问题,因为压根没有这个概念。

**这是一处真实的行为不对齐**,同样的多轮对话"先cd进某目录、再跑相对路径命令"这个使用模式,在cc上能工作(cwd被记住),在我们这里**每次都要模型显式传cwd参数**,否则会以为还在workspace root。是否要补齐取决于产品设计选择——如果模型侧的prompt/工具描述已经教会模型"每次显式传cwd"这个心智模型且实测没出问题,可以判定为intentional-delta;如果没有明确文档化这个差异、纯粹是没做,则应算gap。**建议:至少在`runCommandTool.ts`的工具description里显式声明"不保留cwd状态、每次需要显式传参"，避免模型侧按cc训练出的直觉去调用而出错。**目前工具description里写的是"cwd may be workspace-relative or an allowed absolute path"，没有说明"不持久化"这个关键差异，是一个文档/prompt层面可以低成本补的点。

---

## 三、分类计数

| 分类 | 计数 |
|---|---|
| aligned | 22 |
| gap | 8(#6写盘预览缺失、#13手动转后台缺失、#20子命令上限缺失、#21多cd检测缺失、#41 UNC模式少4层、#42 xargs平台剔除缺失、#43 PowerShell平台门缺失、且P6整体timeout/截断阈值不对齐) |
| deviation | 4(#1默认timeout、#3输出截断阈值、#4截断硬顶、#18 cwd持久化) |
| intentional-delta | 7(#11 run_in_background参数形态、#12/#14/#15/#19/#25/#39/#44 等架构选择不同但效果等价或范围外) |
| 未核实(待细读) | 9(#9/#10相关退出码细节、#27/#29 heredoc与git commit极端case、#45 env清洗、#47沙箱默认值、#48不完整片段子分支、#49花括号展开细节、#51混淆flag检测完整度) |

---

## 四、P0/P1 top5 gap 摘要

1. **P1 #1 默认timeout不一致**:cc默认2分钟,我们默认30秒——同一条慢命令两边超时时机差4倍,直接影响"同输入同输出"硬闸。
2. **P1 #3/#4 输出截断阈值/单位不一致**:cc按字符数(默认3万/硬顶15万),我们按字节数(默认6.4万/硬顶100万)——同一段输出截断点完全不同,且cc超限会整份写盘+预览给模型用Read工具取全量,我们直接丢弃截断部分(#6,P1)。
3. **P1 #18 cwd不跨调用持久化**:cc的`cd`之后下次调用记得当前目录,我们每次全新spawn、不传cwd就回workspace root——这是架构性差异,影响"先cd再跑相对路径命令"这类多轮交互模式,且工具description没写明这个差异,建议至少补文档。
4. **P1 #43 PowerShell工具无平台门**:cc只在Windows注册且外部用户默认关闭,我们在所有平台无条件注册,macOS/Linux用户工具列表里会看到一个必然失败的PowerShell工具——修复成本很低(加一行平台判断)。
5. **P1 #51 混淆flag检测完整度未核实**:cc这块是安全校验里最复杂的单个validator(约400行、7+层子模式,覆盖ANSI-C引号/locale引号/空引号拼接绕过等),我们有对应函数但本轮未逐层核对完整度,鉴于复杂度和历史踩坑记录(cc代码注释显示这块修过多次真实漏洞),建议列为下一轮细读优先项。

补充:矩阵文档§4声称"子命令上限已落"但实际抽查未找到对应实现(#20,P2但需先更正文档记录避免误导后续判断)。
