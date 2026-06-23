// 台球运营管家 · 桌面端 Electron 主进程
//
// 职责:① 开窗口加载现有 web 前端(连云后端出内容/跑 Agent);
//      ② 把"本地原生能力"(发布 RPA / 视频剪辑)经 IPC 暴露给前端;
//      ③ 浏览器自动化(patchright)跑在【独立子进程】,绝不在渲染进程——见 publish.js。
//
// 安全默认全保持:contextIsolation 开 / sandbox 开 / nodeIntegration 关。
// 加载的页面只能通过 preload 的 contextBridge 白名单调用原生能力,拿不到 Node。

const { app, BrowserWindow, ipcMain, shell, dialog, nativeTheme } = require("electron");
const path = require("path");
const publish = require("./publish");
const video = require("./video");
const backend = require("./backend");
const frontend = require("./frontend");
const updater = require("./updater");

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
let backendReady = false;
let frontendUrl = null; // prod 本地前端就绪后的 URL

function createWindow() {
  const isMac = process.platform === "darwin";
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "台球运营管家",
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
  const url = frontendUrl || FORCED_APP_URL || "http://localhost:3000";
  mainWindow.loadURL(url);

  // 外链用系统浏览器打开,不在 app 内导航走丢
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  if (process.env.DESKTOP_DEVTOOLS === "1") mainWindow.webContents.openDevTools({ mode: "detach" });

  mainWindow.on("closed", () => { mainWindow = null; });
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
  // opts.directory=true → 选文件夹(授权 AI 在整个文件夹里读改,如"我的报表"目录);否则选文件。
  const base = opts.directory ? ["openDirectory"] : ["openFile"];
  const properties = opts.multi ? [...base, "multiSelections"] : base;
  const dialogOpts = {
    title: opts.title || (opts.directory ? "选择要让 AI 处理的文件夹" : "选择要让 AI 处理的文件"),
    properties,
  };
  if (!opts.directory) {
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

// 是否运行在桌面端 + 本地后端地址(前端运行时据此连本地后端,不依赖 build 期 env)
ipcMain.handle("desktop:info", () => ({
  isDesktop: true,
  version: app.getVersion(),
  platform: process.platform,
  backendUrl: MANAGE_BACKEND ? backend.backendUrl() : null,
  backendReady,
}));

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
        "台球运营管家启动失败",
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
        "台球运营管家启动失败",
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
