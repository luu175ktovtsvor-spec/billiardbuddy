# 桌面壳 + 前端交互对齐审计（cc-haha spec vs ts/desktop 现状）

> 只读审计，三块（Electron 壳 / 前端交互 / 事件流消费）全部完成。方法：3 个并行只读子代理分别深挖 cc-haha `desktop/electron/**`、`desktop/src/components/**`、`desktop/src/stores/chatStore.ts`（3566 行全读），主代理交叉核对我方 `ts/desktop/**` 全部相关文件（`main.ts`/`preload.ts`/`services/*`/`renderer/app.js` 768 行全读/`renderer-react/**`/`src/types/events.ts`/`src/harness/loop.ts`/`src/server/index.ts` 相关段落）。

## 分类口径
- aligned = 机制一致
- gap = cc 有、我们缺（真缺口）
- deviation = 双方都有但机制/边界不同（非刻意）
- intentional-delta = 例外清单命中（颜色/文案/白标/产品边界/范围外）

## 分类计数（全文表格行粗略统计，供快速定位；精确以正文表格为准）
- gap：约 38 行 　aligned：约 20 行　 deviation：约 17 行　 intentional-delta：约 8 处
- 标记 **P0** 的真缺口共 4 处：① AskUserQuestion 无渲染　② 计划模式(plan mode)全链路 UI 缺失　③ PermissionModeSelector 不存在　④ 自动更新(electron-updater)完全缺失
- 一个"审计过程中纠正自己初判"的重点：cc 本身**没有** split-view diff、**没有**逐行 accept/reject、**没有**编辑参数后批准、**没有**专用 MCP elicitation 表单——这几条最初草稿误判为"cc 有我们没有"，深挖后确认双方一致或 cc 也没有，已在正文改回 aligned / 降级为"自查项非 cc 未对齐"。

---

## 模块一：Electron 壳（已完成）

来源：cc-haha `desktop/electron/**` 全量读（main.ts/preload.ts/services/*，跳过 preview*/terminal.ts 范围外）；我方 `ts/desktop/electron/**` 全量读。

### 1.1 窗口生命周期

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| 关闭按钮语义 | `close` 事件 `preventDefault()`+隐藏（等价最小化到后台），非 `isQuitting` 不真退出，`electron/services/windows.ts:174-195,251-256` | `mainWindow.on('closed',...)` 正常销毁，无拦截，`ts/desktop/electron/main.ts:166` | deviation | P2 | M |
| 窗口默认/最小尺寸 | 1280×820 / 960×640，`windows.ts:6-9` | 1180×760 / 720×480，`ts/desktop/electron/services/windows.ts:9-12` | deviation（我们自定，不必对齐数值） | — | — |
| 平台专属 chrome | win32 `frame:false`+`autoHideMenuBar`+`fullscreenable:true`（配 IPC 窗控），`windows.ts:141-163` | 无平台分支，Windows 用系统原生边框；无窗控 IPC | deviation（架构级二选一，非缺陷） | P2 | L |
| `webPreferences.sandbox` | `sandbox:true` | 未设置（默认 false） | gap | P1 | S |
| 窗口状态持久化算法 | 落盘 `window-state.json`，move/resize **不节流**每次都存，`windows.ts:242-260` | 同结构，move/resize **400ms 去抖**（`installWindowStatePersistence`），关窗立即存 | intentional-delta（我们更优，非缺口） | — | — |
| macOS 越界夹回可视区 | 有 | 有（同算法，移植自 cc） | aligned | — | — |
| Windows/Linux 越界夹回 | cc 也不做（只 macOS 夹） | 同 | aligned | — | — |
| 多窗口/Trace 窗口 | 按 sessionId 开独立"Trace"窗口，`main.ts:54,105-137` | 无 | intentional-delta（范围外：trace 窗属 cc 编码 agent 专属） | — | — |
| `activate` 重建/前台 | 有窗口就 show，无则新建 | 只在零窗口时重建，不显式 show 已存在窗口 | deviation（因为我们没有隐藏语义，问题不大） | P2 | S |
| `window-all-closed` | 仅 `isQuitting && !darwin` 才退出 | 标准 Electron 默认（`!darwin` 就退出） | deviation（与关闭语义联动，见上条） | P2 | S |

### 1.2 sidecar / serverRuntime 管理

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| 健康检查方式 | 真 HTTP `GET /health` 轮询，要求 200+JSON+`{status:'ok'}`，`sidecarManager.ts:167-208` | **纯 TCP connect 探活**，不验证 HTTP 语义，`sidecarManager.ts:44-61` | gap | P1 | S |
| 端口策略 | 配置固定端口 → **上次成功端口落盘复用（sticky）** → 随机兜底，`sidecarManager.ts:93-165` | 固定候选列表 `[8850,8851,8852,8877]` → 随机兜底，**无 sticky 落盘**（代码注释自认"起步版,sticky 落盘是 W13"） | gap（已知在建，task#13/W13 track） | P2 | S |
| 崩溃自动重启 | **主 server 无自动重启**，只记日志（`serverRuntime.ts` 无 supervisor） | **有**：`SidecarSupervisor` 指数退避（1s→16s）+ 60s 滚动窗口最多 5 次 + give-up 用户对话框，`sidecarManager.ts:148-231` | intentional-delta（我们更强，非缺口——审计按 cc=spec 但这里是我们领先，明确标注不要被"补齐"逻辑误删） | — | — |
| 主进程崩溃兜底 | **无**（未挂 uncaughtException/unhandledRejection/render-process-gone） | **有**：`crashGuard.ts`（process 级 + app 级双层，含渲染进程自动 reload + 循环护栏），`main.ts:14,321-351` | intentional-delta（同上，我们更强） | — | — |
| 反复崩溃用户提示 | 无对应机制 | 一次性对话框"后端服务已停止"+重启应用按钮，`main.ts:122-139` | intentional-delta（我们更强） | — | — |
| bind host | `0.0.0.0`（局域网可达，供手机扫码/反代），控制面走 `127.0.0.1` | 仅 `127.0.0.1` | intentional-delta（产品边界：暂无手机配套，非缺口） | — | — |
| 代理注入 | 解析系统代理注入 `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` 给 sidecar，`serverRuntime.ts:164-182` | 无 | gap | P2 | S |
| 启动失败错误详情 | 失败时把最近 80 行 stdout/stderr 拼进 error，`sidecarManager.ts:214-226` | TCP 超时裸错误，无日志附加 | gap | P2 | S |

### 1.3 IPC 白名单面（cc 暴露哪些通道我们缺哪些）

cc：`electron/ipc/channels.ts` + `capabilities.ts` 集中白名单，**每个 invoke 通道都有 payload 校验器**（`ELECTRON_IPC_VALIDATORS`），共 47 个 invoke 通道 + 9 个 event 通道（其中 14 个属 terminal/preview，范围外；**33 个 invoke + 7 个 event 在审计范围内**）。

我们：无 `ipc/channels.ts`/`capabilities.ts`，通道字符串直接内联在 `main.ts`，**无集中白名单/payload 校验层**。共 **4 个 invoke 通道 + 1 个 event 通道**：

| 我们已有 | cc 对应 | 分类 |
|---|---|---|
| `runtime:getServerUrl` | `desktop:runtime:get-server-url` | aligned（机制一致，命名少了 `desktop:` 前缀） |
| `desktop:pickWorkspace` | 无直接对应 | intentional-delta（产品特有） |
| `desktop:preventSleep:start/stop` | 无对应文件出现 | intentional-delta（产品特有） |
| `desktop:menu`（event） | `desktop:window:native-menu-navigate` 等 | deviation（我们更简单） |

| cc 有、我们缺的通道（按能力分组） | file:line | 分类 | P | S/M/L |
|---|---|---|---|---|
| 窗口控制族：minimize/toggle-maximize/close/start-dragging/request-attention/focus/is-maximized/onResized | `channels.ts:1-49` | intentional-delta（因为我们未做自绘 Windows 边框，见 1.1） | — | — |
| `desktop:app:get-version` | 同上 | gap | P2 | S |
| `desktop:command:invoke`（通知权限等通用分发器） | 同上 | gap | P2 | S |
| `desktop:clipboard:read-text/write-text` | 同上 | gap | P1 | S |
| `desktop:shell:open`（协议白名单 http/https/mailto） | `shell.ts:23-35` | gap | P1 | S |
| `desktop:shell:open-path`（路径校验+可执行文件黑名单） | `shell.ts:52-76,96-100` | gap | P2 | S |
| `desktop:dialog:open/save`（通用文件对话框） | `dialogs.ts` | gap（我们只有一个写死的选目录对话框） | P2 | S |
| `desktop:update:*`（check/download/install/prepare-install/cancel-install/relaunch） | `updater.ts` | gap（见 1.7 自动更新，已知在建 task#13） | P0 | L |
| `desktop:notification:*`（permission-state/request-permission/send/action-ack） | — | gap | P1 | M |
| `desktop:zoom:set` | — | gap（我们只有菜单 role 缩放，无 IPC 通道） | P2 | S |
| `desktop:app-mode:*`（portable 模式） | `appMode.ts` | intentional-delta（范围外：portable 分发） | — | — |
| `desktop:adapters:restart-sidecar` | — | intentional-delta（cc 特有消息桥接功能，我们无对应产品面） | — | — |

### 1.4 preload.ts 暴露的 API 面

cc：`window.desktopHost` 树状 ~40+ 叶子 API（`app/commands/clipboard/events/webview/shell/trace/dialogs/updates/notifications/window/terminal/preview/appMode/adapters/zoom`，含 `capabilities` 自描述对象 + 双侧校验）。

我们：`window.desktopHost = { platform, isDesktop, runtime.getServerUrl, pickWorkspace, onMenu, preventSleep.start/stop }`（`ts/desktop/electron/preload.ts:1-25`），**共 6 个叶子 API**，无 `capabilities` 自描述、无客户端侧 payload 校验。

结论：preload 面是 IPC 面的直接映射，缺口与 1.3 一致（gap 分类同上，不重复列）。

### 1.5 菜单

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| Windows 菜单栏 | **整个隐藏**（`Menu.setApplicationMenu(null)`），因为自绘无边框标题栏，`menu.ts:85-88` | **所有平台都建原生菜单**，`main.ts:275` | deviation（架构级二选一，我们用原生边框所以需要菜单，合理） | — | — |
| mac App 菜单 | 有 "Settings…"(⌘,) + `role:'services'` | 缺这两项 | gap | P2 | S |
| Window 菜单 "Close Window" | 有（⌘W） | 缺 | gap | P2 | S |
| View 菜单 reload/devtools/zoom | cc **没有**这些项（cc 只有一个"全屏"） | 我们有（更丰富） | intentional-delta（我们更全，非缺口） | — | — |
| 快捷键 | `⌘,` 设置、`⌘W` 关窗、`Ctrl/⌘F` 全屏 | 仅 `CmdOrCtrl+O` 选工作区 | gap（部分） | P2 | S |

### 1.6 托盘

| 行为点 | cc | 我们 | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| 平台门槛（非 mac 才装） | 一致 | 一致 | aligned | — | — |
| 图标资源 | 要求真实 PNG，缺失就上抛错误（`tray.ts:10-21`） | `nativeImage.createEmpty()` 空图标兜底，永不因缺图崩溃 | deviation（我们更保守但视觉上会显示系统默认图标——产品发布前需真图标，非交互缺口，标记但不计入 P0-P2 分类） | — | — |
| 右键菜单结构（显示/退出两项+分隔线） | 一致 | 一致 | aligned | — | — |

### 1.7 外链安全 / 导航守卫

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| `setWindowOpenHandler` 拒绝弹窗+转系统浏览器 | 有，`navigationGuards.ts` | **逐字移植**，`ts/desktop/electron/services/navigationGuards.ts`（文件头自述"移植自 cc-haha"） | aligned | — | — |
| 主窗口不装 `will-navigate` 守卫（有意，不打断内嵌 SPA 跳转） | 有意省略 | 同（一致） | aligned | — | — |
| `openExternal` 内部协议白名单（仅 http/https/mailto，`normalizeExternalUrl`） | 有，`shell.ts:6,23-35` | **无**——`main.ts:162` 直接 `shell.openExternal(url)`，无二次校验（虽然 window-open 路径上游已被 `isHttpUrl` 挡过，但这层防御纵深缺失） | gap | P1 | S |
| `openSystemPath` 可执行文件扩展名黑名单 | 有 | 无对应功能（我们没暴露"打开本地路径"IPC，暂无实际风险面，但若日后加此类通道要记得补） | gap（潜在，非当前风险） | P2 | S |

### 1.8 自动更新

| 行为点 | cc | 我们 | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| 机制 | `electron-updater`（autoDownload=false，check/download/install/relaunch 四段式 IPC，非静默） | **完全缺失**——`package.json` 无 `electron-updater` 依赖；`electron-builder.yml` 注释明示"需 owner 定发布服务器后开启" | gap（已知在建：task#13/W13，非本次新发现，但仍列全） | P0 | L |

### 1.9 渲染入口安全（rendererEntry 等价物）

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| dev-server URL 加载前置校验 | `isAllowedDevRendererUrl`（限 `http:` + `127.0.0.1`/`localhost`/`::1`）**且仅 `!isPackaged` 才生效**，`rendererEntry.ts:9-31` | `loadRenderer()`（`main.ts:173-182`）：`QF_UI_REACT==='1'` 时直接 `win.loadURL(process.env.ELECTRON_RENDERER_URL)`，**无协议/主机校验，也无 `app.isPackaged` 门槛** | gap（安全，具体是"打包应用若环境变量被污染会信任任意 URL"；利用门槛高但防御纵深应补） | P1 | S |
| portable 模式 | 有完整 `appMode.ts` | 无 | intentional-delta（范围外：portable 分发） | — | — |

---

## 模块二：前端交互行为（已完成，cc 侧 + 我方双侧对照）

来源：我方 `ts/desktop/renderer/{index.html,app.js}`（vanilla，768 行，**默认加载路径**）+ `ts/desktop/renderer-react/src/**`（React 迁移 WIP，behind `QF_UI_REACT=1`，多组件仍是占位 `placeholder.ts`）全量读；cc-haha `desktop/src/components/{chat,controls,layout,workbench,workspace,browser}/**`、`hooks/useKeyboardShortcuts.ts`、`pages/ActiveSession.tsx` 全量读（子代理深挖，79 次工具调用）。

### 2.1 审批 / 权限流

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| 编辑参数后再批准 | **cc 也不支持**——`PermissionDialog.tsx` 只读预览（Edit/Write 走 `DiffViewer` 展示 old/new，Bash 走命令块），无编辑 UI（L96-119） | 同样不支持（后端协议虽支持 `body.args`≠`approval_args` 分离，但前端从不用它） | **aligned**（我之前误判为 gap——cc 本身也没有这个能力，两边一致） | — | — |
| "本次会话都允许" | `respondToPermission(...,{rule:'always'})`，标签 "Allow for session"（会话级非永久级） | "本次对话都允许"（`remember_approval`） | aligned | — | — |
| 拒绝时"说明原因"输入框 | 通用工具审批**没有**（Deny 无输入框）；**仅计划模式**（ExitPlanMode）拒绝时才有 feedback textarea（"Tell Claude what to change"），走 `denyMessage` | 通用拒绝无输入框（aligned）；**计划模式整体缺失**（见下） | 通用工具:aligned；计划模式:gap | — | — |
| 批量/多工具审批 | 不支持——每个 `requestId` 一张卡，多个待批时堆叠渲染 | 同（每个 approval_request 一张卡） | aligned | — | — |
| 审批卡响应后状态 | 保留在时间线里，变"已响应"灰态（不移除） | 同（`.done` 类，opacity 0.6，按钮变文字） | aligned | — | — |
| **AskUserQuestion（模型主动提问）** | 专用组件 `AskUserQuestion.tsx`：多问题横向 tab、选项卡片（单选/多选）、每题都有自由文本框、Ctrl/Cmd+Enter 全部答完可提交、按钮态门控"全部回答" | **完全没有渲染**——`ask_question` 事件（涵盖 AskUserQuestion 工具 + ExitPlanMode 计划批准 + MCP elicitation 三合一，`src/types/events.ts`）在 `app.js:488` 与 `chatStore.ts:255-257` 均落入 `default: break` | **gap（真缺口）** | **P0** | M |
| **计划模式（plan mode）UI** | 完整闭环：`EnterPlanMode`→紧凑状态条；`PermissionModeSelector` 里"Plan"是可手动选的档位之一；`ExitPlanMode`→专用 `ExitPlanModePermissionDialog`（`PlanPreviewCard` 渲计划 md + "请求的权限"列表 + Approve/Keep-planning 两键 + 反馈框）；批准/拒绝后 `PlanToolCallBlock` 渲终态"Plan approved/rejected" | 后端有完整状态机（`harness/loop.ts:1048-1103`：`permissionMode='plan'`→只准改计划文件→`ExitPlanMode`走 `ask_question`→批准后自动切 `acceptEdits`），**前端零渲染**（同上 `ask_question` 落空）。用户唯一能"回应"的手段是趁 running 打字触发 `steer`→落进同一个 `steerInboxes`，但界面**没有任何"AI 在等你确认计划"的提示**——观感上等于卡住 | **gap（真缺口，本次审计最高优先级）** | **P0** | L |
| MCP elicitation 表单 | **cc 自己也没有专用组件**（全仓 `grep -r "elicit"` 零命中）——任何 MCP 侧的结构化提问都会落进 `PermissionDialog` 未知工具兜底（通用图标+原始 JSON 折叠），不是真表单 | 后端有完整 schema 化实现（`handleMcpElicitation`，`server/index.ts:1456-1509`，`AskQuestionField[]`: text/textarea/number/boolean/select/multiselect），前端同上零渲染 | **不算 cc 未对齐缺口**（cc 本身没有可对标的参照物）；但仍是我们自己"后端半成品"，归为独立追踪项，不计入 cc 对齐 gap 计数 | P2（自查项） | M |
| Computer-use 权限弹窗 | 独立 Modal 流程（`ComputerUsePermissionModal.tsx`，两态:系统权限未开通/逐 App 授权） | 无对应功能（产品当前无 computer-use 工具） | intentional-delta（产品范围外，暂无该能力） | — | — |

### 2.2 工具调用折叠 / 分组

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| 默认折叠态 | 默认折叠，仅 `EnterPlanMode` 默认展开（`ToolCallBlock.tsx:56`） | 默认折叠，仅 diff 命中的编辑类工具（edit/write/patch/multi_edit）自动展开（`app.js:441-445`） | deviation（触发条件不同，但"低噪默认折叠"设计哲学一致） | — | — |
| 错误自动展开 | **不会**因出错自动展开（只在折叠头加错误图标+首行摘要） | 同（只变红描边+叉图标，不展开） | aligned | — | — |
| 多工具分组自动展开 | `ToolCallGroupMulti`：默认折叠，**运行中或含子调用时自动展开**（唯一的"活动驱动"自动展开），`ToolCallGroup.tsx:427-431` | 无分组概念（每个工具调用各自独立折叠块，无"多工具合并成一组"的聚合视图） | gap | P2 | M |
| Agent 子调用嵌套树 | `ToolCallTree` 递归缩进渲染子调用（含左侧竖线），子代理调用有独立 `AgentCallCard` | 无嵌套/分组渲染（子代理调用与普通工具调用同级平铺） | gap | P2 | M |
| 流式中的工具输入预览 | `partialInput` 实时解析部分 JSON 字符串字段，边流式边显示行数/字符统计 | 无——`tool_call` 事件必须等参数完整才发一次性渲染 | gap（对应模块三已记录的 tool-input delta 缺口） | P2 | S |
| Bash 命令块 | `TerminalChrome`（`$ command`终端观感） | 纯 JSON.stringify 摘要行 | deviation（视觉，非阻断） | — | — |

### 2.3 Diff 面板

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| 视图模式 | **`react-diff-viewer-continued` `splitView:false`——只有 unified，无 split**（`DiffViewer.tsx:149`） | 只有 unified（`renderUnifiedPatch`） | **aligned**（我之前草稿误判 cc 有 split，实际没有） | — | — |
| 行内 accept/reject | **无**（approval 只在整工具调用层面批准/拒绝） | 无 | aligned | — | — |
| 词级高亮 | `DiffMethod.WORDS`——行内逐词标红/标绿 | 只有整行三色（add/del/hunk），无词级 | gap（细节） | P2 | S |
| 语法高亮 | `prism-react-renderer`，按文件扩展名推断语言 | 无语法高亮 | gap（细节） | P2 | S |

### 2.4 流式渲染

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| 节流窗口 | 50ms `setTimeout` 攒批（text + tool-input 两路），`chatStore.ts:386-445` | 50ms 攒批（仅 text/thinking 两个 channel），`app.js:354-361` | aligned（机制一致，tool-input 那路我们没有，已在 2.2/模块三记录） | — | — |
| 流式光标 | 尾部 shimmer 条动画 | 尾部闪烁竖条 `.wb-cursor` | aligned（视觉不同但机制一致：流式期间显尾标，收尾移除） | — | — |
| 运行指示 | `StreamingIndicator`：三态互斥（api_retry 倒计时 / streaming_fallback 降级提示 / 默认动词+计时+token 估算） | 单一 pill（动词+计时+token 估算），无 retry/fallback 横幅（因为我们后端没有对应事件，见模块三） | deviation（跟随后端事件缺口，非前端独立问题） | — | — |

### 2.5 会话列表 / 切换 / fork

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| 侧栏能力 | 可折叠、Cmd+K 全局搜索、项目分组（3 种组织模式）+2 种排序、拖拽重排+置顶/隐藏（存 localStorage）、多选批量删除、右键菜单删除、刷新按钮 | 仅标题+相对时间的扁平列表，点击切换 | gap（大） | P1 | L |
| **并行多会话（tab）模型** | **支持**：多个会话可同时开在不同 tab，各自独立运行；关闭运行中会话的 tab 会弹"取消/保持后台运行/停止并关闭"三选一对话框（`TabBar.tsx:209-219,470-506`） | **不支持**——单一视图，且 `switchSession()`（`app.js:557`）里 `if (id === conversationId || running) return`：**运行中的会话根本切不走**，必须等它跑完才能看别的会话 | **gap（架构级，非润色）** | **P1** | L |
| 会话 fork/branch | 叫"branch"：`MessageActionBar` 悬停出现 `GitFork` 图标，**从某一条具体消息分支**（`POST /api/sessions/{id}/branch {targetMessageId}`），仅完整轮次后可用，态门控严格（团队会话/运行中/流式中/有后台任务时隐藏该按钮） | 后端 `POST /sessions/:id/fork` **只支持整会话 fork（无 targetMessageId，不能从某条消息分支）**，前端**零入口**（无按钮无菜单项） | gap（前端 + 后端粒度都缺） | P1 | M |

### 2.6 右侧预览面板

单一通用 `#preview` 侧栏（340px），三种用途复用同一 DOM：改动文件列表 / 后台任务列表 / 单文件只读内容（`showChanges`/`showTasks`/`showFile`，`app.js:32-75`）。**无 tab 切换、无图片预览、无 markdown 选区塞回对话、无浏览器 surface、无点选就地改**。task#17 已有详细落地方案文档（`docs/plans/cc-haha右侧预览面板-对标与落地方案.md`），本审计与其结论一致且用新子代理深挖补全了 cc 侧精确清单，见文末"右侧预览能力规格清单"。

### 2.7 @ 提及 / 文件引用 / 附件

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| @ 触发检测 | `detectAtTrigger`：`@` 需在词首（行首/空白后），`ChatInput.tsx:505-536` | 无 `@` 处理 | gap | P1 | M |
| 文件搜索菜单 | `FileSearchMenu`：目录导航（`/`结尾进目录）/ 搜索两模式、面包屑、↑↓·Enter·Tab·→(进目录)·Esc 全键盘 | 无 | gap | P1 | M |
| 剪贴板粘贴图片自动附件 | `handlePaste`，`ChatInput.tsx:830-868` | 无 `paste` 监听 | gap | P2 | S |
| 拖拽文件附件 | `useComposerFileDrop` + 拖拽遮罩 | 无 `drag`/`drop` 监听 | gap | P2 | S |
| 消息排队（运行中继续输入） | `queueUserMessage`：busy 时排队，渲染待发列表（可编辑/立即发送/删除），空闲后自动逐条发 | **无排队语义**——运行中发消息直接走 `steer`（插话进当前轮），非"排队等下一轮" | deviation（两种合理但不同的交互模型，需 owner 判断是否对齐 cc 语义） | P2 | M |

### 2.8 斜杠命令面板

机制完整移植（触发检测 `findSlashTrigger`/排序 `slashRank`/↑↓·Enter·Tab·Esc 全键盘交互/来源角标），代码注释明确"端口 cc ChatInput slashMenu"（`app.js:623-756`）。分类：**aligned**。

### 2.9 后台任务

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| 触发入口 | 对话流内嵌一条"N running/finished"计数行，点击展开滑入式抽屉 | 顶栏固定"任务"按钮，点击拉一次性列表进右侧通用面板 | deviation | — | — |
| 实时推送 | Running/Finished 分区列表，随 `task_started`/`task_progress`/`task_notification` 事件实时更新；Esc 关闭；"清除已完成" | 打开时才拉一次 `/tasks`，**无实时推送**（无 WS 事件驱动更新） | gap | P1 | M |
| 内联时间线卡片 | 后台任务完成/失败会额外在对话时间线内联一张 `BackgroundTaskEventCard` | 无 | gap | P2 | S |
| 跳转到运行中任务 | 抽屉本身不可点击跳转；真正的"跳转"是任务关联的 Agent 工具调用本就内联在对应轮次里 | 无法从任务列表关联回对应会话/轮次 | gap | P2 | S |

### 2.10 权限模式选择器 / 模型选择器

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| PermissionModeSelector | 下拉 4 档（default/acceptEdits/plan/bypassPermissions），选 bypassPermissions 需二次 `ActionDialog` 确认风险 | **不存在**——`settingsStore.ts` 有 `defaultPermissionMode`/`setPermissionMode` 状态但**没有任何 UI 调用它**，用户无法在界面切档 | **gap（真缺口，CLAUDE.md 明确要求"权限档用词照搬 cc"）** | **P0/P1** | M |
| ModelSelector | 按供应商分组 + Effort（low/medium/high/max）行 | 不存在等价组件 | **intentional-delta**（白标铁律"不向客户端暴露底层模型"——展示具体模型名本就不该对齐 cc；若要做，应做成不暴露模型名的"效果档位"选择器，非直接搬 cc 组件） | — | — |

### 2.11 上下文用量指示器

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| ContextUsageIndicator | 圆环按钮显示 % 占用，30s 自动刷新（节流 10s 一次），压缩后强制刷新+5s 重试，hover/tap 出分类 token 明细 | **后端已产出数据、前端完全丢弃**——`usage_update.context_percent/context_window` 在 `harness/loop.ts:803-805` 已算好，`app.js` switch 里 `usage_update` 落 `default:break`（完全不处理）；`renderer-react/chatStore.ts:245-248` 只存 `_lastTotalTokens` 也丢 `context_percent`。当前唯一"用量"展示是运行 pill 里 `streamChars/4` 的粗估单轮 token，非真实占用率 | **gap（真缺口，后端数据已就绪，纯前端消费缺失）** | **P1** | M |

### 2.12 键盘快捷键

| 行为点 | cc + file:line | 我们 + file:line | 分类 | P | S/M/L |
|---|---|---|---|---|---|
| 全局快捷键 hook | `useKeyboardShortcuts.ts`：Cmd/Ctrl+N 新会话、Cmd/Ctrl+K 全局搜索、Escape 关活跃弹窗、Cmd/Ctrl+. 停止生成、App 缩放键 | **完全没有**——`renderer-react/src/hooks/` 目录里连 `useKeyboardShortcuts.ts` 文件都不存在 | **gap（真缺口，实现成本低、性价比高）** | **P1** | S |
| composer 内快捷键（Enter 发送/Shift+Enter 换行/斜杠面板↑↓Tab Esc） | 有（`sendShortcut.ts`+`ChatInput.tsx`） | 有（`app.js:746-756`） | aligned | — | — |

### 2.13 消息操作条

复制/赞/踩/朗读/分享/更多（`MessageActions.tsx`），**无"重新生成"/"编辑并重发"/"从此处 branch"**动作（branch 见 2.5，是独立缺口）。cc 侧 `MessageActionBar` 同样只有 Copy + Fork 两个功能性按钮（其余 UI 元素为 hover 态展示），所以"重新生成/编辑并重发"**cc 也没有**——不算 gap；唯一实差是 Fork 入口缺失（已在 2.5 记录，不重复计数）。

---

---

## 模块三：事件流消费（已完成，见下）

来源：cc-haha `chatStore.ts`（3566 行全读）+ `websocket.ts`/`types/chat.ts`；我方 `src/types/events.ts`（后端真相源）+ `desktop/renderer/app.js` `renderEvent`（`app.js:410-490`）+ `renderer-react/src/stores/chatStore.ts` `reduceEvent`（同构，逐字段对齐 app.js 的行为基线）。

### cc 消费的事件类型（顶层 `ServerMessage.type`，`chatStore.ts:1567` switch）

`connected` / `content_start` / `api_retry` / `streaming_fallback` / `content_delta`（含 text 与 tool-input 两路） / `thinking` / `tool_use_complete` / `tool_result` / `permission_request` / `computer_use_permission_request` / `message_complete` / `user_message_replay` / `error` / `team_created` / `team_update` / `team_deleted` / `task_update`（声明但未处理） / `session_title_updated` / `system_notification`（二级 `subtype`：`slash_commands`/`session_cleared`/`compact_boundary`/`compact_summary`/`memory_saved`/`goal_event`/`task_started`/`task_progress`/`task_notification`） / `pong` / `permission_mode_changed` / `status`（含 `compacting` 阶段态）。

### 我方后端实际发出的事件类型（`src/types/events.ts` AgentEvent，真相源）

`thinking` / `command_invocation` / `tool_call` / `tool_progress` / `tool_result` / `usage_update` / `ask_question` / `final` / `approval_request` / `content_delta`（channel: text|thinking） / `steering` / `todo_update` / `context_note` / `max_turns_reached` / 顶层信封另有 `done`/`ready`/`error`/`approve_result`/`reject_result`/`steer_result`/`interrupt_result`/`pong`。

### 我方前端（app.js + renderer-react，两者行为一致）实际渲染消费的类型

`content_delta` / `thinking` / `command_invocation` / `tool_call` / `tool_result` / `final` / `steering` / `context_note` / `max_turns_reached` / `approval_request` / `done`/`error`/`ready`/`approve_result`。

### 后端已产出、前端零消费的类型（"做了后端没前端=半成品"清单，本审计核心交付）

| 事件类型 | 后端产出位置 | 现状 | 影响 | P |
|---|---|---|---|---|
| `ask_question` | `server/index.ts:1489` 发出；`harness/loop.ts:1030,1084` 驱动 AskUserQuestion 工具 + ExitPlanMode 计划批准 | app.js/chatStore 均 `default: break` | **计划模式批准 UI 完全不可见、MCP elicitation 表单完全不可见**——用户无法感知"AI 在问问题/等计划确认"，只能盲打字触发同一个 `steer` 通道 | **P0** |
| `usage_update`（其中 `context_window`/`context_percent`） | `harness/loop.ts:794-806` | 完全丢弃 | 无上下文用量条，用户不知道快满了要压缩 | P1 |
| `tool_progress` | `AgentEvent` 定义存在 | 未渲染 | 长工具调用无中间进度反馈（纯前端体感，非功能性阻断） | P2 |
| `todo_update` | `AgentEvent` 定义存在 | 未渲染 | 无可视化任务清单（cc 对应 `TodoWrite`→`useCLITaskStore`） | P2 |

### cc 有、我们后端协议里都没有对应能力的类型（架构/产品差异，非"半成品"）

| cc 能力 | 我们现状 | 分类 |
|---|---|---|
| `permission_mode_changed`（后端纠正前端权限档选择器） | 无权限档选择器 UI，也无对应事件 | gap（联动模块二 PermissionModeSelector 缺口） |
| `compact_boundary`/`compact_summary`/`status:compacting`（结构化压缩状态机+摘要） | 只有自由文本 `context_note`（靠正则 `/压缩\|compact/` 猜测） | deviation（我们的压缩通知是弱化版，非结构化） |
| `team_created/update/deleted`（多子代理团队实时状态） | 无产品面对应（我们有 `forkSubagent.ts`/`agentTool.ts` 但无团队可视化） | intentional-delta（产品范围：cc 的"团队"是编码 agent 专属概念，暂不对标） |
| `task_started`/`task_progress`/`task_notification`（后台任务**实时推送进 对话时间线**，不只是侧栏列表） | 我们的"任务"是纯拉取式侧栏列表（见模块二），无推送、不进对话流 | gap | 
| `content_delta` 的 tool-input 增量（工具参数流式打字机效果） | 只流式 text/thinking 两个 channel，`tool_call` 事件必须等参数完整才发 | deviation（体验细节，非阻断） |
| `api_retry`/`streaming_fallback`（供应商重试/降级可见横幅） | 无 | gap，P2 |
| `session_title_updated`（会话标题实时推送） | 前端靠 `final` 后整体 `refreshSessions()` 拉全量列表替代 | deviation（效果相近，效率更低，非功能缺口） |

### 乐观更新 / 批处理 / 本地事件日志（cc vs 我们）

- **乐观更新**：cc 在发送前就把 `user_text` 塞进 transcript，且支持"运行中继续输入排队"（`queueUserMessage`，逐条在 `idle` 时自动发送）。我们：`app.js` 的 `addUser()` 同样先本地插入用户气泡再发送（一致，aligned）；但**运行中输入走的是 `steer`（插话进当前轮次），不是排队等下一轮**——这是一个真实的交互模型差异（deviation，非缺陷，需 owner 判断是否要对齐 cc 的"队列"语义还是保留"插话"语义，两者都是合理设计）。
- **批处理节流**：cc 用 50ms 节流缓冲 text delta 与 tool-input delta（`chatStore.ts:386-445`）；我们同样 50ms 节流（`app.js:354-361`），**机制一致**，aligned。
- **本地事件日志 vs 渲染时间线**：cc 有"实时 WS 事件"与"持久化 JSONL 历史"两条线反复 reconcile（`mergeRestoredHistoryIntoLiveMessages`）。我们靠 `replay`（`type:'replay', after:lastSeq`）在重连/切会话时补拉，机制类似但更简单（无 transcriptMessageId 级去重合并），deviation，非当前审计重点。

---

## 右侧预览能力规格清单（供 task#17 施工用，整合子代理深挖 + 现有方案文档）

`docs/plans/cc-haha右侧预览面板-对标与落地方案.md`（task#17）已有详尽 P0/P1/P2 分期方案；本次子代理对 cc `WorkbenchPanel.tsx`/`WorkspacePanel.tsx`/`BrowserSurface.tsx`/`ActiveSession.tsx` 做了更细的行为级复核，以下是**规格清单**（编号供施工引用），已有方案文档覆盖的机制不重复贴代码，只标"文档已覆盖"：

**A. 开关/触发机制**
- A1 `TabBar` 文件夹图标切换：面板开+workspace 模式时点击关闭；否则强制切到 workspace 模式并打开（不会保留原来的 browser 模式）。
- A2 `openPreview(sessionId, path, kind)` 是**唯一统一入口**：任何"打开文件/diff"的地方（对话内产物卡片、改动文件卡片、OpenWith、文件树点击）都调用它，隐式打开面板+切 workspace 模式——文档已覆盖（"内容管道"章节），此次复核确认这是**单一必经入口**，施工时务必只做一个 `openPreview` 函数，别多处重复开面板逻辑。
- A3 browser 模式独立入口：点击面板内"浏览器"标签，或正文里的 localhost 链接直接 `open(sessionId, url)`。
- A4 宽度：拖拽手柄（指针拖拽 + 键盘 ←→ 32px 步进），默认/最小/最大 = 860/420/1120px，无预览 tab 时进一步限制到 36% 视口宽——文档已定我们自己是 440px 固定，此为 cc 参照区间，不必照搬数值。
- A5 "展开成整页 tab"：跟右侧面板状态**互相独立**——关掉展开出的整页 tab 不影响原会话面板的开关状态。P2 可选，文档已提及。

**B. 面板内容类型（enumerable）**
- B1 workspace 模式导航子面板：**"改动文件"视图**（git status，含 modified/added/deleted/renamed/untracked/copied/type_changed 七种徽标）与**"全部文件"视图**（懒加载目录树）两种可切换视图 + 过滤输入框 + 刷新按钮；右键菜单（文件：加入对话/复制相对路径/复制绝对路径/OpenWith 子菜单；预览 tab：关闭/关闭其它/关闭左侧/关闭右侧/全部关闭）。
- B2 预览 tab 支持两种 kind：`file`（按内容再分流：图片`<img>`/markdown（`MarkdownRenderer variant="document"`）/代码（Prism 高亮+行号））与 `diff`（自绘 unified diff，非 `react-diff-viewer-continued`，含逐行内联高亮）。
- B3 大文件保护：默认截断 2000 行 + "显示全部 N 行" 粘性底栏；超 5000 行退化成纯 `<pre>`（性能兜底）。
- B4 代码行内评论：点击行号弹内联输入框，"加入对话"生成 `code-comment` 引用（非持久化评论，只是聊天附件）。
- B5 markdown/代码选区 → 悬浮"加入对话"popover（选中文字自动生成 `code-selection` 引用）——文档已点名这条是文案 tab 的核心机制。
- B6 多个预览 tab 可同时开（按 `path+kind` 唯一键，同一文件的"查看"和"diff"是两个独立 tab）。
- B7 browser 模式：地址栏（前进/后退/刷新/URL 归一化）+ 截图按钮 + 选择元素（picker）按钮 + 缩放条（10% 步进，持久化每会话）+ 全屏 DOM 遮罩时自动隐藏原生视图（因为原生子视图永远盖在 DOM 之上）——文档已列为 P2，此次复核补充"缩放/截图/picker 是三个独立可点按钮，非一个综合工具条"的细节，供 P2 施工时照此拆分交互点。

**C. 明确"不算右侧面板"、容易混淆的邻近系统（施工时注意别混进 workbench 范畴）**
- C1 **终端面板是聊天列底部的独立 dock**（非右侧面板），有自己的拖拽手柄+Home/End 快捷键、独立 store，也能"展开成 tab"但跟 workbench 的展开是两套机制——终端属"范围外"（PTY 专属），仅记录避免施工时误合并两套面板状态。
- C2 `components/layout/StatusBar.tsx`：cc 里是**死代码**，全仓无人渲染它，不要把它当作参照实现。
- C3 `pages/SessionControls.tsx`：cc 里是**未接线的静态 mockup**（只用 mock 数据，`ContentRouter` 不路由到它），同样不要当作行为参照。

---
