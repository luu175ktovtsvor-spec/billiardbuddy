# Windows 平台对等 · 审计与补齐清单(#35)

> 📌 状态:🚧进行中 · 任务〈Windows 平台对等审计 #35〉 · 只读审计 + 一份文档 · 审计于 2026-07-10
>
> **一句话结论:** 唯一发版目标是 Windows,但从代码看 Windows 是二等公民——**OS 写围栏在 Windows 上根本不生效**(沙箱在主发行平台形同虚设),**危险命令红线是 POSIX/sh 写法、而 Windows 上 run_command 实际跑的是 cmd.exe**(Windows 原生毁灭命令绕过),**关窗即退出+托盘被销毁**(后台任务随手一关就死),**系统通知/揭示文件/打开路径这些原生能力压根没接线**。路径校验、sidecar 打包、单实例、PowerShell 工具这几块 Windows 是对等的。**下面每项给:现状(mac 怎样)→ Windows 差异/风险 → 判定 → 补齐建议。文末是出包前必补优先级清单。**
>
> 本文档只读审计,**未改任何代码**。所有 file:line 引用相对 `ts/`。

---

## 判定总表(先看这张)

| # | 审计项 | 判定 | 严重度 |
|---|--------|------|--------|
| 1 | 沙箱/OS 写围栏 | ❌ **需补(高危)**:OS 沙箱仅 mac/linux,Windows 无围栏 | 🔴 P0 |
| 1b | 危险命令红线 vs cmd.exe | ❌ **需补(高危)**:红线是 sh 写法,Windows 跑 cmd 却不拦 cmd 原生毁灭命令 | 🔴 P0 |
| 2 | 托盘生命周期 / 关到托盘 | ❌ **需补**:关窗即 `app.quit()`,托盘被销毁,后台任务死 | 🟠 P1 |
| 3a | 系统通知(toast) | ❌ **需补**:根本没接 `new Notification`,只有 app 内通知存储 | 🟠 P1 |
| 3b | 揭示文件 / 打开路径 / 打开系统设置 | ❌ **需补**:三个都没接线(IPC/工具都无) | 🟡 P2 |
| 3c | AppUserModelId(通知身份) | ✅ 已对等:已设、与 builder appId 一致 | — |
| 3d | 单实例 | ✅ 已对等:跨平台,second-instance 拉前台 | — |
| 3e | 外链走系统浏览器 openExternal | ✅ 已对等 | — |
| 4a | 路径/权限(盘符/UNC/PATHEXT/波浪号) | ✅ 大体已对等,需真机验 | 🟢 |
| 4b | stateRoot 落点(%USERPROFILE%) | ✅ 已对等(落 `C:\Users\<你>\.billiardbuddy\state`) | 🟢 |
| 4c | 权限 deny 规则大小写不敏感 | ⚠️ **未知需真机验**:Windows 文件系统大小写不敏感 | 🟡 P2 |
| 5a | backend-sidecar `.exe` 打包/spawn/kill | ✅ 已对等:交叉编译产物在包里,taskkill /T 收树 | — |
| 5b | whisper-cli.exe / ffmpeg.exe / DLL / 权重 | ❌ **需补**:没打进包(转写/视频功能在 Win 上优雅降级为不可用) | 🟡 P2 |
| 5c | run_command 子进程树 kill(taskkill /T) | ⚠️ **需补(小)**:Win 上只 `child.kill`,孙进程会孤儿 | 🟡 P2 |
| 6a | 签名(nsis 未签) | ⚠️ 已知取舍:先裸发,SmartScreen 可"仍要运行" | 🟡 P2 |
| 6b | 自动更新(electron-updater) | ❌ **需补**:完全没接,用户没有更新通道(关联 #13) | 🟡 P2 |
| 7 | PowerShellTool 危险命令拦截 | ✅ 已对等:Windows-aware,FATAL/DESTRUCTIVE/SECURITY 全套 | — |

---

## 1. 沙箱 / OS 写围栏 —— 🔴 判定:需补(高危)

**现状(mac):** `startServer` 里 `sandboxEnabled` **默认开**(`src/server/index.ts:930`,env `QF_OS_SANDBOX=0` 才关)。mac 上 `Sandbox.isOsSandboxActive()` 为真 → `wrapCommand` 用 `@anthropic-ai/sandbox-runtime` 的 seatbelt 把 `run_command` 命令包进 OS 盒子,**可写目录只有工作区**,越界写被系统内核拒(`src/sandbox/osSandbox.ts:17-33`、`src/sandbox/sandbox.ts:33-51`)。

**Windows 差异/风险:** `isOsSandboxSupported` 对 `win32` **恒返回 false**(`src/sandbox/osSandbox.ts:29-33`,并有测试锁死 `src/sandbox/osSandbox.test.ts:18`「win32 恒 false」)。于是 Windows 上:
- `isOsSandboxActive()` 恒 false → 走 `winLauncher.wrap()`;
- `WindowsJobObjectLauncher.available()` **恒 false**、`wrap()` **恒返回 null**(`src/sandbox/windowsLauncher.ts:8-18`,是 W3b 的占位桩,Job Object 从没接入);
- `wrapCommand` 拿到 null → `run_command` 走**明文 `cmd /c`**(`src/tools/runCommandTool.ts:163-164`)。

**结论:唯一发行平台上 OS 写围栏完全不生效。** 沙箱这层在 Windows 上是个空壳。此时命令能写/删的范围 = 当前 Windows 用户能写/删的一切(整个 `C:\Users\<你>`、桌面、文档……),不受工作区限制。`describeForPrompt` 对模型也如实说了这点(`src/sandbox/sandbox.ts:58-59`:"OS 写围栏与审批闸、Windows Job Object 隔离待后续启用")——**它没骗人,但意味着围栏确实没有**。

仅剩的应用层护栏:①文件工具(Read/Write/Edit)的 `workspace.resolve` 路径边界 + 改前备份(`src/workspace/workspace.ts`)——**但这只管文件工具,管不了 `run_command` 里任意 shell 命令**;②危险命令红线(见 §1b,而它是 sh 写法);③审批闸(file/outreach/destructive 分级)。

**补齐建议(改哪、怎么改):**
- **短期(出包前必做,最省力):** 承认 Windows 无 OS 围栏,把防线压到 §1b 的红线 + 审批闸上——**必须先把红线补成 cmd.exe-aware**(见 §1b),否则等于裸奔。
- **中期(W3b,真围栏):** 落地 `WindowsJobObjectLauncher.wrap()`——照 Codex windows-sandbox 思路交叉编译 Rust helper.exe,把子进程装进 Job Object(免管理员的进程/资源围栏)。注意 Job Object **主要限进程/资源,不是文件系统 ACL 写围栏**,要做"只可写工作区"得配合 AppContainer / 受限令牌,工程量大;先评估是否值得,还是走"红线 + 审批"路线。
- 无论哪条,`describeForPrompt` 的 Windows 文案要跟实际能力保持一致(现在是一致的,别改坏)。

---

## 1b. 危险命令红线 vs Windows cmd.exe —— 🔴 判定:需补(高危,与 §1 连体)

**现状(mac):** `run_command` 未包裹时 mac 走 `sh -c`(`src/tools/runCommandTool.ts:165`)。红线 `isDangerousCommand` 拦 `rm -rf /`、`sudo`、`mkfs`、`dd of=/dev/`、fork 炸弹、`shutdown/reboot`、`rm *`、`rm C:\`(`src/tools/dangerousCommand.ts:10-20`)——**全是 POSIX/sh 写法**(只有一条 `rm C:\` 沾了点 Windows)。

**Windows 差异/风险:** Windows 上 `run_command` 实际 spawn 的是 **`cmd /c <command>`**(`src/tools/runCommandTool.ts:163-164`),模型自然会写 **cmd/batch 语法**。而红线里**没有任何 cmd.exe 原生毁灭命令**:`del /f /s /q C:\...`、`rd /s /q`、`format C:`、`diskpart`、`cipher /w`、`takeown` / `icacls` 批量、`reg delete HKLM\...`、`rmdir /s` 一个都不在(grep 全库确认:`src/tools/` 里这些模式为空,只有 PowerShellTool 有 `format-volume`)。加上 §1 无 OS 围栏兜底,后果是:**模型在 Windows 上一句 `run_command("del /f /s /q C:\\Users\\me\\Documents\\*")` 既过红线、又无围栏,直接毁数据。**

**补齐建议:**
- 给 `DANGEROUS_PATTERNS` 增补 cmd.exe-aware 红线:`del`/`erase` 带 `/s` 或 `/q` 打到盘符根/用户目录、`rd`/`rmdir` 带 `/s`、`format`、`diskpart`、`cipher /w`、`reg delete HK*`、`takeown`/`icacls` 对系统路径、`bcdedit`、`vssadmin delete shadows` 等。可直接借 `powerShellTool.ts` 的 `FATAL_PATTERNS`/`DESTRUCTIVE_PATTERNS` 思路(那份是 Windows-aware 的,§7)。
- 更稳的做法:**Windows 上让 `run_command` 也走 PowerShell-aware 的分级器**,或干脆引导模型在 Windows 用 PowerShellTool(它红线全)。至少 `classifyCommandRisk` 对 cmd 内置毁灭动词要能判 `destructive`。
- 必须先写"刁钻边界"行为对齐测试(`del /s /q C:\`、`format C:`、`rd /s /q %USERPROFILE%`)再改,符合仓库铁律。

---

## 2. 托盘生命周期 / 关到托盘 —— 🟠 判定:需补

**现状(mac):** mac 不建托盘(`createTray` 里 `if (process.platform === 'darwin') return`,`desktop/electron/main.ts:222`),靠 Dock;`window-all-closed` 在 mac **不退出**(`main.ts:284-285`),符合 mac 习惯(关窗留 Dock)。

**Windows 差异/风险:**
- 非 mac 会 `createTray()` 建一个托盘,右键菜单"显示/退出",左键点击 `showMainWindow`(`main.ts:221-235`)。**看起来有托盘**。
- 但 `window-all-closed` 里 `if (process.platform !== 'darwin') app.quit()`(`main.ts:284-286`)——**Windows 上关掉窗口 = 直接退出整个 app**。而 `before-quit` 会 `tray.destroy()` + `killSidecar`(`main.ts:288-292`)。
- 关键:**全库没有 `win.on('close', e => { e.preventDefault(); win.hide() })` 之类"关到托盘/最小化到托盘"的逻辑**(已 grep 确认 main.ts 无 close 拦截)。所以托盘**只在窗口被最小化/隐藏时有用**;用户一旦点窗口右上角 ✕,`window-all-closed` 触发 → `app.quit()` → 托盘被 destroy、sidecar 被杀。
- 后果:**Windows 用户随手关窗,正在跑的后台任务(媒体渲染/生图/长 agent 循环/task)全部随之死掉**。托盘形同摆设——它想守护后台,却被 quit-on-close 架空。

**补齐建议:**
- 二选一,明确一种:
  - **(A) 真·关到托盘:** 给主窗口加 `close` 事件拦截:非真正退出时 `e.preventDefault()` + `win.hide()`,只有从托盘"退出"或 `before-quit`(`app.isQuitting` 标志)才真退。同时 `window-all-closed` 在 Windows 改为**不 quit**(留托盘)。这样后台任务活着。
  - **(B) 接受关窗即退:** 那就**别建托盘**(去掉 Windows 托盘的错觉),并在关窗前对"有后台任务在跑"给用户提示。
- 推荐 (A):产品定位是"派子代理、后台干活",关窗即杀后台与定位冲突。
- 改后回归:确认 `before-quit` 仍能杀 sidecar(避免关到托盘后 sidecar 泄漏),托盘"退出"走 `app.quit()`。

---

## 3. 原生能力 Windows 实现

### 3a. 系统通知(toast)—— 🟠 判定:需补(两平台都缺)
**现状:** 后台任务完成时只调 `desktopData.addNotification(...)`(`src/server/index.ts:957-958`、`src/server/services/desktopDataStore.ts:314`)——**这是写进 app 内的通知存储(JSON),不是操作系统 toast**。全库**没有任何 `new Notification()`**(Electron 或 Web Notification 都没有,已 grep 确认 main/preload/renderer 都无)。
**Windows 差异/风险:** `AppUserModelId` 已设好(`appIdentity.ts`,见 3c),这是 Windows toast 的**前置条件**——但**前置条件到位、却没有任何代码真的发 toast**。结果:窗口没聚焦时(尤其关到托盘后),用户对"后台任务完成"零系统级反馈。
**补齐建议:** 加一条 IPC(如 `desktop:notify`)在主进程 `new Notification({title, body}).show()`,点击回前台;渲染层/后端任务完成事件驱动它。Windows 依赖已设的 AUMID(3c),mac 无需额外配置。这是 app 内通知的自然补位。

### 3b. 揭示文件 / 打开路径 / 打开系统设置 —— 🟡 判定:需补(两平台都缺)
**现状:** 全库只有 `shell.openExternal(url)`(http 外链,`main.ts:113`、`navigationGuards.ts`)。**没有** `shell.showItemInFolder`(在资源管理器里高亮某文件)、**没有** `shell.openPath`(用默认程序打开文件/文件夹)、**没有**"打开系统设置"(Windows `ms-settings:` / mac `x-apple.systempreferences:`)。preload 只暴露 `pickWorkspace / preventSleep / runtime / onMenu`(`desktop/electron/preload.ts:5-25`),没有揭示/打开通道。
**Windows 差异/风险:** 这些是产品该有的基础桌面能力("在文件夹中显示"生成的产物、"打开这个文件夹")。缺失是两平台通病,但 Windows 是发行平台,优先级更高。
**补齐建议:** 加白名单 IPC:`desktop:revealItem(path)` → `shell.showItemInFolder`;`desktop:openPath(path)` → `shell.openPath`(注意:两者都要先过工作区/路径合法性校验,别让渲染层任意路径揭示);如需"打开系统设置"再加一条走 `shell.openExternal('ms-settings:...')`。

### 3c. AppUserModelId —— ✅ 判定:已对等
`applyWindowsAppUserModelId` 在建窗前调用(`main.ts:259`),仅 Windows 生效,ID = `com.qiufang.assistant`,**与 electron-builder.yml 的 `appId` 一致**(`electron-builder.yml:3` vs `appIdentity.ts:8`)——这点很关键,不一致 toast 会静默失败。groundwork 到位,只差真发 toast(见 3a)。

### 3d. 单实例 —— ✅ 判定:已对等
`acquireSingleInstanceLock`(`singleInstance.ts`)跨平台,拿不到锁就 quit,`second-instance` 事件拉老窗口前台。Windows 上第二次启动会把老窗口带前台,行为正确。有逃生开关 `QF_DESKTOP_DISABLE_SINGLE_INSTANCE_LOCK`。

### 3e. 外链 openExternal —— ✅ 判定:已对等
`installMainWindowNavigationGuards` 把 `window.open`/外链导到系统浏览器、拒不受控子窗口(`main.ts:113`、`navigationGuards.ts`),跨平台。

---

## 4. 路径 / 权限

### 4a. 分隔符 / 盘符 / UNC / 波浪号 / PATHEXT —— ✅ 判定:大体已对等(需真机验)
**现状 + Windows 覆盖(已相当到位):**
- 盘符根/盘符直接子级:`pathValidation.ts:8-9`(`WINDOWS_DRIVE_ROOT_REGEX`/`WINDOWS_DRIVE_CHILD_REGEX`)、`isDangerousRemovalPath` 拦盘符根 `C:\` 与盘符子级(`:54-57`)。
- UNC(`\\server\share`、`//server/share`、混合分隔):`isVulnerableUncPath` **仅 win32 生效**,四条正则覆盖变体,写校验里直接拒(`pathValidation.ts:13-18,42-46,81-83`)——符合铁律里的 `\\server\share` 边界。
- 波浪号:`expandTilde` 处理 `~`、`~/`、Windows 的 `~\`(`pathValidation.ts:31-40`);`~user/~+/~-` 拒。
- 工作区边界:`resolveInWorkspace` 用 `node:path` 的 `relative`(平台感知),判 `../`、`..\\`、跨盘绝对逃逸(`pathBoundary.ts:18-27`)。
- PATHEXT:`findExecutableOnPath` 用 `process.env.PATHEXT`(`.EXE;.CMD;.BAT;.COM`)在 Windows 找可执行(`powerShellTool.ts:560-566`);`transcribe.ts:75` 同款 `['', '.exe', '.cmd', '.bat']`。
**风险:** 逻辑齐,但从没在真 Windows 上跑过边界断言。**判定已对等但标"需真机验"**——按铁律,盘符/UNC/PATHEXT 这类确定性逻辑应在真 Windows 上把刁钻边界(`\\server\share`、`C:\`、`~\`、跨盘 `..`)断一遍。

### 4b. stateRoot 落点 —— ✅ 判定:已对等
`resolveStateRoot` 默认 `~/.billiardbuddy/state`(`src/server/index.ts:916-923`),`getUserConfigHomeDir` = `join(homedir(), '.billiardbuddy')`(`src/harness/memoryNames.ts:53`)。Windows 上 Node `os.homedir()` = `%USERPROFILE%` → 落 **`C:\Users\<你>\.billiardbuddy\state`**,永远可写、与 cwd 无关。打包后 Electron 进程 cwd 可能是 `/` 或安装目录,sidecar 用 `app.getPath('userData')` 当 cwd(`main.ts:53`)、状态又锚到用户配置目录,**都不依赖坏 cwd,Windows 安全**。env `BILLIARDBUDDY_STATE_DIR`/`BILLIARDBUDDY_CONFIG_DIR` 可覆盖。
**小提示(非阻断):** 落在用户主目录下的点目录 `.billiardbuddy` 而非 `%APPDATA%`,不是 Windows 最地道的位置(点目录默认隐藏、有的备份/迁移工具会漏),但功能上完全 OK,当前不必改。

### 4c. 权限 deny 规则大小写不敏感 —— ⚠️ 判定:未知需真机验
**风险:** Windows 文件系统大小写不敏感(`C:\Secret` == `c:\secret`),而 `filePathRuleMatch.ts` 做的是 NFC 归一 + `homedir()` 解析(`:204-206`),**未见按平台做大小写折叠**。若用户配 deny 规则 `C:\Secret\**`,模型用 `c:\secret\...` 访问,可能绕过 deny。
**补齐建议:** 在 Windows 上对权限路径规则匹配做大小写不敏感比较(或 `toLowerCase` 归一)。先写针对 Windows 的用例验证现状是否真漏,再决定改。低概率但属安全洞,列 P2。

---

## 5. sidecar / 二进制

### 5a. backend-sidecar `.exe` 打包/spawn/kill —— ✅ 判定:已对等
- 交叉编译:`build-sidecar.ts` 支持 `bun-windows-x64-baseline`(注:**baseline 是老 CPU 必需**,否则起后端就崩)/`bun-windows-arm64`,产物命名带 `.exe`(`build-sidecar.ts:37-53`)。**产物已在仓库**:`desktop/binaries/backend-sidecar-x86_64-pc-windows-msvc.exe`(已确认存在)。
- 打包:`electron-builder.yml:23-27` 把 `desktop/binaries` 整目录进 `resources/binaries`。
- spawn:`buildSidecarPlan` 按 triple + `.exe` 后缀找二进制、有精确命中 + 兜底扫目录(`main.ts:60-70`),`cwd = userData`(避坏 cwd),`windowsHide: true`(`sidecarManager.ts:74`)。
- kill:`killSidecar` 在 Windows 用 **`taskkill /F /T /PID`** 收整棵进程树(`sidecarManager.ts:84-98`)——防 Bun sidecar 派的 worker 孤儿。**这块是 Windows-aware 做得好的正面样板。**

### 5b. whisper-cli.exe / ffmpeg.exe / DLL / 权重 —— 🟡 判定:需补
**现状:** 转写走**外部二进制 `whisper-cli` + `ffmpeg`,child_process.spawn**,不进 package.json、不 require `.node`(有意避开 ts/CLAUDE.md §8 的 Bun+Windows onnx 段错误;`transcribe.ts:1-11`)。Windows 名字解析对:`platformWhisperName()` 返 `whisper-cli.exe`(`transcribe.ts:66-68`),从 `resourcesPath/binaries` 等目录找(`transcribe.ts:85-104`)。缺失时**优雅降级**抛 `TranscribeUnavailableError`、不崩(`transcribe.ts:50-56,147-158`)。
**Windows 差异/风险:** **`desktop/binaries` 里目前只有 backend-sidecar,没有 `whisper-cli.exe` / `ffmpeg.exe` / `*.dll`(whisper.cpp/ggml 依赖的 DLL)/ 权重 `ggml-*.bin`**(已确认目录内容)。于是转写/视频口播功能在 Windows(和 mac)上一律"不可用"降级。Windows 的 `whisper-cli.exe` 还**必须连它的 DLL 一起放**(不像 mac 静态);`electron-builder.yml` 的 `filter: "**/*"` 会把 binaries 目录下所有文件(含 DLL/模型)打进去,所以放对位置即可。
**补齐建议:** 要上转写/视频功能就把 Windows 版 `whisper-cli.exe` + 全部依赖 DLL + `ffmpeg.exe` + 权重 `ggml-large-v3-turbo*.bin` 放进 `desktop/binaries`(权重放 `binaries/models`)。不上就当已知降级、文档写清。列 P2(取决于是否本期要这些能力)。

### 5c. run_command / PowerShell 子进程树 kill —— 🟡 判定:需补(小)
**风险:** `runCommandTool.killChildTree`(`:283-293`)与 `powerShellTool.killChildTree`(`:660-670`)在 **Windows 上都只 `child.kill('SIGKILL')`**(非 win 才用进程组 `process.kill(-pid)`)。cmd/pwsh 派生的孙进程在超时/取消时**可能孤儿**——而同项目的 `sidecarManager` 明明用了 `taskkill /T` 收树。不一致。
**补齐建议:** Windows 上给这两处也走 `taskkill /F /T /PID`(复用 sidecarManager 的做法),避免超时/中止后残留子进程。

---

## 6. 签名 / 自动更新

### 6a. Windows 签名(nsis)—— 🟡 判定:已知取舍(暂不阻断)
**现状:** `electron-builder.yml:36-43`:`win.target: nsis`、**无证书(未签名)**、`nsis.oneClick:false` + `allowToChangeInstallationDirectory:true`。这与 `docs/苹果与Windows-签名与分发.md` 的策略一致:**Windows 先裸发**,SmartScreen 只是"警告、能绕"(更多信息→仍要运行),量起来后再上微软 Artifact Signing($10/月)。**这是 已拍板的取舍,不算缺口**,但下载页要教用户"仍要运行"。

### 6b. 自动更新(electron-updater)—— 🟡 判定:需补(关联 #13)
**现状:** **`electron-updater` 不是依赖**(package.json 无)、**无 `autoUpdater` 代码**、`electron-builder.yml` **无 `publish` 段**(:45 只有一行注释"需 owner 定发布服务器后开启")。**Windows 用户现在没有任何更新通道**——修了 bug 也只能靠用户重新下载安装。
**补齐建议(#13):** 引 `electron-updater`,`electron-builder.yml` 配 `publish`(generic/GitHub + `latest.yml`),主进程接 `autoUpdater.checkForUpdatesAndNotify()`。**未签名的 NSIS 也能用 electron-updater**(靠 blockmap/sha512 校验,不强依赖签名),所以可先于签名落地。这是 Windows 长期可维护性的关键缺口。

---

## 7. PowerShellTool / 危险命令 —— ✅ 判定:已对等(正面样板)
**现状:** `powerShellTool.ts` 是**明确为 Windows 移植的**(从 cc-haha PowerShellTool),Windows-aware 很全:
- 可执行发现:Windows 优先 `pwsh.exe/pwsh/powershell.exe/powershell`(`:316-325`)。
- 分级:read/file/outreach/destructive,含别名归一(`cat→get-content` 等 `:25-59`)、只读/写/外联 cmdlet 集、git 只读/毁灭判定。
- 红线 `FATAL_PATTERNS`(`:202-206`):`clear-disk`/`format-volume`/`stop-computer`/`restart-computer`、`remove-item` 打盘符根/home/`~`/`$home`、通配删——**这些恰是 §1b run_command 缺的**。
- `DESTRUCTIVE_PATTERNS` + `SECURITY_PATTERNS`(`:161-200`):`-Recurse -Force`、`clear-recyclebin`、`Invoke-Expression`/`iex`、encoded command、`certutil -urlcache`/`bitsadmin`、`Add-Type`、COM、`runas` 提权等,全套。
- 密钥环境变量过滤 `isSecretEnvName`(`:655-658`)。
**判定:** PowerShell 这条路 Windows 对等且质量高。**问题不在 PowerShellTool,而在 §1b——run_command 默认走 cmd.exe 且红线是 sh 写法**。可考虑 Windows 上把危险 shell 引导到 PowerShellTool,或把它的红线思路搬给 run_command。
**小注:** §5c 的子进程树 kill 在 PowerShellTool 里同样是 Windows 未用 taskkill /T。

---

## 出包前必补清单(优先级)

### 🔴 P0 —— 不补不能安全出 Windows 包
1. **补 cmd.exe-aware 危险命令红线(§1b)。** run_command 在 Windows 跑 cmd 却没围栏、红线又是 sh 写法。给 `dangerousCommand.ts` 增补 `del /s /q`、`rd /s`、`format`、`diskpart`、`cipher /w`、`reg delete HK*`、`takeown`/`icacls`、`vssadmin delete shadows` 等,或 Windows 上把 run_command 接 PowerShell-aware 分级器。**先写刁钻边界行为对齐测试再改。**
2. **明确 Windows 无 OS 写围栏的姿态(§1)。** 短期靠"红线 + 审批"兜底(即第 1 条);中期评估 WindowsJobObjectLauncher(W3b)。至少把这条风险写进产品已知项、别让人误以为沙箱在 Windows 生效。
3. **真 Windows 机器冒烟一遍:** sidecar spawn/kill(taskkill /T)、端口占用回退、stateRoot 写盘(`C:\Users\<你>\.billiardbuddy\state`)、工作区路径边界(盘符/UNC/`..`/`~\`)、run_command 走 cmd、PowerShellTool 找到 pwsh。**这是唯一能证伪 §4「需真机验」的手段。**

### 🟠 P1 —— 影响 Windows 基本可用性/体验
4. **托盘/关到托盘(§2):** 二选一并实现——(A)真关到托盘(`close` 拦截 + `window-all-closed` 不 quit,后台任务活)或(B)去掉托盘错觉 + 关窗前提示有后台任务。推荐 A。确认 `before-quit` 仍杀 sidecar。
5. **系统通知 toast(§3a):** 加 `desktop:notify` IPC → `new Notification`,后台任务完成时发;Windows 靠已设的 AUMID。
6. **揭示文件 / 打开路径(§3b):** 加 `desktop:revealItem`/`desktop:openPath` 白名单 IPC(先过路径校验)→ `shell.showItemInFolder`/`shell.openPath`。

### 🟡 P2 —— 分发/长期可维护 + 按需功能
7. **自动更新 electron-updater(§6b / #13):** 引依赖 + `publish` 段 + `latest.yml` + `autoUpdater`。未签名也能跑,可先于签名做。
8. **whisper-cli.exe + DLL + ffmpeg.exe + 权重打包(§5b):** 若本期要转写/视频功能就放进 `desktop/binaries`(+`/models`);不要就把"降级不可用"写进已知项。
9. **子进程树 kill 统一 taskkill /T(§5c):** run_command 与 PowerShell 两处 killChildTree 在 Windows 用 taskkill /T,防孤儿。
10. **权限 deny 规则大小写不敏感(§4c):** Windows 上路径规则匹配做大小写折叠;先写用例验现状。
11. **Windows 代码签名(§6a):** 量起来后上微软 Artifact Signing($10/月),按签名分发文档接入。
12. **Windows 卖相(已记在签名文档 §3):** 那条空 52px 红绿灯位 + 原生标题栏并存,后续做 Windows 专属处理。

---

## 附:关键证据文件索引
- 沙箱平台判定:`ts/src/sandbox/osSandbox.ts:29-33`、`ts/src/sandbox/osSandbox.test.ts:18`
- Windows Job Object 占位桩:`ts/src/sandbox/windowsLauncher.ts:8-18`
- 沙箱门面 + Win 文案:`ts/src/sandbox/sandbox.ts:33-62`
- run_command spawn(cmd /c)+ kill:`ts/src/tools/runCommandTool.ts:154-165,283-293`
- 危险命令红线(sh 写法):`ts/src/tools/dangerousCommand.ts:10-20`
- 托盘 + window-all-closed:`ts/desktop/electron/main.ts:219-235,284-292`
- 通知(仅 app 内存储):`ts/src/server/index.ts:957-958`、`ts/src/server/services/desktopDataStore.ts:314`
- preload 暴露面(无揭示/通知):`ts/desktop/electron/preload.ts:5-25`
- AppUserModelId:`ts/desktop/electron/services/appIdentity.ts`
- 单实例:`ts/desktop/electron/services/singleInstance.ts`
- 路径校验(盘符/UNC/波浪号):`ts/src/workspace/pathValidation.ts`;边界:`ts/src/workspace/pathBoundary.ts`
- stateRoot 落点:`ts/src/server/index.ts:916-923`、`ts/src/harness/memoryNames.ts:53`
- sidecar 打包/spawn/kill:`ts/desktop/electron/main.ts:46-90`、`ts/desktop/electron/services/sidecarManager.ts:64-98`、`ts/desktop/scripts/build-sidecar.ts:30-53`
- 转写二进制解析(whisper.exe/ffmpeg):`ts/src/media/transcribe.ts:66-158`
- PowerShellTool:`ts/src/tools/powerShellTool.ts`
- 打包配置:`ts/electron-builder.yml`;分发/签名策略:`docs/苹果与Windows-签名与分发.md`
