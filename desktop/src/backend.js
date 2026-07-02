// 本地后端编排:Electron 启动时拉起本地 FastAPI(本地 SQLite),全本地、不连云。
// 参考 every-pdf(1229★)模式:spawn 后端 → 轮询 /health 就绪 → crash 自动重启 → 退出 kill。
//
// dev:spawn `uv run uvicorn main:app`(server/ 目录,DATABASE_URL=本地 SQLite)。
// prod:spawn 打进 resources/backend 的 PyInstaller 可执行(后续 build_backend.js 产出)。
//
// 数据库文件存用户数据目录(userData),门店数据是用户自己的、在本机。

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const HOST = "127.0.0.1";
let _port = parseInt(process.env.DESKTOP_BACKEND_PORT || "8077", 10);
let _proc = null;
let _stopping = false;

// 解析 ffmpeg/ffprobe 二进制路径注入后端(装机版 ffbin.py 回退路径不存在)。
// asar 内二进制不可执行 → 指到 app.asar.unpacked(需 build.asarUnpack 带 ffmpeg-static/ffprobe-static)。
function resolveFfBins() {
  const out = {};
  const unpack = (p) => (typeof p === "string" ? p.replace("app.asar", "app.asar.unpacked") : p);
  try { const f = require("ffmpeg-static"); if (f) out.FFMPEG_BIN = unpack(f); } catch { /* 没装则不注入,ffbin 自兜底 */ }
  try { const p = require("ffprobe-static"); if (p && p.path) out.FFPROBE_BIN = unpack(p.path); } catch { /* ignore */ }
  return out;
}

function backendUrl() { return `http://${HOST}:${_port}`; }

// 读取【内置 bundle 密钥】并注入后端进程 env（全内置·用户零配置；key 不写进 git 源码，只放 gitignored 文件/打包资源）。
// 找几个位置：dev 用 server/.env.bundled.local；prod 用打进 resources 的 bundled.env。解析 KEY=VALUE（# 注释、空行跳过）。
function _loadBundledEnv(repoRoot) {
  const candidates = [
    process.resourcesPath ? path.join(process.resourcesPath, "bundled.env") : null,
    repoRoot ? path.join(repoRoot, "server", ".env.bundled.local") : null,
  ].filter(Boolean);
  for (const f of candidates) {
    try {
      if (!fs.existsSync(f)) continue;
      const out = {};
      for (const line of fs.readFileSync(f, "utf-8").split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith("#")) continue;
        const i = s.indexOf("=");
        if (i <= 0) continue;
        out[s.slice(0, i).trim()] = s.slice(i + 1).trim();
      }
      return out;
    } catch { /* ignore, 试下一个 */ }
  }
  return {};
}

// SQLite 数据库文件:userData/billiards.db(用户数据,本机)
function dbUrl(userDataDir) {
  const dbFile = path.join(userDataDir, "billiards.db");
  // aiosqlite 绝对路径:sqlite+aiosqlite:////abs/path
  return `sqlite+aiosqlite:///${dbFile}`;
}

function pingHealth() {
  return new Promise((resolve) => {
    const req = http.get(`${backendUrl()}/api/v1/health`, (res) => {
      resolve(res.statusCode === 200); res.resume();
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function _waitReady(timeoutMs = 60000) {  // 冷启(解密知识库+建库+import)在老机/机械盘较慢,给足 60s
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pingHealth()) return true;
    await new Promise((r) => setTimeout(r, 600));
  }
  return false;
}

// JWT 签名密钥:本地单机版每安装持久化一个随机值(userData/secret.key),
// 重启后 token 不失效。后端 main.py 强制 SECRET_KEY 非空才启动。
function secretKey(userDataDir) {
  const f = path.join(userDataDir, "secret.key");
  try {
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf-8").trim();
  } catch { /* ignore */ }
  const key = require("crypto").randomBytes(32).toString("hex");
  try { fs.writeFileSync(f, key, { mode: 0o600 }); } catch { /* ignore */ }
  return key;
}

// BYOK 主密钥:加密老板自带的大模型 key(Fernet)。纯 BYOK 模式下盒子不内置任何平台 key,
// 老板首启填自己的 key → 后端用此主密钥加密落本地 SQLite。每安装持久化一个,
// 否则 PUT /me/byok 会因 BYOK_ENCRYPT_KEY 缺失返回 503,桌面大模型起不来(P0.1 致命卡点)。
// Fernet key 要求 32 字节经 url-safe base64 编码、且带 padding 的 44 字符串
// (Python base64.urlsafe_b64decode 严格校验 padding,缺 '=' 会 "Incorrect padding")。
// Node 的 base64url 不带 padding(43 字符),这里补齐到 4 的倍数。
function byokEncryptKey(userDataDir) {
  const f = path.join(userDataDir, "byok.key");
  try {
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf-8").trim();
  } catch { /* ignore */ }
  const raw = require("crypto").randomBytes(32).toString("base64url");
  const key = raw + "=".repeat((4 - (raw.length % 4)) % 4); // 43 → 44 (Fernet 合法)
  try { fs.writeFileSync(f, key, { mode: 0o600 }); } catch { /* ignore */ }
  return key;
}

function _spawnProc({ userDataDir, repoRoot, onLog }) {
  const env = {
    ...process.env,
    ..._loadBundledEnv(repoRoot),   // 内置模型 key（MiMo/Seedream/Seedance…）；放最前，下面的基建 env 仍能覆盖它
    DATABASE_URL: dbUrl(userDataDir),
    DESKTOP_LOCAL: "1",
    SECRET_KEY: secretKey(userDataDir),
    BYOK_ENCRYPT_KEY: byokEncryptKey(userDataDir), // 纯 BYOK:加密老板自带 key,缺它则 PUT /me/byok 503
    RAG_EMBEDDER: "fastembed", // 本地语义模型(bge-zh ~90MB):知识/店脑/历史"按意思找料",换说法也能找对。
                               // 首次用时联网拉~90MB存本机缓存(后续离线);打包时应预置模型免首次下载(见执行清单)。
    // 上传/海报/Logo/二维码落点:app 包内是【只读】的(装到 /Applications 或 Gatekeeper translocation),
    // 不指开会让生图写盘崩、最坏首启 mkdir 崩。指到 userData 可写目录。
    UPLOAD_DIR: path.join(userDataDir, "uploads"),
    // 口播模型(whisper ~1.4G)不打进包(省体积),首启后台下到 userData/models(见 model-downloader.js)。
    // 指到那个落点:下好前 transcribe.py 判目录不存在→口播不可用(前端已灰掉按钮),下好后自动可用。
    WHISPER_MODEL_DIR: path.join(userDataDir, "models", "faster-whisper-medium"),
    // V2 视频渲染:后端拉起本 app 自带的 Chromium 做离屏渲染(不额外打 Playwright,见开发文档 §8)。
    // ELECTRON_BIN=本 app 二进制;QF_RENDER_MAIN=要传的脚本(dev 传 main.js;装机包 baked main → 空,不传)。
    ELECTRON_BIN: process.execPath,
    QF_RENDER_MAIN: require("electron").app.isPackaged ? "" : path.join(__dirname, "main.js"),
    // ffmpeg/ffprobe 二进制路径(装机版 ffbin.py 的回退写死 desktop/node_modules,装机包不存在 → 必须显式注入)。
    // asar 里的二进制不可执行 → 指到 app.asar.unpacked(需 package.json build.asarUnpack 带 ffmpeg-static/ffprobe-static)。
    ...resolveFfBins(),
  };
  // PyInstaller onedir 产物:resources/backend/billiards_backend/billiards_backend(目录里的内层 exe)。
  const exeName = process.platform === "win32" ? "billiards_backend.exe" : "billiards_backend";
  const packedExe = process.resourcesPath
    ? path.join(process.resourcesPath, "backend", "billiards_backend", exeName)
    : null;

  // detached(非 Windows):子进程自成进程组(setsid),退出时能"负 pid"整组掐断——尤其 dev 下 uv 会再 fork
  // uvicorn 子进程,只杀 uv 父进程会留下 uvicorn 继续占 8077,下次开 app "端口被占"起不来(实测踩到)。
  const _detached = process.platform !== "win32";
  if (packedExe && fs.existsSync(packedExe)) {
    // prod:跑打包的 PyInstaller 可执行
    _proc = spawn(packedExe, ["--host", HOST, "--port", String(_port)], { env, cwd: path.dirname(packedExe), detached: _detached });
  } else {
    // dev:server/ 目录跑 uv uvicorn(本机 SQLite)
    const serverDir = path.join(repoRoot, "server");
    _proc = spawn("uv", ["run", "uvicorn", "main:app", "--host", HOST, "--port", String(_port)], { env, cwd: serverDir, detached: _detached });
  }
  // spawn 失败(命令不存在/无权限/exe 损坏)时 stdout/stderr 为 null,直接 .on 会 TypeError 崩主进程。
  if (_proc.stdout) _proc.stdout.on("data", (d) => onLog && onLog(d.toString()));
  if (_proc.stderr) _proc.stderr.on("data", (d) => onLog && onLog(d.toString()));
  // spawn 失败时 error 与 close 会先后各触发一次,只能重启一次,否则两个定时器叠加成 spawn 风暴。
  // 用一次性闸把"失败 → 延时重启"统一收口,保持原有自愈机制。
  let _restarted = false;
  const _restart = (why) => {
    if (_restarted) return;
    _restarted = true;
    _proc = null;
    if (!_stopping) {
      onLog && onLog(`[backend] ${why},3 秒后重启…\n`);
      setTimeout(() => _spawnProc({ userDataDir, repoRoot, onLog }), 3000);
    }
  };
  // spawn 自身失败(可执行文件找不到、uv 没装)走 error 事件,不挂会抛未捕获异常崩主进程。
  _proc.on("error", (err) => _restart(`启动失败:${err && err.message}`));
  _proc.on("close", (code) => _restart(`进程退出(code ${code})`));
}

// 启动后端并等就绪。返回 { ok, url }。
async function start({ userDataDir, repoRoot, onLog }) {
  fs.mkdirSync(userDataDir, { recursive: true });
  _stopping = false;
  _spawnProc({ userDataDir, repoRoot, onLog });
  const ready = await _waitReady();
  if (!ready) {
    // 健康探活超时:最常见是 8077 端口被别的程序占用(后端起不来/连不上),
    // 不能静默回落到打不开的空白页。明确记一条人话原因,main 据此弹窗告诉用户。
    onLog && onLog(`[backend] 后端在超时内未就绪:${_port} 端口可能被别的程序占用,请关闭占用程序后重启软件。\n`);
  }
  return { ok: ready, url: backendUrl(), port: _port };
}

// 整组掐断后端进程：避免"杀了父进程、子进程(uvicorn)还活着占 8077"留孤儿。
function _killTree(proc) {
  if (!proc || !proc.pid) return;
  if (process.platform === "win32") {
    // Windows 无进程组负 pid 语义 → taskkill /T 连子树一起杀
    try { spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"]); return; } catch { /* fallthrough */ }
  } else {
    // detached 启动 → 进程组 id = pid，负号杀整组(连 uv 拉起的 uvicorn)。先 SIGTERM 优雅退、500ms 后没退再 SIGKILL。
    try { process.kill(-proc.pid, "SIGTERM"); }
    catch { try { proc.kill("SIGTERM"); } catch { /* ignore */ } }
    setTimeout(() => { try { process.kill(-proc.pid, "SIGKILL"); } catch { /* ignore */ } }, 500);
    return;
  }
  try { proc.kill(); } catch { /* ignore */ }
}

function stop() {
  _stopping = true;
  if (_proc) { _killTree(_proc); _proc = null; }
}

module.exports = { start, stop, backendUrl, loadBundledEnv: _loadBundledEnv };
