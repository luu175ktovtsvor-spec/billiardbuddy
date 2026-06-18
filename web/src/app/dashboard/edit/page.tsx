"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Loader2, Upload, Smartphone, Scissors, Send, CheckCircle2 } from "lucide-react";
import { useDesktop } from "@/hooks/use-desktop";

/* 视频剪辑(桌面端专属):选视频 → 选操作(转竖屏/裁剪/烧字幕/Logo水印/变速/转码) → 本机 ffmpeg 处理 → 导出 → 去发布。
 * 全本地、不上传;输出存到源视频同目录(加 _edited 后缀)。 */

type OpId = "to_vertical" | "trim" | "speed" | "burn_subtitle" | "watermark" | "transcode";
const OPS: { id: OpId; name: string; desc: string }[] = [
  { id: "to_vertical", name: "转竖屏", desc: "9:16 抖音/快手竖屏(自动补黑边居中)" },
  { id: "trim", name: "裁剪片段", desc: "截取一段(填开始秒数+时长)" },
  { id: "speed", name: "变速", desc: "加速/减速(2=2倍速)" },
  { id: "burn_subtitle", name: "烧字幕", desc: "把 .srt 字幕烧进画面" },
  { id: "watermark", name: "加 Logo 水印", desc: "右上角叠门店 Logo" },
  { id: "transcode", name: "转码导出", desc: "统一编码、各平台兼容" },
];

function withSuffix(path: string, suffix: string) {
  const m = path.match(/^(.*)(\.[^.]+)$/);
  return m ? `${m[1]}${suffix}${m[2]}` : `${path}${suffix}.mp4`;
}

export default function EditPage() {
  const { isDesktop, electron } = useDesktop();
  const [op, setOp] = useState<OpId>("to_vertical");
  const [videoPath, setVideoPath] = useState("");
  const [videoName, setVideoName] = useState("");
  const [srtPath, setSrtPath] = useState("");
  const [logoPath, setLogoPath] = useState("");
  const [startSec, setStartSec] = useState("0");
  const [durationSec, setDurationSec] = useState("15");
  const [speed, setSpeed] = useState("1.5");
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [outputPath, setOutputPath] = useState("");
  const [error, setError] = useState("");
  const vRef = useRef<HTMLInputElement>(null);
  const sRef = useRef<HTMLInputElement>(null);
  const lRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!electron) return;
    return electron.video.onProgress((p) => setPct(p.pct || 0));
  }, [electron]);

  const pickPath = (e: React.ChangeEvent<HTMLInputElement>, set: (p: string) => void, setName?: (n: string) => void) => {
    const f = e.target.files?.[0];
    if (!f) return;
    set((f as File & { path?: string }).path || "");
    setName?.(f.name);
  };

  const run = async () => {
    if (!electron || !videoPath) return;
    const output = withSuffix(videoPath, "_edited");
    const args: Record<string, unknown> = { input: videoPath, output };
    if (op === "trim") { args.startSec = parseFloat(startSec) || 0; args.durationSec = parseFloat(durationSec) || 15; }
    if (op === "speed") args.speed = parseFloat(speed) || 1;
    if (op === "burn_subtitle") { if (!srtPath) { setError("先选 .srt 字幕文件"); return; } args.srtPath = srtPath; }
    if (op === "watermark") { if (!logoPath) { setError("先选 Logo 图片"); return; } args.logoPath = logoPath; }
    setRunning(true); setError(""); setOutputPath(""); setPct(0);
    try {
      await electron.video.run(op, args);
      setOutputPath(output);
    } catch (err) {
      setError(err instanceof Error ? err.message : "剪辑失败");
    } finally {
      setRunning(false);
    }
  };

  if (!isDesktop) {
    return (
      <div className="mx-auto max-w-xl py-16 text-center">
        <Smartphone className="mx-auto mb-4 h-12 w-12 text-slate-300" />
        <h1 className="mb-2 text-lg font-semibold text-slate-900">视频剪辑是桌面版功能</h1>
        <p className="text-sm text-slate-500">剪辑在你电脑本机处理(不上传、快)。请用「台球运营管家」桌面版。</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl pb-24">
      <h1 className="mb-1 text-xl font-bold text-slate-900">视频剪辑</h1>
      <p className="mb-6 text-sm text-slate-500">本机处理、不上传;剪好直接去发布。</p>

      {/* 选视频 */}
      <input ref={vRef} type="file" accept="video/*" className="hidden" onChange={(e) => pickPath(e, setVideoPath, setVideoName)} />
      <button type="button" onClick={() => vRef.current?.click()}
        className="mb-4 flex w-full items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-slate-50 px-4 py-3 text-sm text-slate-600">
        <Upload className="h-4 w-4" />{videoName || "选择本地视频…"}
      </button>

      {/* 选操作 */}
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3">
        {OPS.map((o) => (
          <button key={o.id} type="button" onClick={() => setOp(o.id)}
            className={`rounded-xl px-3 py-2.5 text-left transition-colors ${op === o.id ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-700"}`}>
            <div className="text-sm font-medium">{o.name}</div>
            <div className={`text-[11px] ${op === o.id ? "text-white/80" : "text-slate-400"}`}>{o.desc}</div>
          </button>
        ))}
      </div>

      {/* 操作参数 */}
      <div className="mb-4 space-y-3 rounded-2xl border border-slate-100 bg-white p-4">
        {op === "trim" && (
          <div className="grid grid-cols-2 gap-3">
            <label className="text-sm text-slate-600">开始(秒)<input value={startSec} onChange={(e) => setStartSec(e.target.value)} className="mt-1 h-10 w-full rounded-lg bg-slate-50 px-3" /></label>
            <label className="text-sm text-slate-600">时长(秒)<input value={durationSec} onChange={(e) => setDurationSec(e.target.value)} className="mt-1 h-10 w-full rounded-lg bg-slate-50 px-3" /></label>
          </div>
        )}
        {op === "speed" && (
          <label className="text-sm text-slate-600">倍速(0.5-4)<input value={speed} onChange={(e) => setSpeed(e.target.value)} className="mt-1 h-10 w-full rounded-lg bg-slate-50 px-3" /></label>
        )}
        {op === "burn_subtitle" && (
          <>
            <input ref={sRef} type="file" accept=".srt" className="hidden" onChange={(e) => pickPath(e, setSrtPath)} />
            <button type="button" onClick={() => sRef.current?.click()} className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">{srtPath ? "已选字幕 ✓" : "选 .srt 字幕"}</button>
          </>
        )}
        {op === "watermark" && (
          <>
            <input ref={lRef} type="file" accept="image/*" className="hidden" onChange={(e) => pickPath(e, setLogoPath)} />
            <button type="button" onClick={() => lRef.current?.click()} className="rounded-lg bg-slate-100 px-3 py-2 text-sm text-slate-600">{logoPath ? "已选 Logo ✓" : "选 Logo 图片"}</button>
          </>
        )}
        {(op === "to_vertical" || op === "transcode") && <p className="text-sm text-slate-400">无需额外参数,直接处理。</p>}
      </div>

      {running && (
        <div className="mb-4 rounded-2xl bg-slate-50 p-4">
          <div className="mb-1.5 flex items-center gap-2 text-sm text-slate-600"><Loader2 className="h-4 w-4 animate-spin" />本机处理中… {pct}%</div>
          <div className="h-1.5 w-full rounded-full bg-slate-200"><div className="h-1.5 rounded-full bg-brand-500 transition-all" style={{ width: `${pct}%` }} /></div>
        </div>
      )}
      {error && <div className="mb-4 rounded-2xl bg-red-50 p-4 text-sm text-red-700">⚠️ {error}</div>}
      {outputPath && (
        <div className="mb-4 rounded-2xl bg-emerald-50 p-4 text-sm text-emerald-700">
          <div className="flex items-center gap-1.5"><CheckCircle2 className="h-4 w-4" />剪好了,已存到:</div>
          <div className="mt-1 break-all font-mono text-xs">{outputPath}</div>
          <Link href="/dashboard/publish" className="mt-2 inline-flex items-center gap-1 rounded-lg bg-brand-600 px-3 py-1.5 text-white"><Send className="h-3.5 w-3.5" />去发布</Link>
        </div>
      )}

      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-100 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-2xl">
          <button type="button" disabled={!videoPath || running} onClick={run}
            className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 text-[15px] font-medium text-white disabled:opacity-40">
            {running ? <Loader2 className="h-5 w-5 animate-spin" /> : <Scissors className="h-5 w-5" />}开始剪辑
          </button>
        </div>
      </div>
    </div>
  );
}
