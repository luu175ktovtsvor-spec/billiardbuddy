// 本机 AI 助手 · 桌面端 Electron 主进程
//
// 职责:① 开窗口加载现有 web 前端(连云后端出内容/跑 Agent);
//      ② 把"本地原生能力"(发布 RPA / 视频剪辑)经 IPC 暴露给前端;
//      ③ 浏览器自动化(patchright)跑在【独立子进程】,绝不在渲染进程——见 publish.js。
//
// 安全默认全保持:contextIsolation 开 / sandbox 开 / nodeIntegration 关。
// 加载的页面只能通过 preload 的 contextBridge 白名单调用原生能力,拿不到 Node。

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme, desktopCapturer, screen, systemPreferences } = require("electron");
const path = require("path");
const publish = require("./publish");
const video = require("./video");
const backend = require("./backend");
const frontend = require("./frontend");
const updater = require("./updater");
const crypto = require("crypto");

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

let mainWindow = null;
const windows = new Set();
let backendReady = false;
let frontendUrl = null; // prod 本地前端就绪后的 URL

function createWindow(opts = {}) {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "本机 AI 助手",
    // 跟随系统深浅色：暗色用深底，浅色用白底（避免启动闪屏与界面不一致）
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0e0f11" : "#ffffff",
    // macOS 原生质感:隐藏标题栏(保留红绿灯,内容延伸到顶),红绿灯位对齐桌面壳侧栏顶部 52px 区(见 web 的 .app-drag)。
    // 毛玻璃 vibrancy 暂不开——需配合侧栏背景透明 + 真机调，先用 CSS 近似(bg-sidebar/85 + backdrop-blur)。
    ...(isMac ? { titleBarStyle: "hiddenInset", trafficLightPosition: { x: 16, y: 18 } } : {}),
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
  if (opts.workbenchId) url.searchParams.set("workbench", opts.workbenchId);
  win.loadURL(url.toString());

  // 锁定壳层窗口标题=通用产品名。web/ 与云端共享，layout.tsx 的 document.title 是"球房 AI 运营助手"，
  // 默认会覆盖窗口标题(任务切换/调度中心/窗口菜单都显示旧名)。仅 preventDefault 在 Next 客户端路由下不够稳，
  // 这里 preventDefault + 主动 setTitle 双保险：任何时候页面想改标题都强制拉回"本机 AI 助手"(台球只是内置行业包)，
  // 又不改共享 web 文案、不影响云端。
  const PRODUCT_TITLE = "本机 AI 助手";
  const lockTitle = () => { if (!win.isDestroyed()) win.setTitle(PRODUCT_TITLE); };
  win.webContents.on("page-title-updated", (e) => { e.preventDefault(); lockTitle(); });
  win.webContents.on("dom-ready", lockTitle);
  win.webContents.on("did-finish-load", lockTitle);

  // 外链用系统浏览器打开,不在 app 内导航走丢
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.DESKTOP_DEVTOOLS === "1") win.webContents.openDevTools({ mode: "detach" });

  mainWindow = win;
  windows.add(win);
  win.on("focus", () => { mainWindow = BrowserWindow.getFocusedWindow() || win; });
  win.on("closed", () => {
    windows.delete(win);
    mainWindow = BrowserWindow.getAllWindows()[0] || null;
  });
  return win;
}

// 进度/状态回推渲染层(扫码就绪、发布进度、剪辑进度)
function emit(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
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
ipcMain.handle("publish:login:start", (_e, { platform }) =>
  publish.startLogin(platform, {
    onQrcode: (dataUrl) => emit("publish:login:qrcode", { platform, dataUrl }),
    onStatus: (status) => emit("publish:login:status", { platform, status }),
  })
);

ipcMain.handle("publish:login:check", (_e, { platform }) => publish.checkLogin(platform));

// 发布:人确认后调用。content = { videoPath, title, tags, coverPath, scheduleAt? }
ipcMain.handle("publish:post", (_e, { platform, content }) =>
  publish.post(platform, content, {
    onProgress: (p) => emit("publish:progress", { platform, ...p }),
  })
);

// ──────────────────────────────────────────────────────────────
// IPC:视频剪辑(ffmpeg)。基础能力:裁剪/拼接/竖屏转码/烧字幕/水印/变速。
// ──────────────────────────────────────────────────────────────
ipcMain.handle("video:probe", (_e, { inputPath }) => video.probe(inputPath));
ipcMain.handle("video:run", (_e, { op, args }) =>
  video.run(op, args, { onProgress: (p) => emit("video:progress", { op, ...p }) })
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
  if (canPickDir && opts.createDirectory) properties.push("createDirectory");
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
        error: "还没拿到「屏幕录制」权限，我看不到你的屏幕。请到 系统设置 → 隐私与安全性 → 屏幕录制 里勾上「本机 AI 助手」，再重开一次 App 就能用了。",
      };
    }
    const timeout = (ms, value = null) => new Promise((resolve) => setTimeout(() => resolve(value), ms));
    const saveScreenshot = (image, prefix = "screen") => {
      if (!image || image.isEmpty()) return null;
      const dir = path.join(app.getPath("userData"), "uploads", "screenshots");
      fs.mkdirSync(dir, { recursive: true });
      const fp = path.join(dir, `${prefix}_${Date.now()}_${require("crypto").randomBytes(4).toString("hex")}.png`);
      fs.writeFileSync(fp, image.toPNG());
      return { path: fp, size: image.getSize() };
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
      return { ok: true, path: captured.path, width: captured.size.width, height: captured.size.height, source: "screen" };
    }
    const win = BrowserWindow.getFocusedWindow() || mainWindow || BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      const windowImage = await win.capturePage();
      const fallback = saveScreenshot(windowImage, "screen_window");
      if (fallback) {
        return { ok: true, path: fallback.path, width: fallback.size.width, height: fallback.size.height, source: "window" };
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
  windowCount: BrowserWindow.getAllWindows().length,
}));

// 多窗口/多工作台最小闭环：新开一个独立窗口，前端状态、工作目录、任务订阅自然隔离。
ipcMain.handle("desktop:newWindow", () => {
  const workbenchId = `wb_${crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(12).toString("hex")}`;
  const w = createWindow({ workbenchId });
  return { ok: true, windowCount: BrowserWindow.getAllWindows().length, id: w.id, workbenchId };
});

app.whenReady().then(async () => {
  if (MANAGE_BACKEND) {
    // 全本地:先拉起本地后端(本地 SQLite),就绪后再开窗口
    const r = await backend.start({
      userDataDir: app.getPath("userData"),
      repoRoot: REPO_ROOT,
      onLog: (s) => { if (process.env.DESKTOP_DEVTOOLS === "1") process.stdout.write(`[backend] ${s}`); },
    });
    backendReady = r.ok;
    if (!r.ok) {
      // 不静默回落到打不开的空白页:明确弹一条人话报错,告诉用户端口可能被占用。
      console.error("本地后端未在超时内就绪,前端可能连不上");
      const port = r.port || 8077;
      dialog.showErrorBox(
        "本机 AI 助手启动失败",
        `后端服务没能起来(${port} 端口可能被别的程序占用)。\n\n` +
        `请关闭占用该端口的程序后,重新打开本软件。`
      );
    }
  }
  if (MANAGE_FRONTEND) {
    // prod:后端就绪后起本地 Next.js standalone(它把 /api/v1/* 反代到本地后端)。
    // 无 standalone 产物(dev 直接运行 electron .)则 ok=false,回落 DESKTOP_APP_URL/localhost:3000。
    const f = await frontend.start({
      onLog: (s) => { if (process.env.DESKTOP_DEVTOOLS === "1") process.stdout.write(`[frontend] ${s}`); },
    });
    if (f.ok) frontendUrl = f.url;
    else if (f.reason === "no-standalone") {
      // dev 路径:本就没打包前端产物,回落 DESKTOP_APP_URL/localhost:3000 是预期行为,不报错。
      console.warn("本地前端未起(无 standalone 产物),回落 DESKTOP_APP_URL/localhost:3000");
    } else {
      // 有 standalone 产物却没起来:端口被占用等真故障。不静默回落到打不开的页,弹人话报错。
      const port = f.port || 3100;
      console.error("本地前端未在超时内就绪");
      dialog.showErrorBox(
        "本机 AI 助手启动失败",
        `界面服务没能起来(${port} 端口可能被别的程序占用)。\n\n` +
        `请关闭占用该端口的程序后,重新打开本软件。`
      );
    }
  }
  createWindow();
  // 自动更新:打包后后台静默检查(dev/mac 内部自跳过,不阻塞、不打扰)
  updater.init({
    app,
    getWindow: () => mainWindow,
    onLog: (s) => { if (process.env.DESKTOP_DEVTOOLS === "1") process.stdout.write(s); },
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  publish.dispose();
  backend.stop();
  frontend.stop();
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => { backend.stop(); frontend.stop(); });
