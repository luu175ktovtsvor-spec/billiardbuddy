// 口播模型(faster-whisper-medium, ~1.4G)按需下载器。
//
// 为什么不打进安装包:whisper 占 1.4G,装包会到 1.7G 劝退用户。抽出来放服务器,
// 用户首次打开主界面时后台下载、下完存本地、以后不再下(参照大厂"核心小+重货按需下")。
// 核心程序/生图/基础视频不依赖它,装完立刻能用;只有"口播转字幕"要等它就绪。
//
// 下载源:QF_MODEL_BASE_URL(bundled.env,指向 owner 中国服务器的 /models/)。
// 落点:userData/models/faster-whisper-medium/(可写目录),backend.js 经 WHISPER_MODEL_DIR 指过去。
// 健壮性:断点续传(Range)、sha256 校验(防下坏)、原子落盘(.part→rename)、幂等(已完整则跳过)、失败可重试。

const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const crypto = require("crypto");

const MODEL_NAME = "faster-whisper-medium";

function modelDir(userDataDir) {
  return path.join(userDataDir, "models", MODEL_NAME);
}

// 下载源基址:去尾斜杠。优先用显式传入(main.js 从 bundled.env 读),回退 process.env。
function baseUrl(explicit) {
  return String(explicit || process.env.QF_MODEL_BASE_URL || "").replace(/\/+$/, "");
}

function _get(url) {
  // 返回 Promise<IncomingMessage>(已发起、可读流)。跟随一次重定向。http/https 自适应。
  return new Promise((resolve, reject) => {
    const lib = url.startsWith("https") ? https : http;
    const req = lib.get(url, { timeout: 30000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        _get(res.headers.location).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("下载连接超时")));
    req.on("error", reject);
  });
}

function _getJson(url) {
  return _get(url).then(
    (res) =>
      new Promise((resolve, reject) => {
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} @ ${url}`)); }
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (buf += c));
        res.on("end", () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
        res.on("error", reject);
      })
  );
}

function _sha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    const s = fs.createReadStream(file);
    s.on("data", (d) => h.update(d));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

// 单文件下载:支持 Range 断点续传;下到 <dest>.part,校验 sha256 通过后 rename 成 <dest>。
// onBytes(deltaBytes) 每收到一块回调一次,供上层累计总进度。
async function _downloadFile(url, dest, expectSize, expectSha, onBytes) {
  const part = dest + ".part";
  let have = 0;
  try { have = fs.statSync(part).size; } catch { have = 0; }
  if (have > expectSize) { fs.rmSync(part, { force: true }); have = 0; } // .part 反而更大=坏了,重下

  const lib = url.startsWith("https") ? https : http;
  await new Promise((resolve, reject) => {
    const headers = have > 0 ? { Range: `bytes=${have}-` } : {};
    const req = lib.get(url, { headers, timeout: 30000 }, (res) => {
      if (res.statusCode === 416) { res.resume(); return resolve(); } // 已下满
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} @ ${url}`)); }
      // 服务器不认 Range(返 200 而非 206)→ 从头写,别追加
      const append = res.statusCode === 206 && have > 0;
      if (!append) have = 0;
      const out = fs.createWriteStream(part, { flags: append ? "a" : "w" });
      res.on("data", (chunk) => { onBytes && onBytes(chunk.length); });
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("下载连接超时")));
    req.on("error", reject);
  });

  const sz = fs.statSync(part).size;
  if (sz !== expectSize) throw new Error(`文件大小不符(${sz}≠${expectSize}) ${path.basename(dest)}`);
  if (expectSha) {
    const sha = await _sha256(part);
    if (sha !== expectSha) { fs.rmSync(part, { force: true }); throw new Error(`校验失败(下坏了) ${path.basename(dest)}`); }
  }
  fs.renameSync(part, dest);
}

// 本地模型是否已就绪(全部文件在、大小对得上 manifest)。无 manifest(离线/首启还没下)时按文件存在粗判。
function isReadySync(userDataDir, manifest) {
  const dir = modelDir(userDataDir);
  if (!fs.existsSync(path.join(dir, "model.bin"))) return false;
  if (!manifest) return true; // 有 model.bin 且拿不到 manifest 校验时,先当就绪(离线兜底)
  for (const [name, info] of Object.entries(manifest.files || {})) {
    const f = path.join(dir, name);
    try { if (fs.statSync(f).size !== info.size) return false; } catch { return false; }
  }
  return true;
}

// 确保模型就位。已就绪则秒返;否则按 manifest 逐个文件断点续传下载 + 校验。
// onProgress({phase, percent, downloadedBytes, totalBytes, file}) 全程回调。
// 返回 { ok, dir, error }。失败不抛(上层据 ok 决定重试/提示)。
async function ensureModel(userDataDir, { onProgress, baseUrl: explicitBase } = {}) {
  const dir = modelDir(userDataDir);
  const base = baseUrl(explicitBase);
  const emit = (o) => { try { onProgress && onProgress(o); } catch {} };

  if (!base) return { ok: false, dir, error: "未配置模型下载地址(QF_MODEL_BASE_URL)" };

  // 先拿 manifest(小文件,几KB)。拿不到但本地已有 model.bin → 当就绪(离线兜底)。
  let manifest = null;
  try { manifest = await _getJson(`${base}/${MODEL_NAME}/manifest.json`); } catch (e) {
    if (isReadySync(userDataDir, null)) { emit({ phase: "ready", percent: 100 }); return { ok: true, dir }; }
    return { ok: false, dir, error: "拿不到模型清单(网络不通?): " + e.message };
  }

  if (isReadySync(userDataDir, manifest)) { emit({ phase: "ready", percent: 100 }); return { ok: true, dir }; }

  fs.mkdirSync(dir, { recursive: true });
  const entries = Object.entries(manifest.files || {});
  const totalBytes = entries.reduce((s, [, i]) => s + i.size, 0);
  // 已完成文件的字节先计入进度(断点续传体验:重开接着涨)
  let done = 0;
  for (const [name, info] of entries) {
    const f = path.join(dir, name);
    try { if (fs.statSync(f).size === info.size) done += info.size; } catch {}
  }
  emit({ phase: "downloading", percent: Math.floor((done / totalBytes) * 100), downloadedBytes: done, totalBytes });

  for (const [name, info] of entries) {
    const f = path.join(dir, name);
    try { if (fs.statSync(f).size === info.size) continue; } catch {} // 已完整,跳过
    try {
      let fileDone = 0;
      try { fileDone = fs.statSync(f + ".part").size; } catch {}
      await _downloadFile(`${base}/${MODEL_NAME}/${name}`, f, info.size, info.sha256, (delta) => {
        done += delta;
        emit({ phase: "downloading", percent: Math.min(99, Math.floor((done / totalBytes) * 100)), downloadedBytes: done, totalBytes, file: name });
      });
    } catch (e) {
      return { ok: false, dir, error: `下载 ${name} 失败: ${e.message}` };
    }
  }
  emit({ phase: "ready", percent: 100, downloadedBytes: totalBytes, totalBytes });
  return { ok: true, dir };
}

module.exports = { modelDir, isReadySync, ensureModel, MODEL_NAME, _internal: { _downloadFile, _getJson, _sha256 } };
