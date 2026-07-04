"use client";

/**
 * 视频创作工作区(独立整页 · /dashboard/video):
 *   左·预览播放器(客户端秒级:顺序播选中源片段 + DOM 文案浮层,改文案即时刷新,不等渲染)
 *   下·镜头条(挑出的高光段) · 右·控制台(选素材/模式/比例/生成) + 内置对话框(改文案) + 出片
 * 接后端 V2 三步:/auto_plan_v2(出方案+配文案) → /recaption(对话改文案) → /render_v2(出片,慢)。
 * 「预览走客户端、导出走服务端」:改文案在浏览器 DOM 即时看到;点"出片"才服务端逐帧渲染成有包装的成品。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Film, Plus, Loader2, Sparkles, Send, Download, Play, Pause, Clapperboard, AlertTriangle } from "lucide-react";

import { api, type MediaJobStatus, type VideoDocView } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { useDesktop } from "@/hooks/use-desktop";
import { useWhisperReady } from "@/hooks/use-whisper-ready";

const BTN = "inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-[13px] font-medium transition active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100";
const BTN_PRIMARY = `${BTN} bg-[#10a37f] text-white hover:bg-[#0e906f]`;
const BTN_GHOST = `${BTN} bg-black/[0.05] text-[#1d1d1f] hover:bg-black/[0.08] dark:bg-white/[0.06] dark:text-[#e6e7e9] dark:hover:bg-white/[0.1]`;

const RATIOS = [
  { id: "9:16", label: "竖版 9:16" },
  { id: "1:1", label: "方形 1:1" },
  { id: "16:9", label: "横版 16:9" },
  { id: "original", label: "保持原片" },
] as const;

type Seg = { src: string; in: number; out: number; caption: string };

function fileUrl(p: string): string {
  // 走后端同源 http 流(带 Range),别用 file://——http 页里 Chromium 拒载 file:// 会黑屏(P0-3)
  if (p.startsWith("http") || p.startsWith("/api/")) return p;
  return `/api/v1/video-edit/localfile?path=${encodeURIComponent(p)}`;
}

export function VideoWorkspacePage({ initialFromGen }: { initialFromGen?: string } = {}) {
  const { electron } = useDesktop();
  const [paths, setPaths] = useState<string[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [segs, setSegs] = useState<Seg[]>([]);
  const [brand, setBrand] = useState("");
  const [mode, setMode] = useState<"ambient" | "speech">("ambient");
  // 口播模型(whisper 1.4G)按需下载状态:下好前"口播"模式灰掉。桌面外(web)无 electron.models → 视作就绪不挡。
  // 共享 hook(D-Task-9 抽出，语音输入按钮复用同一套就绪门，别各造一份)。
  const { ready: speechReady, status: modelStatus } = useWhisperReady();
  const [ratio, setRatio] = useState<"9:16" | "1:1" | "16:9" | "original">("9:16");
  const [targetDur, setTargetDur] = useState(16);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recapText, setRecapText] = useState("");
  const [reply, setReply] = useState<string | null>(null);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);
  // G-A・渲染后体检门返回的软提醒(大白话·非空才有):复渲后仍有问题时的一句话caveat,不挡看片、不弹窗。
  const [renderCaveat, setRenderCaveat] = useState<string | null>(null);

  // ── 客户端顺序预览播放器 ──
  const videoRef = useRef<HTMLVideoElement>(null);
  const [playIdx, setPlayIdx] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const v = videoRef.current;
    if (!v || !segs.length) return;
    const seg = segs[Math.min(playIdx, segs.length - 1)];
    const want = fileUrl(seg.src);
    if (v.getAttribute("data-src") !== want) {
      v.setAttribute("data-src", want);
      v.src = want;
    }
    const seek = () => { try { v.currentTime = seg.in; if (playing) void v.play(); } catch { /* ignore */ } };
    if (v.readyState >= 1) seek(); else v.addEventListener("loadedmetadata", seek, { once: true });
  }, [playIdx, segs, playing]);

  const onTimeUpdate = useCallback(() => {
    const v = videoRef.current;
    if (!v || !segs.length) return;
    const seg = segs[Math.min(playIdx, segs.length - 1)];
    if (v.currentTime >= seg.out - 0.03) {
      if (playIdx < segs.length - 1) setPlayIdx((i) => i + 1);
      else { v.pause(); setPlaying(false); setPlayIdx(0); }
    }
  }, [playIdx, segs]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (playing) { v.pause(); setPlaying(false); }
    else { setPlaying(true); void v.play(); }
  }, [playing]);

  const pickVideos = useCallback(async () => {
    if (!electron?.files?.pick) { setError("请在桌面版里使用视频工作区"); return; }
    const r = await electron.files.pick({
      title: "选要剪的视频", multi: true,
      filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "avi", "mkv", "webm"] }],
    });
    if (r.canceled || !r.paths?.length) return;
    setPaths(r.paths); setError(null); setProject(null); setSegs([]); setFinalUrl(null);
  }, [electron]);

  // 当前正在跑的轮询请求：组件卸载时 abort，防卸载后 setState。
  const pollAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { pollAbortRef.current?.abort(); }, []);

  const runJob = useCallback(async (submit: () => Promise<{ job_id: string }>): Promise<MediaJobStatus> => {
    const { job_id } = await submit();
    const controller = new AbortController();
    pollAbortRef.current = controller;
    return api.pollMediaJob(job_id, (j) => setStage(j.stage || ""), undefined, controller.signal);
  }, []);

  // ── E1-C2・生图台"做成视频"handoff:openWorkbench("video",{fromGen}) 带过来的单图素材,单独一条
  // 最小图生视频入口——和上面"选本机视频→自动剪辑"是两条完全不同的管线(单图动起来 vs 剪真实素材),
  // 状态/轮询各自独立、互不干扰。fromGen 只是个 id(真图从不走 IPC),这里按 id 换成真实 URL 再喂给
  // /studio/i2v——和生成工作室"做成视频"按钮调的是同一个后端接口，只是入口挪到了这。
  const [handoff, setHandoff] = useState<{ url: string; ratio: string; isVideo: boolean } | null>(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const [handoffMotion, setHandoffMotion] = useState("");
  const [handoffDuration, setHandoffDuration] = useState(5);
  const [handoffAudio, setHandoffAudio] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffStage, setHandoffStage] = useState("");
  const [handoffVideoUrl, setHandoffVideoUrl] = useState<string | null>(null);
  const handoffAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { handoffAbortRef.current?.abort(); }, []);

  useEffect(() => {
    if (!initialFromGen) return;
    let cancelled = false;
    setHandoff(null); setHandoffError(null); setHandoffVideoUrl(null);
    api.studioGetGeneration(initialFromGen)
      .then((r) => { if (!cancelled) setHandoff({ url: r.url, ratio: r.ratio, isVideo: r.is_video }); })
      .catch((e) => { if (!cancelled) setHandoffError(getErrorMessage(e)); });
    return () => { cancelled = true; };
  }, [initialFromGen]);

  const runHandoffI2v = useCallback(async () => {
    if (!handoff || handoff.isVideo || handoffBusy) return;
    setHandoffBusy(true); setHandoffError(null); setHandoffVideoUrl(null);
    setHandoffStage("正在让这张图动起来…(要等几分钟)");
    const controller = new AbortController();
    handoffAbortRef.current = controller;
    try {
      const { job_id } = await api.studioI2v({
        first_frame: handoff.url,
        source_generation_id: initialFromGen,
        prompt: handoffMotion.trim() || undefined,
        ratio: handoff.ratio,
        duration: handoffDuration,
        generate_audio: handoffAudio,
      });
      const done = await api.pollMediaJob(job_id, (j) => setHandoffStage(j.stage || ""), undefined, controller.signal);
      const url = (done.result?.urls as string[] | undefined)?.[0];
      if (!url) throw new Error("没拿到视频链接，换个说法再试一次。");
      setHandoffVideoUrl(url);
    } catch (e) {
      if (controller.signal.aborted) return; // 组件已卸载：别再 setState
      setHandoffError(getErrorMessage(e));
    } finally {
      if (!controller.signal.aborted) { setHandoffBusy(false); setHandoffStage(""); }
    }
  }, [handoff, handoffBusy, handoffMotion, handoffDuration, handoffAudio, initialFromGen]);

  // 出方案 + 配文案 → 建预览段(客户端)
  const buildSegs = useCallback((doc: VideoDocView, captions: string[]): Seg[] => {
    return doc.clips.map((c, i) => ({
      src: (c.media ? doc.media[c.media]?.src : "") || "",
      in: c.src_in ?? 0,
      out: c.src_out ?? 0,
      caption: captions[i] || "",
    }));
  }, []);

  const generate = useCallback(async () => {
    if (!paths.length) return;
    setBusy(true); setError(null); setFinalUrl(null); setReply(null);
    setStage(mode === "speech" ? "在听你视频里讲了啥、挑出讲得好的段落…" : "在看每段视频哪一刻最出彩、把废镜头挑出去…");
    try {
      if (mode === "speech") {
        // 口播线:auto_plan(speech) → 出片走 renderVideoProject(保原声+烧字幕)
        const job = await runJob(() => api.videoEditAutoPlan({ video_paths: paths, mode: "speech", ratio, target_duration: targetDur }));
        const res = (job.result || {}) as { project?: string };
        if (!res.project) throw new Error("没拿到剪辑项目");
        setProject(res.project); setBrand("");
        const { doc } = await api.getVideoProject(res.project);
        setSegs(doc.clips.map((c) => ({ src: (c.media ? doc.media[c.media]?.src : "") || "", in: c.src_in ?? 0, out: c.src_out ?? 0, caption: "" })));
      } else {
        const job = await runJob(() => api.videoEditAutoPlanV2({ video_paths: paths, mode: "ambient", ratio, target_duration: targetDur }));
        const res = (job.result || {}) as { project?: string; captions?: string[]; brand?: string };
        if (!res.project) throw new Error("没拿到剪辑项目");
        setProject(res.project); setBrand(res.brand || "");
        const { doc } = await api.getVideoProject(res.project);
        setSegs(buildSegs(doc, res.captions || []));
      }
      setPlayIdx(0);
    } catch (e) {
      if (pollAbortRef.current?.signal.aborted) return; // 组件已卸载：别再 setState
      setError(getErrorMessage(e));
    } finally {
      if (!pollAbortRef.current?.signal.aborted) { setBusy(false); setStage(""); }
    }
  }, [paths, mode, ratio, targetDur, runJob, buildSegs]);

  // 对话改任何东西(快·同步)→ 用返回的 shots 重建预览(换段/删段/改序都可能变结构)
  const doFeedback = useCallback(async () => {
    const feedback = recapText.trim();
    if (!feedback || !project) return;
    setBusy(true); setError(null);
    try {
      const r = await api.editVideoFeedback(project, feedback);
      setBrand(r.brand || brand);
      setReply(r.reply || null);
      setSegs(r.shots.map((s) => ({ src: s.src, in: s.start, out: s.end, caption: s.caption })));
      setPlayIdx(0);
      setRecapText("");
    } catch (e) {
      setError(getErrorMessage(e));
    } finally { setBusy(false); }
  }, [recapText, project, brand]);

  // 出片(慢·服务端逐帧渲染)
  const doExport = useCallback(async () => {
    if (!project) return;
    setBusy(true); setError(null); setFinalUrl(null); setRenderCaveat(null);
    setStage(mode === "speech" ? "在出片(保原声+烧字幕),好了叫你…" : "在渲染成片(带包装),好了叫你…");
    try {
      const job = await runJob(() => (mode === "speech" ? api.renderVideoProject(project, "成片") : api.renderVideoV2(project, "成片")));
      const res = (job.result || {}) as { urls?: string[]; caveat?: string };
      const url = res.urls?.[0];
      if (!url) throw new Error("没拿到成片链接");
      setFinalUrl(url);
      setRenderCaveat(res.caveat && res.caveat.trim() ? res.caveat.trim() : null);
    } catch (e) {
      if (pollAbortRef.current?.signal.aborted) return; // 组件已卸载：别再 setState
      setError(getErrorMessage(e));
    } finally {
      if (!pollAbortRef.current?.signal.aborted) { setBusy(false); setStage(""); }
    }
  }, [project, mode, runJob]);

  const curCap = segs.length ? segs[Math.min(playIdx, segs.length - 1)].caption : "";

  return (
    <div className="flex h-screen flex-col bg-[#fbfbfd] text-[#1d1d1f] dark:bg-[#161618] dark:text-[#e6e7e9]">
      {/* 头 */}
      <div className="flex items-center gap-2 border-b border-black/[0.06] px-5 py-3 dark:border-white/[0.08]">
        <Clapperboard size={18} className="text-[#10a37f]" />
        <span className="text-[14px] font-semibold">视频创作工作区</span>
        <span className="text-[12px] text-[#86868b]">氛围模式 · 挑高光→配文案→可对话改→出片</span>
      </div>

      {error && (
        <div className="mx-5 mt-3 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* 左:预览 + 镜头条 */}
        <div className="flex flex-1 flex-col items-center gap-3 overflow-y-auto p-5">
          <div className="relative flex items-center justify-center overflow-hidden rounded-xl bg-black" style={{ width: 320, height: ratio === "16:9" ? 180 : ratio === "1:1" ? 320 : 568 }}>
            {segs.length ? (
              <>
                {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                <video ref={videoRef} onTimeUpdate={onTimeUpdate} muted={mode !== "speech"} playsInline className="h-full w-full object-cover" />
                {/* DOM 文案浮层(即时,近似成片样式) */}
                {curCap && (
                  <div className="pointer-events-none absolute inset-x-0 bottom-[18%] px-6 text-center">
                    <span className="inline-block rounded bg-black/25 px-2 text-[26px] font-bold text-white" style={{ textShadow: "0 2px 12px rgba(0,0,0,.7)", fontFamily: "'SmileySans-Oblique','PingFang SC',sans-serif" }}>{curCap}</span>
                  </div>
                )}
                <button onClick={togglePlay} className="absolute bottom-2 left-2 rounded-full bg-black/40 p-1.5 text-white hover:bg-black/60">
                  {playing ? <Pause size={16} /> : <Play size={16} />}
                </button>
              </>
            ) : (
              <div className="flex flex-col items-center gap-2 text-[#8e8e93]">
                <Film size={34} />
                <span className="text-[12px]">选素材后点“生成方案”</span>
              </div>
            )}
          </div>

          {/* 镜头条 */}
          {segs.length > 0 && (
            <div className="flex w-full max-w-[520px] flex-wrap justify-center gap-1.5">
              {segs.map((s, i) => (
                <button key={i} onClick={() => { setPlayIdx(i); setPlaying(false); }}
                  className={`rounded-md px-2 py-1 text-[11px] transition ${i === playIdx ? "bg-[#10a37f] text-white" : "bg-black/[0.05] text-[#3a3a3c] hover:bg-black/[0.1] dark:bg-white/[0.06] dark:text-[#c7c7cc]"}`}>
                  镜{i + 1} · {s.caption || "…"}
                </button>
              ))}
            </div>
          )}
          {stage && <div className="flex items-center gap-2 text-[12px] text-[#10a37f]"><Loader2 size={14} className="animate-spin" /> {stage}</div>}
        </div>

        {/* 右:控制台 + 对话框 */}
        <div className="flex w-[340px] flex-col gap-4 overflow-y-auto border-l border-black/[0.06] p-5 dark:border-white/[0.08]">
          {/* E1-C2・从生图台带过来的图(openWorkbench handoff):独立小卡片,和下面"选本机视频剪辑"是两条不同的路,互不影响 */}
          {initialFromGen && (
            <div className="flex flex-col gap-2 rounded-xl border border-[#007AFF]/25 bg-[#007AFF]/[0.05] p-3">
              <div className="text-[12px] font-semibold text-[#007AFF]">从生图台带来的图</div>
              {!handoff && !handoffError && <div className="flex items-center gap-2 text-[12px] text-[#8e8e93]"><Loader2 size={13} className="animate-spin" /> 正在取图…</div>}
              {handoffError && <div className="text-[12px] text-red-600 dark:text-red-400">{handoffError}</div>}
              {handoff && (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={handoff.url} alt="待处理素材" className="w-full rounded-lg border border-black/[0.06] object-cover dark:border-white/[0.08]" style={{ maxHeight: 160 }} />
                  {handoff.isVideo ? (
                    <div className="text-[11px] text-[#8e8e93]">这个素材本身已经是视频，不用再生成一遍。</div>
                  ) : (
                    <>
                      <textarea
                        value={handoffMotion}
                        onChange={(e) => setHandoffMotion(e.target.value)}
                        placeholder="运镜描述（可选），比如：镜头缓慢推进、灯光渐暗"
                        rows={2}
                        disabled={handoffBusy}
                        className="w-full resize-none rounded-lg border border-black/[0.08] bg-white px-2.5 py-1.5 text-[12px] outline-none transition placeholder:text-[#b0b0b5] focus:border-[#007AFF]/50 dark:border-white/[0.08] dark:bg-[#1c1c1e] dark:placeholder:text-[#56585f]"
                      />
                      <div className="flex flex-wrap items-center gap-1.5">
                        {[5, 8, 10].map((d) => (
                          <button key={d} type="button" disabled={handoffBusy} onClick={() => setHandoffDuration(d)}
                            className={`rounded-md px-2 py-1 text-[11px] transition ${handoffDuration === d ? "bg-[#007AFF] text-white" : "bg-black/[0.05] text-[#3a3a3c] hover:bg-black/[0.1] dark:bg-white/[0.06] dark:text-[#c7c7cc]"}`}>
                            {d} 秒
                          </button>
                        ))}
                        <button type="button" disabled={handoffBusy} onClick={() => setHandoffAudio((v) => !v)}
                          className={`rounded-md px-2 py-1 text-[11px] transition ${handoffAudio ? "bg-[#007AFF] text-white" : "bg-black/[0.05] text-[#3a3a3c] hover:bg-black/[0.1] dark:bg-white/[0.06] dark:text-[#c7c7cc]"}`}>
                          {handoffAudio ? "带配音" : "无配音"}
                        </button>
                      </div>
                      <button className={`${BTN_PRIMARY} w-full`} disabled={handoffBusy} onClick={runHandoffI2v}>
                        {handoffBusy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />} 用这张图生成视频
                      </button>
                      {handoffBusy && handoffStage && <div className="text-[11px] text-[#007AFF]">{handoffStage}</div>}
                      {handoffVideoUrl && (
                        // eslint-disable-next-line jsx-a11y/media-has-caption
                        <video src={handoffVideoUrl} controls className="w-full rounded-lg bg-black" />
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* 选素材 */}
          <div>
            <div className="mb-1.5 text-[12px] font-semibold text-[#6e6e73] dark:text-[#9a9ca3]">① 素材</div>
            <button className={`${BTN_GHOST} w-full`} onClick={pickVideos}><Plus size={15} /> 选本机视频{paths.length ? `(${paths.length})` : ""}</button>
          </div>

          {/* 模式 */}
          <div className="flex flex-col gap-2">
            <div className="text-[12px] font-semibold text-[#6e6e73] dark:text-[#9a9ca3]">② 模式</div>
            <div className="flex gap-1.5">
              {([["ambient", "氛围片", "挑高光+特效+配乐"], ["speech", "口播", "转录+字幕+保原声"]] as const).map(([id, label, hint]) => {
                const locked = id === "speech" && !speechReady;   // 口播模型没下好前锁住
                return (
                  <button key={id} disabled={locked}
                    onClick={() => { if (locked) return; setMode(id); setProject(null); setSegs([]); setFinalUrl(null); }}
                    title={locked ? "口播功能正在准备中（首次使用需下载语音模型）" : hint}
                    className={`flex-1 rounded-md px-2 py-1.5 text-[12px] transition ${locked ? "cursor-not-allowed bg-black/[0.03] text-[#c7c7cc] dark:bg-white/[0.03] dark:text-[#5a5c63]" : mode === id ? "bg-[#10a37f] text-white" : "bg-black/[0.05] text-[#3a3a3c] hover:bg-black/[0.1] dark:bg-white/[0.06] dark:text-[#c7c7cc]"}`}>
                    {label}{id === "speech" && !speechReady && (modelStatus.phase === "error" ? " ⚠" : " ⏳")}
                  </button>
                );
              })}
            </div>
            {/* 口播模型下载态提示(仅未就绪时显示) */}
            {!speechReady && (
              <div className="text-[11px] text-[#8e8e93]">
                {modelStatus.phase === "downloading"
                  ? `口播功能准备中：正在下载语音模型 ${modelStatus.percent || 0}%（约 1.4G，仅首次，下好自动可用）`
                  : modelStatus.phase === "error"
                    ? <>口播模型下载失败。<button onClick={() => window.electron?.models?.retry()} className="text-[#007AFF] hover:underline">重试</button></>
                    : "口播功能准备中…"}
              </div>
            )}
          </div>

          {/* 参数 */}
          <div className="flex flex-col gap-2">
            <div className="text-[12px] font-semibold text-[#6e6e73] dark:text-[#9a9ca3]">③ 参数</div>
            <div className="flex flex-wrap gap-1.5">
              {RATIOS.map((r) => (
                <button key={r.id} onClick={() => setRatio(r.id)}
                  className={`rounded-md px-2.5 py-1 text-[12px] transition ${ratio === r.id ? "bg-[#10a37f] text-white" : "bg-black/[0.05] text-[#3a3a3c] hover:bg-black/[0.1] dark:bg-white/[0.06] dark:text-[#c7c7cc]"}`}>
                  {r.label}
                </button>
              ))}
            </div>
            <label className="flex items-center gap-2 text-[12px] text-[#6e6e73]">
              目标时长 <input type="range" min={8} max={24} value={targetDur} onChange={(e) => setTargetDur(+e.target.value)} className="flex-1" /> {targetDur}s
            </label>
          </div>

          <button className={`${BTN_PRIMARY} w-full`} disabled={!paths.length || busy} onClick={generate}>
            {busy && stage ? <Loader2 size={15} className="animate-spin" /> : <Sparkles size={15} />} 生成方案
          </button>

          {/* 对话改任何东西(氛围片可改;口播成品靠原声+字幕,暂不走对话编辑) */}
          {project && mode === "ambient" && (
            <div className="flex flex-col gap-2 rounded-xl bg-black/[0.03] p-3 dark:bg-white/[0.04]">
              <div className="text-[12px] font-semibold text-[#6e6e73] dark:text-[#9a9ca3]">💬 说大白话改(文案/镜头/节奏/配乐…)</div>
              <div className="text-[11px] text-[#8e8e93]">如“文案甜一点”“第2段换掉”“配乐慢些”“整体短点”“调色别这么暖”。改完预览即时刷新。</div>
              {reply && <div className="rounded-lg bg-[#10a37f]/10 px-2.5 py-1.5 text-[12px] text-[#0e906f]">{reply}</div>}
              <div className="flex gap-1.5">
                <input value={recapText} onChange={(e) => setRecapText(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) void doFeedback(); }}
                  placeholder="想怎么改…" disabled={busy}
                  className="flex-1 rounded-lg border border-black/10 bg-white px-2.5 py-1.5 text-[13px] outline-none focus:border-[#10a37f] dark:border-white/10 dark:bg-[#1c1c1e]" />
                <button className={BTN_PRIMARY} disabled={!recapText.trim() || busy} onClick={doFeedback}><Send size={14} /></button>
              </div>
            </div>
          )}

          {/* 出片 */}
          {project && (
            <button className={`${BTN_PRIMARY} w-full`} disabled={busy || !segs.length} onClick={doExport}>
              {busy && stage.includes("渲染") ? <Loader2 size={15} className="animate-spin" /> : <Download size={15} />} 出片(带包装)
            </button>
          )}

          {finalUrl && (
            <div className="flex flex-col gap-2">
              <div className="text-[12px] font-semibold text-[#10a37f]">成片好了 ✓</div>
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video src={finalUrl} controls className="w-full rounded-lg bg-black" />
              {/* G-A・渲染后体检门caveat:软提醒不挡看片(风格同生图台text_quality_warning)。
                  后端(qc_caveat_message)已经把"要不要我再调一版?"接在句尾,这里原样展示不重复加。 */}
              {renderCaveat && (
                <div className="flex items-start gap-1 text-[11px] text-[#b58a00] dark:text-[#e0b23a]">
                  <AlertTriangle className="mt-[1px] h-3 w-3 shrink-0" />
                  <span>{renderCaveat}</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
