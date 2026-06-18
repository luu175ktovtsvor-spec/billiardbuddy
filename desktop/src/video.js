// 视频剪辑层:ffmpeg-static + child_process.spawn(不用已归档的 fluent-ffmpeg)
//
// 打包坑(调研验证):asar 归档里的二进制不能直接 spawn,运行时要把路径
// app.asar → app.asar.unpacked;electron-builder 要 asarUnpack ffmpeg-static 二进制。
//
// 基础能力(MVP):probe(取时长/分辨率) + run(裁剪/拼接/竖屏转码/烧字幕/Logo水印/变速)。
// 进度:解析 ffmpeg stderr 的 `time=` 对照总时长算百分比,webContents.send 回推。

const { spawn } = require("child_process");

function resolveBin(mod) {
  // ffmpeg-static / ffprobe-static 导出二进制绝对路径;打包后要替换 asar→asar.unpacked
  let p = require(mod);
  if (typeof p === "object" && p.path) p = p.path; // ffprobe-static 导出 {path}
  return p.replace("app.asar", "app.asar.unpacked");
}

function ffmpegBin() { return resolveBin("ffmpeg-static"); }
function ffprobeBin() {
  try { return resolveBin("ffprobe-static"); } catch { return null; }
}

function _run(bin, args, { onProgress, totalSec } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args);
    let stderr = "";
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      // ffmpeg 进度行:frame=.. time=00:00:12.34 ..
      const m = s.match(/time=(\d+):(\d+):(\d+\.\d+)/);
      if (m && onProgress && totalSec) {
        const cur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
        onProgress({ pct: Math.min(100, Math.round((cur / totalSec) * 100)) });
      }
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve({ ok: true, log: stderr }) : reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(-400)}`))));
  });
}

// 取视频元数据(时长/宽高)
async function probe(inputPath) {
  const ffprobe = ffprobeBin();
  if (ffprobe) {
    const args = ["-v", "error", "-show_entries", "format=duration:stream=width,height", "-of", "json", inputPath];
    const out = await new Promise((res, rej) => {
      const c = spawn(ffprobe, args);
      let o = ""; c.stdout.on("data", (d) => (o += d)); c.on("error", rej);
      c.on("close", () => res(o));
    });
    try {
      const j = JSON.parse(out);
      const v = (j.streams || []).find((s) => s.width) || {};
      return { durationSec: parseFloat(j.format?.duration || 0), width: v.width || 0, height: v.height || 0 };
    } catch { return { durationSec: 0, width: 0, height: 0 }; }
  }
  return { durationSec: 0, width: 0, height: 0 };
}

// 各剪辑操作 → ffmpeg 命令行参数。args 由前端给,缺省值在此兜底。
const OPS = {
  // 裁剪:{ input, output, startSec, durationSec }
  trim: (a) => ["-y", "-ss", String(a.startSec || 0), "-i", a.input, "-t", String(a.durationSec), "-c", "copy", a.output],
  // 转竖屏 1080x1920(补黑边/居中裁,scale+pad):{ input, output }
  to_vertical: (a) => ["-y", "-i", a.input, "-vf",
    "scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:black", "-c:a", "copy", a.output],
  // 变速:{ input, output, speed }(speed=2 即2倍速)
  speed: (a) => ["-y", "-i", a.input, "-filter_complex",
    `[0:v]setpts=${1 / (a.speed || 1)}*PTS[v];[0:a]atempo=${a.speed || 1}[an]`, "-map", "[v]", "-map", "[an]", a.output],
  // 烧硬字幕:{ input, output, srtPath }
  burn_subtitle: (a) => ["-y", "-i", a.input, "-vf", `subtitles='${(a.srtPath || "").replace(/'/g, "\\'")}'`, "-c:a", "copy", a.output],
  // Logo水印:{ input, output, logoPath, x, y }(右上角缺省)
  watermark: (a) => ["-y", "-i", a.input, "-i", a.logoPath, "-filter_complex",
    `overlay=${a.x ?? "W-w-20"}:${a.y ?? 20}`, "-c:a", "copy", a.output],
  // 转码导出(统一编码,平台兼容):{ input, output }
  transcode: (a) => ["-y", "-i", a.input, "-c:v", "libx264", "-preset", "medium", "-crf", "23", "-c:a", "aac", "-b:a", "128k", a.output],
};

// 拼接多段(concat demuxer,需同编码):{ inputs:[..], output }——单独处理
async function _concat(a, ctx) {
  const fs = require("fs"); const os = require("os"); const path = require("path");
  const listFile = path.join(os.tmpdir(), `concat_${process.pid}.txt`);
  fs.writeFileSync(listFile, a.inputs.map((p) => `file '${p}'`).join("\n"));
  try {
    return await _run(ffmpegBin(), ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", a.output], ctx);
  } finally { try { fs.unlinkSync(listFile); } catch { /* ignore */ } }
}

async function run(op, args, { onProgress } = {}) {
  if (op === "concat") return _concat(args, { onProgress });
  const builder = OPS[op];
  if (!builder) throw new Error(`未知剪辑操作: ${op}`);
  const meta = args.input ? await probe(args.input).catch(() => ({})) : {};
  return _run(ffmpegBin(), builder(args), { onProgress, totalSec: meta.durationSec });
}

module.exports = { probe, run, OPS: Object.keys(OPS).concat("concat") };
