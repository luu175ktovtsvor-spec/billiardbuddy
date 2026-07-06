# W3 · Harness 沙箱(双层)findings（2026-07-06 · macOS arm64 · Bun 1.3.14）

> 双层沙箱：应用层 TOCTOU 护栏(跨平台) + Mac/Linux OS 真沙箱(接 `@anthropic-ai/sandbox-runtime`)。照 cc-haha 重写、借其安全正则进我们自己的文件。
> 全量 `bun test` = **75 pass / 0 fail / 144 expect / 15 files**；`tsc --noEmit` = exit 0；`bun run smoke:sandbox`(mac 真起 sandbox-exec)= 工作区内写✓ / 工作区外写被拒✓。
> 分步计划：`docs/plans/TS-W3-Harness沙箱-实现计划-2026-07-06.md`（8 任务 · subagent-driven · 每任务先测后码 + 独立子代理评审）。owner 拍板 **W3 拆半窗**（本窗 Mac 全可测；Windows 原生 Job Object helper.exe = W3b）。

## 建了什么（新增/改动文件）
| 层 | 文件 | 职责 |
|---|---|---|
| 应用层 | `src/workspace/pathValidation.ts`(新) | `validatePath` TOCTOU 护栏：expandTilde / UNC(4 正则,win) / `~user` 变体拒 / `$``%``=` 展开拒 / 写操作禁 glob；`isDangerousRemovalPath`(删根/盘符/home);`PathValidationError`;`FileOperation` |
| 应用层 | `src/workspace/workspace.ts`(改) | `resolve(requested, operation='read')` 改经 `validatePath`(默认 read 保后向兼容);backup 红线不动 |
| 应用层 | `src/tools/{fileRead,fileWrite,listDir}Tool.ts`(改) | 传 operation(read/read/write)→ 写操作走护栏(拒 glob/$展开) |
| 命令红线 | `src/tools/dangerousCommand.ts`(改) | 补 `rm *`/`rm /*`、盘符根 `rm C:\`;给 W3 通配 + W2 两条 rm-root 补 `/i`(catch `rm -RF`)。命令内 UNC **删掉**(过挡良性、交 W4) |
| OS 沙箱 | `src/sandbox/osSandbox.ts`(新) | 包 `@anthropic-ai/sandbox-runtime`:`buildRuntimeConfig`(工作区写围栏)/`isOsSandboxSupported`/`ensureInitialized`(askCallback 放行)/`wrapArgv` |
| 分派门面 | `src/sandbox/sandbox.ts`(新) | `Sandbox`:平台分派 `wrapCommand → {argv,env} | null`(null=明文 spawn)+ `describeForPrompt`(沙箱状态给模型) |
| Windows | `src/sandbox/windowsLauncher.ts`(新) | Job Object 接口占位:W3 回退明文 + DESKTOP_DEBUG 日志;**W3b 接入点** |
| 接线 | `src/tools/Tool.ts`(改) | `ToolContext.sandbox?`(可选) |
| 接线 | `src/tools/runCommandTool.ts`(改) | `ctx.sandbox?.wrapCommand()` 包裹后 spawn(返 null 走原 W2 明文);timeout/signal/退出码 一个共享块管两分支 |
| 接线 | `src/tools/generalTools.ts`(改) | `buildGeneralRegistry(opts?:{sandbox?})` → run_command 描述拼 `describeForPrompt()`(spread 不改单例) |
| 接线 | `src/harness/loop.ts`(改) | `RunAgentLoopOptions.sandbox?` → 透传 ctx |
| smoke | `scripts/smoke/sandbox.smoke.ts`(新) + `package.json`(smoke:sandbox) | mac 真起沙箱验写围栏(不进 bun test,保 CI 跨平台绿) |
| 依赖 | `@anthropic-ai/sandbox-runtime@^0.0.63` | §1 铁律预授权的唯一公开包例外;**Bun 1.3.14 下能 import,无需退 srt CLI** |

## 关键决策（记给后窗,别重新纠结）
1. **抄码口径已定死(owner 2026-07-06)**:借 cc-haha 的正则/命名/写法/结构进我们自己的文件 = OK(功能性代码随便抄,§9「写法照它」);唯一红线 = 别把它整份 `.ts` 源文件原样当产品发。ts/CLAUDE.md 铁律1 已对齐主文档 §1 铁律2。**W4/W5 别再为这个停下来问。**
2. **⚠️ 行为对齐(owner 唯一较真·全 harness 窗通用)**:照 cc-haha 写的确定性逻辑(路径校验/沙箱/危险命令)必须「同输入→同决策」——验收拿刁钻边界(`../escape`/`\\server\share`/`~root/.ssh`/`rm -rf *`)断言判得跟 cc-haha 一模一样,别只测自己想到的用例。Task 3 评审正是靠这条逮出并修掉 2 个真 bug(见下)。
3. **OS 沙箱 = opt-in(默认 enabled=false)**(照 cc-haha `sandbox.enabled` 默认关)。W3 只证明「启用时写围栏真生效」;**「默认开 / 按命令决定要不要沙箱(shouldUseSandbox) / 工作区内自动放行不弹确认」= W4**(§5:有了 OS 沙箱才敢自动放行,而自动放行绑审批=W4)。
4. **W3 沙箱只做文件系统写围栏、网络故意放行**。sandbox-runtime 网络是 allow-only、空 allowedDomains = **断网**(会掐 npm/git/curl)。W3 种子 `allowWrite=[工作区]` + `askCallback: async () => true` 放行网络。**⚠️ 网络未围栏——别以为也关了;网络策略(白名单/审批)= W4。** smoke 只验文件写围栏。
5. **wrapArgv 不走二次 shell**:用 `wrapWithSandboxArgv` 返回 `{argv,env}` 直接 spawn(sandbox-exec 内部自带 shell);未包裹才走 `sh -c`/`cmd /c`。
6. **删根检测 `isDangerousRemovalPath` 本窗只定义、未接线**(路径校验用不到它;命令级删根靠 `dangerousCommand` 正则)。留给 W4 的完整分类器接。
7. **Windows 首发 = app 护栏(路径沙箱 Task1/2 跨平台生效 + 改前备份 W2 + 审批闸 W4)+ Job Object 占位**;真隔离(Job Object 免管理员 + restricted-token/WFP)= W3b/二期。

## W3 明确没做（留后窗,别以为漏了）
- **Windows 原生 Job Object helper.exe**(Rust,照 Codex windows-sandbox 思路,免管理员)→ **W3b**(Windows CI 交叉编译 + W14 真机验)。接入点 = `WindowsJobObjectLauncher.available()/wrap()`。
- **网络围栏 / shouldUseSandbox 逐命令决策 / 工作区内自动放行 / 审批闸 / 完整危险命令分类器(可逆性·爆炸半径)** → **W4**。
- **restricted-token / WFP 出站网络拦截**(要管理员、分发摩擦大)→ 二期。
- **命令内 UNC 检测**(过挡良性转义路径、删了)→ W4 的 command-verb 感知分类器(路径级 UNC 已由 Task1 `isVulnerableUncPath` 兜)。

## 坑 / 注意
- **`@anthropic-ai/sandbox-runtime` 在 Bun 下能跑**(Bun 1.3.14 实测 import 成功,exports 含 `SandboxManager`)。它 ships `vendor/srt-win.exe`(Windows WFP/ACL,要管理员=二期) + `vendor/seccomp`(Linux),核心是 JS,无 N-API `.node`,故 Bun 兼容好。
- **强制模型**(README 核实):写=allow-only 默认全拒(必须 allowWrite);读=deny-then-allow 默认全放;网络=allow-only 默认断网。`allowWrite→allowOnly`、`denyWrite→denyWithinAllow`(vendor sandbox-manager.js 已核)。
- **`getDefaultWritePaths()` 放开 /tmp 等**(`/dev/*`、`/tmp/claude`、`~/.npm/_logs`…),故 smoke 用 **`$HOME` 作越界目标**(不在任何默认写规则内),别用 /tmp。
- **macOS `os.tmpdir()` 实解到 `/var/folders/.../T`(→`/private/...`)**,凡工作区根跟落盘路径比对一律 `realpathSync(mkdtempSync(...))`。
- **`ensureInitialized` 模块级 initialized 标志是非原子 check-then-set**;W3 loop 串行调工具无实际竞态,W4+ 若并发调工具需串行入口/加锁。
- **`isOsSandboxSupported(platform)` 的 platform 参仅 win32 分支权威**;darwin/linux 委托 vendor `isSupportedPlatform()` 读真 `process.platform`(vendor API 限制)。

## ⚠️ 给 W3b 的硬交接（Windows 原生 Job Object）
- **接入点**:`src/sandbox/windowsLauncher.ts` 的 `WindowsJobObjectLauncher.available()`(→ 变 true)+ `wrap(command)`(→ 返 `{argv,env}` 起子进程装进 Job Object)。门面 `sandbox.ts` 的 win32 分支已在调它,W3b 只需把占位换真实现。
- **做法**:照 **Codex `windows-sandbox-rs`** 思路(它仓库开源、非通用库,照思路重写)——**首发 W3b = `Job Object`(进程/资源围栏、免管理员)**;`CreateRestrictedToken`(write-restricted + 合成 SID 二次写检查)/ WFP 出站(要管理员、分发摩擦)= 更后。
- **打包**:Rust helper.exe 各平台(win x64,兼容老 CPU)CI 交叉编译打进包 `asarUnpack`;别指望装机时编。
- **真机验** = W14(干净 Windows 机走全链路)。app 护栏(路径沙箱+备份+审批)首发已在,Job Object 是加固层。
- ⚠️ **别用 sandbox-runtime 的 Windows 路**(srt-win.exe WFP/ACL 要管理员 + 注销重登,分发体验差,owner 已定放二期)。

## 行为对齐逮到的真 bug（Task 3,记为范例）
评审按「行为对齐」拿刁钻边界跑,逮出 2 个 Important 并修掉:① 命令内 UNC 正则 `/\\\\[^\s\\/]+[\\/]/` **过挡良性转义路径**(`echo "C:\\Users\\foo"`/`curl -d '{"path":"C:\\Users\\test"}'`/`sed 's#C:\\old\\path#'`,因 `\\`=JSON/引号/sed 里转义一个字面反斜杠)→ 删该正则、命令内 UNC 交 W4;② `rm *` 通配缺 `/i` **漏挡 `rm -RF *`**(大写 R 在 macOS/BSD 合法)→ 补 `/i`(顺手给 W2 两条 rm-root 也补,catch `rm -RF /`)。修后独立复核 30 用例 + ReDoS 检查全过。**教训:确定性红线正则必须两头测——既别漏挡危险、更别过挡良性。**

## 复跑
```bash
cd ts && export PATH="$HOME/.bun/bin:$PATH"
bun test               # 75 pass / 0 fail / 15 files
bun run typecheck      # exit 0
bun run smoke:sandbox  # 工作区内写✓ / 工作区外写被拒✓(mac 真起 sandbox-exec)
```

## 下一窗(2026-07-06 更新)
W4「Harness·其余」已拆 **5 子窗 W4a–e**(见 `docs/plans/TS-W4-拆窗与研究底稿-2026-07-06.md`)。**W4a 审批权限已建**(审批闸/权限三档/plan 判定/拒绝跟踪/HMAC/白标 anti-reveal,见 `W4a-approval-permissions-findings.md`,107 pass)。**下一窗 = W4b 定向脚手架**(plan enter/exit + todo + system-reminder + steering);或 **W3b**(Windows 原生 Job Object)。
本文件里点名交「W4」的那几件(shouldUseSandbox / 网络围栏 / 完整危险命令分类器 / 默认开沙箱)= **sandbox 尾巴**,不在 W4a–e 五窗内,owner 定当独立小窗(底稿 §5)。
