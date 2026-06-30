"use client";

/**
 * 生成工作室(阶段2 MVP·独立窗口 /dashboard/studio):
 * 左·控制台(大白话+✨优化提示词+参考图+比例+模型→生成) · 中·预览(出图+变体挑选) · 右·操控台(基于这张改/局部改/换比例/做视频)。
 * 直连 /studio/generate、/studio/edit(绕 LLM),异步出图轮询 media-jobs。白底偏绿 macOS。
 * 治"改不动图":基于当前这张就地改(原图当底图),不跳回输入框重掷。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { Image as ImageIcon, ImagePlus, X, Wand2, Copy, Download, ThumbsUp, Loader2, RefreshCw, Check, AlertTriangle, Layers, Film, Sparkles } from "lucide-react";
import { api, type MediaJobStatus } from "@/lib/api";

// react-konva 碰 canvas/window,不能 SSR → dynamic ssr:false(M4)
const StudioMaskCanvas = dynamic(() => import("@/components/desktop/studio-mask-canvas"), { ssr: false });

const RATIOS = [
  { id: "9:16", label: "竖版 9:16" },
  { id: "3:4", label: "3:4" },
  { id: "1:1", label: "方形 1:1" },
  { id: "16:9", label: "横版 16:9" },
];
// 生图模型(前端可选)。火山 Seedream 首选(国内直连·近第一梯队);gpt-image-2 当前默认(已可用)。
// ⚠️ 默认先用 gpt-image-2(火山需开通图像权限才能跑);开通后把下面 useState 默认值改成 seedream id 即可。
const MODELS = [
  { id: "doubao-seedream-4-5-251128", label: "火山 Seedream" },
  { id: "gpt-image-2", label: "gpt-image-2" },
];

type Shot = { url: string; generationId?: string; ratio: string; isVideo?: boolean };

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export default function StudioPage() {
  const [prompt, setPrompt] = useState("");
  const [optimized, setOptimized] = useState("");    // 优化后的提示词(可改;有则当真实 prompt 送模型)
  const [optimizing, setOptimizing] = useState(false);
  const [imageModel, setImageModel] = useState("gpt-image-2");  // 选的生图模型;默认先用能跑的 gpt(火山需开权限)
  const [ratio, setRatio] = useState("9:16");
  const [count, setCount] = useState(2);             // 出几版(变体)·默认2张给"一眼挑"
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [current, setCurrent] = useState<Shot | null>(null);
  const [history, setHistory] = useState<Shot[]>([]);
  const [batch, setBatch] = useState<Shot[]>([]);    // 刚出的这一批变体(2-4张),给用户一眼挑
  const [refs, setRefs] = useState<string[]>([]);    // 参考图(本机绝对路径),图生图:当风格/参考喂给模型
  const [editText, setEditText] = useState("");
  const [maskMode, setMaskMode] = useState(false);   // 局部重绘模式
  const [vDuration, setVDuration] = useState(5);     // 视频时长(秒)
  const [vAudio, setVAudio] = useState(false);       // 视频配音
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 用 ref 跟踪当前图,runJob 里读它把上一张推进历史——别在 setState 更新函数里塞 setState 副作用(StrictMode 会双跑)。
  const currentRef = useRef<Shot | null>(null);
  useEffect(() => { currentRef.current = current; }, [current]);

  const onTick = (j: MediaJobStatus) =>
    setStage(j.stage || (j.status === "queued" ? "排队中…" : "正在出图…"));

  const runJob = useCallback(async (start: () => Promise<{ job_id: string }>, keepRatio: string, mode: "generate" | "edit" = "edit") => {
    setBusy(true); setError(null); setStage("正在出图…");
    try {
      const { job_id } = await start();
      const done = await api.pollMediaJob(job_id, onTick);
      const urls = (done.result?.urls as string[] | undefined) || [];
      const ids = (done.result?.generation_ids as string[] | undefined) || [];
      const r = (done.result?.ratio as string | undefined) || keepRatio;
      if (!urls.length) throw new Error("这次没出来，换个说法再试一次。");
      const isVideo = !!done.result?.is_video;
      const shots: Shot[] = urls.map((u, i) => ({ url: u, generationId: ids[i], ratio: r, isVideo }));
      const prev = currentRef.current;
      if (mode === "generate") {
        // 新出的一批是"待挑的变体":上一张存进历史,整批进 batch,默认选第一张(用户点着挑)
        setHistory((h) => [...(prev ? [prev] : []), ...h].slice(0, 12));
        setBatch(shots);
      } else {
        // 改图/换比例等派生:上一张 + 多出来的变体进历史可回看,变体条不动
        setHistory((h) => [...(prev ? [prev] : []), ...shots.slice(1), ...h].slice(0, 12));
      }
      setCurrent(shots[0]);
      window.electron?.notifyStudioArtifact?.({ kind: "poster", generationId: shots[0].generationId, url: shots[0].url });
    } catch (e) {
      setError(e instanceof Error ? e.message : "生成失败，请稍后再试。");
    } finally {
      setBusy(false); setStage("");
    }
  }, []);

  const onGenerate = () => {
    if (!prompt.trim() || busy) return;
    void runJob(() => api.studioGenerate({
      prompt: prompt.trim(), ratio, count,
      reference_image_paths: refs.length ? refs : undefined,
      image_model: imageModel,
      image_prompt: optimized.trim() || undefined,   // 有优化后的就当真实 prompt;没有就发原话
    }), ratio, "generate");
  };
  // 提示词优化:把大白话改写成优化的提示词,填进可编辑框(这条就是真正发给模型的)
  const onOptimize = async () => {
    if (!prompt.trim() || optimizing || busy) return;
    setOptimizing(true); setError(null);
    try {
      const r = await api.studioExpand({ prompt: prompt.trim() });
      setOptimized(r.image_prompt || "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "优化没成功，直接生成也行。");
    } finally { setOptimizing(false); }
  };
  // 在这一批变体里挑一张:切成选中的那张;若当前是改出来的(不在变体里),先存进历史别弄丢
  const pickVariant = (s: Shot) => {
    if (busy) return;
    const cur = currentRef.current;
    if (cur && !batch.some((b) => b.url === cur.url)) setHistory((h) => [cur, ...h].slice(0, 12));
    setCurrent(s);
  };
  // 上传参考图:弹系统文件框选本机图(返回绝对路径),桌面后端按路径读;图生图当风格/参考用
  const pickRefs = async () => {
    if (busy) return;
    if (!window.electron?.files?.pick) { setError("上传参考图需要桌面版。"); return; }
    try {
      const r = await window.electron.files.pick({
        title: "选参考图（拿它当风格/参考，不会照抄内容）",
        multi: true,
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "bmp"] }],
      });
      if (r.canceled || !r.paths?.length) return;
      setRefs((prev) => Array.from(new Set([...prev, ...r.paths])).slice(0, 6));
    } catch { /* 取消/失败:忽略 */ }
  };
  const removeRef = (p: string) => setRefs((prev) => prev.filter((x) => x !== p));
  const onEdit = () => {
    if (!current || !editText.trim() || busy) return;
    if (!current.generationId) { setError("这张图没有来源记录，改不了；重新生成一张再改。"); return; }
    const instruction = editText.trim();
    setEditText("");
    void runJob(() => api.studioEdit({ prompt: instruction, source_generation_id: current.generationId as string, ratio: current.ratio }), current.ratio);
  };
  const onChangeRatio = (r: string) => {
    setRatio(r);
    if (current?.generationId && !busy) {
      void runJob(() => api.studioEdit({ prompt: "保持画面主体和风格不变，换成这个画幅比例重新构图", source_generation_id: current.generationId as string, ratio: r }), r);
    }
  };
  // 局部重绘:把涂出来的 mask 存临时文件 → /studio/edit 带 mask_path 只改涂的那块
  const onApplyMask = async (maskBase64: string, instruction: string) => {
    if (!current?.generationId) return;
    if (!window.electron?.files?.saveTemp) { setError("局部重绘需要桌面版（要把蒙版存成临时文件）。"); return; }
    try {
      const saved = await window.electron.files.saveTemp({ base64: maskBase64, ext: "png" });
      if (!saved.ok || !saved.path) throw new Error("蒙版没存成功，重试一下。");
      const gid = current.generationId, rr = current.ratio, maskPath = saved.path;
      setMaskMode(false);
      void runJob(() => api.studioEdit({ prompt: instruction, source_generation_id: gid, mask_path: maskPath, ratio: rr }), rr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "局部重绘失败，稍后再试。");
    }
  };
  // 做成视频:把当前这张图动起来(人确认=点这个按钮 + 一次确认)。复用"基于这张改"输入框当运镜描述。
  const onMakeVideo = () => {
    if (!current || current.isVideo || busy) return;
    if (typeof window !== "undefined" && !window.confirm("做成视频要等几分钟、也比较费，确定吗？")) return;
    const ff = current.url, gid = current.generationId, rr = current.ratio, motion = editText.trim() || undefined;
    void runJob(() => api.studioI2v({ first_frame: ff, source_generation_id: gid, prompt: motion, ratio: rr, duration: vDuration, generate_audio: vAudio }), rr);
  };
  // 多镜合成:把当前+历史里有来源记录的视频片段拼成一条(真 ffmpeg 在本机 Electron 跑)
  const videoShots = [current, ...history].filter((s): s is Shot => !!s && !!s.isVideo && !!s.generationId);
  const onCompose = async () => {
    if (videoShots.length < 2 || busy) return;
    if (!window.electron?.video?.run) { setError("拼视频需要桌面版（用本机的 ffmpeg）。"); return; }
    setBusy(true); setError(null); setStage("正在把几段视频拼成一条…");
    try {
      const plan = await api.studioCompose(videoShots.map((s) => s.generationId as string));
      await window.electron.video.run("concat", { inputs: plan.inputs, output: plan.output_path });
      const prev = currentRef.current;
      setHistory((h) => [...(prev ? [prev] : []), ...h].slice(0, 12));
      setCurrent({ url: plan.output_url, ratio: current?.ratio || "9:16", isVideo: true });
    } catch (e) {
      setError(e instanceof Error ? e.message : "拼接没成功，稍后再试。");
    } finally {
      setBusy(false); setStage("");
    }
  };
  const onCopy = async () => {
    if (!current) return;
    try {
      const blob = await (await fetch(current.url)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
      setCopied(true); setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("复制没成功（可能系统不支持），可以先用「保存到本机」。");
    }
  };
  const onSave = async () => {
    if (!current?.url || !window.electron?.files) return;
    try {
      const blob = await (await fetch(current.url)).blob();
      await window.electron.files.save({ defaultName: current.isVideo ? "工作室视频.mp4" : "工作室作品.png", base64: await blobToBase64(blob), title: current.isVideo ? "保存视频" : "保存图片" });
    } catch {
      setError("保存没成功，稍后再试。");
    }
  };
  const onRate = () => { if (current?.generationId) void api.rateGeneration(current.generationId, "good"); };

  const chip = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-[12px] font-medium transition active:scale-[0.97] ${
      active ? "bg-[#10a37f] text-white" : "bg-black/[0.04] text-[#3a3a3c] hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-[#c8cace] dark:hover:bg-white/[0.1]"
    }`;

  return (
    <div className="flex h-screen w-full flex-col bg-white text-[#1d1d1f] antialiased dark:bg-[#0e0f11] dark:text-[#e6e7e9]">
      {/* 顶部可拖拽条(macOS 红绿灯区) */}
      <div className="app-drag flex h-[44px] shrink-0 items-center gap-2 border-b border-black/[0.06] px-20 dark:border-white/[0.06]">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#10a37f]/15 text-[#10a37f]"><ImageIcon className="h-3.5 w-3.5" /></span>
        <span className="text-[13px] font-semibold tracking-tight">生成工作室</span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左·控制台 */}
        <aside className="flex w-[280px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-black/[0.06] p-4 dark:border-white/[0.06]">
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">想做张什么图？</div>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="大白话说想做啥就行，比如：周五台球之夜海报，霓虹灯氛围，醒目标题"
              rows={4}
              className="w-full resize-none rounded-lg border border-black/[0.08] bg-black/[0.02] px-3 py-2 text-[13px] outline-none transition placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:placeholder:text-[#56585f]"
            />
            <button
              type="button"
              onClick={onOptimize}
              disabled={busy || optimizing || !prompt.trim()}
              title="把你的大白话改写成更出好图的提示词，可以再改；改完就是真正发给模型的"
              className="mt-1.5 flex h-8 w-full items-center justify-center gap-1.5 rounded-lg border border-[#10a37f]/30 bg-[#10a37f]/[0.06] text-[12.5px] font-medium text-[#10a37f] transition hover:bg-[#10a37f]/[0.12] active:scale-[0.99] disabled:opacity-50"
            >
              {optimizing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5" />}
              {optimizing ? "优化中…" : "优化提示词"}
            </button>
            {optimized && (
              <div className="mt-1.5">
                <div className="mb-1 flex items-center justify-between text-[11px] text-[#6e6e73] dark:text-[#9a9ca3]">
                  <span>优化后（可改，这就是真正发给模型的）</span>
                  <button type="button" onClick={() => setOptimized("")} className="text-[#b0b0b5] transition hover:text-[#ff3b30]">清空</button>
                </div>
                <textarea
                  value={optimized}
                  onChange={(e) => setOptimized(e.target.value)}
                  rows={4}
                  className="w-full resize-none rounded-lg border border-[#10a37f]/30 bg-[#10a37f]/[0.04] px-3 py-2 text-[12.5px] leading-relaxed outline-none transition focus:border-[#10a37f]/60 dark:border-[#10a37f]/30 dark:bg-[#10a37f]/[0.08]"
                />
              </div>
            )}
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">参考图（可选，拿它当风格/参考）</div>
            <button
              type="button"
              onClick={pickRefs}
              disabled={busy}
              className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-dashed border-black/[0.12] bg-black/[0.015] text-[13px] font-medium text-[#3a3a3c] transition hover:border-[#10a37f]/40 hover:bg-[#10a37f]/[0.04] active:scale-[0.99] disabled:opacity-50 dark:border-white/[0.12] dark:bg-white/[0.02] dark:text-[#c8cace]"
            >
              <ImagePlus className="h-3.5 w-3.5" /> 上传参考图
            </button>
            {refs.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {refs.map((p) => (
                  <span key={p} className="flex items-center gap-1 rounded-md bg-black/[0.04] py-1 pl-2 pr-1 text-[11.5px] text-[#3a3a3c] dark:bg-white/[0.06] dark:text-[#c8cace]">
                    <span className="max-w-[150px] truncate">{p.split(/[\\/]/).pop()}</span>
                    <button type="button" onClick={() => removeRef(p)} title="移除" className="shrink-0 text-[#b0b0b5] transition hover:text-[#ff3b30]"><X className="h-3 w-3" /></button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">比例</div>
            <div className="flex flex-wrap gap-1.5">
              {RATIOS.map((r) => <button key={r.id} type="button" onClick={() => setRatio(r.id)} className={chip(ratio === r.id)}>{r.label}</button>)}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">模型</div>
            <div className="flex flex-wrap gap-1.5">
              {MODELS.map((m) => <button key={m.id} type="button" onClick={() => setImageModel(m.id)} className={chip(imageModel === m.id)}>{m.label}</button>)}
            </div>
          </div>
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">出几版（多挑一张）</div>
            <div className="flex flex-wrap gap-1.5">
              {[1, 2, 3, 4].map((n) => <button key={n} type="button" onClick={() => setCount(n)} className={chip(count === n)}>{n} 版</button>)}
            </div>
          </div>
          <button
            type="button"
            onClick={onGenerate}
            disabled={busy || !prompt.trim()}
            className="mt-1 flex h-10 items-center justify-center gap-2 rounded-lg bg-[#10a37f] text-[14px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.99] disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            {busy ? "出图中…" : "生成"}
          </button>
          {error && (
            <div className="flex items-start gap-1.5 rounded-md border border-[#ff3b30]/20 bg-[#ff3b30]/[0.04] px-2.5 py-2 text-[12px] text-[#c4352b] dark:text-[#ff8585]">
              <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" /><span>{error}</span>
            </div>
          )}
        </aside>

        {/* 中·预览 */}
        <main className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-[#fafafa] p-6 dark:bg-[#0b0c0e]">
          {maskMode && current && !busy ? (
            <StudioMaskCanvas imageUrl={current.url} busy={busy} onApply={onApplyMask} onCancel={() => setMaskMode(false)} />
          ) : busy ? (
            <div className="flex flex-col items-center gap-3 text-[#86868b] dark:text-[#6e7077]">
              <div className="h-[320px] w-[240px] animate-pulse rounded-xl bg-black/[0.05] dark:bg-white/[0.05]" />
              <div className="flex items-center gap-2 text-[13px]"><Loader2 className="h-4 w-4 animate-spin text-[#10a37f]" />{stage || "正在出图…"}</div>
              <div className="text-[11.5px]">出图大概要几十秒到几分钟，做好了直接显示在这。</div>
            </div>
          ) : current ? (
            current.isVideo ? (
              <video src={current.url} controls autoPlay loop className="max-h-full max-w-full rounded-xl shadow-sm" />
            ) : batch.length > 1 ? (
              <div className="flex h-full w-full flex-col items-center gap-3">
                <div className="shrink-0 text-[12px] text-[#86868b] dark:text-[#6e7077]">出了 {batch.length} 版，点下面的小图挑一张最满意的，再到右边改</div>
                <div className="flex min-h-0 flex-1 items-center justify-center">
                  <img src={current.url} alt="选中的版本" className="max-h-full max-w-full rounded-xl object-contain shadow-sm" />
                </div>
                <div className="flex shrink-0 flex-wrap items-center justify-center gap-2 pb-1">
                  {batch.map((s, i) => {
                    const active = s.url === current.url;
                    return (
                      <button key={i} type="button" onClick={() => pickVariant(s)} title={`第 ${i + 1} 版`}
                        className={`relative overflow-hidden rounded-lg border-2 transition ${active ? "border-[#10a37f]" : "border-transparent hover:border-[#10a37f]/40"}`}>
                        <img src={s.url} alt={`第 ${i + 1} 版`} className="h-16 w-16 object-cover" />
                        {active && <span className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-[#10a37f] text-white"><Check className="h-2.5 w-2.5" /></span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : (
              <img src={current.url} alt="生成结果" className="max-h-full max-w-full rounded-xl object-contain shadow-sm" />
            )
          ) : (
            <div className="flex flex-col items-center gap-2 text-[#b0b0b5] dark:text-[#56585f]">
              <ImageIcon className="h-10 w-10" />
              <div className="text-[13px]">左边说一句、点「生成」，图就出在这里</div>
            </div>
          )}
        </main>

        {/* 右·操控台 */}
        <aside className="flex w-[280px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-black/[0.06] p-4 dark:border-white/[0.06]">
          {current ? (
            <>
              {!current.isVideo && (<>
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">基于这张改（就地改，不用重头说）</div>
                <textarea
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  placeholder="比如：把背景换成夜晚、标题再大一点、加点烟雾感"
                  rows={3}
                  className="w-full resize-none rounded-lg border border-black/[0.08] bg-black/[0.02] px-3 py-2 text-[13px] outline-none transition placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:placeholder:text-[#56585f]"
                />
                <button
                  type="button"
                  onClick={onEdit}
                  disabled={busy || !editText.trim()}
                  className="mt-1.5 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[#10a37f] text-[13px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.99] disabled:opacity-50"
                >
                  <Wand2 className="h-3.5 w-3.5" /> 改这张（整张）
                </button>
                <button
                  type="button"
                  onClick={() => setMaskMode(true)}
                  disabled={busy || !current.generationId}
                  title="只改图上你圈出来的那一块"
                  className="mt-1.5 flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[#10a37f]/30 bg-[#10a37f]/[0.06] text-[13px] font-medium text-[#10a37f] transition hover:bg-[#10a37f]/[0.12] active:scale-[0.99] disabled:opacity-50"
                >
                  <Layers className="h-3.5 w-3.5" /> 圈一块局部改
                </button>
              </div>
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">换比例（按这张重出）</div>
                <div className="flex flex-wrap gap-1.5">
                  {RATIOS.map((r) => <button key={r.id} type="button" disabled={busy} onClick={() => onChangeRatio(r.id)} className={chip(current.ratio === r.id)}>{r.label}</button>)}
                </div>
              </div>
              {/* 做成视频(图生视频):时长 + 配音 + 一次确认 */}
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">做成视频</div>
                <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                  {[5, 8, 10].map((d) => <button key={d} type="button" onClick={() => setVDuration(d)} className={chip(vDuration === d)}>{d} 秒</button>)}
                  <button type="button" onClick={() => setVAudio((v) => !v)} className={chip(vAudio)}>{vAudio ? "带配音" : "无配音"}</button>
                </div>
                <button
                  type="button"
                  onClick={onMakeVideo}
                  disabled={busy || !current.generationId}
                  title="把这张图动起来，做成几秒短视频（要等几分钟）"
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[#007AFF]/30 bg-[#007AFF]/[0.06] text-[13px] font-medium text-[#007AFF] transition hover:bg-[#007AFF]/[0.12] active:scale-[0.99] disabled:opacity-50"
                >
                  <Film className="h-3.5 w-3.5" /> 让这张动起来（做成视频）
                </button>
              </div>
              </>)}
              <div className="flex flex-wrap gap-1.5">
                {!current.isVideo && (
                <button type="button" onClick={onCopy} className="flex items-center gap-1 rounded-md border border-black/[0.08] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#3a3a3c] transition hover:bg-black/[0.03] active:scale-[0.97] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#c8cace]">
                  {copied ? <><Check className="h-3.5 w-3.5 text-[#10a37f]" /> 已复制</> : <><Copy className="h-3.5 w-3.5" /> 复制图片</>}
                </button>
                )}
                <button type="button" onClick={onSave} className="flex items-center gap-1 rounded-md border border-black/[0.08] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#3a3a3c] transition hover:bg-black/[0.03] active:scale-[0.97] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#c8cace]">
                  <Download className="h-3.5 w-3.5" /> 保存到本机
                </button>
                <button type="button" onClick={onRate} className="flex items-center gap-1 rounded-md border border-black/[0.08] bg-white px-2.5 py-1.5 text-[12px] font-medium text-[#3a3a3c] transition hover:bg-[#10a37f]/10 hover:text-[#10a37f] active:scale-[0.97] dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#c8cace]">
                  <ThumbsUp className="h-3.5 w-3.5" /> 好评
                </button>
              </div>
              {videoShots.length >= 2 && (
                <button
                  type="button"
                  onClick={onCompose}
                  disabled={busy}
                  title="把做过的几段视频按顺序拼成一条(在本机用 ffmpeg,不上传)"
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[#007AFF]/30 bg-[#007AFF]/[0.06] text-[13px] font-medium text-[#007AFF] transition hover:bg-[#007AFF]/[0.12] active:scale-[0.99] disabled:opacity-50"
                >
                  <Film className="h-3.5 w-3.5" /> 把这 {videoShots.length} 段拼成一条
                </button>
              )}
              {history.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">改过的版本</div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {history.map((h, i) => (
                      <button key={i} type="button" onClick={() => !busy && setCurrent(h)} title="点回到这一版" className="overflow-hidden rounded-md border border-black/[0.08] transition hover:border-[#10a37f]/50 dark:border-white/[0.08]">
                        {h.isVideo
                          ? <video src={h.url} muted className="aspect-square w-full object-cover" />
                          : <img src={h.url} alt={`版本 ${i + 1}`} className="aspect-square w-full object-cover" />}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : (
            <div className="flex flex-1 items-center justify-center px-2 text-center text-[12px] text-[#b0b0b5] dark:text-[#56585f]">
              出图后，这里能就地改图、复制、换比例、存到电脑。
            </div>
          )}
          <div className="mt-auto flex items-center gap-1 pt-2 text-[11px] text-[#b0b0b5] dark:text-[#56585f]">
            <RefreshCw className="h-3 w-3" /> 改图也会等几十秒到几分钟，正常。
          </div>
        </aside>
      </div>
    </div>
  );
}
