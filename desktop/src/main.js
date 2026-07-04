// 台球运营助手 · 桌面端 Electron 主进程
//
// 职责:① 开窗口加载现有 web 前端(连云后端出内容/跑 Agent);
//      ② 把"本地原生能力"(发布 RPA / 视频剪辑)经 IPC 暴露给前端;
//      ③ 浏览器自动化(patchright)跑在【独立子进程】,绝不在渲染进程——见 publish.js。
//
// 安全默认全保持:contextIsolation 开 / sandbox 开 / nodeIntegration 关。
// 加载的页面只能通过 preload 的 contextBridge 白名单调用原生能力,拿不到 Node。

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, desktopCapturer, screen, systemPreferences, Notification, globalShortcut } = require("electron");
const path = require("path");
const publish = require("./publish");
const video = require("./video");
const backend = require("./backend");
const modelDownloader = require("./model-downloader");
const tts = require("./tts");
const frontend = require("./frontend");
const updater = require("./updater");
const crypto = require("crypto");
const fs = require("fs");

// ── 运行日志落盘(userData/logs/desktop.log) ─────────────────────
// 1.0.0 真机事故教训:装机包不写日志=用户机上出问题只能盲猜。后端/前端/更新器输出全部落盘,
// 超 5MB 滚动成 .old。报错弹窗直接指向这个文件,用户把文件发回来就能定位。
let _logStream = null;
function logFilePath() { return path.join(app.getPath("userData"), "logs", "desktop.log"); }
function fileLog(prefix, s) {
  try {
    if (!_logStream) {
      const p = logFilePath();
      fs.mkdirSync(path.dirname(p), { recursive: true });
      try { if (fs.existsSync(p) && fs.statSync(p).size > 5 * 1024 * 1024) fs.renameSync(p, `${p}.old`); } catch { /* 滚动失败不阻塞 */ }
      _logStream = fs.createWriteStream(p, { flags: "a" });
    }
    _logStream.write(`[${new Date().toISOString()}] ${prefix}${String(s).trimEnd()}\n`);
  } catch { /* 日志绝不阻塞主流程 */ }
}

// ── 单实例锁 ──────────────────────────────────────────────────
// 客户手滑双击两次图标(或没反应又点一次) → 第二个进程会跟第一个抢同一个本地后端端口，
// 表现成一个"程序坏了"式的端口冲突错误框。用 Electron 单实例锁挡掉：抢不到锁的第二实例
// 直接退出，把已经开着的窗口拉到前台，而不是再起一份全套后端/前端。
// ⚠️ 但 QF_RENDER_MANIFEST 分支(见下方 app.whenReady 里约 320 行起)是"渲染 worker 模式"——
// 本 App 运行期间，后端会再拉起一份自身二进制做离屏逐帧渲染，这是设计如此的自我调用，
// 绝不能被单实例锁当成"重复启动"挡下来(挡下来 = 渲染 worker 永远起不来、V2 出片必败)。
// 所以锁只在"非 worker 模式"下才申请，worker 模式完全跳过这段、不受影响。
let gotSingleInstanceLock = true; // worker 模式恒 true(不参与抢锁)；主模式下取真实抢锁结果
if (!process.env.QF_RENDER_MANIFEST) {
  gotSingleInstanceLock = app.requestSingleInstanceLock();
  if (!gotSingleInstanceLock) {
    app.quit();
  } else {
    app.on("second-instance", () => {
      // 用户又点了一次图标：别开新窗口，把已有窗口拉到前台。
      const win = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : BrowserWindow.getAllWindows()[0];
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
    });
  }
} else {
  // 渲染 worker 模式:主 App 还开着,worker 是第二个 Electron 进程。若共用同一份 userData,
  // 两个 Chromium 会抢 GPU cache / LevelDB 文件锁(Windows 上尤其容易),轻则刷错误日志、
  // 重则离屏渲染起不来。给 worker 一个独立的临时 userData,进程隔离、互不抢锁。
  // 必须在 app ready 之前设置(ready 后改 userData 不生效),所以放在文件顶部这里。
  app.setPath("userData", path.join(app.getPath("temp"), `qf-render-worker-${process.pid}`));
}

// 加载哪个前端:dev 跑本地 web(含发布UI,在 feat/desktop-agent 分支),prod 起打包的 Next.js standalone。
// 云端 main(zzyppz.cn)没有发布UI,故默认不直连云端页面。
// DESKTOP_APP_URL 显式设了就优先用它(dev 调试);否则 prod 走本地前端(frontend.js 起 server.js)。
const FORCED_APP_URL = process.env.DESKTOP_APP_URL || null;
// 是否由 Electron 托管本地后端(全本地)。设 0 则自己手动起后端(dev 调试用)。
const MANAGE_BACKEND = process.env.DESKTOP_MANAGE_BACKEND !== "0";
// 是否由 Electron 托管本地前端(prod 全本地)。设 0 或显式给 DESKTOP_APP_URL 则不起。
const MANAGE_FRONTEND = process.env.DESKTOP_MANAGE_FRONTEND !== "0" && !FORCED_APP_URL;
// 仓库根(dev 用 uv 跑 server/);desktop/src → desktop → repo
const REPO_ROOT = path.join(__dirname, "..", "..");

// ── Windows 系统版本探测(B3 · 标题栏现代化用) ──────────────────────────────
// process.getSystemVersion() 在 Windows 上返回形如 "10.0.22631" 的三段号,第三段是 build 号。
// 22621 = Windows 11 22H2(2022-09)。选它做阈值是因为 Electron 官方文档明确写 BrowserWindow
// win.setBackgroundMaterial('mica') "只支持 Windows 11 22H2 及以上"(低于这个 build 调用要么
// 无效要么行为不确定)。低于这个阈值时:① 不启用 Mica 材质(下面 WIN_MICA_ENABLED 直接判否);
// ② titleBarOverlay 的颜色只给不透明纯色(不带 rgba 半透明/vibrancy 花活),规避旧版 Windows +
// 较旧 Chromium 组合下 titleBarOverlay 已知的重绘/主题跟随问题(见 electron/electron#45958
// "dark mode 不跟随 titleBarStyle"、#39959 "backgroundMaterial 直到 resize 才生效")。
// ⚠️ titleBarOverlay 本身官方文档未标注最低 Windows 版本要求(Win10 同样能用、不受这个阈值限制),
// 所以下面只用这个阈值门 Mica,不整体关闭 Windows 现代标题栏。
function _winBuildNumber() {
  if (process.platform !== "win32") return 0;
  const parts = String(process.getSystemVersion() || "").split(".");
  return parseInt(parts[2], 10) || 0;
}
const IS_WIN11_22H2_PLUS = process.platform === "win32" && _winBuildNumber() >= 22621;
// Mica 材质(win.setBackgroundMaterial('mica')/构造期 backgroundMaterial:'mica')官方以外已知
// issue 较多(拖拽/resize 才生效、多屏行为不一致等),做成默认关的加分项——只有显式设
// QF_WIN_MICA=1 环境变量、且系统满足 Win11 22H2+ 才会真正启用;默认永远是纯色 titleBarOverlay。
const WIN_MICA_ENABLED = process.env.QF_WIN_MICA === "1" && IS_WIN11_22H2_PLUS;

let mainWindow = null;
const windows = new Set();
let backendReady = false;
let frontendUrl = null; // prod 本地前端就绪后的 URL

// ── D-Task-10 全局快捷键小窗(截图提问) ──────────────────────────────────
// ⚠️ 坑1(侦察实锤)：createWindow() 里 `mainWindow = win` + focus 回写(见下方 createWindow 尾部)会把
// 任何经它创建/聚焦的窗口"劫持"成全局 mainWindow。小窗如果走 createWindow()，小窗一创建/一获焦，
// 全局 mainWindow 就被它占了，"回车带进主窗对话"会找错窗口——所以小窗【绝不走 createWindow】，
// 单开 createQuickInputWindow()，不做那套赋值/focus 回写。
// ⚠️ 坑2：触发快捷键那一刻就要把"内容送进哪个窗口"快照下来，而不是等小窗弹出、用户打完字提交时
// 再去读全局 mainWindow——中间这段时间窗口焦点可能已经变化。快照存在 quickInputTargetWindow。
let quickInputWindow = null;
let quickInputTargetWindow = null;
// Alt+Space 在 Windows 是系统窗口菜单快捷键、别用；选一个不撞常见系统/软件热键的组合。
const QUICK_INPUT_HOTKEY = "CommandOrControl+Shift+Space";
// ⚠️ 坑3(复审实锤)：openStudio/openVideoStudio/openWorkbench 开出的独立路由窗口(/dashboard/workbench，
// 含 E1-C1 前的旧 /dashboard/studio、/dashboard/video)页面上没有 DesktopChatShell，没人订阅
// quickinput:inject——如果老板正盯着这类窗口按快捷键，全局 mainWindow 又恰好在 createWindow() 的
// focus 回写里被它顶替过(见坑1)，注入会静默送空。
// 修法：只把"没有 route"的窗口(chat 根路由/新工作台，真有 DesktopChatShell)标记为 chat 窗，
// 单独跟踪"最近聚焦的 chat 窗口"，快照目标时只在 chat 窗里选，绝不选中 studio/video/workbench 窗。
let lastFocusedChatWindow = null;

// ── 作品文件夹:首启自动建好一个固定目录,用户全程不用选"工作文件夹"。──────
// 建在系统文档目录下(mac ~/Documents/台球助手,Windows 文档\台球助手)。这不是 Claude Code
// 那种"选工作文件夹"的开发者仪式——只是"产出默认存哪",用户从头到尾不用知道这个概念。
// 建失败(权限/磁盘异常等)优雅退回 null:前端据此退回旧的"无默认"行为,不崩、不弹错。
let workspaceDir = null;
function ensureWorkspaceDir() {
  try {
    const dir = path.join(app.getPath("documents"), "台球助手");
    fs.mkdirSync(dir, { recursive: true });
    workspaceDir = dir;
  } catch (err) {
    fileLog("[workspace] ", `作品文件夹创建失败,退回无默认:${String((err && err.message) || err)}`);
    workspaceDir = null;
  }
}

function createWindow(opts = {}) {
  const isMac = process.platform === "darwin";
  const isWin = process.platform === "win32";
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "台球运营助手",
    // 跟随系统深浅色：暗色用深底，浅色用白底（避免启动闪屏与界面不一致）
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e0f11" : "#ffffff",
    // macOS 原生质感:隐藏标题栏(保留红绿灯,内容延伸到顶),红绿灯位对齐桌面壳侧栏顶部 52px 区(见 web 的 .app-drag)。
    // 毛玻璃 vibrancy 暂不开——需配合侧栏背景透明 + 真机调，先用 CSS 近似(bg-sidebar/85 + backdrop-blur)。
    ...(isMac ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } } : {}),
    // Windows 现代标题栏:走 VS Code 路线——titleBarStyle:'hidden' + titleBarOverlay,不用全自绘
    // frameless(frame:false)。frameless 会丢 Win11 Snap Layouts(悬停最大化按钮弹出的四宫格分屏
    // 菜单是系统直接绑定在原生最大化按钮上的,自绘窗口没有那颗按钮本体就没有这个菜单);
    // titleBarOverlay 保留系统原生窗口控制按钮(最小化/最大化/关闭)本体、只是把它们"扣"进网页画布
    // 右上角,Windows 依然认得到这是标准窗口,Snap Layouts/贴边分屏照常。
    // overlay 颜色跟随当前深浅色主题、只用不透明纯色(原因见上方 IS_WIN11_22H2_PLUS 注释);
    // height 40 与 macOS 侧的 40px 拖拽区(见下方 web 的 .app-drag)对齐,视觉上南北一致。
    ...(isWin ? {
      titleBarStyle: "hidden",
      titleBarOverlay: nativeTheme.shouldUseDarkColors
        ? { color: "#1c1d1f", symbolColor: "#e6e7e9", height: 40 }
        : { color: "#ffffff", symbolColor: "#3a3a3c", height: 40 },
      // Mica 材质默认关,见上方 WIN_MICA_ENABLED 注释;只有显式开关 + Win11 22H2+ 才加这个字段。
      ...(WIN_MICA_ENABLED ? { backgroundMaterial: "mica" } : {}),
    } : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // 默认即开,显式声明
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // prod：本地前端就绪 → 它的 URL；否则用 DESKTOP_APP_URL(dev) 或兜底 localhost:3000。
  const baseUrl = frontendUrl || FORCED_APP_URL || "http://localhost:3000";
  const url = new URL(baseUrl);
  if (opts.route) url.pathname = opts.route;             // 生成工作室等独立路由窗口
  if (opts.workbenchId) url.searchParams.set("workbench", opts.workbenchId);
  // E1-C1：openWorkbench 带参打开——mode 拼成 ?panel=image|video，payload 是轻标识(如 { fromGen })，
  // 逐个键平铺进 query（不 JSON 塞大对象/图 bytes），容器页首次挂载时用 useSearchParams 读初始面板。
  if (opts.workbenchMode) url.searchParams.set("panel", opts.workbenchMode);
  if (opts.workbenchPayload && typeof opts.workbenchPayload === "object") {
    for (const [k, v] of Object.entries(opts.workbenchPayload)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }
  win.loadURL(url.toString());

  // 锁定壳层窗口标题=产品名(owner 2026-07-02 定名「台球运营助手」)。web/ 与云端共享，layout.tsx 的
  // document.title 是"球房 AI 运营助手"，默认会覆盖窗口标题(任务切换/调度中心/窗口菜单都显示旧名)。
  // 仅 preventDefault 在 Next 客户端路由下不够稳，这里 preventDefault + 主动 setTitle 双保险，
  // 又不改共享 web 文案、不影响云端。
  const PRODUCT_TITLE = "台球运营助手";
  const lockTitle = () => { if (!win.isDestroyed()) win.setTitle(PRODUCT_TITLE); };
  win.webContents.on("page-title-updated", (e) => { e.preventDefault(); lockTitle(); });
  win.webContents.on("dom-ready", lockTitle);
  win.webContents.on("did-finish-load", lockTitle);

  // 外链用系统浏览器打开,不在 app 内导航走丢
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  // 只拦了 window.open 还不够:聊天气泡里的裸 <a> 一点(不经 window.open，是同一个 webContents
  // 直接导航)、或页面任何脚本改 location，都会让这个无边框窗口被整个导航到外部网址、回不来
  // (没有地址栏/前进后退，只能强杀重开)。will-navigate 补拦：目标 origin 跟本窗口自己加载的
  // origin(本地前端 baseUrl，见上面 `url`)不一样就挡住导航；只有 http(s):// 链接才转交系统浏览器打开
  // (防 file://、javascript: 等协议被滥用 openExternal)。同源的 Next.js 客户端路由走 History API，
  // 属于"页内导航"，不会触发这个事件，不受影响。
  const selfOrigin = url.origin;
  win.webContents.on("will-navigate", (event, navigationUrl) => {
    let targetOrigin = null;
    try { targetOrigin = new URL(navigationUrl).origin; } catch { /* 非法 URL 直接当作外链拦 */ }
    if (targetOrigin !== selfOrigin) {
      event.preventDefault();
      if (/^https?:\/\//i.test(navigationUrl)) shell.openExternal(navigationUrl);
    }
  });

  if (process.env.DESKTOP_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });

  // 没有 opts.route 的是 chat 根路由窗口(主 chat / desktop:newWindow 开的新工作台)——真渲染
  // DesktopChatShell、能接 quickinput:inject；opts.route 有值的(studio/video)是独立路由窗口，
  // 没有 DesktopChatShell，不能当快捷键小窗的注入目标(见上方坑3)。
  win.__qfIsChat = !opts.route;
  // P0-1 窗口单例化：记下这扇窗口是哪个 route 开的，供 focusOrOpenByRoute() 按 route 找已开窗口。
  // chat 窗口(route 为空/newWindow 开的新工作台)不受影响——route 各不相同(或都是 undefined
  // 时不参与单例查找，见下方函数)，仍可自由多开。
  win.__qfRoute = opts.route || null;

  mainWindow = win;
  windows.add(win);
  win.on("focus", () => {
    mainWindow = BrowserWindow.getFocusedWindow() || win;
    if (win.__qfIsChat) lastFocusedChatWindow = win;
  });
  win.on("closed", () => {
    windows.delete(win);
    mainWindow = BrowserWindow.getAllWindows()[0] || null;
    if (lastFocusedChatWindow === win) lastFocusedChatWindow = null;
  });
  return win;
}

// D-Task-10：全局快捷键唤起的置顶小输入窗——打字/截屏 → 回车带进主窗对话，老板截美团后台/对手海报
// 就地问，不用切来切去。⚠️ 独立实现，不走 createWindow()（避免 mainWindow 被小窗劫持，见上方坑1注释）：
// 不赋值 mainWindow、不挂 focus 回写、不加进 `windows` 广播集合(它不是"工作台窗口"，不参与多窗口成品同步)。
function createQuickInputWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  const win = new BrowserWindow({
    width: 640,
    height: 168,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false, // ready-to-show 后再显示，避免加载瞬间的白屏闪一下
    center: true,
    backgroundColor: dark ? "#0e0f11" : "#ffffff",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // 安全默认不破例
      sandbox: true,
      nodeIntegration: false,
    },
  });
  // 复用主窗同一套 frontendUrl/FORCED_APP_URL 解析(main.js:160-165)，别自己另拼 3000/3100。
  const baseUrl = frontendUrl || FORCED_APP_URL || "http://localhost:3000";
  const url = new URL(baseUrl);
  url.pathname = "/quick";
  win.loadURL(url.toString());
  win.once("ready-to-show", () => { if (!win.isDestroyed()) win.show(); });
  // 失焦自动隐藏(体验加分：点别处/切走就收起，不用手动关)；隐藏而非销毁，下次唤起更快。
  win.on("blur", () => { if (!win.isDestroyed()) win.hide(); });
  win.on("closed", () => { if (quickInputWindow === win) quickInputWindow = null; });
  return win;
}

// 触发入口(全局快捷键 → 这里)。⚠️ 坑2：先把"内容要送进哪个窗口"快照到 quickInputTargetWindow，
// 再弹小窗——避免小窗弹出/获焦这段时间窗口焦点状态变化导致后续注入找错目标。
// ⚠️ 坑3：目标必须是真有 DesktopChatShell 的 chat 窗，不能是全局 mainWindow(可能已被 studio/video
// 窗的 focus 回写顶替，见坑1+坑3注释)——兜底链：当前聚焦窗若是 chat 窗 → 用它；否则最近聚焦过的
// chat 窗若还活着 → 用它；否则随便找一个还活着的 chat 窗；实在一个 chat 窗都没有才退回 mainWindow
// (极端兜底，至少不崩，但此时可能确实没有能接注入的窗口)。
function openQuickInput() {
  const focused = BrowserWindow.getFocusedWindow();
  quickInputTargetWindow = (focused && !focused.isDestroyed() && focused.__qfIsChat)
    ? focused
    : (lastFocusedChatWindow && !lastFocusedChatWindow.isDestroyed())
      ? lastFocusedChatWindow
      : (BrowserWindow.getAllWindows().find((w) => w.__qfIsChat)
        || ((mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null));
  if (quickInputWindow && !quickInputWindow.isDestroyed()) {
    quickInputWindow.show();
    quickInputWindow.focus();
    return;
  }
  quickInputWindow = createQuickInputWindow();
}
// e2e 测试专用挂钩：main.js 是入口脚本、不是被 require 的模块，Playwright 的 electronApp.evaluate()
// 在主进程里执行、拿不到这个文件内的闭包函数；挂一个引用到 global 供 e2e 直接调用等价函数触发——
// 全局热键在无头/CI 自动化环境里真实按键未必可靠，这样测"触发后窗口数+1"更稳。不新增任何面向渲染进程/
// 外部的能力面，仍是主进程内部自己调用同一个函数。
global.__qfE2EOpenQuickInput = openQuickInput;

// 进度/状态回推渲染层(扫码就绪、发布进度、剪辑进度)
// 多窗口并行：优先投给【发起该动作的窗口】(target=event.sender)，不串到当前焦点窗口；没传 target 才退回焦点窗口。
function emit(channel, payload, target) {
  const wc = (target && !target.isDestroyed()) ? target
    : (mainWindow && !mainWindow.isDestroyed()) ? mainWindow.webContents : null;
  if (wc && !wc.isDestroyed()) wc.send(channel, payload);
}

// ──────────────────────────────────────────────────────────────
// IPC:发布(RPA)。所有"对外/花钱"动作都是【备好内容 → 人点确认 → 才发】(审批闸)。
// 渲染层经 window.electron.publish.* 调用;真正的浏览器自动化在 publish.js 的子进程里。
// ──────────────────────────────────────────────────────────────
ipcMain.handle("publish:platforms", () => publish.listPlatforms());

// 发布功能是否可用(发布内核存在或本机有 python3)。前端显发布入口前先问,
// 不可用就隐藏入口/给说人话提示,别让老板点了才失败。返回 { ok, reason? }。
ipcMain.handle("publish:available", () => publish.checkAvailable());

// 扫码登录:启动登录流,二维码 data-url 经 publish:login:qrcode 事件推前端展示;
// 登录完成/失败经 publish:login:status 推。返回一个 sessionId 供前端跟踪。
ipcMain.handle("publish:login:start", (e, { platform }) =>
  publish.startLogin(platform, {
    onQrcode: (dataUrl) => emit("publish:login:qrcode", { platform, dataUrl }, e.sender),
    onStatus: (status) => emit("publish:login:status", { platform, status }, e.sender),
  })
);

ipcMain.handle("publish:login:check", (_e, { platform }) => publish.checkLogin(platform));

// 发布:人确认后调用。content = { videoPath, title, tags, coverPath, scheduleAt? }
ipcMain.handle("publish:post", (e, { platform, content }) =>
  publish.post(platform, content, {
    onProgress: (p) => emit("publish:progress", { platform, ...p }, e.sender),
  })
);

// ──────────────────────────────────────────────────────────────
// IPC:视频剪辑(ffmpeg)。基础能力:裁剪/拼接/竖屏转码/烧字幕/水印/变速。
// ──────────────────────────────────────────────────────────────
ipcMain.handle("video:probe", (_e, { inputPath }) => video.probe(inputPath));
ipcMain.handle("video:run", (e, { op, args }) =>
  video.run(op, args, { onProgress: (p) => emit("video:progress", { op, ...p }, e.sender) })
);

// 本地文件选择器:老板选定文件 → 返回绝对路径,前端随对话以 selected_files 传后端,
// Agent 沙箱据此授权可读/改这些文件(默认 Excel/文本报表;可传 opts.filters/properties 定制)。
ipcMain.handle("files:pick", async (_e, opts = {}) => {
  // P0-1：opts.filesAndFolders=true → 一个弹窗里【文件或文件夹都能选】(macOS 支持;授权整个文件夹给 AI 读改、
  // 且不再按类型过滤把 .py 等灰掉);opts.directory=true → 只选文件夹;否则只选文件。
  let base;
  if (opts.filesAndFolders && process.platform === "darwin") base = ["openFile", "openDirectory"];
  else if (opts.directory) base = ["openDirectory"];
  else base = ["openFile"];
  const properties = opts.multi ? [...base, "multiSelections"] : [...base];
  const canPickDir = base.includes("openDirectory");
  // 只要弹窗允许选文件夹，就一律带上 "createDirectory"，让 macOS 系统对话框自带"新建文件夹"按钮——
  // 不再依赖调用方显式传 opts.createDirectory。这样前端"新建空白文件夹 / 使用现有文件夹"两个按钮
  // 合并成一个之后，不用改调用参数就能兜住"新建"这条路径(用户在同一个弹窗里直接点新建即可)。
  if (canPickDir) properties.push("createDirectory");
  const dialogOpts = {
    title: opts.title || (canPickDir ? "选择要让 AI 处理的文件 / 文件夹" : "选择要让 AI 处理的文件"),
    properties,
  };
  if (opts.defaultPath) dialogOpts.defaultPath = opts.defaultPath;
  // 只有"纯选文件"才挂类型过滤;一旦允许选文件夹 → 不挂过滤(否则 .py 等非白名单被灰、整文件夹也选不了)。
  if (!canPickDir) {
    dialogOpts.filters = opts.filters || [
      { name: "报表/文档", extensions: ["xlsx", "xlsm", "csv", "txt", "md"] },
      // 图片/视频:让老板能直接选图/录屏给 AI 看(多模态)。视频走 video_url 原生送、图片走 image_url。
      { name: "图片/视频", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "tiff", "tif", "mp4", "mov", "webm", "mkv", "avi", "m4v"] },
      { name: "所有文件", extensions: ["*"] },
    ];
  }
  const result = await dialog.showOpenDialog(mainWindow || undefined, dialogOpts);
  return { canceled: result.canceled, paths: result.filePaths || [] };
});

// 系统「另存为」：把成品(base64 字节)写到老板自己选的位置(桌面/任意文件夹)。
// 用于画板「定稿 → 另存为 Word/Markdown/…」。opts: { defaultName, base64, filters, title }
ipcMain.handle("files:save", async (_e, opts = {}) => {
  const fs = require("fs");
  const path = require("path");
  const dialogOpts = {
    title: opts.title || "保存到本机",
    defaultPath: path.join(app.getPath("desktop"), opts.defaultName || "成品"),
  };
  if (Array.isArray(opts.filters) && opts.filters.length) dialogOpts.filters = opts.filters;
  const result = await dialog.showSaveDialog(mainWindow || undefined, dialogOpts);
  if (result.canceled || !result.filePath) return { canceled: true };
  try {
    fs.writeFileSync(result.filePath, Buffer.from(opts.base64 || "", "base64"));
    return { canceled: false, path: result.filePath };
  } catch (err) {
    return { canceled: false, error: String((err && err.message) || err) };
  }
});

// 打开某个文件在系统文件管理器里的位置。用于“保存到电脑”后让用户立刻找到成品。
ipcMain.handle("files:showInFolder", async (_e, opts = {}) => {
  const target = String(opts.path || "");
  if (!target) return { ok: false, error: "没有文件路径" };
  try {
    shell.showItemInFolder(target);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle("files:openPath", async (_e, opts = {}) => {
  const target = String(opts.path || "");
  if (!target) return { ok: false, error: "没有文件路径" };
  try {
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 贴图/拖图：把"剪贴板粘贴 / 拖入"的图片字节(base64)存成临时文件,返回绝对路径,
// 前端塞进 selected_files → AI 沙箱据此被授权读它(让老板能把截图/店照直接贴进对话给 AI 看)。
ipcMain.handle("files:saveTemp", async (_e, opts = {}) => {
  const fs = require("fs");
  const path = require("path");
  try {
    const dir = path.join(app.getPath("userData"), "uploads", "pasted");
    fs.mkdirSync(dir, { recursive: true });
    const ext = String(opts.ext || "png").replace(/[^a-z0-9]/gi, "").slice(0, 5) || "png";
    const name = `paste_${require("crypto").randomBytes(6).toString("hex")}.${ext}`;
    const fp = path.join(dir, name);
    fs.writeFileSync(fp, Buffer.from(opts.base64 || "", "base64"));
    return { ok: true, path: fp };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// C1 首启特例：扫「桌面 + 作品文件夹」两个目录顶层，找最近修改的一份表格报表(.xlsx/.xls/.csv)。
// 只读文件名 + mtime，不读内容、不递归子目录。故障安全：任何一步出错都返回 null——
// 扫不到就当没有，绝不因为这个"顺手一瞥"报错打扰用户。
ipcMain.handle("files:scanReports", async () => {
  try {
    const exts = new Set([".xlsx", ".xls", ".csv"]);
    const dirs = [app.getPath("desktop"), workspaceDir].filter(Boolean);
    let best = null; // { name, path, mtime }
    for (const dir of dirs) {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const ent of entries) {
        if (!ent.isFile()) continue;
        const ext = path.extname(ent.name).toLowerCase();
        if (!exts.has(ext)) continue;
        if (ent.name.startsWith("~$")) continue; // Excel 临时锁文件
        const full = path.join(dir, ent.name);
        let mtime = 0;
        try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
        if (!best || mtime > best.mtime) best = { name: ent.name, path: full, mtime };
      }
    }
    return best ? { name: best.name, path: best.path } : null;
  } catch { return null; }
});

// 看当前屏幕：由桌面壳直接截图并保存成临时文件，前端把路径作为附件传给 Agent。
// 这样入口不依赖模型先主动调用工具；用户点了就确定把当前屏幕放进本轮上下文。
ipcMain.handle("desktop:captureScreen", async () => {
  const fs = require("fs");
  const path = require("path");
  try {
    // macOS：用户明确拒绝过「屏幕录制」权限时 desktopCapturer 截出来是黑屏/只剩自己窗口——直接给人话引导，
    // 别静默返回黑图让用户以为坏了。只拦 denied/restricted（明确不可用）；granted/not-determined 仍走截图，
    // 避免在 getMediaAccessStatus 对屏幕录制返回不准时误伤已授权用户。Windows 无此系统级开关，跳过。
    const _screenPerm = process.platform === "darwin" ? systemPreferences.getMediaAccessStatus("screen") : "granted";
    if (_screenPerm === "denied" || _screenPerm === "restricted") {
      return {
        ok: false,
        needsPermission: true,
        error: "还没拿到「屏幕录制」权限，我看不到你的屏幕。请到 系统设置 → 隐私与安全性 → 屏幕录制 里勾上「台球运营助手」，再重开一次 App 就能用了。",
      };
    }
    const timeout = (ms, value = null) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
    const saveScreenshot = (image, prefix = "screen") => {
      if (!image || image.isEmpty()) return null;
      const dir = path.join(app.getPath("userData"), "uploads", "screenshots");
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, `${prefix}_${Date.now()}_${require("crypto").randomBytes(4).toString("hex")}.png`);
      fs.writeFileSync(fp, image.toPNG());
      // D-Task-10：小窗里要给老板看一眼"截到了什么"的缩略图预览——注意这只是给小窗展示用的小图，
      // 送进 AI 的原图仍是上面写盘的 fp 那份全尺寸文件，不受这个缩略图影响。缩略图生成失败不影响主流程
      // (前端拿不到 thumbDataUrl 就退回不显示预览图，截图本身、AI 看图链路都不受影响)。
      let thumbDataUrl;
      try {
        const size = image.getSize();
        const thumbWidth = Math.min(280, size.width || 280);
        const thumbHeight = size.width ? Math.round((size.height / size.width) * thumbWidth) : 0;
        thumbDataUrl = image.resize({ width: thumbWidth, height: thumbHeight || undefined }).toDataURL();
      } catch { /* 缩略图是加分项，失败不影响截图主流程 */ }
      return { path: fp, size: image.getSize(), thumbDataUrl };
    };
    const display = screen.getPrimaryDisplay();
    const { width, height } = display.size;
    const sources = await Promise.race([
      desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: Math.max(width, 1280), height: Math.max(height, 720) },
      }).catch(() => []),
      timeout(1800, []),
    ]);
    const source = Array.isArray(sources) ? (sources.find((s) => String(s.display_id) === String(display.id)) || sources[0]) : null;
    const captured = source ? saveScreenshot(source.thumbnail, "screen") : null;
    if (captured) {
      return { ok: true, path: captured.path, width: captured.size.width, height: captured.size.height, source: "screen", thumbDataUrl: captured.thumbDataUrl };
    }
    const win = BrowserWindow.getFocusedWindow() || mainWindow || BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      const windowImage = await win.capturePage();
      const fallback = saveScreenshot(windowImage, "screen_window");
      if (fallback) {
        return { ok: true, path: fallback.path, width: fallback.size.width, height: fallback.size.height, source: "window", thumbDataUrl: fallback.thumbDataUrl };
      }
    }
    return { ok: false, error: "没有拿到屏幕截图" };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 是否运行在桌面端 + 本地后端地址(前端运行时据此连本地后端,不依赖 build 期 env)
ipcMain.handle("desktop:info", () => ({
  isDesktop: true,
  version: app.getVersion(),
  platform: process.platform,
  backendUrl: MANAGE_BACKEND ? backend.backendUrl() : null,
  backendReady,
  downloadsPath: app.getPath("downloads"),
  workspaceDir, // 自动建好的作品文件夹(建失败则 null,前端退回旧的"无默认"行为)
  windowCount: BrowserWindow.getAllWindows().length,
}));

// 多窗口/多工作台最小闭环：新开一个独立窗口，前端状态、工作目录、任务订阅自然隔离。
ipcMain.handle("desktop:newWindow", () => {
  const workbenchId = `wb_${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString("hex")}`;
  const w = createWindow({ workbenchId });
  return { ok: true, windowCount: BrowserWindow.getAllWindows().length, id: w.id, workbenchId };
});

// P0-1 窗口单例化：studio/video 这类独立路由窗口重复打开时只 focus 已开的那扇、不再新开一扇。
// 按 route 找(见 createWindow 里的 win.__qfRoute)——不同 route 互相独立单例，不会互相顶掉；
// chat 窗口(newWindow 开的新工作台)route 为空不参与这个查找，仍可自由多开。
// E1-C1：加第三个参数 onFocusExisting——已开着的窗口需要"再收一次新参数"时(如工作台切面板/换
// payload)用它把事件送进已开的那扇窗，不用另起一份查找逻辑。
function focusOrOpenByRoute(route, createOpts = {}, onFocusExisting) {
  for (const w of windows) {
    if (w && !w.isDestroyed() && w.__qfRoute === route) {
      if (w.isMinimized()) w.restore();
      w.focus();
      if (onFocusExisting) onFocusExisting(w);
      return w;
    }
  }
  return createWindow({ route, ...createOpts });
}

// E1-C1：工作台单例窗口(/dashboard/workbench，图片/视频双面板 + 模板占位)。已开就 focus + 推
// workbench:navigate 事件切面板/带 payload；没开就带 mode/payload 拼进 URL query 新开一扇。
// payload 只能是轻标识(如 { fromGen })，真图/大对象一律不进这条通路(容器页按 id 自己去取)。
function openWorkbench(mode, payload) {
  return focusOrOpenByRoute(
    "/dashboard/workbench",
    { workbenchMode: mode, workbenchPayload: payload },
    (w) => w.webContents.send("workbench:navigate", { mode: mode || null, payload: payload || null }),
  );
}

ipcMain.handle("desktop:openWorkbench", (_e, opts = {}) => {
  const w = openWorkbench(opts.mode, opts.payload);
  return { ok: true, id: w.id };
});

// 生成工作室(旧 IPC，向后兼容保留)：重定向进工作台图片面板，不再单独开 /dashboard/studio 窗口。
ipcMain.handle("desktop:openStudio", () => {
  const w = openWorkbench("image");
  return { ok: true, id: w.id };
});

// 视频创作工作区(旧 IPC，向后兼容保留)：重定向进工作台视频面板。
ipcMain.handle("desktop:openVideoStudio", () => {
  const w = openWorkbench("video");
  return { ok: true, id: w.id };
});

// M2 工作室成品同步：子窗（工作室）出了成品 → 广播给其它窗口，主窗"最近作品"据此刷新。
ipcMain.handle("desktop:studioArtifact", (e, payload) => {
  for (const w of windows) {
    if (w && !w.isDestroyed() && w.webContents !== e.sender) {
      w.webContents.send("studio:artifact", payload || {});
    }
  }
  return { ok: true };
});

// D-Task-10：小窗「回车提交」→ 把内容(文字+可选截图路径)注入到快捷键触发那一刻快照下来的目标窗口
// (quickInputTargetWindow)，绝不用可能已被弄脏的全局 mainWindow(见 openQuickInput 上方坑2注释)。
ipcMain.handle("quickinput:submit", (_e, payload = {}) => {
  const targetWin = (quickInputTargetWindow && !quickInputTargetWindow.isDestroyed())
    ? quickInputTargetWindow
    : ((mainWindow && !mainWindow.isDestroyed()) ? mainWindow : (BrowserWindow.getAllWindows().find((w) => w !== quickInputWindow) || null));
  const text = String(payload.text || "");
  const imagePath = payload.imagePath || null;
  if (targetWin && !targetWin.isDestroyed() && (text || imagePath)) {
    targetWin.webContents.send("quickinput:inject", { text, imagePath });
    if (targetWin.isMinimized()) targetWin.restore();
    targetWin.show();
    targetWin.focus();
  }
  if (quickInputWindow && !quickInputWindow.isDestroyed()) quickInputWindow.hide();
  return { ok: !!(targetWin && !targetWin.isDestroyed()) };
});

// 小窗自己按 Esc / 点关闭：隐藏而非销毁(下次唤起更快，同 blur 自动隐藏的处理)。
ipcMain.handle("quickinput:close", () => {
  if (quickInputWindow && !quickInputWindow.isDestroyed()) quickInputWindow.hide();
  return { ok: true };
});

// F1b 统一跨平台通知层：渲染进程轮询后端通知中心(GET /api/v1/notifications?after=)拿到新条目后
// 喊这里弹一条【真·系统原生通知】——mac 走通知中心、Windows 走 Toast(靠上面 app.setAppUserModelId
// 设好的 AUMID 才能在 Windows 任务栏正确落位)。故障安全：不支持/失败都不抛给渲染进程，返回 { ok:false }。
ipcMain.handle("notification:show", (_e, opts = {}) => {
  try {
    if (!Notification.isSupported()) {
      return { ok: false, error: "系统不支持原生通知" };
    }
    const body = String(opts.body || "");
    if (!body) return { ok: false, error: "通知内容为空" };
    const title = String(opts.title || "台球运营助手");
    new Notification({ title, body }).show();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// D-Task-8 朗读播报(读给我听)：渲染进程调这里,主进程 spawn 系统自带 TTS 命令念文案/简报——
// 不用 Web Speech API(见 tts.js 顶部注释)。故障安全：失败/不支持都不抛给渲染进程，返回 { ok:false, error? }。
ipcMain.handle("tts:speak", (_e, { text } = {}) => {
  try {
    return tts.speak(text);
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("tts:stop", () => {
  try {
    return tts.stop();
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

// 朗读"结束/失败"是异步事件(spawn 后立即同步 return { ok:true } 不代表念完了)——订阅 tts.onEnd,
// 广播给所有窗口,前端才能复位"正在朗读"UI(自然念完 / spawn 失败如 say 二进制缺失都要复位,不然
// UI 卡死在"正在朗读",只能手动点停止或点别处顶掉)。照 model:progress 的多窗口广播写法。
tts.onEnd((p) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) { try { w.webContents.send("tts:end", p); } catch {} }
  }
});

// D-Task-4 开机自启：定时任务要 app 开着才会跑，老板想让"每天早上自动写文案"真的按时发生，
// 就得让软件开机自动打开。故障安全：不支持/失败都不抛给渲染进程，返回 { ok:false, error? }。
ipcMain.handle("app:getAutoLaunch", () => {
  try {
    return { enabled: app.getLoginItemSettings().openAtLogin };
  } catch (err) {
    return { enabled: false, error: String((err && err.message) || err) };
  }
});
ipcMain.handle("app:setAutoLaunch", (_e, opts = {}) => {
  try {
    app.setLoginItemSettings({ openAtLogin: !!opts.enabled });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

app.whenReady().then(async () => {
  // 抢锁失败的第二实例：app.quit() 在 ready 前调用并不保证 ready 回调不执行(Electron 时序未承诺)，
  // 不加这道守卫，第二实例仍可能抢跑到 backend.start() 去占 8077 端口——正是单实例锁要防的事。
  if (!gotSingleInstanceLock) return;
  // ── V2 视频渲染 worker 模式:后端设 env 拉起本 app 的 Chromium 做离屏逐帧渲染,渲完即退。──
  // dev 和装机包同一套(复用自带 Chromium,不额外打 Playwright)。不开窗、不起后端。
  if (process.env.QF_RENDER_MANIFEST) {
    try {
      const { runRenderWorker } = require("./render-worker");
      await runRenderWorker(process.env.QF_RENDER_MANIFEST, process.env.QF_RENDER_OUT);
      app.exit(0);
    } catch (e) {
      console.error("[render-worker] 失败:", e);
      app.exit(1);
    }
    return;
  }
  // Windows 任务栏身份标识(AUMID)必须在【任何窗口创建之前】设好——含首启闪屏窗。
  // SetCurrentProcessExplicitAppUserModelID 只对其后创建的窗口生效;放晚了会漏掉更早创建、
  // 且首启可能挂一两分钟的 splash,令它挂错任务栏身份/默认图标。放这里(两个早退分支之后、
  // 建任何窗口之前):worker 模式已 return 不会执行到、主流程则先于 splash 生效。必须与
  // package.json build.appId 逐字一致(否则打包身份 vs 运行时身份对不上,任务栏分组/通知照样错乱)。仅 Windows 生效。
  app.setAppUserModelId("cn.zzyppz.billiards.desktop");
  // 作品文件夹要在窗口打开、前端第一次问 desktop:info 之前就建好(同步 mkdir,极快,不影响启动时长)。
  ensureWorkspaceDir();
  // 首启进度窗:第一次打开要在用户机上解密知识库+建库,可能要一两分钟。
  // 没有它,用户只看到"点了没反应"→反复双击/以为坏了(1.0.0 真机事故)。仅装机包显示,dev 不弹。
  let splash = null;
  if (app.isPackaged && MANAGE_BACKEND) {
    const dark = nativeTheme.shouldUseDarkColors;
    splash = new BrowserWindow({
      width: 420, height: 180, frame: false, resizable: false,
      backgroundColor: dark ? "#0e0f11" : "#ffffff",
      webPreferences: { sandbox: true },
    });
    const splashHtml = `<!doctype html><meta charset="utf-8"><body style="margin:0;display:flex;align-items:center;justify-content:center;height:100vh;font-family:system-ui,'Microsoft YaHei',sans-serif;background:${dark ? "#0e0f11" : "#ffffff"};color:${dark ? "#e6e7e9" : "#1d1d1f"}"><div style="text-align:center"><div style="font-size:15px;font-weight:600">台球运营助手</div><div style="margin-top:10px;font-size:12.5px;line-height:1.7;color:${dark ? "#9a9ca3" : "#6e6e73"}">正在启动…第一次打开需要准备数据<br>可能要一两分钟,请不要关闭</div></div></body>`;
    splash.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml)}`);
  }
  const closeSplash = () => { if (splash && !splash.isDestroyed()) splash.close(); splash = null; };

  if (MANAGE_BACKEND) {
    // 全本地:先拉起本地后端(本地 SQLite),就绪后再开窗口
    const r = await backend.start({
      userDataDir: app.getPath("userData"),
      repoRoot: REPO_ROOT,
      onLog: (s) => { fileLog("[backend] ", s); if (process.env.DESKTOP_DEVTOOLS === "1") process.stdout.write(`[backend] ${s}`); },
    });
    backendReady = r.ok;
    if (!r.ok) {
      // 不静默回落到打不开的空白页:明确弹一条人话报错。"端口被占"只是可能之一,别当唯一原因误导用户。
      console.error("本地后端未在超时内就绪,前端可能连不上");
      const port = r.port || 8077;
      fileLog("[shell] ", `后端未在超时内就绪,弹启动失败窗(port=${port})`);
      closeSplash();
      dialog.showErrorBox(
        "台球运营助手启动失败",
        `后端服务没能在预期时间内启动。\n\n` +
        `可能原因:第一次启动准备数据比较慢、安全软件拦截了程序、或 ${port} 端口被别的程序占用。\n\n` +
        `请重新打开软件再试一次;还不行的话,把下面这个日志文件发给我们,一看就能定位:\n${logFilePath()}`
      );
    }
  }
  if (MANAGE_FRONTEND) {
    // prod:后端就绪后起本地 Next.js standalone(它把 /api/v1/* 反代到本地后端)。
    // 无 standalone 产物(dev 直接运行 electron .)则 ok=false,回落 DESKTOP_APP_URL/localhost:3000。
    const f = await frontend.start({
      onLog: (s) => { fileLog("[frontend] ", s); if (process.env.DESKTOP_DEVTOOLS === "1") process.stdout.write(`[frontend] ${s}`); },
    });
    if (f.ok) frontendUrl = f.url;
    else if (f.reason === "no-standalone") {
      // dev 路径:本就没打包前端产物,回落 DESKTOP_APP_URL/localhost:3000 是预期行为,不报错。
      console.warn("本地前端未起(无 standalone 产物),回落 DESKTOP_APP_URL/localhost:3000");
    } else {
      // 有 standalone 产物却没起来:端口被占用等真故障。不静默回落到打不开的页,弹人话报错。
      const port = f.port || 3100;
      console.error("本地前端未在超时内就绪");
      fileLog("[shell] ", `前端未在超时内就绪,弹启动失败窗(port=${port})`);
      closeSplash();
      dialog.showErrorBox(
        "台球运营助手启动失败",
        `界面服务没能在预期时间内启动(${port} 端口可能被别的程序占用)。\n\n` +
        `请重新打开软件再试一次;还不行的话,把下面这个日志文件发给我们:\n${logFilePath()}`
      );
    }
  }
  closeSplash();
  createWindow();
  // D-Task-10 全局快捷键：注册失败(被系统或其它程序占用)故障安全——log 一句，不崩、不弹错扰民。
  // 只在主流程注册(这里已过滤掉 QF_RENDER_MANIFEST worker 分支的早退 return，见上方约行 610)。
  try {
    const registered = globalShortcut.register(QUICK_INPUT_HOTKEY, () => openQuickInput());
    if (!registered) {
      fileLog("[quickInput] ", `全局快捷键 ${QUICK_INPUT_HOTKEY} 注册失败(可能被系统或其它程序占用)，快捷唤起小窗功能本次不可用，不影响其它功能。`);
    }
  } catch (err) {
    fileLog("[quickInput] ", `全局快捷键注册异常：${String((err && err.message) || err)}`);
  }
  // 口播模型(whisper 1.4G)不打进包,首启后台下载(不阻塞主界面:聊天/生图/基础视频立刻能用)。
  // 进度推给前端角标显示,下好前"做口播视频"按钮由前端灰掉。
  startModelDownload();
  // 自动更新:打包后后台静默检查(dev/mac 内部自跳过,不阻塞、不打扰)
  updater.init({
    app,
    getWindow: () => mainWindow,
    onLog: (s) => { fileLog("", s); if (process.env.DESKTOP_DEVTOOLS === "1") process.stdout.write(s); },
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// ── 口播模型按需下载编排 ──────────────────────────────────────
// _modelStatus 是全局单一真相:前端进 UI 时 invoke("model:status") 拿当前态,之后靠 "model:progress" 推送更新。
let _modelStatus = { phase: "idle", percent: 0 }; // idle|downloading|ready|error
let _modelDownloading = false;

function _broadcastModel() {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) { try { w.webContents.send("model:progress", _modelStatus); } catch {} }
  }
}

async function startModelDownload() {
  if (_modelDownloading) return;
  const userDataDir = app.getPath("userData");
  // 已就绪(下过了)直接标 ready,不重下
  try {
    if (modelDownloader.isReadySync(userDataDir, null) && require("fs").existsSync(require("path").join(modelDownloader.modelDir(userDataDir), "model.bin"))) {
      _modelStatus = { phase: "ready", percent: 100 }; _broadcastModel(); return;
    }
  } catch {}
  _modelDownloading = true;
  _modelStatus = { phase: "downloading", percent: 0 }; _broadcastModel();
  try {
    // 下载源(QF_MODEL_BASE_URL)在 bundled.env:主进程 process.env 里没有,从 backend 的加载器读出来传进去。
    const bundled = backend.loadBundledEnv(REPO_ROOT) || {};
    const r = await modelDownloader.ensureModel(userDataDir, {
      baseUrl: bundled.QF_MODEL_BASE_URL || process.env.QF_MODEL_BASE_URL,
      onProgress: (o) => { _modelStatus = { ..._modelStatus, ...o }; _broadcastModel(); },
    });
    _modelStatus = r.ok ? { phase: "ready", percent: 100 } : { phase: "error", percent: _modelStatus.percent || 0, error: r.error };
  } catch (e) {
    _modelStatus = { phase: "error", percent: _modelStatus.percent || 0, error: String(e && e.message || e) };
  } finally {
    _modelDownloading = false; _broadcastModel();
  }
}

ipcMain.handle("model:status", () => _modelStatus);
ipcMain.handle("model:retry", () => { startModelDownload(); return { ok: true }; });

app.on("window-all-closed", () => {
  publish.dispose();
  backend.stop();
  frontend.stop();
  if (process.platform !== "darwin") app.quit();
});

// D-Task-10：官方最佳实践——退出前解注册全局快捷键，防止进程异常退出/重复注册导致热键卡死残留。
app.on("before-quit", () => { backend.stop(); frontend.stop(); globalShortcut.unregisterAll(); });
