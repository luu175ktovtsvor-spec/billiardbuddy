// 本地前端编排：prod 时拉起 Next.js standalone 服务（server.js），渲染层 loadURL 它。
//
// 架构（为何这么简单可靠）：
//   - web 用 output:"standalone" 打包出 server.js，自带 Node http 服务。
//   - next.config.js 的 rewrites 已把 /api/v1/* 和 /uploads/* 反代到 API_PROXY_URL
//     （打包时已烘成 http://127.0.0.1:8077 = 本地后端端口）。
//   - 前端用相对 API 路径（NEXT_PUBLIC_API_URL 空）→ 浏览器看是【同源】请求 server.js
//     → server.js 反代到后端。**零 CORS、零跨域**，前端不需要知道后端在哪。
//
//   所以 main 进程只需：起后端(8077) → 起前端(server.js, 固定 3100) → loadURL http://127.0.0.1:3100。
//
// dev 不走这里（main.js 用 DESKTOP_APP_URL=localhost:3000 直连 web dev）。

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const http = require("http");

const HOST = "127.0.0.1";
const PORT = parseInt(process.env.DESKTOP_FRONTEND_PORT || "3100", 10);
let _proc = null;
let _stopping = false;

function frontendUrl() { return `http://${HOST}:${PORT}`; }

// 前端 standalone 产物落点：electron-builder extraResources 把 web/.next/standalone 等拷成
// resources/frontend/app/（含 server.js + .next/static + public）。见 scripts/build_frontend.js。
function serverEntry() {
  if (!process.resourcesPath) return null;
  const entry = path.join(process.resourcesPath, "frontend", "app", "server.js");
  return fs.existsSync(entry) ? entry : null;
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get(frontendUrl(), (res) => { resolve(res.statusCode > 0); res.resume(); });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => { req.destroy(); resolve(false); });
  });
}

async function _waitReady(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await ping()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function _spawnProc(entry, onLog) {
  const cwd = path.dirname(entry);
  const env = {
    ...process.env,
    PORT: String(PORT),
    HOSTNAME: HOST,
    NODE_ENV: "production",
  };
  // 用 Electron 自带的 Node 跑 server.js（ELECTRON_RUN_AS_NODE：把当前 Electron 二进制当纯 Node 用，
  // 用户机器不需另装 Node）。
  _proc = spawn(process.execPath, [entry], {
    cwd,
    env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
  });
  _proc.stdout.on("data", (d) => onLog && onLog(d.toString()));
  _proc.stderr.on("data", (d) => onLog && onLog(d.toString()));
  _proc.on("close", (code) => {
    _proc = null;
    if (!_stopping) {
      onLog && onLog(`[frontend] 进程退出(code ${code})，3 秒后重启…\n`);
      setTimeout(() => _spawnProc(entry, onLog), 3000);
    }
  });
}

// 启动前端并等就绪。返回 { ok, url }。无 standalone 产物（dev）则 ok=false 让 main 走 dev 路径。
async function start({ onLog } = {}) {
  const entry = serverEntry();
  if (!entry) return { ok: false, url: null, reason: "no-standalone" };
  _stopping = false;
  _spawnProc(entry, onLog);
  const ready = await _waitReady();
  return { ok: ready, url: frontendUrl() };
}

function stop() {
  _stopping = true;
  if (_proc) { try { _proc.kill(); } catch { /* ignore */ } _proc = null; }
}

module.exports = { start, stop, frontendUrl, serverEntry };
