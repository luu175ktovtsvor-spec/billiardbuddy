# 审计 04:工作区/沙箱/路径护栏 —— cc-haha 对齐差异(只读)

> 规格源:`~/Desktop/cc-haha-ref`(当前源码,含其 vendored `@anthropic-ai/sandbox-runtime@0.0.44`)。
> 现状:`/Users/swl/Desktop/球房运营AI助手-桌面版/ts`(工作树现状,含未提交改动;vendored `@anthropic-ai/sandbox-runtime@0.0.63`)。
> 方法:两边源码亲读(非文档),含 npm 依赖包本体(README + dist/.d.ts)核实底层库真实语义。

## 发现表

| # | 行为点 | cc + file:line | 我们 + file:line(或"缺") | 分类 | P | S/M/L |
|---|---|---|---|---|---|---|
| 1 | OS 沙箱生产接线(server 入口真的构造 Sandbox 注入 ctx) | `src/cli/print.ts:619-627`、`src/screens/REPL.tsx:2334-2338` | `ts/src/server/index.ts:974-976`(`buildSandbox`)+ 用于 `runAgentLoop`(:1953)与 `runApprovedTool`(:2364) | aligned(且已确认落地) | — | — |
| 2 | 沙箱默认开关 | cc **默认 off**:`isSandboxingEnabled()`→`getSandboxEnabledSetting() = settings?.sandbox?.enabled ?? false`(`src/utils/sandbox/sandbox-adapter.ts:459-467`),需用户在 settings.json 显式 `sandbox.enabled:true` | 我们**默认 on**:`sandboxEnabled = opts.sandboxEnabled ?? (env.QF_OS_SANDBOX !== '0')`(`ts/src/server/index.ts:975`,注释标注"owner 2026-07-09") | intentional-delta(已拍板加固,非漏抄) | 记录 | — |
| 3 | 降级路径 try/catch 覆盖 | `wrapWithSandbox` 内部捕获,`initialize()` 失败也吞掉(`sandbox-adapter.ts:782-788`) | `Sandbox.wrapCommand()` 把 `ensureInitialized`+`wrapArgv` 一并包在 try/catch,失败置 `degraded=true` 返回 null,绝不阻断命令(`ts/src/sandbox/sandbox.ts:34-45`) | aligned | — | — |
| 4 | 工作区主边界 symlink 解析(区内 symlink 指向区外) | `getPathsForPermissionCheck`(`src/utils/fsOperations.ts:288-382`,收集 original+symlink链+realpath 全部落点)+ `isPathAllowed`(`src/utils/permissions/pathValidation.ts:141-267`) | `Workspace.resolve()` 先字符串边界(`pathBoundary.ts`)、再 `pathContainedInRoots(target,[root])`(`ts/src/workspace/symlinkResolve.ts:99-103`,同款"原路径+symlink链+realpath"算法);测试:`workspace.test.ts:23-45`(区内 symlink 指区外→拒,区内→放行) | aligned | — | — |
| 5 | 网络围栏语义(库本体) | 库文档:allow-only、**默认全部拒绝**;未匹配 allow/deny 的 host **落到 `SandboxAskCallback`,无回调则拒**(`node_modules/@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-schemas.d.ts:60-80`)。cc 的回调 = 真实审批请求:REPL 走 UI 弹窗、print/SDK 走 `can_use_tool` 协议问宿主"Allow network connection to X?"(`src/cli/structuredIO.ts:735-757`) | `askCallback` 硬编码 `async()=>true`(`ts/src/sandbox/osSandbox.ts:43`),`allowedDomains:[]/deniedDomains:[]`(`ts/src/sandbox/osSandbox.ts:25`)——两者叠加 = **任意域名一律放行**,不是"没做网络围栏"而是**主动短路库自带的默认拒绝**,且没有任何审批介入 | deviation(比"未实现"更进一步的主动放行;已知晓但语义比自认的"网络放行"更彻底——完全无 ask 环节) | P2 | S(把 askCallback 从"恒 true"改成"恒 false"/或对齐真实 ask 即可,W4 范围) |
| 6 | Windows/PowerShell 沙箱现状 | cc 应用代码明确**不用**库的新版 alpha Windows 支持:"On Windows native, sandbox is unavailable (bwrap/sandbox-exec are POSIX-only)"(`src/tools/PowerShellTool/PowerShellTool.tsx:207-221`);仅当 `sandbox.enabled && !allowUnsandboxedCommands` 时**硬拒绝执行**(`WINDOWS_SANDBOX_POLICY_REFUSAL`,同文件 :219) | Windows 无 OS 级沙箱,靠应用层护栏(`ts/src/sandbox/windowsLauncher.ts` 占位恒返回 null);`isOsSandboxSupported` 硬编码排除 win32(`ts/src/sandbox/osSandbox.ts:30-33`) | aligned(结果等价:两边 Windows 都无真沙箱、都退化到应用层护栏) | — | — |
| 6a | ↳ "沙箱必需但不可用→硬拒绝"策略 | 有:`isWindowsSandboxPolicyViolation()` + `WINDOWS_SANDBOX_POLICY_REFUSAL`(同上) | 缺:我们没有 `failIfUnavailable`/"required" 概念,`grep failIfUnavailable\|isSandboxRequired` 全仓零命中 | gap(次要,无托管策略场景用不上,但概念缺失) | P2 | S |
| 7 | additional-directories → OS 沙箱 allowWrite 联动 | `convertToSandboxRuntimeConfig` 显式把 `additionalDirs`(`--add-dir`/`/add-dir` 持久化 + CLAUDE.md 派生)塞进 `allowWrite`,注释写明理由:"Bash commands run inside the sandbox need this, not just file tools which check at app level"(`src/utils/sandbox/sandbox-adapter.ts:290-299`) | **缺**:`Sandbox.wrapCommand()` 只用 `writablePaths:[this.workspace.root]` 建 OS 沙箱配置(`ts/src/sandbox/sandbox.ts:38`),从不读 `ctx.additionalWorkingDirectories`(`ts/src/permissions/permissionUpdate.ts:61-67` 的 `addDirectories` 结果)也不读 `Workspace` 私有的 `allowedPaths`(`ts/src/workspace/workspace.ts:22`,无 getter 暴露) | gap(真实功能缺口,非纯理论) | **P1** | S-M |
| 8 | OS 沙箱层 denyWrite(防沙箱内进程自改配置逃逸) | cc 显式拒写 settings.json(各 source)、`.claude/skills`、`.claude/commands`(库自带保护)、`.claude/agents`(库自带)、managed 配置目录、bare-git-repo 文件(`sandbox-adapter.ts:230-280`) | **缺**:`buildRuntimeConfig` 的 `denyWritePaths` 参数存在但调用方(`sandbox.ts:38`)从未传入,恒为 `[]`——OS 层对 `.billiardbuddy/settings.json`、hooks 配置、skills 目录**零保护**(app 层已有"未信任工作区丢弃 allow 规则"的信任闸作缓解,见 `permissionsSettings.ts:61`,故非唯一防线失守,但 OS 层这道防线确实没接) | gap(有 app 层兜底缓解,但 OS 层这层本该有的防线是空的) | P1 | S |
| 9 | `dangerouslyDisableSandbox` 逃生舱 / `excludedCommands` 白名单 | Bash/PowerShell 工具 inputSchema 含 `dangerouslyDisableSandbox`(受 `sandbox.allowUnsandboxedCommands` 策略约束),`shouldUseSandbox()` 判定逻辑(`src/tools/BashTool/shouldUseSandbox.ts:130-153`);另有 `sandbox.excludedCommands` 用户白名单(同文件 :52-58) | **缺**:`run_command` inputSchema 无此参数,全仓 `grep dangerouslyDisableSandbox\|excludedCommands` 零命中(`ts/src/tools/runCommandTool.ts:29-38`) | gap(功能/易用性缺口——OS 沙箱默认开且无逃生舱,合法需要网络/外部写的命令只能整进程级 `QF_OS_SANDBOX=0` 才能放行) | P2 | S |
| 10 | **full-disk-access 会话 × OS 沙箱默认开 的冲突**(不在原清单,审计中发现) | n/a(cc 无"全盘访问会话"这个我们自家产品概念) | `Workspace.fullDiskAccess`(`ts/src/server/index.ts:676`)只让**应用层** `resolve()` 放行工作区外路径(`ts/src/workspace/workspace.ts:38,45`),但 `buildSandbox()` 完全不知道这个标记(`server/index.ts:976`),OS 沙箱 `allowWrite` 依然只有 `workspace.root`——**全盘访问会话跑 `run_command` 写工作区外路径时,会被默认开启的 OS 沙箱在内核层拦下(EPERM)**,与该功能"desktop full-disk sessions can run from external directories"的文档承诺(`runCommandTool.ts:28`)矛盾 | gap(自产品自身定位冲突,非 cc 对齐问题,但根因与 #7 同源) | **P0**(功能性回归,文档承诺的能力在默认配置下静默失效) | S(fullDiskAccess=true 时把 Sandbox 也建成 disabled,或把额外可写根接进 allowWrite) |

## 已知待办核对结果

1. **OS 沙箱生产接线默认开** —— ✅**已做**。`ts/src/server/index.ts:975-976` 真构造 `Sandbox` 注入 `ctx.sandbox`(`:1953` 主循环、`:2364` 审批放行路径都过一遍);`QF_OS_SANDBOX=0` 或 `opts.sandboxEnabled=false` 关;降级 try/catch 全覆盖(`sandbox.ts:34-45`,涵盖 `ensureInitialized` 与 `wrapArgv` 两段,任何失败都置 `degraded` 回退明文,不阻断命令)。**新发现的副作用**:默认开与 `fullDiskAccess` 会话组合会破坏后者(见发现表 #10,P0)。

2. **工作区主边界 symlink 解析** —— ✅**已做**,与 cc 判定逻辑一致。`Workspace.resolve()`(`workspace.ts:33-48`)先字符串边界(`pathBoundary.ts`)再 symlink 落点核验(`symlinkResolve.ts::pathContainedInRoots`,算法与 cc `getPathsForPermissionCheck` 同构:原路径+symlink链每一跳+最终 realpath 全收集,任一跳落在 root 外都算逃逸)。测试覆盖区内→区外 symlink 拒绝、区内→区内 symlink 放行、fullDiskAccess 跳过该guard 三种场景(`workspace.test.ts:23-53`)。

3. **网络围栏策略** —— **确认差异,且比原认知更彻底**。cc 依赖库的 allow-only 默认拒绝 + 真实 ask 回调(REPL 弹窗/SDK `can_use_tool` 协议真问一次);我们的 `askCallback` 恒返回 `true`(`osSandbox.ts:43`),等价于**完全关闭网络围栏、不经任何审批**,而不是"文件围栏+网络放行"这种中性表述——是**主动覆盖库默认拒绝**成放行。之前的项目记忆把这描述为"选了文件围栏网络放行",属实但表述偏轻;建议后续窗口至少把 `askCallback` 改成恒 `false`(默认拒绝、留 W4 做真审批),现状对外部网络请求零拦截。

4. **PowerShell/Windows 侧沙箱** —— **两边等价**:cc 自己的应用代码也不用库新版 alpha Windows 沙箱(明确注释"Windows native sandbox unavailable"),两边 Windows 都是"OS 层无真沙箱、纯应用层护栏"。差一个次要点:cc 有"沙箱必需但不可用→硬拒绝执行"的策略闸(企业托管场景用),我们完全没有这个概念(非我们产品当前需要的场景,标 gap 但低优先级)。

5. **additional-directories / access-root 机制** —— **确认缺失,与自认一致**。cc 有两层:①`sandbox-adapter.ts` 把 `--add-dir`/CLAUDE.md 派生的 additionalDirectories 塞进 OS 沙箱 `allowWrite`(供 Bash 用);②`filesystemAccessRoots.ts` 的 `registerFilesystemAccessRoot`/`registerChangedFileAccessRoot`,供桌面 UI 预览"本轮改到工作区外的文件"、以及 rewind 时把这些额外根注册为可读根(`src/server/api/sessions.ts:389-391,801,956`)。我们只有 ①的应用层版本(`ctx.additionalWorkingDirectories`,见发现表 #7),且**这层还没接进 OS 沙箱**;②完全没有——`ts/docs/alignment-notes.md:114-117` 自认"若之前工具写文件写到会话工作区之外,`executeRewind` 构造的最小 ToolContext 没带这些授权,会对该路径抛越界错",与 cc 用 `registerChangedFileAccessRoot` 的解法直接对应。

6. **刁钻边界抽测** —— 六项全部亲验、两边判定一致或有对应机制:
   - `../escape` → 两边都拒(`pathBoundary.test.ts:23-24`、`workspace.test.ts` 对应用例;cc `pathValidation.ts` 同逻辑)。
   - `\\server\share` → 两边都识别为 UNC 需人工确认(cc `containsVulnerableUncPath`;我们 `pathValidation.ts:43-46` + 测试 `pathValidation.test.ts:28-37`)。
   - `~root/.ssh` → 两边都拒(cc `pathValidation.ts:398-415`;我们 `pathValidation.ts:85-87` + 测试 `pathValidation.test.ts:22-24,69-71`)。
   - 区内 symlink 链 → 两边都解析全链路 followed(见 #2)。
   - `/dev/stdin` → 两边在**读文件工具**层拦截(cc `FileReadTool.ts:97-129` 的 `BLOCKED_DEVICE_PATHS`;我们 `ts/src/tools/fileIoSafety.ts:15-44` 逐字对齐移植,含注释标明来源行号),这是文件读工具子系统而非 workspace/sandbox 核心,但确认存在且行为一致。

## 分类计数

- aligned:5(#1 生产接线、#3 降级 try/catch、#4 symlink 解析、#6 Windows 现状对等、#6 刁钻边界 5/6 项)
- gap:5(#6a Windows 策略闸缺失、#7 additional-dirs 未联动 OS 沙箱、#8 OS 层 denyWrite 未接、#9 无逃生舱、#10 fullDiskAccess 冲突)
- deviation:1(#5 网络围栏——主动短路库默认拒绝)
- intentional-delta:1(#2 沙箱默认开关,已拍板加固)
- 范围外/不算:0(本次未触及 CLI/TUI/vim/IDE/SSH/遥测)

## P0/P1 Top5(按严重度)

1. **P0 · #10 fullDiskAccess 会话被默认开的 OS 沙箱静默拦写**——"全盘访问"这个已文档化承诺的能力,在默认配置(`QF_OS_SANDBOX` 未设即为开)下对 `run_command`/`background_command` 写工作区外路径会被内核 EPERM,功能性回归,修复成本低(S)。
2. **P1 · #7 additionalWorkingDirectories 未接入 OS 沙箱 allowWrite**——app 层已放行的额外目录(如 `agentMemory.ts` 的 memory 目录、`/add-dir` 等价物),shell 命令写入时仍会被 OS 沙箱拦,cc 有明确对应处理我们没抄。
3. **P1 · #8 OS 沙箱层 denyWrite 从未populated**——`.billiardbuddy/settings.json`/hooks/skills 在 OS 沙箱层零保护(app 层信任闸有部分缓解,非唯一防线失守但确实少一层)。
4. **P1(标为 gap,已知)· #5 网络围栏完全放行且无审批**——不算不知情的缺口,但当前状态是"主动关闭"而非"暂未实现",建议至少把默认改回库原生的拒绝语义。
5. **P2 · #9 无 dangerouslyDisableSandbox/excludedCommands 逃生舱**——OS 沙箱默认开又没有单命令级豁免,合法需要外部写/网络的命令目前只能整进程关沙箱,体验缺口。
