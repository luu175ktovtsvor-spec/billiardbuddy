"use client";

/**
 * 生成工作室(阶段2 MVP·独立窗口 /dashboard/studio):
 * 左·控制台(大白话+参考图+比例+风格→生成) · 中·预览(出图+变体挑选) · 右·操控台(第二层,圈选+说话/换比例/做视频)。
 * 直连 /studio/generate、/studio/edit(绕 LLM),异步出图轮询 media-jobs。白底偏绿 macOS。
 * 治"改不动图":基于当前这张就地改(原图当底图),不跳回输入框重掷。
 * E2-1・小白化:模型名(gpt-image-2/Seedream)、变体数量、"优化提示词"按钮已收进背后自动处理——
 * 明面只留 2 个参数(比例+风格),提示词优化默默做,数量固定出 4 张给"一眼挑"(见下方注释与 onGenerate)。
 * E2-3・布局两态:首屏(current==null)只有左输入面板 + 中场景卡/空态,右边编辑操控台不渲染;打开/选中
 * 一张图(current!=null)后编辑操控台才冒出来。编辑入口也合并:原来并列的"改这张(整张)"+"圈一块局部改"
 * 两个按钮收成一个"圈选+说话"(StudioMaskCanvas),圈了=局部重绘、不圈=整图改,由 onSubmitEdit 分流。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { LucideIcon } from "lucide-react";
import { Image as ImageIcon, ImagePlus, X, Wand2, Copy, Download, ThumbsUp, Loader2, RefreshCw, Check, AlertTriangle, Layers, Film, CreditCard, PartyPopper, UserPlus, Sparkles, Trophy, Camera, Repeat } from "lucide-react";
import { api, type MediaJobStatus } from "@/lib/api";

// react-konva 碰 canvas/window,不能 SSR → dynamic ssr:false(M4)
const StudioMaskCanvas = dynamic(() => import("@/components/desktop/studio-mask-canvas"), { ssr: false });

// 大白话比例标签(id 不变,只把 label 换成"什么场合用"——沿用 chat-thread.tsx 的"抖音竖版"说法)。
// E2-1b・易拉宝(2:5)/横幅(5:2)已在后端 poster_service.SIZE_MAP 补上专属映射(查证过的 Seedream
// 合法尺寸,不再静默 fallback 成 3:4),且 generate_images 里强制这两挡走 Seedream(gpt-image-2
// 出不了这么极端的长宽比),前端可以放心加这两个新挡了。
const RATIOS = [
  { id: "9:16", label: "抖音竖版 9:16" },
  { id: "3:4", label: "海报竖版 3:4" },
  { id: "1:1", label: "朋友圈方图 1:1" },
  { id: "16:9", label: "店内横幅 16:9" },
  { id: "2:5", label: "易拉宝(2:5 竖长条)" },
  { id: "5:2", label: "横幅(宽版)" },
];
// E2-1・模型选择收进后端自动路由,前端不再手选:
// 生成走 poster_service._route_image_model——不传 image_model 时默认落 Seedream(国内直连快、不踩大陆
// 连 gpt-image-2 那条 60s 超时坑),只有复杂创意/西文为主/高保真人像改图才会自动路由到 GPT,GPT 失败还
// 有自动降级回 Seedream 的安全网(已读 poster_service.py:424-441 核实)。改图走 _route_edit_model(改文
// 字→Seedream,改内容→GPT)。前端三处 studioEdit 调用同样不再传 image_model,交给后端判断。
// 风格卡复用后端 services/agent/poster_styles.py 的 POSTER_STYLES(10 选 6,覆盖面广的几个),
// key 要跟后端对得上(resolve_style_prompt 优先按 key 精确匹配)。
const STYLES = [
  { key: "warm", label: "温馨有爱", desc: "情侣、朋友来打球，暖暖的有氛围" },
  { key: "neon", label: "年轻潮酷", desc: "年轻人、夜场，酷炫抓眼球" },
  { key: "minimal", label: "简约干净", desc: "清爽不花哨，显得有档次" },
  { key: "festive", label: "热闹喜庆", desc: "过节、搞活动，红红火火" },
  { key: "luxury", label: "高档大气", desc: "推会员、充值，显高端" },
  { key: "sporty", label: "活力运动", desc: "比赛、约球，有冲劲" },
];

// E2-2・场景卡"例子先行":首屏空态(还没出图时)展示台球运营场景当例子，点卡=把一段可改草稿
// 预填进左边的 prompt 输入框(setPrompt + 聚焦)，不发消息、不触发生成——和主聊天窗欢迎屏
// StarterCard 语义不同(那边点了直接 chat.send 走 ReAct)，这里是"填表单草稿等用户改"。
// 文案铁律:草稿只描述画面/场景，绝不编造具体店名/电话/价格/第三方品牌，留给用户自己填；
// 招聘助教是正常岗位描述+明写"别写暧昧擦边"，守安全红线，不当擦边引流文案处理。
type ScenarioCard = { Icon: LucideIcon; title: string; hint: string; prompt: string };
const SCENARIOS: ScenarioCard[] = [
  { Icon: CreditCard, title: "会员充值海报", hint: "推会员充值，吸引老顾客", prompt: "帮我做一张会员充值优惠海报，写清楚“充多少送多少”（具体金额我自己填），风格温馨大气，适合发朋友圈和贴在店里" },
  { Icon: PartyPopper, title: "周末活动海报", hint: "周末场次活动，拉人气", prompt: "做一张本店周末台球活动的海报，写清楚活动亮点（具体时间地点我自己补），氛围热闹喜庆，适合发朋友圈" },
  { Icon: UserPlus, title: "招聘助教", hint: "正常招聘，写清楚岗位要求", prompt: "帮我写一张招聘台球助教的海报，要求形象好、球技过关、有耐心教学（薪资和联系方式我自己填），风格干净大方，别写暧昧擦边的内容" },
  { Icon: Sparkles, title: "新台/新设备上线", hint: "宣传新增球台或设备", prompt: "做一张海报，宣传本店新增了球台/设备，风格现代大气，标题醒目（具体台数和品牌我自己填）" },
  { Icon: Trophy, title: "比赛报名海报", hint: "办比赛，吸引人报名", prompt: "做一张台球比赛报名海报，写清楚比赛形式和奖励亮点（具体日期和奖金我自己填），风格有冲劲、吸引年轻人参赛" },
  { Icon: Camera, title: "球房氛围图", hint: "日常氛围，发圈发视频封面都能用", prompt: "做一张台球房日常营业的氛围图，灯光有质感、有人在打球的画面感，适合当短视频封面或朋友圈配图" },
];

// E2-4・text_quality_warning/Message：U5 的"改图轮 OCR 重出后仍未对上→best-effort 返图+软警告"信号，
// 这批(job 级，不是精细到某一张)只要触发过就带出来，供中间预览区露一句很轻的大白话提示。
type Shot = { url: string; generationId?: string; ratio: string; isVideo?: boolean; modelSwitched?: boolean; textQualityWarning?: boolean; textQualityWarningMessage?: string };

async function blobToBase64(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  let bin = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export default function StudioPage() {
  const [prompt, setPrompt] = useState("");
  const [style, setStyle] = useState("");            // 选的风格卡 key(空=不指定,按用户说的原样出)
  const [ratio, setRatio] = useState("9:16");
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("");
  const [current, setCurrent] = useState<Shot | null>(null);
  const [history, setHistory] = useState<Shot[]>([]);
  const [batch, setBatch] = useState<Shot[]>([]);    // 刚出的这一批变体(2-4张),给用户一眼挑
  const [refs, setRefs] = useState<string[]>([]);    // 参考图(本机绝对路径),图生图:当风格/参考喂给模型
  const [maskMode, setMaskMode] = useState(false);   // 圈选+说话(编辑操作台第二层)是否打开
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [leftW, setLeftW] = useState(280);    // 左栏宽(拖分隔条调)
  const [rightW, setRightW] = useState(280);   // 右栏宽(拖分隔条调·仅第二层出现编辑操作台时用)

  // E2-2・场景卡预填的落点:点卡只 setPrompt + 聚焦，不发消息、不调任何生成接口。
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const pickScenario = (s: ScenarioCard) => {
    setPrompt(s.prompt);
    promptRef.current?.focus();
  };

  // 用 ref 跟踪当前图,runJob 里读它把上一张推进历史——别在 setState 更新函数里塞 setState 副作用(StrictMode 会双跑)。
  const currentRef = useRef<Shot | null>(null);
  useEffect(() => { currentRef.current = current; }, [current]);
  // 当前正在跑的轮询请求：组件卸载时 abort，防卸载后 setState。
  const pollAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => { pollAbortRef.current?.abort(); }, []);

  const onTick = (j: MediaJobStatus) =>
    setStage(j.stage || (j.status === "queued" ? "排队中…" : "正在出图…"));

  const runJob = useCallback(async (start: () => Promise<{ job_id: string }>, keepRatio: string, mode: "generate" | "edit" = "edit") => {
    setBusy(true); setError(null); setStage("正在出图…");
    const controller = new AbortController();
    pollAbortRef.current = controller;
    try {
      const { job_id } = await start();
      const done = await api.pollMediaJob(job_id, onTick, undefined, controller.signal);
      const urls = (done.result?.urls as string[] | undefined) || [];
      const ids = (done.result?.generation_ids as string[] | undefined) || [];
      // U2 降级安全网标记:这张是不是"GPT 失败后自动切到了 Seedream 重试"——反映给用户一句很轻的提示(item 6)。
      const switched = (done.result?.model_switched as boolean[] | undefined) || [];
      // E2-4・收 U5 遗留:这一批里是否有张图 OCR 重出后仍没对上、best-effort 放行了(job 级信号，不分张)。
      const textWarn = !!done.result?.text_quality_warning;
      const textWarnMsg = (done.result?.text_quality_warning_message as string | undefined) || undefined;
      const r = (done.result?.ratio as string | undefined) || keepRatio;
      if (!urls.length) throw new Error("这次没出来，换个说法再试一次。");
      const isVideo = !!done.result?.is_video;
      const shots: Shot[] = urls.map((u, i) => ({
        url: u, generationId: ids[i], ratio: r, isVideo, modelSwitched: !!switched[i],
        textQualityWarning: textWarn, textQualityWarningMessage: textWarnMsg,
      }));
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
      if (controller.signal.aborted) return; // 组件已卸载：别再 setState
      setError(e instanceof Error ? e.message : "生成失败，请稍后再试。");
    } finally {
      if (!controller.signal.aborted) { setBusy(false); setStage(""); }
    }
  }, []);

  // 提示词优化默默做(不露"优化"按钮/框):生成前先静默调一次 studioExpand,把改写结果当 image_prompt
  // 送模型;expand 失败就直接吞掉、用原话生成,不弹错也不卡住用户(用户从头到尾只看到"生成"这一个动作)。
  // count 固定传 4(出几版一眼挑)——后端 StudioGenerateIn.count 默认是 1,不显式传会退化成只出 1 张。
  const onGenerate = () => {
    if (!prompt.trim() || busy) return;
    const raw = prompt.trim();
    void runJob(async () => {
      let imagePrompt: string | undefined;
      try {
        const r = await api.studioExpand({ prompt: raw });
        imagePrompt = r.image_prompt || undefined;
      } catch {
        imagePrompt = undefined;   // 优化没成功就用原话,静默兜底
      }
      return api.studioGenerate({
        prompt: raw, ratio, count: 4,
        style: style || undefined,
        reference_image_paths: refs.length ? refs : undefined,
        image_prompt: imagePrompt,
      });
    }, ratio, "generate");
  };
  // E2-4・要同款(编辑第二层三件套第 3 件·新建):拿这张成品当参考图，重新生成一批相似的
  // ——保主体/风格，不是"改这一张"(那是圈选+说话/换比例的活)。复用 onGenerate 的静默扩写套路，
  // 用左边输入框里现在这句话当 prompt(留空则给个大白话兜底，别空 prompt 拦在红线预检前)。
  const onSameStyle = () => {
    if (!current || current.isVideo || busy || !current.generationId) return;
    const raw = prompt.trim() || "跟这张图保持一样的风格和主体，再出一批新的";
    const gid = current.generationId, rr = current.ratio;
    void runJob(async () => {
      let imagePrompt: string | undefined;
      try {
        const r = await api.studioExpand({ prompt: raw });
        imagePrompt = r.image_prompt || undefined;
      } catch {
        imagePrompt = undefined;
      }
      return api.studioGenerate({
        prompt: raw, ratio: rr, count: 4,
        style: style || undefined,
        reference_generation_ids: [gid],
        image_prompt: imagePrompt,
      });
    }, rr, "generate");
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
  // E2-3・圈选+说话:合并原来并列的"改这张(整张)"+"圈一块局部改"两个入口,统一进一个 StudioMaskCanvas——
  // 有没有圈(mask)由画布决定,圈了 = 局部重绘(带 mask_path 只改涂的那块)、不圈 = 整图改(不带 mask_path)。
  // 恢复 mask 可用(删掉 E2-1 留的 maskUnsupported=true 硬禁用):审查已核实改内容默认路由 gpt-image-2(支持
  // mask),且后端对不支持 mask 的模型会优雅降级成整图改(mask 读取失败/越界只是忽略、不是硬失败)。
  const onSubmitEdit = async (maskBase64: string | undefined, instruction: string) => {
    if (!current || !instruction.trim() || busy) return;
    if (!current.generationId) { setError("这张图没有来源记录，改不了；重新生成一张再改。"); return; }
    const gid = current.generationId, rr = current.ratio;
    if (!maskBase64) {
      // 没圈 = 整图改
      setMaskMode(false);
      void runJob(() => api.studioEdit({ prompt: instruction, source_generation_id: gid, ratio: rr }), rr);
      return;
    }
    // 圈了 = 局部重绘:先把涂出来的 mask 存临时文件 → /studio/edit 带 mask_path 只改涂的那块
    if (!window.electron?.files?.saveTemp) { setError("局部重绘需要桌面版（要把蒙版存成临时文件）。"); return; }
    try {
      const saved = await window.electron.files.saveTemp({ base64: maskBase64, ext: "png" });
      if (!saved.ok || !saved.path) throw new Error("蒙版没存成功，重试一下。");
      setMaskMode(false);
      void runJob(() => api.studioEdit({ prompt: instruction, source_generation_id: gid, mask_path: saved.path as string, ratio: rr }), rr);
    } catch (e) {
      setError(e instanceof Error ? e.message : "局部重绘失败，稍后再试。");
    }
  };
  const onChangeRatio = (r: string) => {
    setRatio(r);
    if (current?.generationId && !busy) {
      void runJob(() => api.studioEdit({ prompt: "保持画面主体和风格不变，换成这个画幅比例重新构图", source_generation_id: current.generationId as string, ratio: r }), r);
    }
  };
  // 做成视频(R4・owner 6-30 拍板):不再就地生视频,改成带图跳进工作台的视频面板——
  // 同一扇工作台窗口内"生图→视频"切面板 + 带 fromGen(轻标识,真图从不进 IPC),视频面板自己按 id 取图。
  // 非桌面(web,没有 window.electron)降级成提示,不崩。
  const onMakeVideo = () => {
    if (!current || current.isVideo || busy || !current.generationId) return;
    if (!window.electron?.openWorkbench) { setError("做成视频需要在桌面版里操作。"); return; }
    void window.electron.openWorkbench("video", { fromGen: current.generationId });
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
  // 拖分隔条调左/右栏宽:按下记起点,全局监听 mousemove 调宽、mouseup 收尾;clamp 200~480px。
  const startDrag = (side: "left" | "right") => (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "left" ? leftW : rightW;
    const setW = side === "left" ? setLeftW : setRightW;
    const onMove = (ev: MouseEvent) => {
      const delta = ev.clientX - startX;
      setW(Math.max(200, Math.min(480, side === "left" ? startW + delta : startW - delta)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  };

  const chip = (active: boolean) =>
    `rounded-md px-2.5 py-1 text-[12px] font-medium transition active:scale-[0.97] ${
      active ? "bg-[#10a37f] text-white" : "bg-black/[0.04] text-[#3a3a3c] hover:bg-black/[0.07] dark:bg-white/[0.06] dark:text-[#c8cace] dark:hover:bg-white/[0.1]"
    }`;
  return (
    <div className="flex h-screen w-full flex-col bg-white text-[#1d1d1f] antialiased dark:bg-[#0e0f11] dark:text-[#e6e7e9]">
      {/* 顶部可拖拽条(macOS 红绿灯区) */}
      <div className="app-drag app-titlebar-safe-right flex h-[44px] shrink-0 items-center gap-2 border-b border-black/[0.06] px-20 dark:border-white/[0.06]">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#10a37f]/15 text-[#10a37f]"><ImageIcon className="h-3.5 w-3.5" /></span>
        <span className="text-[13px] font-semibold tracking-tight">生成工作室</span>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左·控制台 */}
        <aside style={{ width: leftW }} className="flex shrink-0 flex-col gap-4 overflow-y-auto border-r border-black/[0.06] p-4 dark:border-white/[0.06]">
          <div>
            <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">想做张什么图？</div>
            <textarea
              ref={promptRef}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="大白话说想做啥就行，比如：周五台球之夜海报，霓虹灯氛围，醒目标题"
              rows={4}
              className="w-full resize-none rounded-lg border border-black/[0.08] bg-black/[0.02] px-3 py-2 text-[13px] outline-none transition placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:placeholder:text-[#56585f]"
            />
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
            <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">风格（可选，不选就按你说的原样出）</div>
            <div className="flex flex-wrap gap-1.5">
              {STYLES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  title={s.desc}
                  onClick={() => setStyle((cur) => (cur === s.key ? "" : s.key))}
                  className={chip(style === s.key)}
                >
                  {s.label}
                </button>
              ))}
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

        {/* 拖分隔条:调左栏宽 */}
        <div onMouseDown={startDrag("left")} title="拖动调整左栏宽度" className="w-1.5 shrink-0 cursor-col-resize transition hover:bg-[#10a37f]/30" />
        {/* 中·预览 */}
        <main className="flex min-w-0 flex-1 items-center justify-center overflow-auto bg-[#fafafa] p-6 dark:bg-[#0b0c0e]">
          {maskMode && current && !busy ? (
            <StudioMaskCanvas imageUrl={current.url} busy={busy} onApply={onSubmitEdit} onCancel={() => setMaskMode(false)} />
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
                <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5">
                  <img src={current.url} alt="选中的版本" className="max-h-full max-w-full rounded-xl object-contain shadow-sm" />
                  {current.modelSwitched && (
                    <div className="shrink-0 text-[11px] text-[#b0b0b5] dark:text-[#56585f]">这张用了备用模型完成，效果可能略有差异</div>
                  )}
                  {current.textQualityWarning && (
                    <div className="flex shrink-0 items-center gap-1 text-[11px] text-[#b58a00] dark:text-[#e0b23a]">
                      <AlertTriangle className="h-3 w-3" />{current.textQualityWarningMessage || "文字可能有点偏差，可以再改一版"}
                    </div>
                  )}
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
              <div className="flex h-full w-full flex-col items-center justify-center gap-1.5">
                <img src={current.url} alt="生成结果" className="max-h-full max-w-full rounded-xl object-contain shadow-sm" />
                {current.modelSwitched && (
                  <div className="shrink-0 text-[11px] text-[#b0b0b5] dark:text-[#56585f]">这张用了备用模型完成，效果可能略有差异</div>
                )}
                {current.textQualityWarning && (
                  <div className="flex shrink-0 items-center gap-1 text-[11px] text-[#b58a00] dark:text-[#e0b23a]">
                    <AlertTriangle className="h-3 w-3" />{current.textQualityWarningMessage || "文字可能有点偏差，可以再改一版"}
                  </div>
                )}
              </div>
            )
          ) : (
            // E2-2・首屏空态"例子先行":还没出过图时展示场景卡当例子；一出图这个分支就不再命中，
            // 卡片自然让位给结果，不会挡着看图(满足"出图后淡出/收起"的要求)。
            <div className="flex w-full max-w-[560px] flex-col items-center gap-5 px-4">
              <div className="flex flex-col items-center gap-2 text-[#b0b0b5] dark:text-[#56585f]">
                <ImageIcon className="h-10 w-10" />
                <div className="text-[13px]">左边说一句、点「生成」，图就出在这里</div>
              </div>
              <div className="w-full">
                <div className="mb-2 text-center text-[11.5px] text-[#86868b] dark:text-[#6e7077]">
                  不知道怎么说？点个例子，会先填进左边输入框，改改再生成
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {SCENARIOS.map((s) => (
                    <button
                      key={s.title}
                      type="button"
                      onClick={() => pickScenario(s)}
                      title={s.prompt}
                      className="group flex flex-col items-start gap-1 rounded-lg border border-black/[0.07] bg-white p-2.5 text-left shadow-sm transition hover:border-[#10a37f]/35 hover:bg-[#10a37f]/[0.04] active:scale-[0.98] dark:border-white/[0.07] dark:bg-[#141519] dark:shadow-none dark:hover:border-[#10a37f]/35 dark:hover:bg-white/[0.04]"
                    >
                      <s.Icon className="h-4 w-4 text-[#10a37f]" />
                      <div className="text-[12px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{s.title}</div>
                      <div className="text-[11px] leading-snug text-[#86868b] dark:text-[#6e7077]">{s.hint}</div>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </main>

        {/* E2-3・两态第二层:编辑操控台只在打开了某张图(current!=null)时才冒出来,首屏(还没出图/没选中
            任何一张)不渲染这一整块(含拖分隔条),别让刚进来的用户看见一堆专业按钮。选择"右侧面板"这个
            形态(不用抽屉/图下)——出图后天然是"看图+调整"并排,和 macOS 常见的检查器面板顺手,改动也最小。 */}
        {current && (
          <>
            {/* 拖分隔条:调右栏宽 */}
            <div onMouseDown={startDrag("right")} title="拖动调整右栏宽度" className="w-1.5 shrink-0 cursor-col-resize transition hover:bg-[#10a37f]/30" />
            {/* 右·操控台(第二层) */}
            <aside style={{ width: rightW }} className="flex shrink-0 flex-col gap-4 overflow-y-auto border-l border-black/[0.06] p-4 dark:border-white/[0.06]">
              {!current.isVideo && (<>
              {/* E2-3・圈选+说话:合并原来并列的"改这张(整张)"+"圈一块局部改"两个按钮成一个入口——
                  点开后在中间画布里圈一块 = 局部重绘,不圈直接说 = 整图改,由 onSubmitEdit 按有没有 mask 分流。 */}
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">改这张（就地改，不用重头说）</div>
                <button
                  type="button"
                  onClick={() => setMaskMode(true)}
                  disabled={busy || !current.generationId}
                  title="想圈哪块就圈一下、只改那一块；不圈就直接说，整张一起改"
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-[#10a37f] text-[13px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.99] disabled:opacity-50"
                >
                  <Layers className="h-3.5 w-3.5" /> 圈选 + 说话
                </button>
              </div>
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">换比例（按这张重出）</div>
                <div className="flex flex-wrap gap-1.5">
                  {RATIOS.map((r) => <button key={r.id} type="button" disabled={busy} onClick={() => onChangeRatio(r.id)} className={chip(current.ratio === r.id)}>{r.label}</button>)}
                </div>
              </div>
              {/* E2-4・要同款(编辑第二层三件套第 3 件):拿这张当参考图，新出一批相似的——和上面
                  "圈选+说话"(改这一张)、"换比例"(按这张重出同一张)是三种不同操作，别混。 */}
              <div>
                <div className="mb-1.5 text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">要同款（拿这张当参考，新出一批相似的）</div>
                <button
                  type="button"
                  onClick={onSameStyle}
                  disabled={busy || !current.generationId}
                  title="保持这张的风格/主体，重新生成一批新图（不是改这一张）"
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-black/[0.08] bg-black/[0.02] text-[13px] font-medium text-[#3a3a3c] transition hover:border-[#10a37f]/40 hover:bg-[#10a37f]/[0.04] active:scale-[0.99] disabled:opacity-50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#c8cace]"
                >
                  <Repeat className="h-3.5 w-3.5" /> 要同款
                </button>
              </div>
              {/* 做成视频(R4)：只跳转不就地出片——带这张图进工作台的视频面板，视频那边配运镜/时长/配音再出片 */}
              <div>
                <button
                  type="button"
                  onClick={onMakeVideo}
                  disabled={busy || !current.generationId}
                  title="带这张图跳到视频工作台，在那边配运镜/时长/配音再生成"
                  className="flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-[#007AFF]/30 bg-[#007AFF]/[0.06] text-[13px] font-medium text-[#007AFF] transition hover:bg-[#007AFF]/[0.12] active:scale-[0.99] disabled:opacity-50"
                >
                  <Film className="h-3.5 w-3.5" /> 去视频台做成视频
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
              <div className="mt-auto flex items-center gap-1 pt-2 text-[11px] text-[#b0b0b5] dark:text-[#56585f]">
                <RefreshCw className="h-3 w-3" /> 改图也会等几十秒到几分钟，正常。
              </div>
            </aside>
          </>
        )}
      </div>
    </div>
  );
}
