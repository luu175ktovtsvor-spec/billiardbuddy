# cc-haha 右侧预览面板 — 对标与落地方案（task #17）

> 📌 状态：🚧进行中 · 任务〈task#17 右侧交互预览抄 cc preview-agent〉· 最后核对 2026-07-09
>
> **面向后续实现子代理。** 这份是"照着施工"的方案，不是概念稿。三分法铁律贯穿每一块：**交互机制照抄 cc-haha / 颜色走 WorkBuddy `var(--wb-*)` / 用户可见文字走 WorkBuddy 中文、去 Claude 字样、白标不暴露底层来源**。
>
> 关键源码坐标（本方案所有"照抄"都指向它们，实现时去这些文件对原文）：
> - cc-haha 右侧面板：`~/Desktop/cc-haha-ref/desktop/src/components/workbench/WorkbenchPanel.tsx`、`components/workspace/WorkspacePanel.tsx`、`components/browser/BrowserSurface.tsx`、`pages/ActiveSession.tsx`（第 651–663 行是右侧 `<aside>` 挂载点）
> - 点选就地改（crown jewel）：`~/Desktop/cc-haha-ref/desktop/src/preview-agent/*`（`index.ts` / `picker.ts` / `editBubble.ts` / `selector.ts` / `metadata.ts` / `screenshot.ts` / `bridge.ts` / `protocol.ts`）
> - 宿主/传输/安全：`desktop/electron/services/preview.ts`、`electron/preview-preload.ts`、`electron/ipc/previewMessage.ts`、`electron/ipc/channels.ts`
> - 选区→对话的胶水：`desktop/src/lib/previewEvents.ts`、`lib/selectionComposer.ts`、`lib/assistantOutputTargets.ts`、`lib/handlePreviewLink.ts`、`lib/previewLinkRouter.ts`、`lib/htmlPreviewPolicy.ts`
> - 我们的落点：`ts/desktop/renderer/index.html` + `ts/desktop/renderer/app.js`（vanilla JS 单文件渲染器）、`ts/desktop/electron/main.ts` + `preload.ts`、`ts/src/server/index.ts`
> - 设计真相源（视觉/布局以它为准）：`docs/design/mockups/agent-preview.html` + `docs/design/桌面Agent-macOS设计规范.md` §4.5

---

## 0. 一句话结论

cc-haha 右侧那一整套 = **一个可开关的第三栏「工作台/预览面板」**，内部有两大 surface：**① 文件工作区预览**（图片 / 代码 / diff / markdown，其中 markdown 支持"选一段塞回对话"）和 **② 原生浏览器预览**（localhost 开发服务器 / 本地 HTML / 远程页），浏览器 surface 里藏着**点选就地改**——注入一个 `preview-agent` 脚本到被预览页，鼠标点中任意 DOM 元素 → 弹小面板改样式/文本 → 确认后把「圈选标注截图 + selector + 用户备注」直接当成一条消息发给模型，模型据此改本地前端源码。外加一条**内容管道**：从助手正文里认出"产出物"（海报/HTML/localhost/图片）→ 渲成卡片 → 点开进面板预览。

我们要落的，是把这套的**机制**搬过来，但**外壳按我们自己的设计**（`agent-preview.html` 那张三栏图：右侧 440px，`📝 文案 / 🎨 海报 / 📊 报表` 三标签 + 底部 `保存到本机 / 基于此调整 / 重新生成`），并把 owner 特别要的 **生图产物→右侧预览→点选/迭代** 打通进去。

**重要架构叉（P0 就要拍板）**：cc-haha 用的是 **Electron 原生 `WebContentsView` 子视图**（不是 iframe）承载被预览页。我们的渲染器是 vanilla JS、同源从 sidecar 加载。**P0/P1 走"同源 sandboxed iframe + postMessage"**（能覆盖我们自家生成的 HTML/海报/文案/报表，不动 Electron 主进程，还能在纯浏览器里跑）；**P2 再上原生 `WebContentsView`**（覆盖跨域/远程/localhost 开发服务器 + 原生截图）。详见 §5 卡点 1。

---

## 1. cc 右侧面板能力全清单（逐条：内容类型 / 交互 / 机制 / 归类）

归类三档：**【直接抄】**机制照搬；**【白标适配】**机制照搬但文案/命名/来源要改成 WorkBuddy 中文 + 白标；**【我们特有】**cc 没有、我们设计要的（主要是生图预览迭代 + artifacts 持久化）。

### 1.1 面板骨架与布局
| 能力 | cc 实现 | 归类 |
|---|---|---|
| 可开关的第三栏（右侧 `<aside>`，随会话开/关/记宽度） | `ActiveSession.tsx` L651-663 挂 `WorkbenchPanel`；`workspacePanelStore` 存 `isPanelOpen/width/mode`；`WorkspaceResizeHandle` 拖拽改宽 | 【直接抄】机制；宽度我们用设计的 **440px**、拖拽区间照抄 |
| 面板头「模式切换」 | cc 是 `文件工作区 ↔ 浏览器`（`WorkbenchPanel.tsx` MODE_ITEMS）；**我们改成 `📝 文案 / 🎨 海报 / 📊 报表`**（设计 §4.5） | 【白标适配】切换机制抄、标签换我们的 |
| 面板可"展开成整页 Tab" | `WorkbenchTab` + `tabStore.openWorkbenchTab` + `ContentRouter` | 【直接抄】P2 可选，非核心 |
| 关闭 ✕ 退回双栏 | `closePanel` | 【直接抄】 |

### 1.2 内容类型（预览什么）
| 内容类型 | cc 在哪渲染 | 机制 | 归类 |
|---|---|---|---|
| **图片** | `WorkspacePanel.tsx` `ImagePreview`（L741）→ `<img>` | 直接 `<img src>`；我们叠"Quick Look 灰底取景 + 尺寸标"（设计） | 【白标适配】海报 tab 的主体 |
| **代码/文本** | `WorkspacePanel` 代码视图（行数上限 + "显示全部已加载行"，L470+） | 纯文本按行渲染、超限折叠 | 【直接抄】 |
| **代码 diff** | `DiffViewer.tsx`（红加/绿删） | 我们 `app.js` 已有 `renderUnifiedPatch`/`.diff` 样式，直接复用 | 【直接抄】（我们已有等价物） |
| **Markdown** | `MarkdownRenderer.tsx`，且**支持选中一段 → 塞回对话**（`onAddSelection`） | marked 渲染 + 选区 popover | 【直接抄】机制；文案 tab 用它 |
| **网页 / HTML / localhost** | `BrowserSurface.tsx` 原生子视图 | 见 §1.4 | 【直接抄】机制（P2 上原生） |
| **office/表格/pdf** | `WorkspaceFileOpenWith`/canvas 系列 | cc 走 openWith；**我们服务端已有 `/api/v1/canvas/{doc,sheet,excel-edit,doc-blocks}`** 可直接用 | 【我们特有优势】报表 tab 用它 |
| **视频** | `InlineVideoGallery`/`assistantOutputTargets` 认 `mp4/webm` | 我们剪辑是自家产品、不对标 cc，仅认产物即可 | 【我们特有】 |

### 1.3 内容管道（正文认产物 → 卡片 → 预览）
| 能力 | cc 实现 | 归类 |
|---|---|---|
| 从助手正文抽"产出物" | `assistantOutputTargets.ts`（775 行）：正则抽 `markdown-link / plain-url / plain-path`，认 `local-html / localhost-url / image / video / markdown` 五类，**并用本轮真实改动文件 `changedFiles` 校正**（`index.html` 修正成真的 `todo-app/index.html`，没改过的丢弃） | 【直接抄】机制（这是"从正文认产物→卡片"的核心，reference 05 §⑥ 点名要抄） |
| 产出物卡片 | `AssistantOutputTargetCard.tsx`：图标 + 标题 + 类型角标 + `打开`(→`handlePreviewLink`) + `用其它应用打开`(OpenWith) | 【白标适配】卡片抄、角标文案换中文（文案/海报/报表/网页/图片） |
| 链接路由 | `previewLinkRouter.ts`（classify: browser-localhost/browser-file/file-preview/remote/ignored）+ `handlePreviewLink.ts`（分发到 浏览器/文件预览/外链/OpenWith）+ `htmlPreviewPolicy.ts`（静态 HTML 直预览 vs 框架模板走源码视图，靠有没有 `package.json/vite.config.*` 兄弟文件判） | 【直接抄】纯逻辑，边界很刁钻、别自己造 |

### 1.4 原生浏览器预览 surface（`BrowserSurface.tsx`）
| 能力 | cc 实现 | 归类 |
|---|---|---|
| 承载被预览页 | 主进程 `ElectronPreviewService`（`preview.ts`）建 `WebContentsView`，`contentView.addChildView`，`computeWebviewBounds` 把它精准盖在面板区；渲染层只报 bounds、原生视图渲染在 DOM 之上 | 【直接抄】机制（P2） |
| 地址栏 / 前进后退 / 刷新 / 缩放 | `BrowserAddressBar` + `browserPanelStore`（history/historyIndex/zoom 0.5–1.5） | 【白标适配】P2；aria-label 换中文 |
| **截图**按钮 | `previewBridge.message({type:'capture',kind:'full'})` → 主进程 `capturePage()` 原生截图 → 回灌成 composer 附件 | 【直接抄】机制 |
| **选择元素**（picker）按钮 | 见 §2 点选就地改 | 【直接抄】机制 |
| 本地预览就绪探测 | `waitForLocalPreview`（HEAD 探 `/preview-fs//local-file` 2.5s）+ 15s 兜底收 loading | 【直接抄】纯逻辑 |
| 全屏 overlay 时隐藏原生视图 | `overlayStore.count>0` → `setVisible(false)`（原生视图永远盖在 DOM 之上，弹窗会被它挡） | 【直接抄】这是原生视图路线的必踩坑，P2 注意 |

### 1.5 生图产物预览 + 迭代（【我们特有】，owner 特别点名）
cc 没有"生图→右侧预览→点选迭代"这条完整闭环（它只把图当产出物卡片）。我们的设计（`agent-preview.html` + §4.5）要：
- 系统跑出一张海报 → 右侧 **海报 tab** 大图预览（实际比例 9:16、灰底取景、底部尺寸标 `9:16 · 1152×2048 · medium`）；
- 底部工具条：`⤓ 保存到本机`（服务端 `/api/v1/canvas/save-to-library` 或直接下载 `/uploads/posters/*`）、`✎ 基于此调整`（refine_from：以此图为参考重生，走 media 生图）、`↻ 重新生成`；
- **点选迭代**：用户对图不满意 → 在图上**框选一块区域** + 说人话（"这里字太小""换个背景"）→ 触发 refine 重生（**位图不能像 DOM 那样 patch，落法见 §2.4 第 4 条**）。
> 归类：机制骨架抄 cc 的"选区→截图+备注→塞回对话"，但**落到的动作是生图 refine 而非改源码**——这是四条落法里最"我们特有"的一条。

---

## 2. 点选就地改（point-and-edit）机制拆解

### 2.0 一句话
**在被预览页里注入一个 `preview-agent` 脚本 → 用户点中任意元素（蓝框高亮）→ 弹小面板改样式/文本并实时预览 → 确认后，把"圈选编号截图 + CSS selector + nth 路径 + 用户备注 + 具体改动"打包成一条消息，直接发给模型，模型据此改本地前端源码。** 引用靠"圈了编号的截图"承载，不把 DOM 噪音写进输入框。

### 2.1 注入与桥（cc 原文）
- 主进程在被预览页 `did-finish-load` 后 `executeJavaScript(preview-agent.js)` 注入 agent（`preview.ts::injectPreviewAgent`），并通过 `preview-preload.ts` 暴露 `window.__DESKTOP_PREVIEW_POST__`（一个把消息 IPC 送回宿主的函数）。
- agent 侧 `bridge.ts` + `protocol.ts` 定义**版本化 JSON 协议**（每条带 `v:1`）：
  - 宿主→agent：`enter-picker` / `exit-picker` / `capture{kind}`
  - agent→宿主：`ready` / `navigated` / `error` / `selection{payload}` / `screenshot{dataUrl,kind}` / `picker-exited`
- `previewMessage.ts` 对每条消息**严格校验**（字节上限 8MB；`data:image/(png|jpeg|webp);base64,...` 正则白名单；URL 只放行 http(s)；`shouldForwardPreviewMessage` 只认 top-frame）。**这套校验必须原样抄，是信任边界。**

### 2.2 拾取器 picker（`picker.ts` + `index.ts`）
- picker 用 **Shadow DOM 浮层宿主**（`position:fixed;inset:0;z-index:2147483647`，`attachShadow`）画蓝色高亮框——**刻意用 Shadow DOM 避免被页面 CSS 影响、抗 CSP 内联限制**。
- `mousemove`（capture 阶段）→ `picker.hover(target)` 移动高亮框；`click`（capture 阶段，`preventDefault+stopPropagation`）→ `picker.select()` 锁定当前元素，随即弹编辑气泡。

### 2.3 编辑气泡 editBubble（`editBubble.ts`，163 行）
- 也是 Shadow DOM 弹层。字段：`文本 / 文字颜色 / 背景 / Opacity / 字体` + 一个"描述这些更改…"的备注输入框 + 取消/✓。
- 输入即 `applyEdit` **实时把改动应用到真实元素**（所见即所得）；取消则回滚到 `original` 快照；确认则 `computeChange(original,current)` 算出 diff（每字段 `{from,to}`）+ 备注，回调 `onConfirm`。
- 位置计算 `computeBubbleLayout` 处理视口边界（上下翻转、夹取）。

### 2.4 确认后的四条落法（关键：别混成一套）
cc 只有"HTML 页改源码"一条。我们有四种被预览内容，**每种"点选就地改"落到不同动作**：

1. **HTML 页 / 本地前端（直接抄 cc）**：`index.ts::emitSelection` → 画**编号标注 overlay**（蓝框 + 数字角标"1"，`screenshot.ts::createAnnotationOverlay`）→ 请求截图（cc 走主进程原生 `capturePage`；我们同源 iframe 走 `html2canvas`）→ 组 `buildElementMetadata`（`selector.ts` 出 CSS selector + nth-child 路径、tag/id/classes/text/boundingBox/computedStyles/outerHtmlSnippet）→ 发 `selection`。宿主侧 `previewEvents.ts` 收到 → `selectionComposer.ts::buildSelectionDirectMessage` 拼出人话消息（**"请根据截图中编号 1 的蓝色标注修改本地前端。目标元素：<div> Selector：… 用户注释：…"**，带标注截图当附件）→ **直接 `sendMessage` 给模型** → 模型改本地源码文件。**这条是核心闭环，机制 1:1 抄，文案已无 Claude 字样、白标 OK。**
2. **文案（text canvas，我们特有优势）**：文案 tab 里选中一段文本 → 弹"定向改这段"popover（抄 cc markdown `onAddSelection` 的选区机制）→ 调**已存在的服务端 `POST /api/v1/canvas/edit`**（`ts/src/server/index.ts` L2568，当前是 `local_fallback` 桩、只拼接——**P1 要把它接真模型调用**）→ 只改选中段、不动别处（ChatGPT Canvas inline-edit）。
3. **报表（sheet，我们特有优势）**：报表 tab 表格里点格 inline 改 → 调**已存在的 `POST /api/v1/canvas/sheet` + `/api/v1/canvas/excel-edit`**（L2596/2609，csv/xlsx 真实写回已实现）。
4. **海报（位图 refine，最"我们特有"）**：位图没有 DOM，不能点元素 patch。落法 = **在图上框选一块矩形区域**（复用 picker 的 Shadow 浮层画框，但目标是坐标框不是 element）→ 备注 → 触发 **media 生图 refine_from**（以原图 + 区域 + 指令重生整图）。截图直接用原海报本身。**别硬套 DOM selector。**

### 2.5 白标必改点
- 注入脚本 `preview-agent.js` 内不得出现 Claude/Anthropic/cc-haha 字样；`__PREVIEW_AGENT__`/`__DESKTOP_PREVIEW_POST__` 这类全局名可保留（用户不可见），但若怕暴露可改成中性名（如 `__QF_PREVIEW__`）。
- composer 模板文案本身无品牌（"修改本地前端"），保留即可；`editBubble` 字段标签已是中文。
- 不向客户端暴露底层模型名——refine/canvas/edit 走网关，白标口径同全局。

---

## 3. 落地方案分期

> 施工顺序按"最小可用 → 点选改 → 全量对齐"。每期标清**改哪些文件 / 要不要后端·壳层配合 / 依赖**。renderer 为主战场（vanilla JS，别引 React）。

### P0 — 右侧面板骨架 + 图片/HTML 静态预览（最小可用）
**目标**：右侧三栏面板立起来，能预览海报图 + 静态 HTML，能从正文认产物一键打开。**不碰 Electron 主进程。**

改动：
- `ts/desktop/renderer/index.html`
  - 把现有 `#preview`（现在只做"改动文件/后台任务"340px）**重构成设计的 artifact 面板**：宽 440px；面板头 = `📝 文案 / 🎨 海报 / 📊 报表` 标签切换（tablist，配色 `var(--wb-*)`）+ ✕；面板体 = 内容区（海报走 Quick Look 灰底 `#ececf0`/暗色对应 token、居中 `<img>`）；底部工具条 = `⤓ 保存到本机 / ✎ 基于此调整 / ↻ 重新生成` + 尺寸标。样式全用现有 `--wb-*` token。
  - 布局改三栏：`#main` 里对话流 `.wrap` 保持 `max-width:720px`；面板开时 `#app` 变 `侧栏240 + 对话flex + 预览440`；加**拖拽改宽手柄**（抄 `ActiveSession.tsx::WorkspaceResizeHandle` 的指针拖拽逻辑，宽度存 `localStorage`）。
  - "改动文件/后台任务"两个入口收编进同一面板（多一个"改动/任务"surface 或保留其简单列表，别和 artifact 抢位）。
- `ts/desktop/renderer/app.js`
  - 新增面板控制器：`openPreview(kind, payload)` / `closePreview()` / tab 切换 / 底部工具条 3 个按钮。
  - **内容管道 P0**：把 `assistantOutputTargets.ts` 的抽取逻辑**端口成 vanilla JS**（认 image/local-html/localhost/markdown，用本轮 `changedFiles`（app.js 已有 `changedFiles` Set）校正）；在 `settleAssistant()`/`final` 时对助手正文跑一遍 → 正文下方渲"打开预览"chip（点开进面板对应 tab）。
  - **生图自动开面板**：`renderEvent` 的 `tool_result`（app.js L449）里已 `noteFileChange`；加：识别生图工具结果里的 `poster_url`/图片路径 → 自动 `openPreview('poster', {url})`（同源 `/uploads/posters/*`）。
- `ts/src/server/index.ts`（后端配合，轻量）
  - 加 **`/preview-fs/<conversationId>/<相对路径>`** 静态路由：把工作区里生成的 HTML（含相对资源）以原样 served（端口 cc `handlePreviewLink.ts::previewFsUrl` + `htmlPreviewPolicy.ts` 的沙箱/静态判定；沙箱限死工作区根、`..` 越界拒——复用现有 `pathBoundary`）。海报图已有 `/uploads/posters/*`，图片预览 P0 不需要新后端。

依赖：无新 npm 依赖（P0 纯 DOM）。截图/点选 P0 不做。

### P1 — 点选就地改（point-and-edit）
**目标**：三条"就地改"闭环（HTML DOM 点选 / 文案选段 / 报表点格）跑通，走同源 iframe + postMessage。

改动：
- 新增 `ts/desktop/renderer/preview-agent.js`（**端口 cc `preview-agent/*`**：`picker`+`editBubble`+`selector`+`metadata`+`screenshot`+`bridge`+`protocol` 合成一个 vanilla bundle）。截图用 `html2canvas`（同源 iframe 可用）替 cc 的原生 `capturePage`。
- `ts/src/server/index.ts`
  - HTML 静态预览的 served 页面里**注入 `<script src="/preview-agent.js">`**（或渲染器对同源 iframe `contentWindow` 注入）；serve `preview-agent.js`。
  - **把 `/api/v1/canvas/edit` 从 `local_fallback` 桩接上真模型调用**（当前 L2568 只拼接字符串）——文案"定向改这段"要真改。
- `ts/desktop/renderer/app.js`（宿主角色，端口 cc `previewEvents.ts` + `selectionComposer.ts`）
  - iframe 承载被预览 HTML（`sandbox="allow-scripts allow-same-origin"`，同源才能注入 agent）；宿主 ↔ iframe 用 **`postMessage`** 跑 §2.1 协议（把 cc 的 IPC 传输换成 postMessage，`previewMessage.ts` 的校验**原样端口**）。
  - 面板头加 `选择元素`/`截图` 按钮（抄 `BrowserSurface.tsx` 的 previewActions，aria-label 中文）。
  - 收到 `selection` → 拼 `buildSelectionDirectMessage` 消息 + 标注截图附件 → 走现有 WS `run`/`steer` 发给模型（复用 app.js 的 `wsSend`/`send`）。
  - 文案 tab 选段 → `/canvas/edit`；报表 tab 点格 → `/canvas/sheet`+`/canvas/excel-edit`（后端已就绪）。
- `index.html`：加 picker/编辑气泡在 iframe 内自绘（Shadow DOM，样式内联），宿主侧只加按钮 + 面板样式。

依赖：`html2canvas`（打进渲染器；cc 也用它）。

### P2 — 原生浏览器预览 + diff + 报表可视化 + 原生截图 + 其它（全量对齐 cc）
**目标**：能预览**跨域/远程/localhost 开发服务器**（同源 iframe 覆盖不了的），原生 `capturePage` 截图，补齐 diff/报表/openWith。

改动：
- `ts/desktop/electron/main.ts` + 新增 `ts/desktop/electron/services/preview.ts`（端口 cc `ElectronPreviewService`：建 `WebContentsView`、bounds、注入 preview-agent、原生截图）+ `ipc/previewMessage.ts`（端口校验）+ `preview-preload.ts` + `ipc/channels.ts`（preview 通道）。
- `ts/desktop/electron/preload.ts`：暴露 `preview` 桥（open/navigate/setBounds/setVisible/setZoom/close/message/onEvent，端口 cc `previewBridge.ts`）。
- 打包：加 `preview-agent` 编译产物 build 步（cc 有 `desktop/scripts/build-preview-agent.ts`）。
- `app.js`/`index.html`：浏览器 surface UI（地址栏/前进后退/缩放，端口 `BrowserSurface`/`BrowserAddressBar`），报 bounds（端口 `computeWebviewBounds`）；overlay 时隐藏原生视图（`overlayStore` 机制）。
- `ts/src/server/index.ts`：加 `/local-file/<abs>` 路由（端口 cc，$HOME 沙箱）给工作区外的绝对路径文件预览。
- 补 **diff 预览** tab（复用 app.js 现有 `renderUnifiedPatch`）、**报表可视化**（`/canvas/doc-blocks`/`sheet` 已有）、OpenWith 菜单（端口 `openWithItems.ts`）。

依赖：动 Electron 主进程（和正在改 renderer 的子代理不冲突，分属 `electron/` vs `renderer/`）。

---

## 4. 与现有 renderer 的接入点（怎么不破坏现有流）

- **面板宿主已存在**：`index.html` 已有 `#preview` DOM + 一套 `--wb-*` token + `.diff`/`.code-card`/markdown 渲染器（`app.js`）。P0 是**重构 `#preview` 的用途**（从"改动文件列表"升级成 artifact/canvas 面板），不是从零建。现有 `changesBtn`/`tasksBtn`（app.js L53/75）驱动 `#preview` 的逻辑要并进新面板的 surface 切换。
- **三栏布局不动对话流内核**：面板是对话列右侧的**兄弟第三栏**，对话列保留自己的滚动/智能跟随（app.js 的 `shouldAutoScroll`/`scrollToBottom` 不受影响）；只需给 `.wrap` 维持 `max-width:720px` + 面板开时压缩 `#main` 宽度。**斜杠面板 `#cmd-panel`、审批卡、流式尾光标、交互批次**都在对话列内，面板开关不碰它们。
- **自动打开钩子挂在事件流里**：`renderEvent` 的 `tool_result`/`final`（app.js L449/L466）是唯一注入点——生图结果→开海报 tab；正文认产物→渲 chip。**别在 WS 帧解析层动手**，只在渲染层加。
- **WS/run 状态零耦合**：点选就地改发消息复用现有 `send()`/`wsSend()`/`steer` 通道（运行中就 steer 插话、空闲就 run），面板不新开连接、不改 `running` 语义。
- **权限档不变**：改本地前端源码属"读写本机文件（带备份）"，按铁律不弹审批直接做；海报 refine（花钱）走生图、owner 口径"生图不弹审批直接出图"。面板不引入新审批面。

---

## 5. 风险与卡点（最大三个 + 其余）

### 卡点 1（最大）：传输分叉——同源 iframe vs 原生 WebContentsView
cc-haha 用**原生子视图**（能注入任意页、原生 `capturePage`、渲染在 DOM 之上）。我们渲染器 vanilla + 同源加载。
- **P0/P1 走同源 sandboxed iframe + postMessage**：覆盖"自家生成的 HTML/海报/文案/报表"（同源，能注入 agent、能 `html2canvas`），不动 Electron 主进程，还能在纯浏览器跑。**代价**：同源 iframe 注入不了**跨域/远程/localhost 开发服务器**（这些页不同源，`contentWindow` 不可注入；远程页还可能 `X-Frame-Options/CSP` 拒绝被 iframe）；截图只能 `html2canvas`（比原生 `capturePage` 弱，跨域资源/字体可能糊）。
- **要原生能力必须 P2 上 `WebContentsView`**（动 `electron/`）。
- **拍板建议**：P0 先 iframe（我们设计的主场景=自家产物，同源足够）；把原生视图列为 P2 明确增量，别一上来啃 Electron 主进程。owner 定。

### 卡点 2：点选就地改"落到改动"的四条落法别混
cc 只有"HTML→改源码"一条。我们有四种内容 → 四种落法（§2.4）：HTML=DOM 选区→改源码（抄 cc）、文案=选段→`/canvas/edit`（后端 stub 要 P1 接真模型）、报表=点格→`/canvas/excel-edit`（后端已就绪）、海报=框选区域→生图 refine（位图不能 DOM patch）。**把四者当一套写=错**。尤其海报：别硬套 `buildSelector`；框选给的是坐标矩形，refine 是重生整图。

### 卡点 3：安全边界 / CSP / postMessage 信任 / 白标
- iframe 必须 `sandbox`（同源注入 agent 有 XSS 面）；postMessage **原样端口 cc `previewMessage.ts`** 的 `v:1` 类型校验 + 字节上限 + `data:image/(png|jpeg|webp)` 正则白名单 + 只认 top-frame + http(s)；`origin` 校验加严（只收自己 iframe 的 origin）。
- **生图产物必须同源可读**：海报走 `/uploads/posters/*`、HTML 走 `/preview-fs/*`（都同源 sidecar），**别用 `file://`**（iframe 读不了、`html2canvas` 也会跨域污染 canvas 导不出）。
- **白标**：注入脚本 + composer 文案不得带 Claude/Anthropic/cc-haha；不暴露底层模型（refine/canvas 走网关）。全局名可换中性（`__QF_PREVIEW__`）。

### 其余风险
- **`assistantOutputTargets` 端口成本**：cc 原文 775 行（含 markdown-link/fenced-code/directory-tree 解析 + changedFiles 校正）。P0 可先做"认 image/localhost/local-html"的精简版，别一次端全。
- **`/canvas/edit` 是桩**：当前 `local_fallback` 只拼字符串（`ts/src/server/index.ts` L2571），P1 文案"定向改这段"要它真调模型才有意义，否则用户以为改了其实没改。
- **原生视图挡弹窗**（P2）：`WebContentsView` 永远盖在 DOM 之上，我们的斜杠面板/审批卡/toast 会被它挡——必须抄 cc 的 `overlayStore` 机制，有 DOM 浮层时 `setVisible(false)`。
- **拖拽改宽的 min/max**：cc 面板 `min(420px,54%)~62%`；我们设计固定倾向 440，但仍需 min/max 夹取防拖崩。

---

## 6. 附：现成可复用资产盘点（少造轮子）

| 我们已有 | 位置 | P 期用途 |
|---|---|---|
| `--wb-*` 三层 token（含暗色） | `index.html` L15-160 | 全期配色 |
| markdown/代码卡/inline 渲染器 | `app.js` `mdRender`/`makeCodeCard`/`renderInline` | 文案 tab 渲染、diff |
| 彩色 diff 渲染 | `app.js` `renderUnifiedPatch`/`.diff` 样式 | diff 预览 tab（P2） |
| `changedFiles` Set + `noteFileChange` | `app.js` L25-31 | 产物校正、生图开面板 |
| `/api/v1/canvas/{edit,render,save-to-library,doc,sheet,excel-edit,doc-blocks}` | `ts/src/server/index.ts` L2564+ | 文案/报表就地改、保存到本机（edit 是桩要接真模型） |
| `/uploads/posters/*`、`/uploads/local/*` 静态服务 | `ts/src/server/index.ts` L2425/L1474 | 海报同源预览 |
| `/api/v1/agent/fs/{read,list}` | app.js 已用 | 文件树/文件预览 |
| media 生图（poster_url、refine） | `ts/src/media/mediaJobs.ts` | 海报 refine 迭代 |
| 沙箱/路径边界 | `ts/src/workspace/pathBoundary.ts` | `/preview-fs` 沙箱 |

**要新写/端口的**：面板骨架三栏 + 拖拽（抄 `ActiveSession`）、`assistantOutputTargets` JS 端口、`preview-agent.js` JS 端口（P1）、`/preview-fs` 路由（P0 后端）、原生 `WebContentsView` 一套（P2 Electron）。
