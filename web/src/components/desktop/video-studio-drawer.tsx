"use client";

/**
 * AI 剪辑台抽屉（消费级·卡片优先，渐进暴露）
 *
 * 架构落地：面板只对【时间轴文档】发原子操作（/video-edit/ops），与 AI 共用同一份真相源；渲染器出片。
 * V1 给小白默认的是「片段挑选条 + 分段卡片 + 一键出片预览」，不是完整多轨时间轴（NNG 渐进暴露：完整时间轴留后面）。
 *
 * 流程：选本机视频 → 理解素材(转写+切镜头) → 候选片段卡片点选进片 → 自动配字幕/加字幕 → 出片 → 预览。
 */
import { useCallback, useState } from "react";
import { X, Film, Loader2, Plus, Trash2, ArrowUp, ArrowDown, Type, Captions, Clapperboard, Download } from "lucide-react";

import { api, type VideoCandidate, type VideoDocView, type MediaJobStatus } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { useDesktop } from "@/hooks/use-desktop";

interface Props {
  open: boolean;
  onClose: () => void;
  conversationId?: string | null;
}

const BTN = "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[13px] font-medium transition active:scale-[0.97] disabled:opacity-40 disabled:active:scale-100";
const BTN_PRIMARY = `${BTN} bg-[#10a37f] text-white hover:bg-[#0e906f]`;
const BTN_GHOST = `${BTN} bg-black/[0.04] text-[#1d1d1f] hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-[#e6e7e9] dark:hover:bg-white/[0.1]`;

function fmt(s: number): string {
  return `${s.toFixed(1)}s`;
}

export function VideoStudioDrawer({ open, onClose, conversationId }: Props) {
  const { electron } = useDesktop();
  const [paths, setPaths] = useState<string[]>([]);
  const [project, setProject] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<VideoCandidate[] | null>(null);
  const [doc, setDoc] = useState<VideoDocView | null>(null);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<string>("");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [captionText, setCaptionText] = useState("");

  const reset = useCallback(() => {
    setPaths([]); setProject(null); setCandidates(null); setDoc(null);
    setVideoUrl(null); setError(null); setStage(""); setCaptionText("");
  }, []);

  const pickVideos = useCallback(async () => {
    if (!electron?.files?.pick) { setError("请在桌面版里使用剪辑台"); return; }
    const r = await electron.files.pick({
      title: "选要剪的视频", multi: true,
      filters: [{ name: "视频", extensions: ["mp4", "mov", "m4v", "avi", "mkv", "webm"] }],
    });
    if (r.canceled || !r.paths?.length) return;
    setPaths(r.paths); setError(null);
  }, [electron]);

  // 慢任务统一：提交 job → 轮询 → 给大白话进度
  const runJob = useCallback(async (submit: () => Promise<{ job_id: string }>): Promise<MediaJobStatus> => {
    const { job_id } = await submit();
    return api.pollMediaJob(job_id, (j) => setStage(j.stage || ""));
  }, []);

  const refreshDoc = useCallback(async (proj: string) => {
    const r = await api.getVideoProject(proj);
    setDoc(r.doc);
  }, []);

  const runInventory = useCallback(async () => {
    if (!paths.length) return;
    setBusy(true); setError(null); setStage("正在识别视频里的语音和镜头…");
    try {
      const job = await runJob(() => api.videoEditInventory({ video_paths: paths, conversation_id: conversationId }));
      const res = (job.result || {}) as { project?: string; candidates?: VideoCandidate[] };
      if (!res.project) throw new Error("没拿到剪辑项目");
      setProject(res.project);
      setCandidates(res.candidates || []);
      await refreshDoc(res.project);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false); setStage("");
    }
  }, [paths, conversationId, runJob, refreshDoc]);

  const applyOps = useCallback(async (ops: Record<string, unknown>[]) => {
    if (!project) return;
    setBusy(true); setError(null);
    try {
      const r = await api.applyVideoOps(project, ops);
      if (!r.ok) { setError((r.errors || []).join("；") || "改动没生效"); }
      setDoc(r.doc);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }, [project]);

  const addSegment = useCallback((media: string, start: number, end: number) => {
    void applyOps([{ op: "add_clip", track: "v", media, src_in: start, src_out: end }]);
  }, [applyOps]);

  const removeClip = useCallback((id: string) => {
    void applyOps([{ op: "remove_clip", id }]);
  }, [applyOps]);

  const moveClip = useCallback((id: string, dir: -1 | 1) => {
    if (!doc) return;
    const ids = doc.clips.map((c) => c.id);
    const i = ids.indexOf(id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void applyOps(ids.map((cid, idx) => ({ op: "reorder_clip", id: cid, order: idx })));
  }, [doc, applyOps]);

  const addCaption = useCallback(() => {
    const text = captionText.trim();
    if (!text || !doc) return;
    const end = Math.min(3, Math.max(1.5, doc.duration || 3));
    void applyOps([{ op: "add_caption", track: "sub", text, start: 0, end, style: "promo" }]);
    setCaptionText("");
  }, [captionText, doc, applyOps]);

  const doAutoCaption = useCallback(async () => {
    if (!project) return;
    setBusy(true); setError(null);
    try {
      const r = await api.autoCaptionVideo(project);
      if (!r.ok) setError((r.errors || []).join("；") || "自动字幕添加失败");
      setDoc(r.doc);
      if (r.added === 0) setError("这些片段里没识别到口播，可以手动添加字幕。");
    } catch (e) {
      setError(getErrorMessage(e));
    } finally { setBusy(false); }
  }, [project]);

  const doRender = useCallback(async () => {
    if (!project) return;
    setBusy(true); setError(null); setVideoUrl(null); setStage("正在合成视频，完成后会提醒你…");
    try {
      const job = await runJob(() => api.renderVideoProject(project, "成片", conversationId));
      const res = (job.result || {}) as { urls?: string[] };
      const url = res.urls?.[0];
      if (!url) throw new Error("没拿到成片链接");
      setVideoUrl(url);
    } catch (e) {
      setError(getErrorMessage(e));
    } finally { setBusy(false); setStage(""); }
  }, [project, conversationId, runJob]);

  if (!open) return null;

  const hasClips = !!doc && doc.clips.length > 0;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-full w-full max-w-[560px] flex-col bg-[#fbfbfd] shadow-2xl dark:bg-[#1c1c1e]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头 */}
        <div className="flex items-center justify-between border-b border-black/[0.06] px-5 py-3 dark:border-white/[0.08]">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-[#1d1d1f] dark:text-[#e6e7e9]">
            <Clapperboard size={17} className="text-[#10a37f]" /> AI 剪辑台
          </div>
          <button onClick={onClose} className="rounded-md p-1 text-[#86868b] hover:bg-black/[0.05] dark:hover:bg-white/[0.08]">
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          {error && (
            <div className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-[12px] text-red-600 dark:bg-red-950/40 dark:text-red-400">
              {error}
            </div>
          )}

          {/* ① 选素材 */}
          {!project && (
            <div className="flex flex-col items-center gap-4 py-10 text-center">
              <Film size={40} className="text-[#c7c7cc]" />
              <div className="text-[13px] text-[#6e6e73] dark:text-[#9a9ca3]">
                把你手机拍的视频丢进来，管家帮你剪成竖屏成品短视频。
              </div>
              <button className={BTN_PRIMARY} onClick={pickVideos}><Plus size={15} /> 选本机视频</button>
              {paths.length > 0 && (
                <div className="w-full text-left">
                  <div className="mb-1 text-[12px] text-[#86868b]">已选 {paths.length} 个:</div>
                  <ul className="mb-3 space-y-0.5">
                    {paths.map((p) => (
                      <li key={p} className="truncate text-[12px] text-[#1d1d1f] dark:text-[#e6e7e9]">· {p.split("/").pop()}</li>
                    ))}
                  </ul>
                  <button className={BTN_PRIMARY} onClick={runInventory} disabled={busy}>
                    {busy ? <Loader2 size={15} className="animate-spin" /> : <Film size={15} />} 理解素材
                  </button>
                </div>
              )}
            </div>
          )}

          {busy && stage && (
            <div className="mb-3 flex items-center gap-2 rounded-lg bg-[#10a37f]/[0.08] px-3 py-2 text-[12px] text-[#0e906f]">
              <Loader2 size={14} className="animate-spin" /> {stage}
            </div>
          )}

          {/* ② 候选片段 → 点选进片 */}
          {project && candidates && (
            <div className="mb-5">
              <div className="mb-2 text-[12px] font-semibold text-[#6e6e73] dark:text-[#9a9ca3]">可选片段（点一下加进你的片子）</div>
              {candidates.map((c) => (
                <div key={c.media} className="mb-3">
                  <div className="mb-1 truncate text-[12px] text-[#86868b]">
                    {c.name} · {fmt(c.duration)} · {c.has_speech ? "有口播" : "空镜"}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {(c.has_speech && c.phrases.length ? c.phrases : c.scenes.map(([s, e]) => ({ start: s, end: e, text: "" }))).map((seg, i) => (
                      <button
                        key={i}
                        onClick={() => addSegment(c.media, seg.start, seg.end)}
                        disabled={busy}
                        className="max-w-[240px] truncate rounded-md border border-black/[0.08] bg-white px-2 py-1 text-left text-[11px] text-[#1d1d1f] transition hover:border-[#10a37f] hover:bg-[#10a37f]/[0.05] disabled:opacity-40 dark:border-white/[0.1] dark:bg-white/[0.04] dark:text-[#e6e7e9]"
                        title={"text" in seg && seg.text ? seg.text : `${fmt(seg.start)}-${fmt(seg.end)}`}
                      >
                        [{fmt(seg.start)}-{fmt(seg.end)}] {"text" in seg && seg.text ? seg.text : "镜头"}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* ③ 我的片子（分段卡片） */}
          {project && doc && (
            <div className="mb-5">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] font-semibold text-[#6e6e73] dark:text-[#9a9ca3]">我的片子（≈{fmt(doc.duration)}）</span>
              </div>
              {!hasClips && <div className="rounded-lg bg-black/[0.03] px-3 py-4 text-center text-[12px] text-[#86868b] dark:bg-white/[0.04]">还没挑片段——上面点几个加进来。</div>}
              <div className="space-y-1.5">
                {doc.clips.map((c, i) => (
                  <div key={c.id} className="flex items-center gap-2 rounded-lg border border-black/[0.06] bg-white px-3 py-2 dark:border-white/[0.08] dark:bg-white/[0.03]">
                    <span className="w-5 text-center text-[12px] font-semibold text-[#10a37f]">{i + 1}</span>
                    <span className="flex-1 text-[12px] text-[#1d1d1f] dark:text-[#e6e7e9]">{c.media} 源 [{fmt(c.src_in)}-{fmt(c.src_out)}]</span>
                    <button onClick={() => moveClip(c.id, -1)} disabled={busy || i === 0} className="rounded p-0.5 text-[#86868b] hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08]"><ArrowUp size={14} /></button>
                    <button onClick={() => moveClip(c.id, 1)} disabled={busy || i === doc.clips.length - 1} className="rounded p-0.5 text-[#86868b] hover:bg-black/[0.05] disabled:opacity-30 dark:hover:bg-white/[0.08]"><ArrowDown size={14} /></button>
                    <button onClick={() => removeClip(c.id)} disabled={busy} className="rounded p-0.5 text-[#86868b] hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40"><Trash2 size={14} /></button>
                  </div>
                ))}
              </div>

              {/* 字幕 */}
              {hasClips && (
                <div className="mt-3">
                  <div className="mb-1.5 flex gap-2">
                    <button className={BTN_GHOST} onClick={doAutoCaption} disabled={busy}><Captions size={14} /> 自动配字幕(口播)</button>
                  </div>
                  <div className="flex gap-1.5">
                    <input
                      value={captionText}
                      onChange={(e) => setCaptionText(e.target.value)}
                      placeholder="加一句促销字幕(如:新到乔氏台子)"
                      className="flex-1 rounded-lg border border-black/[0.08] bg-black/[0.02] px-2.5 py-1.5 text-[12px] text-[#1d1d1f] outline-none focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#e6e7e9]"
                    />
                    <button className={BTN_GHOST} onClick={addCaption} disabled={busy || !captionText.trim()}><Type size={14} /> 加</button>
                  </div>
                  {doc.captions.length > 0 && (
                    <div className="mt-2 space-y-1">
                      {doc.captions.map((cap) => (
                        <div key={cap.id} className="flex items-center gap-2 text-[11px] text-[#6e6e73] dark:text-[#9a9ca3]">
                          <span className="flex-1 truncate">「{cap.text}」 @{fmt(cap.start || 0)}-{fmt(cap.end || 0)}</span>
                          <button onClick={() => removeClip(cap.id)} disabled={busy} className="rounded p-0.5 hover:text-red-500"><Trash2 size={12} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ④ 出片预览 */}
          {videoUrl && (
            <div className="mb-4">
              <div className="mb-1.5 text-[12px] font-semibold text-[#6e6e73] dark:text-[#9a9ca3]">成片</div>
              <video src={videoUrl} controls className="w-full rounded-xl bg-black" style={{ maxHeight: 420 }} />
              <a href={videoUrl} download className="mt-2 inline-flex items-center gap-1 text-[12px] text-[#10a37f] hover:underline">
                <Download size={13} /> 下载成片
              </a>
            </div>
          )}
        </div>

        {/* 底部动作条 */}
        {project && (
          <div className="flex items-center justify-between gap-2 border-t border-black/[0.06] px-5 py-3 dark:border-white/[0.08]">
            <button className={BTN_GHOST} onClick={reset} disabled={busy}>重新开始</button>
            <button className={BTN_PRIMARY} onClick={doRender} disabled={busy || !hasClips}>
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Clapperboard size={15} />} 出片
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
