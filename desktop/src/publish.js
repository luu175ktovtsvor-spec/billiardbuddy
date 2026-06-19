// 发布层:Electron 主进程 ←(child_process)→ 本地 Python 发布内核(publisher/,借 social-auto-upload)
//
// 设计:浏览器自动化(patchright)绝不放渲染进程,跑在【独立 Python 子进程】里。
// 主进程只负责 spawn 子进程、按【JSON-line 协议】解析它的 stdout、把事件回推渲染层。
//
// 子进程协议(publisher/cli.py 每行输出一个 JSON):
//   {"type":"qrcode","dataUrl":"data:image/png;base64,..."}   登录二维码就绪
//   {"type":"status","status":"waiting|scanned|success|expired|error","msg":"..."}
//   {"type":"progress","stage":"upload|fill|publish","pct":0-100,"msg":"..."}
//   {"type":"result","ok":true|false,"url":"作品链接?","error":"..."}
//
// MVP 平台:抖音(douyin)先做;快手/视频号/小红书复用同协议,后续子代理并行加。

const { spawn, spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const readline = require("readline");

// 平台元数据(前端展示用);enabled=false 的是占位、worker 还没接
const PLATFORMS = [
  { id: "douyin", name: "抖音", enabled: true },
  { id: "kuaishou", name: "快手", enabled: true },
  { id: "shipinhao", name: "视频号", enabled: true },
  { id: "xiaohongshu", name: "小红书", enabled: true },
];

// 发布内核位置:dev 在 desktop/publisher;打包后在 resources/publisher(asarUnpack)
function publisherDir() {
  // process.resourcesPath 仅打包后存在
  const packed = process.resourcesPath ? path.join(process.resourcesPath, "publisher") : null;
  if (packed && fs.existsSync(packed)) return packed;
  return path.join(__dirname, "..", "publisher");
}

// cookie/会话存本机用户目录(每平台一份,加密由 worker 侧或后续补)
function sessionDir() {
  const dir = path.join(os.homedir(), ".billiards-desktop", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function pythonBin() {
  // dev 用系统 python3(可经 DESKTOP_PYTHON 覆盖,如 python / 绝对路径)
  return process.env.DESKTOP_PYTHON || "python3";
}

// 打包后的发布 worker 可执行(PyInstaller --onedir 产物,含 patchright,用户免装 Python)。
// 布局(同后端):resources/publisher-bin/billiards_publisher/billiards_publisher(.exe)。
// 存在则优先用它,否则回退 python3 cli.py(dev / 未打包 worker 时)。
function packagedWorkerExe() {
  if (!process.resourcesPath) return null;
  const exeName = process.platform === "win32" ? "billiards_publisher.exe" : "billiards_publisher";
  const p = path.join(process.resourcesPath, "publisher-bin", "billiards_publisher", exeName);
  return fs.existsSync(p) ? p : null;
}

// python3 是否真能跑(回退路径需要它)。spawnSync 同步探一下版本,失败=没装。
function pythonUsable() {
  try {
    const r = spawnSync(pythonBin(), ["--version"], { stdio: "ignore", timeout: 4000 });
    return r.status === 0; // 退出码 0 = 可执行
  } catch {
    return false;
  }
}

// 发布功能是否可用(给前端在显入口前先问,别让老板点了才失败)。
// 可用 = ① 装了打包发布内核(publisher-bin,免装 Python);或 ② 本机有 python3 且回退脚本在。
// 返回 { ok, reason }(reason 给前端拿去拼说人话提示)。
function checkAvailable() {
  if (packagedWorkerExe()) return { ok: true };
  const cliExists = fs.existsSync(path.join(publisherDir(), "cli.py"));
  if (cliExists && pythonUsable()) return { ok: true };
  // 不可用:区分两种原因,前端按 reason 给不同说人话提示
  if (!cliExists) return { ok: false, reason: "no_worker" }; // 安装包没带发布内核(理论上不该发生)
  return { ok: false, reason: "no_python" }; // 回退要 python3 但本机没装
}

const _running = new Map(); // platform -> child proc(防同平台并发)

function _spawnWorker(args, { onLine }) {
  const dir = publisherDir();
  // 优先打包 exe(billiards_publisher <args>);否则 dev 回退 python3 cli.py <args>。
  const exe = packagedWorkerExe();
  const [cmd, baseArgs] = exe
    ? [exe, []]
    : [pythonBin(), [path.join(dir, "cli.py")]];
  const child = spawn(cmd, [...baseArgs, ...args], {
    cwd: dir,
    env: { ...process.env, SAU_SESSION_DIR: sessionDir(), PYTHONUNBUFFERED: "1" },
  });
  let stderr = "";
  // spawn 失败(python3/打包 worker 找不到、无权限)时 stdout/stderr 为 null,
  // readline/.on 直接用会 TypeError 崩主进程;先判非 null。
  if (child.stdout) {
    const rl = readline.createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      line = line.trim();
      if (!line.startsWith("{")) return; // 忽略非协议输出(日志)
      try { onLine(JSON.parse(line)); } catch { /* 容错:坏行跳过 */ }
    });
  }
  if (child.stderr) child.stderr.on("data", (d) => { stderr += d.toString(); });
  // spawn 自身失败走 error 事件,不挂会未捕获崩主进程。把原因并进 stderr,
  // 让上层 close 回调(startLogin/checkLogin/post)的 reject 带上人话原因。
  child.on("error", (err) => { stderr += `\n[发布内核启动失败] ${err && err.message}`; });
  return { child, getStderr: () => stderr };
}

function listPlatforms() {
  return PLATFORMS;
}

// 启动扫码登录:返回 Promise(登录最终结果);过程中经回调推二维码/状态
function startLogin(platform, { onQrcode, onStatus }) {
  if (_running.has(`login:${platform}`)) return Promise.reject(new Error("该平台正在登录中"));
  return new Promise((resolve, reject) => {
    const { child, getStderr } = _spawnWorker(["login", "--platform", platform], {
      onLine: (msg) => {
        if (msg.type === "qrcode") onQrcode(msg.dataUrl);
        else if (msg.type === "status") onStatus(msg);
      },
    });
    _running.set(`login:${platform}`, child);
    child.on("close", (code) => {
      _running.delete(`login:${platform}`);
      if (code === 0) resolve({ ok: true });
      else reject(new Error(getStderr() || `登录进程退出码 ${code}`));
    });
  });
}

// 查登录态(cookie 是否还有效)
function checkLogin(platform) {
  return new Promise((resolve) => {
    let result = { loggedIn: false };
    const { child } = _spawnWorker(["check", "--platform", platform], {
      onLine: (msg) => { if (msg.type === "result") result = { loggedIn: !!msg.ok }; },
    });
    child.on("close", () => resolve(result));
  });
}

// 发布(人确认后调用)。content={videoPath,title,tags[],coverPath?,scheduleAt?}
function post(platform, content, { onProgress }) {
  if (_running.has(`post:${platform}`)) return Promise.reject(new Error("该平台有任务在发布中"));
  return new Promise((resolve, reject) => {
    const payloadPath = path.join(os.tmpdir(), `sau_post_${platform}_${process.pid}.json`);
    fs.writeFileSync(payloadPath, JSON.stringify(content), "utf-8");
    let finalResult = null;
    const { child, getStderr } = _spawnWorker(["post", "--platform", platform, "--payload", payloadPath], {
      onLine: (msg) => {
        if (msg.type === "progress") onProgress(msg);
        else if (msg.type === "result") finalResult = msg;
      },
    });
    _running.set(`post:${platform}`, child);
    child.on("close", (code) => {
      _running.delete(`post:${platform}`);
      try { fs.unlinkSync(payloadPath); } catch { /* ignore */ }
      if (finalResult && finalResult.ok) resolve(finalResult);
      else reject(new Error((finalResult && finalResult.error) || getStderr() || `发布进程退出码 ${code}`));
    });
  });
}

function dispose() {
  for (const child of _running.values()) {
    try { child.kill(); } catch { /* ignore */ }
  }
  _running.clear();
}

module.exports = { listPlatforms, checkAvailable, startLogin, checkLogin, post, dispose };
