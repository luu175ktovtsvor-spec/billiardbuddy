# 前端架构对齐 cc-haha:vanilla → React 迁移方案(施工蓝图)

> 📌 状态:🚧进行中 · 任务〈前端架构对齐 cc-React 迁移〉· 建于 2026-07-10
> owner 定调:**架构层面全部对标 cc-haha,含前端框架/语言**。目标 = 把现在的 vanilla JS 两文件前端(`ts/desktop/renderer/{index.html,app.js}`)整体迁到 cc-haha 那套 **React 18 + Vite + Tailwind + Zustand** 前端架构,以后像抄后端一样直接抄 cc 的前端组件、再换 WorkBuddy 皮。
> 参考代码:`~/Desktop/cc-haha-ref/desktop`(LICENSE 允许 copy/modify/distribute)。本仓库前端:`ts/desktop/renderer`;后端 sidecar:`ts/src/server`。
> 关联计划(别重复造):右侧预览面板 = `docs/plans/cc-haha右侧预览面板-对标与落地方案.md`(task#17);斜杠命令 = `docs/plans/cc-haha斜杠命令全搬-施工总图.md`。

---

## 0. 一句话结论(给赶时间的人)

- **cc 前端 = React 18.3 + TypeScript5 + Vite8 + Tailwind CSS 4(`@theme`)+ Zustand5**,无路由库(自研 tab 路由),Electron 壳 `loadFile(dist/index.html)` 加载,前端 **不进 sidecar 二进制**。
- **我们现状 = vanilla 两文件被 `with{type:'text'}` 内嵌进 sidecar 二进制**,Electron `loadURL(http://host:port/)` 从 sidecar HTTP 服务器拿前端。
- **最大难点(打包)的解法 = 照抄 cc:停止内嵌,Vite 打出 `dist/` 松散文件,Electron 直接 `loadFile` 它;React app 通过新增 IPC `getServerUrl` 拿到 sidecar 地址再 fetch/WS**。删掉 `embeddedFrontend.ts`。
- **迁移路径 = React 外壳大爆炸起地基,组件屏对屏并行抄**(不是把 React 塞进现有 app.js)。现有 vanilla 的 batch1/2 + 斜杠面板作"交互行为参照",不作代码移植源。
- **三分法**:交互/组件行为直接抄 cc 的 `.tsx`;配色换成 WorkBuddy 主题层(改 cc token 的**值**、保留 token 的**名**);用户文字走 i18n zh-CN(WorkBuddy 中文),去 Claude/Anthropic/Haha 字样、不暴露底层模型。

---

## 1. cc-haha 前端架构全貌

### 1.1 技术栈(`desktop/package.json` 实读)

| 维度 | cc-haha 选型 | 版本 | 备注 |
|---|---|---|---|
| 框架 | React + React DOM | `^18.3.1` | 函数组件 + hooks,`React.StrictMode` |
| 语言 | TypeScript | `^5.9.3` | strict、`noUncheckedIndexedAccess`、`jsx:react-jsx`、`@/*`→`src/*` |
| 构建 | **Vite** + `@vitejs/plugin-react` | `vite ^8` | `base:'./'`(file:// 相对路径必需),target `es2021/safari15` |
| 样式 | **Tailwind CSS 4** via `@tailwindcss/vite` | `^4.0.0` | **无 tailwind.config.js**;token 写在 `theme/globals.css` 的 `@theme{}` 块 + `@import "tailwindcss"` |
| 状态 | **Zustand** | `^5.0.3` | 每个域一个 store(共 43 个 store 文件),无 Redux/Context 大杂烩 |
| 路由 | **无第三方路由** | — | 自研:`tabStore`(标签页)+ `ContentRouter`(switch 分发 page) |
| 图标 | `lucide-react` + Material Symbols Outlined 字体 | — | 字体自托管 woff2(`public/fonts/`) |
| Markdown | `marked` + `dompurify` + `@tailwindcss/typography` | — | `components/markdown/MarkdownRenderer` |
| 代码高亮 | `shiki` + `react-shiki` + `prism-react-renderer` | — | `components/chat/CodeViewer` |
| 图表/数学 | `mermaid` `katex` | — | `MermaidRenderer` |
| Diff | `react-diff-viewer-continued` | — | `components/chat/DiffViewer` |
| 终端 | `@xterm/xterm` + `addon-fit` | — | 配 electron 主进程 `node-pty`(我们暂不需要,见白标取舍) |
| 拖拽 | `@dnd-kit/*` | — | 排序/拖放 |
| 其它 | `html2canvas` `qrcode` | — | 截图 / 移动端扫码 |
| i18n | 自研 `src/i18n`(locales) | — | `useTranslation()` hook + zh-CN/en 等 locale |
| 字体 | 自托管 Inter / Manrope / JetBrains Mono / Material Symbols | — | 无 Google CDN 依赖(离线可用,分发友好) |

**关键**:cc 的 Tailwind 是 v4「CSS-first」写法——不靠 config 文件,而是在 `globals.css` 用 `@theme{ --color-primary:#8F482F; ... }` 声明设计 token,组件里用 `bg-[var(--color-surface)]`、`text-[var(--color-text-primary)]` 这类任意值语法直接吃 CSS 变量。这一点对换皮极其友好(见 §6)。

### 1.2 目录结构(一句话)

`src/main.tsx`(bootstrap,动态 import + 启动看门狗)→ `App.tsx` → `components/layout/AppShell.tsx`(侧栏 + TabBar + ContentRouter 三段)→ `pages/*`(EmptySession / ActiveSession / Settings / ScheduledTasks / Trace…)→ `components/{chat,layout,shared,workbench,workspace,browser,controls,markdown,settings,skills,plugins,tasks,teams,trace}`;横向:`stores/*`(zustand 域 store)、`api/*`(REST + WS 客户端)、`lib/desktopHost/*`(IPC 桥)、`lib/*`(工具)、`hooks/*`、`theme/globals.css`(token)、`i18n/*`、`types/*`。

分层(自上而下):
```
index.html ─ CSP + 启动看门狗(8s 未挂载就渲染报错页)+ <div id=root> + <script src=/src/main.tsx>
  └ main.tsx ─ 动态 import App/ErrorBoundary/diagnosticsCapture/initializeTheme,createRoot().render
      └ App ─ 装通知导航 hook,渲染 <AppShell/>
          └ AppShell ─ bootstrap: initializeDesktopServerUrl()→fetchSettings()→restoreTabs();
                        左 Sidebar｜右 main(TabBar + ContentRouter)｜ToastContainer + UpdateChecker
              └ ContentRouter ─ 按 activeTab.type 分发:session→ActiveSession, settings→Settings,
                        scheduled→ScheduledTasks, trace→TraceSession, workbench→WorkbenchTab, terminal→TerminalSettings
                  └ ActiveSession ─ 主聊天屏:MessageList + ChatInput + SessionTaskBar + BackgroundTasksBar
                        + 右侧可选 WorkbenchPanel(点选预览)+ 底部可选 Terminal 面板
```

### 1.3 与后端/主进程怎么通信(三条线)

1. **REST**:`api/client.ts` — 可变 `baseUrl`(`setBaseUrl/getBaseUrl`)+ `authToken`,导出 `api.get/post/put/patch/delete`。默认 `http://127.0.0.1:3456`,超时 120s,失败上报 diagnostics。
2. **WebSocket**:`api/websocket.ts` — `WebSocketManager`,**每个 sessionId 一条 WS**,URL `ws://host/ws/<sessionId>?token=`,带 ping 心跳(30s)、指数退避重连、离线消息队列。
3. **Electron IPC 桥**:`lib/desktopHost/*` — 统一 `DesktopHost` 契约接口(`types.ts` 定义全部能力:runtime.getServerUrl / clipboard / dialogs / notifications / terminal / preview / window / updates / appMode…)。`electron/preload.ts` 用 `contextBridge.exposeInMainWorld('desktopHost', electronHost)` 注入;`browserHost.ts` 是无 `window.desktopHost` 时的浏览器兜底(移动端/H5 场景)。
   - **服务器地址发现**:`lib/desktopRuntime.ts` 的 `initializeDesktopServerUrl()` —— 桌面端调 IPC `host.runtime.getServerUrl()` 拿 sidecar URL → `setBaseUrl()` → 轮询 `/health`(要求返回 JSON `{status:'ok'}`)。浏览器/H5 端用 same-origin 或 query 参数 `serverUrl`+`token`。

> 这套「file:// 加载 + IPC 发现 server URL + 同一份 dist 又能被 sidecar 当 H5 网页 serve」的双运行时设计,是 cc「桌面 + 手机扫码同用一份前端」的根。我们起步只做桌面端,H5 companion 可后置。

---

## 2. 我们现状(实读)

### 2.1 前端 = vanilla 两文件

- `ts/desktop/renderer/index.html`(~33KB):`<style>` 里一整套 WorkBuddy `--wb-*` token(`:root` 基础层 + `:root[data-theme="dark"]` 深色重写),`<link>` favicon,末尾 `<script src=app.js>`。
- `ts/desktop/renderer/app.js`(~47KB):一个大文件,含 markdown/代码卡渲染(batch1/2)、斜杠命令面板、WS 连接、fetch 各接口。**用 same-origin 相对 URL**:`/agent/ws?conversationId=`、`/api/v1/agent/*`、`/sessions`、`/tasks`、`/api/settings`。

### 2.2 前端怎么被服务、怎么进包(当前)

- `src/server/embeddedFrontend.ts`:`import indexHtmlRaw from '../../desktop/renderer/index.html' with { type: 'text' }` + 同款 `app.js`,导出 `EMBEDDED_FRONTEND` map(`/index.html`、`/app.js`)。
- `src/server/index.ts` 的 `serveFrontendAsset(pathname)`(~L983):先文件系统查找,失败回退 `EMBEDDED_FRONTEND`;catch-all(~L4455)兜所有非 API 路径。
- **为什么要内嵌**:sidecar 是 `bun build --compile` 出的单二进制,运行时 `import.meta.dir` 指向虚拟 bunfs,读不到真实磁盘文件;不内嵌 → 打包后首页 404。
- Electron:`desktop/electron/main.ts` 自己 `reserveServerPort` 抢端口 → `startSidecar` → `mainWindow.loadURL('http://127.0.0.1:'+serverPort+'/')`(L113)。**即前端从 sidecar 的 HTTP 服务器加载,不是本地文件。**
- 打包:`electron-builder.yml` — `files` 里 `desktop/renderer/**/*` 也进了 asar(但当前运行时走 sidecar URL,不是 loadFile);sidecar 二进制走 `extraResources: desktop/binaries → resources/binaries`。

### 2.3 现状 vs cc 的根本差异(一张表)

| 环节 | 我们现状 | cc-haha | 迁移后(目标) |
|---|---|---|---|
| 前端形态 | vanilla 2 文件 | React/Vite 多文件 bundle | React/Vite 多文件 bundle |
| 进包方式 | 内嵌进 sidecar 二进制 | Vite `dist/` 松散文件进 asar | **同 cc:`dist/` 松散文件进 asar** |
| Electron 加载 | `loadURL(sidecar http)` | `loadFile(dist/index.html)` | **同 cc:`loadFile`** |
| server URL 发现 | 前端 same-origin 相对路径 | IPC `getServerUrl` + `setBaseUrl` | **同 cc:IPC 发现** |
| sidecar 职责 | 后端 + serve 前端 | 仅后端(可选 serve H5) | 仅后端(H5 后置) |

---

## 3. 最大难点:React bundle 怎么进我们的 sidecar/electron 包(推荐解法)

### 3.1 难在哪

现在靠 `with{type:'text'}` 把 **2 个文本文件**塞进 sidecar 二进制。React 是 **一坨构建产物**(`index.html` + 若干 hash 命名的 `.js`/`.css` + 字体/图片资源),没法逐个 `with{type:'text'}` 内嵌——这条不解决,整个迁移落不了地。

### 3.2 推荐方案:照抄 cc,**不再内嵌,改 loadFile**

**核心动作:让 Electron 直接加载 Vite 打出的本地 `dist/`,前端通过 IPC 拿 sidecar 地址。** sidecar 从此只做后端,前端与它彻底解耦。

具体步骤(属于「地基」,见 §7):

1. **Vite 输出目录避让**。cc 的 Vite 输出是 `desktop/dist`,但我们 `electron-builder.yml` 的 `output` 已经是 `desktop/dist`(装 `.app` 的目录),**会撞车**。→ Vite 输出改到 `ts/desktop/renderer-dist/`(或 `web-dist/`),`vite.config.ts` 里 `build.outDir` 指定,`base:'./'` 照抄。
2. **Electron 换 loadFile**。把 `main.ts` 的 `loadURL(sidecar)` 换成照抄 cc 的 `resolveRendererEntry` + `loadRendererEntry`:
   - packaged:`loadFile(join(appRoot,'renderer-dist','index.html'))`;
   - dev:读 `ELECTRON_RENDERER_URL`(Vite dev server `http://127.0.0.1:1420`)走 HMR,仅允许 loopback。
3. **新增 IPC `runtime:getServerUrl`**。`main.ts` 已经 `reserveServerPort` 拿到 `serverPort`;加一个 `ipcMain.handle('runtime:getServerUrl', ()=>`http://127.0.0.1:${serverPort}`)`,`preload` 里 `contextBridge` 暴露成 `window.desktopHost.runtime.getServerUrl()`(对齐 cc 的 `DesktopHost` 契约)。React app 的 `initializeDesktopServerUrl()` 就能拿到并 `setBaseUrl`。
4. **打包清单**。`electron-builder.yml` 的 `files` 把 `desktop/renderer/**/*` 换成 `desktop/renderer-dist/**/*`;sidecar `extraResources` 不变。
5. **删内嵌**。删 `src/server/embeddedFrontend.ts` + `index.ts` 里对 `EMBEDDED_FRONTEND` 的 import/兜底;`serveFrontendAsset` 可整段删(桌面不再用),或留着改成读磁盘上的真实 `renderer-dist`(仅当以后要 H5 companion 才需要,起步不做)。
6. **CSP**。照抄 cc 的 `index.html` CSP,尤其 `connect-src` 要放行 `http://127.0.0.1:* http://localhost:* ws://127.0.0.1:* ws://localhost:*`(file:// 页面要连本地 sidecar)。`base:'./'` 保证 file:// 下相对资源路径正确。

**为什么不选「继续让 sidecar serve 一个 React dist」**:那需要把整份 dist 塞进单二进制(内嵌)或让 sidecar 从磁盘读 `renderer-dist`(extraResources)。前者对多文件 bundle 不现实;后者能做但和 cc 架构分叉、且要维护一套 dev/prod 路径解析,收益只有「未来 H5」——起步不值当。**loadFile 是 cc 的标准做法,直接对齐最省心。**

### 3.3 与 `bun build --compile` 的关系(澄清)

`bun build --compile` 只编 **后端 sidecar**(`backend-sidecar.ts` → 单二进制,`build-sidecar.ts` 不变)。React 前端**完全不经过 bun compile**,走 Vite build。两条产线彻底分离——这正是解耦的意义。electron-builder 把「Vite dist(asar 内)+ sidecar 二进制(extraResources)」一起打进 DMG/EXE。

---

## 4. app 骨架 + 与后端通信(复用现有契约,别改后端)

React app 入口/外壳直接抄 cc(`main.tsx`/`App.tsx`/`AppShell`/`ContentRouter`),**唯一要改的是 `api/*` 这层适配我们后端契约**——后端 `/agent/ws`、`/api/v1/*` 不动。

### 4.1 后端契约适配点(api 层是唯一改动面)

| cc 客户端 | cc 约定 | 我们约定(实读 `src/server/index.ts`) | 适配动作 |
|---|---|---|---|
| `api/websocket.ts` `buildSessionWebSocketUrl` | `ws://host/ws/<sessionId>?token=` | **`ws://host/agent/ws?conversationId=<id>&after=<n>`**(单端点,conversationId 走 query) | 改 URL 构造:path 用 `/agent/ws`,加 `conversationId`/`after` query |
| `api/client.ts` `baseUrl` | 默认 `http://127.0.0.1:3456` | 我们 sidecar 端口 `8850/8851/8852/8877` 之一(动态) | 默认值改我们首选端口;实际以 IPC `getServerUrl` 为准 |
| REST 路径 | `/api/*`、`/sessions`、`/ws` | `/api/v1/agent/*`、`/sessions`、`/tasks`、`/api/settings`、`/api/v1/*`(大量域路由) | 各 `api/*.ts` 里的路径逐个对齐我们的真实路由 |
| `/health` | 返回 JSON `{status:'ok'}` | 需核对我们 `/health`(index.ts L919)返回形状 | 若不是 `{status:'ok'}` JSON,二选一:改 `waitForHealth` 判定 或 让后端对齐(推荐后端对齐,省得改客户端) |
| WS 事件 schema | cc 的 `types/chat` `ServerMessage/ClientMessage` | 我们 `/agent/ws` 的实际事件(content-block 流) | **最高风险适配**:`chatStore` 的消息 reducer + `types/chat` 必须按我们 `/agent/ws` 真实 payload 逐字段对齐(见 §4.2) |

### 4.2 ⚠️ 最高风险:chatStore 消息协议对齐

cc 的 `chatStore` + `types/chat` 是围绕 cc 的 WS 事件流写的。我们后端内核虽也照 cc 移植(content-block),但 **WS 端点形状不同(`/agent/ws?conversationId=` vs `/ws/<id>`)、事件包装可能有差异**。

施工要求:
1. 先读透我们 `src/server/index.ts` 里 `/agent/ws` 的 upgrade 处理(L3053 附近)+ 它 push 的每种事件 payload。
2. 以 cc 的 `chatStore`/`types/chat` 为**目标结构**抄过来,然后逐事件 reconcile 到我们的真实 payload(消息增量、工具 use/result、thinking、审批请求、todo、token usage、goal 状态等)。
3. 这是**地基 Block 0 里最费时、最容易埋雷的一步**,必须由起地基的那个 agent 亲自做,不外包;做完要拿真后端跑通「发一句 → 流式出字 → 工具卡 → 结束」的端到端再宣布地基完成。

### 4.3 现有 vanilla 交互作"行为参照"

我们 app.js 里已经打磨过的 batch1/2(markdown/代码卡渲染)、斜杠命令面板(输入 `/` 弹命令、过滤/↑↓/Enter/Tab/Esc)、权限/审批卡逻辑,**是交互细节的验收基线**——抄 cc 组件时对照它,别把已有的交互细节弄丢。但**不移植 app.js 的代码**,只当「必须复现的行为清单」。

---

## 5. 组件抄运表(切成互不重叠的并行块)

**类别标注**:🟢 直接抄换皮(照抄 cc `.tsx`,只换 token/文案)· 🟡 白标适配(抄但要去 Claude/改产品语义/删登录)· 🔵 我们特有(cc 无,自建)· ⚪ 我们不抄(cc 有但我们产品不需要,起步跳过)。

> 依赖基座:所有块都依赖【地基】产出的 `stores/{ui,tab,session,chat,settings}` + `api/{client,websocket}` + `theme` + `shared/` 原语 + `i18n`。块内文件互不重叠,可 N 个 agent 并行。

### Block 0 —【地基·必须先做一次】见 §7,不并行

### Block A — 聊天流渲染核心 🟢
- **负责组件(cc 源 → 我们 target,同名照抄)**:`chat/MessageList`、`chat/AssistantMessage`、`chat/UserMessage`、`chat/MessageActionBar`、`chat/StreamingIndicator`、`chat/ThinkingBlock`、`chat/chatBlocks`、`markdown/MarkdownRenderer`、`chat/CodeViewer`、`chat/DiffViewer`、`chat/MermaidRenderer`、`chat/ContextUsageIndicator`、`chat/InlineImageGallery`、`chat/InlineVideoGallery`、`chat/ImageGalleryModal`、`chat/AttachmentGallery`。
- **新文件**:`src/components/chat/*`、`src/components/markdown/*` + 依赖库(marked/dompurify/shiki/react-shiki/mermaid/katex/react-diff-viewer-continued)。
- **依赖基座**:`chatStore`、`theme`、`shared/CopyButton`。
- **行为参照**:app.js batch1/2 渲染。

### Block B — 工具调用 & 审批卡 🟢/🟡
- `chat/ToolCallBlock`、`chat/ToolCallGroup`、`chat/ToolResultBlock`、`chat/PermissionDialog`、`chat/PlanModePermissionDialog`、`chat/PlanModePreview`、`chat/CurrentTurnChangeCard`、`chat/AskUserQuestion`、`controls/PermissionModeSelector`。(`chat/ComputerUsePermissionModal` ⚪ 起步跳过,除非要 computer-use。)
- **依赖**:`chatStore`。
- **行为参照**:app.js 审批卡(原因 what/why/impact + 破坏性警告 + 卡内 diff)、权限五档用词照搬 cc(逐项确认/自动接受修改/跳过确认)。
- **白标**:审批只卡对外/不可逆/花钱;生图不弹审批(去钱味,产品红线)。

### Block C — 输入区(composer)& 斜杠面板 🟢
- `chat/ChatInput`、`chat/composerUtils`、`chat/sendShortcut`、`chat/useComposerFileDrop`、`chat/ComposerDropOverlay`、`chat/LocalSlashCommandPanel`、`chat/FileSearchMenu`、`chat/clipboard`、`controls/ModelSelector`。
- **依赖**:`chatStore` + 新 `slashStore`(斜杠命令)。
- **后端**:`/api/v1/agent/commands`、`/api/v1/agent/fs/list|read`、`/api/v1/agent/packs`。
- **行为参照**:app.js 斜杠面板(已在 vanilla 完整实现,交互细节全在那)+ `docs/plans/cc-haha斜杠命令全搬-施工总图.md`。
- **白标**:`ModelSelector` 不暴露底层模型/供应商名。

### Block D — 会话/侧栏详情/标签/任务条 🟢
- `layout/Sidebar`(富内容,shell 在地基)、`layout/OpenProjectMenu`、`chat/SessionTaskBar`、`chat/BackgroundTasksBar`、`chat/InlineTaskSummary`、`pages/EmptySession` 详情、`shared/ProjectContextChip`、`shared/RepositoryLaunchControls`、`shared/DirectoryPicker`。
- **依赖基座**:`sessionStore`(全量)、`tabStore`、新 `cliTaskStore`/`taskStore`。
- **后端**:`/sessions`、`/tasks?conversationId=`、`/api/v1/agent/workspace-status`。

### Block E — 右侧预览面板 / 工作台 / 浏览器 🔵/🟢 → **归口到已有计划**
- `workbench/*`、`workspace/*`、`browser/*`、`lib/previewBridge`、`lib/previewEvents`、`lib/previewLinkRouter`、electron `services/preview`(主进程 `WebContentsView`)。
- **⚠️ 这就是 task#17,已有独立方案 `docs/plans/cc-haha右侧预览面板-对标与落地方案.md`——本块只做对齐引用,不在此展开、不重复设计。**
- **我们特有 🔵**:生图海报预览卡挂在这一区(cc 无对应,自建适配)。

### Block F — 设置面板 🟡(白标最重)
- `pages/Settings` + `pages/{TerminalSettings,AdapterSettings,ActivitySettings,DiagnosticsSettings,McpSettings,MemorySettings,ComputerUseSettings}`、`components/settings/*`、`components/skills/*`、`components/plugins/*`、`components/tasks/*`(定时任务)、对应 store(`providerStore`/`mcpStore`/`memoryStore`/`skillStore`/`pluginStore`/`taskStore`)。
- **白标/取舍**:
  - ⚪ **删**:`settings/ClaudeOfficialLogin`、`settings/ChatGPTOfficialLogin`、`api/hahaOAuth*`、`stores/hahaOAuth*`(我们内置 key 走网关、免登录,不给用户登第三方账号)。
  - ⚪ **起步跳过**:`teams/*`+`pages/AgentTeams`、`trace/*`+`pages/Trace*`、adapters(feishu/telegram/wechat/dingtalk/whatsapp)——我们产品形态不同,按需再评估。
  - 🟡 保留但改语义:模型设置(不暴露底层)、MCP、记忆、技能、定时任务、诊断。

### Block G — 共享原语 & hooks 🟢(**大部分并入地基**)
- `shared/{Button,Modal,Dropdown,Input,Textarea,Toast,Spinner,ConfirmDialog,ConfirmPopover,CopyButton,ActionDialog,MobileBottomSheet}`、`hooks/*`、`common/*`、`components/ErrorBoundary`。
- **说明**:`shared/` 是所有块的地基,应在 Block 0 一并抄完(或紧随 0 的第一优先块),不能拖到后面并行。

### Block H — 我们特有 🔵(无 cc 对应)
- 生图海报预览卡(与 Block E 配合)、台球领域包挂载 UI(SessionStart 挂 `billiards`)、video-edit 剪辑编排面板。
- **依赖**:全部基座就绪后自建;参照 `docs/plans/video-use-*`、`docs/plans/生图人像优化-*`。

---

## 6. 三分法落法(交互抄 cc / 配色 WorkBuddy / 文字 WorkBuddy 中文)

### 6.1 交互机制 & 组件行为 = 直接抄 cc 的 `.tsx`
LICENSE 允许 copy/modify。组件逻辑、hooks、store 结构照搬,唯一改动是 §4 的 api 适配层 + 下面两项皮。

### 6.2 配色 = WorkBuddy token 主题层(改值不改名)
- cc 组件全用 `var(--color-*)` 语义 token(`--color-surface`/`--color-text-primary`/`--color-primary`/`--color-border`…),定义在 `theme/globals.css` 的 `@theme{}` + `:root`/`[data-theme="dark"]`。cc 的品牌主色是 `#8F482F`(赤陶色)。
- **落法**:抄 cc 的 `globals.css`,**保留全部 token 名**,只把 `@theme{}` 和 `:root` 里的**值**换成 WorkBuddy 调色板。我们现有 `index.html` 的 `--wb-*`(brand `#00C29A` / gray 阶 / 黑白透明阶 / 圆角 / 动效)已是成熟一套,直接映射到 cc 的 `--color-*` 语义名:
  - `--color-primary/--color-brand` ← `--wb-brand-light`(`#00C29A`)
  - `--color-surface/-container*` ← `--wb-gray-l*` / `--wb-bg-*`
  - `--color-text-primary/secondary/tertiary` ← `--wb-text-*`
  - `--color-border` ← `--wb-border`,`--color-success/error/warning` ← `--wb-*`
- 建议新增 `src/theme/workbuddy-tokens.css`,在 `globals.css` 之后 `@import`,集中覆盖,便于「抄 cc 新组件后一次性套皮」。深色走 `:root[data-theme="dark"]`,和我们现在的分层一致。
- 依据:`docs/references/竞品拆解/02-前端设计-配色与质感.md` + 现有 `index.html` `:root --wb-*` + `docs/design/桌面Agent-macOS设计规范.md`。

### 6.3 用户可见文字 = i18n zh-CN(WorkBuddy 中文)+ 去底层字样
- cc 已有 `src/i18n`(`useTranslation()` + locales)。抄组件时文案已是 `t('key')`。**只需产出/维护一份 zh-CN locale**,用 WorkBuddy 中文写法填 key。
- **去 Claude/Anthropic/Haha 白标点**:app 名 `Claude Code Haha`→`球房管家`(`index.html <title>`、window title、`main.tsx` 的 `__CC_HAHA_*` 全局名可保留内部名但 UI 文案换)、空态 hero 的 `app-icon.png` 换我们图标、`StartupErrorView`/启动看门狗英文文案换中文、权限用词照搬 cc 中文口径。
- 白标铁律:不向客户端暴露底层模型/供应商(`ModelSelector` 只显示我们的展示名)。

---

## 7. 地基 vs 可并行(明确边界)

### 7.1 【地基】必须先做一次的耦合底座(串行,一个 agent 主导,做完才放并行)
1. **构建产线**:`vite.config.ts`(outDir=`renderer-dist`,base `./`)+ Tailwind4(`@tailwindcss/vite`)+ `desktop/package.json` 前端依赖(React/Vite/Tailwind/Zustand/marked/shiki/… 一套)+ `tsconfig`(jsx/paths)+ `index.html`(CSP + 启动看门狗 + `#root` + main.tsx)。
2. **打包/加载切换(§3 全套)**:Electron `main.ts` 换 `resolveRendererEntry`+`loadFile`;新增 IPC `runtime:getServerUrl` + preload 暴露 `window.desktopHost`;`electron-builder.yml` `files` 换 `renderer-dist/**`;**删 `embeddedFrontend.ts` + serveFrontendAsset 兜底**。
3. **app 外壳**:`main.tsx`、`App.tsx`、`components/layout/{AppShell,Sidebar(壳),TabBar,TitleBar,StatusBar,WindowControls,ContentRouter}`、`ErrorBoundary`、`StartupErrorView`、`H5ConnectionView`(可留空壳)。
4. **主题层**:`theme/globals.css`(抄 cc)+ `theme/workbuddy-tokens.css`(套 WorkBuddy 值)+ 自托管字体(或先用系统字体兜底)。
5. **后端接缝(§4)**:`api/client.ts`(默认端口改我们的)、`api/websocket.ts`(URL 改 `/agent/ws?conversationId=`)、`lib/desktopRuntime.ts`、`lib/desktopHost/*`(electronHost/browserHost/types/index)。
6. **核心 store**:`stores/{uiStore,tabStore,sessionStore,chatStore,settingsStore}`——其中 **`chatStore` 的消息协议对齐是最高风险(§4.2)**。
7. **共享原语 + i18n**:`shared/*` 全套、`hooks/*`、`i18n` scaffold + zh-CN 种子 locale。
8. **验收地基完成 = 拿真后端跑通端到端**:Electron 起 → sidecar 起 → React 从 file:// 加载 → IPC 拿到 server URL → 发一句话 → WS 流式出字 → 至少一个工具卡渲染 → 结束。这一步过了,才允许并行铺 A–H。

### 7.2 【可并行】地基好了就能并行铺开的组件块
Block A(聊天流渲染)、Block B(工具/审批卡)、Block C(输入区/斜杠)、Block D(会话/侧栏/任务)、Block F(设置)、Block H(我们特有)可各派一个 agent 并行——文件互不重叠,共享基座只读。Block E(右侧预览)走它自己的已有计划(task#17)独立推进。建议并行优先级:A→C→B→D 先出可用聊天闭环,F/E/H 随后。

---

## 8. 迁移路径推荐:React 外壳大爆炸起地基 + 组件屏对屏并行

**推荐 = 「地基大爆炸 + 组件渐进并行」的混合**,不是纯大爆炸、也不是把 React 塞进 app.js 的纯渐进。

- **为什么不能纯渐进(React 嵌进现有 vanilla)**:两者共用一个 `index.html`/一条 WS,框架不同没法半挂载;而且加载方式要从 `loadURL(sidecar)` 切成 `loadFile(dist)`,是一次性切换,天然是「换壳」。
- **为什么不纯大爆炸(全部重写完再上)**:cc 前端体量巨大(chat 62 文件、stores 43、api 34、pages 28…),一次性全抄再上线周期太长、风险集中。
- **推荐做法**:
  1. 先把 §7.1 地基一次性立起来(含一个能跑通的最小聊天屏)——这一步是大爆炸的「壳 + 管线」。
  2. 之后 A–H 组件屏对屏并行填充,每块独立可验收。
  3. 现有 vanilla app.js 的 batch1/2 + 斜杠面板作**行为参照迁进 React**(照着复现交互,不搬代码)。
- **风险兜底(过渡期回退)**:Electron 用 env 开关决定加载 `renderer-dist`(React)还是旧 sidecar URL(vanilla)。React 未达 parity 前,默认可留 vanilla;地基验收过后再把默认切 React。旧 vanilla 两文件 + embeddedFrontend 在 React 达 parity、正式切换后再 `git rm`(对齐文档铁律:过时即删不归档)。

---

## 9. 返回给 owner(结构化回执)

1. **cc 前端栈**:React 18.3 + TypeScript 5.9 + **Vite 8** 构建 + **Tailwind CSS 4(`@theme` CSS-first,无 config)** 样式 + **Zustand 5** 状态;无第三方路由(自研 tabStore + ContentRouter switch);Electron `loadFile(dist)` 加载、前端不进 sidecar 二进制。目录:`main.tsx→App→AppShell(Sidebar+TabBar+ContentRouter)→pages/*→components/{chat,layout,shared,workbench,...}`,横向 `stores/ api/ lib/desktopHost/ theme/ i18n/`。
2. **最大难点(打包)推荐解法**:**停止把前端内嵌进 sidecar 二进制**,改照抄 cc——Vite 打 `dist/`(输出目录改 `renderer-dist` 以避让 electron-builder 的 `desktop/dist`),Electron `loadFile` 加载,React 通过新增 IPC `runtime:getServerUrl` 拿 sidecar 地址再 fetch/WS。删 `embeddedFrontend.ts`。sidecar 从此只做后端。
3. **抄运表并行块**:切成 **Block 0 地基(串行)+ A 聊天流 / B 工具审批 / C 输入斜杠 / D 会话侧栏 / E 右侧预览(归口 task#17)/ F 设置 / G 共享原语(并入地基)/ H 我们特有** 共 8 块,A–D/F/H 地基后可并行。
4. **推荐迁移路径**:**地基大爆炸(壳+管线+最小聊天屏)+ 组件屏对屏并行**;不纯渐进(框架不同没法半挂载)、不纯大爆炸(体量太大风险集中);过渡期用 env 开关保留 vanilla 回退。
5. **先做一次的地基**:构建产线 / loadFile+IPC 打包切换(删内嵌)/ app 外壳 / WorkBuddy 主题层 / 后端接缝(api+ws 适配我们路由)/ 核心 store(chatStore 协议对齐=最高风险)/ 共享原语+i18n;验收 = 拿真后端跑通「发话→流式→工具卡→结束」。
6. **蓝图路径**:`docs/plans/前端架构对齐cc-React迁移方案.md`(本文件)。
7. **确认**:全程只读调研,**未改任何代码/配置文件**(package.json、renderer、electron、构建脚本一律没动),仅新建了本份蓝图 md。

---

## 附:关键文件坐标(施工直接查)

**cc-haha 参考**(`~/Desktop/cc-haha-ref/desktop/`):
- 构建:`package.json`、`vite.config.ts`、`tsconfig.json`、`index.html`
- 加载/打包:`electron/main.ts`(`resolveRendererEntry`/`loadFile`/IPC 注册)、`electron/services/rendererEntry.ts`、`electron/services/serverRuntime.ts`、`electron/preload.ts`、`scripts/build-sidecars.ts`
- 入口/外壳:`src/main.tsx`、`src/App.tsx`、`src/components/layout/AppShell.tsx`、`src/components/layout/ContentRouter.tsx`
- 通信:`src/api/client.ts`、`src/api/websocket.ts`、`src/lib/desktopRuntime.ts`、`src/lib/desktopHost/{index,types,electronHost,browserHost}.ts`
- 主题:`src/theme/globals.css`(`@theme` token + `:root`/`[data-theme]`)
- 主屏:`src/pages/ActiveSession.tsx`(聊天列 + 右侧 workbench + 底部 terminal)

**我们本仓库**(`ts/`):
- 现状前端:`desktop/renderer/{index.html,app.js}`
- 内嵌/服务:`src/server/embeddedFrontend.ts`、`src/server/index.ts`(`serveFrontendAsset` L983、`/agent/ws` L3053、catch-all L4455)
- Electron:`desktop/electron/main.ts`(`loadURL` L113、`reserveServerPort`、IPC 注册 L220)、`desktop/electron/preload.ts`
- 构建/打包:`desktop/scripts/build-sidecar.ts`、`desktop/sidecars/backend-sidecar.ts`、`electron-builder.yml`、`package.json`(scripts:`desktop:build`/`build:sidecar`/`desktop:dist`)
- 皮/设计:`docs/references/竞品拆解/02-前端设计-配色与质感.md`、`docs/design/桌面Agent-macOS设计规范.md`、`index.html` 内 `--wb-*` token
