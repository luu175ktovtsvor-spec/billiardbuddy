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

function backendUrl() { return `http://${HOST}:${_port}`; }

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

async function _waitReady(timeoutMs = 30000) {
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
    DATABASE_URL: dbUrl(userDataDir),
    DESKTOP_LOCAL: "1",
    SECRET_KEY: secretKey(userDataDir),
    BYOK_ENCRYPT_KEY: byokEncryptKey(userDataDir), // 纯 BYOK:加密老板自带 key,缺它则 PUT /me/byok 503
  };
  // PyInstaller onedir 产物:resources/backend/billiards_backend/billiards_backend(目录里的内层 exe)。
  const exeName = process.platform === "win32" ? "billiards_backend.exe" : "billiards_backend";
  const packedExe = process.resourcesPath
    ? path.join(process.resourcesPath, "backend", "billiards_backend", exeName)
    : null;

  if (packedExe && fs.existsSync(packedExe)) {
    // prod:跑打包的 PyInstaller 可执行
    _proc = spawn(packedExe, ["--host", HOST, "--port", String(_port)], { env, cwd: path.dirname(packedExe) });
  } else {
    // dev:server/ 目录跑 uv uvicorn(本机 SQLite)
    const serverDir = path.join(repoRoot, "server");
    _proc = spawn("uv", ["run", "uvicorn", "main:app", "--host", HOST, "--port", String(_port)], { env, cwd: serverDir });
  }
  _proc.stdout.on("data", (d) => onLog && onLog(d.toString()));
  _proc.stderr.on("data", (d) => onLog && onLog(d.toString()));
  _proc.on("close", (code) => {
    _proc = null;
    if (!_stopping) {
      onLog && onLog(`[backend] 进程退出(code ${code}),3 秒后重启…\n`);
      setTimeout(() => _spawnProc({ userDataDir, repoRoot, onLog }), 3000);
    }
  });
}

// 启动后端并等就绪。返回 { ok, url }。
async function start({ userDataDir, repoRoot, onLog }) {
  fs.mkdirSync(userDataDir, { recursive: true });
  _stopping = false;
  _spawnProc({ userDataDir, repoRoot, onLog });
  const ready = await _waitReady();
  return { ok: ready, url: backendUrl() };
}

function stop() {
  _stopping = true;
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; }
}

module.exports = { start, stop, backendUrl };
