"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { getErrorMessage, downloadImage, safeFileName } from "@/lib/utils";
import { isWeChat } from "@/lib/wechat";
import { ApiError } from "@/types/api";
import type { SizeOption, GeneratedImage, PosterText } from "@/types/poster";
import type { StoreResponse } from "@/types/store";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { CardSelect } from "@/components/ui/card-select";
import { PageHeader } from "@/components/layout/page-header";
import { Sheet } from "@/components/ui/sheet";
import { QuotaBadge } from "@/components/quota-badge";
import { PosterIntro } from "@/components/poster-intro";
import {
  ImageIcon,
  Upload,
  X,
  Send,
  Download,
  Loader2,
  Sparkles,
  HelpCircle,
  ChevronDown,
  Type,
  QrCode,
  Image as ImageLogo,
} from "lucide-react";
import { EmptyStoreGuide } from "@/components/empty-store-guide";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  images?: GeneratedImage[];
}

type BackgroundMode = "ai_generate" | "store_photo";

interface ConversationState {
  id: string | null;
  title: string;
  messages: ConversationMessage[];
  refineFrom: string | null;
  ratio: string;
  quality: "low" | "medium" | "high" | "auto";
  /** 参考图对整个对话持续有效，每轮全量随请求发送（可随时移除） */
  references: Array<{ path: string; preview: string }>;
  addStoreInfo: boolean;
  noText: boolean;
  /** 首图生成时用的结构化载荷，「再来一版」复用（标题/Logo/二维码/门店底图随原话一起带回） */
  firstPayload?: {
    posterText: PosterText | null;
    backgroundMode: BackgroundMode;
    storePhotoPath?: string;
    logoPath?: string;
    qrPath?: string;
  };
}

/** 单张已上传素材（门店照/Logo/二维码），preview 可能是 blob: 也可能是远端 url */
interface UploadedAsset {
  path: string;
  preview: string;
}

const QUALITY_OPTIONS = [
  { value: "low", label: "草稿", desc: "快速便宜" },
  { value: "medium", label: "标准", desc: "日常够用" },
  { value: "high", label: "高清", desc: "印刷级" },
  { value: "auto", label: "自动", desc: "模型决定" },
];

const BACKGROUND_OPTIONS = [
  { value: "ai_generate", label: "AI 生成场景", desc: "凭空画一张" },
  { value: "store_photo", label: "上传门店照优化", desc: "在实拍上加工" },
];

/** 调整方向预设：用户进了调整模式常常不知道说什么，给可点的方向 */
const REFINE_PRESETS = [
  "文字更大更醒目",
  "背景更简洁",
  "换一组配色",
  "整体更亮一些",
  "更有高级感",
  "人物更突出",
];

/** 生图等待阶段文案：30-60 秒的等待里让用户知道没卡住 */
const GEN_STAGES = [
  "正在理解你的描述…",
  "正在构图与配色…",
  "正在绘制画面细节…",
  "正在精修质感，马上就好…",
];

function createNewConversation(): ConversationState {
  return {
    id: null,
    title: "新对话",
    messages: [],
    refineFrom: null,
    ratio: "3:4",
    quality: "auto",
    references: [],
    addStoreInfo: false,
    noText: false,
  };
}

function ConversationPageInner() {
  const params = useParams();
  const router = useRouter();
  const searchParams = useSearchParams();
  const conversationId = params.conversationId as string;

  const { isAuthenticated, isLoading: authLoading } = useAuth();

  /* Store */
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [storeLoading, setStoreLoading] = useState(true);

  /* Conversation state */
  const [conv, setConv] = useState<ConversationState>(createNewConversation());
  const [sizeOptions, setSizeOptions] = useState<SizeOption[]>([]);
  const [prompt, setPrompt] = useState("");
  const [quotaVersion, setQuotaVersion] = useState(0);
  const [genStage, setGenStage] = useState(0);
  const [genSeconds, setGenSeconds] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  // 微信 WebView 不支持 a[download]:下载入口降级为"长按图片保存"引导
  const [inWeChat, setInWeChat] = useState(false);
  useEffect(() => setInWeChat(isWeChat()), []);
  // null=未知(不禁用);0=用尽 → 禁用生成,免得点了再撞 429
  const [quotaRemaining, setQuotaRemaining] = useState<number | null>(null);
  const quotaExhausted = quotaRemaining !== null && quotaRemaining <= 0;

  /* ── 首图合成器：背景来源 / 要写的字 / Logo·二维码 / 出几张 ── */
  const [backgroundMode, setBackgroundMode] = useState<BackgroundMode>("ai_generate");
  const [storePhoto, setStorePhoto] = useState<UploadedAsset | null>(null);
  const [posterTitle, setPosterTitle] = useState("");
  const [posterLinesText, setPosterLinesText] = useState("");
  const [posterContact, setPosterContact] = useState("");
  const [logoAsset, setLogoAsset] = useState<UploadedAsset | null>(null);
  const [qrAsset, setQrAsset] = useState<UploadedAsset | null>(null);
  const [showTextSection, setShowTextSection] = useState(false);
  const [showBrandSection, setShowBrandSection] = useState(false);

  /* ── 扩写引擎 ── */
  const [useExpand, setUseExpand] = useState(true);
  const [expandedPrompt, setExpandedPrompt] = useState(""); // AI 优化后的描述（用户可改）
  const [hasExpanded, setHasExpanded] = useState(false); // 是否已扩写过（用它判断两段式，避免用户清空预览后误触发再次扩写）
  const [expandNeeds, setExpandNeeds] = useState<string[]>([]);
  const [expanding, setExpanding] = useState(false);

  /* ── 新手引导 ── */
  const [showIntro, setShowIntro] = useState(false);

  /* Refs */
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const expandAbortRef = useRef<AbortController | null>(null);
  const lastAttemptRef = useRef<{ text: string; refine: string | null } | null>(null);
  // 组件存活标记：上传 async 回来后 setState 前要看它，避免卸载后 setState
  const mountedRef = useRef(true);
  // 镜像最新的 blob: preview 列表，供卸载 cleanup 读到（闭包否则拿到空初值）
  const blobPreviewsRef = useRef<string[]>([]);

  /* Update conversation state */
  const updateConv = useCallback((patch: Partial<ConversationState>) => {
    setConv((prev) => ({ ...prev, ...patch }));
  }, []);

  /* 把当前所有 blob: preview 镜像进 ref，供卸载 cleanup 读到最新值 */
  useEffect(() => {
    const previews = [
      ...conv.references.map((r) => r.preview),
      storePhoto?.preview,
      logoAsset?.preview,
      qrAsset?.preview,
    ].filter((p): p is string => !!p && p.startsWith("blob:"));
    blobPreviewsRef.current = previews;
  }, [conv.references, storePhoto, logoAsset, qrAsset]);

  /* 卸载时：标记已卸载（async 回调据此跳过 setState）+ 释放残留 blob: URL，防内存泄漏 */
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      for (const url of blobPreviewsRef.current) URL.revokeObjectURL(url);
    };
  }, []);

  /* 描述变化即作废上一次扩写结果——避免拿旧扩写出新图 */
  const handleDescriptionChange = useCallback((value: string) => {
    setPrompt(value);
    setExpandedPrompt("");
    setExpandNeeds([]);
    setHasExpanded(false);
  }, []);

  /* 把 textarea 多行活动信息拆成 lines[]（去掉空行） */
  const buildPosterText = useCallback((): PosterText | null => {
    const title = posterTitle.trim();
    const lines = posterLinesText
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const contact = posterContact.trim();
    if (!title && lines.length === 0 && !contact) return null;
    return {
      ...(title ? { title } : {}),
      ...(lines.length > 0 ? { lines } : {}),
      ...(contact ? { contact } : {}),
    };
  }, [posterTitle, posterLinesText, posterContact]);

  /* Load store */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setStoreLoading(true);
    api.getMyStore()
      .then((s) => { if (!cancelled) setStore(s); })
      .catch(() => { if (!cancelled) setStore(null); })
      .finally(() => { if (!cancelled) setStoreLoading(false); });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  /* Load size options */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    api.listSizeOptions()
      .then((data) => { if (!cancelled) setSizeOptions(data.sizes || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  /* 首次进入自动弹一次功能介绍（localStorage 记住已看过） */
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (!localStorage.getItem("poster_intro_seen")) {
        setShowIntro(true);
        localStorage.setItem("poster_intro_seen", "1");
      }
    } catch {
      /* localStorage 不可用（隐私模式）时静默跳过引导 */
    }
  }, []);

  /* Pre-fill prompt from URL */
  useEffect(() => {
    const urlPrompt = searchParams.get("prompt");
    if (urlPrompt) setPrompt(urlPrompt);
  }, [searchParams]);

  /* Load existing conversation or create new */
  useEffect(() => {
    if (!isAuthenticated || conversationId === "new") return;
    let cancelled = false;
    setLoadingDetail(true);
    api.getPosterConversationDetail(conversationId)
      .then((detail) => {
        if (cancelled) return;
        const messages: ConversationMessage[] = [];
        const refPaths: string[] = [];
        for (const msg of detail.messages) {
          if (msg.prompt) {
            messages.push({ role: "user", content: msg.prompt });
          }
          messages.push({
            role: "assistant",
            content: "",
            images: [{ generation_id: msg.generation_id, poster_url: msg.poster_url, created_at: msg.created_at }],
          });
          // 恢复对话级参考图（跨轮去重，保持上传顺序）
          for (const p of msg.reference_images || []) {
            if (p && !refPaths.includes(p)) refPaths.push(p);
          }
        }
        const lastMsg = detail.messages[detail.messages.length - 1];
        // 历史页"继续调整这张图"带 ?refine=生成ID 进入:基准图定位到那张(须真实存在)
        const refineParam = searchParams.get("refine");
        const refineValid =
          refineParam && detail.messages.some((m) => m.generation_id === refineParam);
        // 用函数式更新保留本地已选设置：新对话首图生成后 URL replace 会重跑本 effect，
        // 硬编码默认值会把用户选的质量/门店信息/禁文字静默重置
        setConv((prev) => ({
          id: detail.id,
          title: detail.title,
          messages,
          refineFrom: (refineValid ? refineParam : lastMsg?.generation_id) || null,
          ratio: lastMsg?.ratio || prev.ratio || "3:4",
          quality: prev.quality,
          references: refPaths.map((p) => ({ path: p, preview: api.resolveUrl(p) })),
          addStoreInfo: prev.addStoreInfo,
          noText: prev.noText,
        }));
      })
      .catch((err) => {
        if (cancelled) return;
        // 仅"对话不存在"才降级为新对话；其它错误显式提示，避免内容静默分叉进新会话
        if (err instanceof ApiError && err.status === 404) {
          setConv(createNewConversation());
        } else {
          setError("对话加载失败，请刷新重试");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDetail(false);
      });
    return () => { cancelled = true; };
  }, [isAuthenticated, conversationId]);

  /* Auto scroll */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conv.messages]);

  /* 等待阶段文案推进（每 9 秒进一档，停在最后一档）+ 真实已用时秒数。
   * 只有阶段文案会在 27 秒后停在"马上就好"——再干等 20 多秒就是欺骗感;
   * 跳动的真实秒数让用户确信没卡住。 */
  useEffect(() => {
    if (!generating) {
      setGenStage(0);
      setGenSeconds(0);
      return;
    }
    const stageTimer = setInterval(
      () => setGenStage((s) => Math.min(s + 1, GEN_STAGES.length - 1)),
      9000,
    );
    const secondsTimer = setInterval(() => setGenSeconds((s) => s + 1), 1000);
    return () => {
      clearInterval(stageTimer);
      clearInterval(secondsTimer);
    };
  }, [generating]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }, []);

  /* Reference upload（风格参考，最多 5 张，对话级持续生效） */
  const handleReferenceUpload = async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (conv.references.length + fileArray.length > 5) {
      setError("最多上传 5 张参考图");
      return;
    }
    try {
      const newRefs = [...conv.references];
      for (const file of fileArray) {
        const res = await api.uploadReferenceImage(file);
        newRefs.push({ path: res.path, preview: URL.createObjectURL(file) });
      }
      if (!mountedRef.current) return;
      updateConv({ references: newRefs });
    } catch {
      if (!mountedRef.current) return;
      setError("参考图上传失败");
    }
  };

  const removeReference = (index: number) => {
    const removed = conv.references[index];
    if (removed && removed.preview.startsWith("blob:")) URL.revokeObjectURL(removed.preview);
    updateConv({ references: conv.references.filter((_, i) => i !== index) });
  };

  /* 单张素材上传（门店照/Logo/二维码）——复用 uploadReferenceImage 接口 */
  const uploadSingleAsset = async (
    file: File,
    setter: (a: UploadedAsset | null) => void,
    failMsg: string,
  ) => {
    try {
      const res = await api.uploadReferenceImage(file);
      if (!mountedRef.current) return;
      setter({ path: res.path, preview: URL.createObjectURL(file) });
    } catch {
      if (!mountedRef.current) return;
      setError(failMsg);
    }
  };

  const clearAsset = (asset: UploadedAsset | null, setter: (a: UploadedAsset | null) => void) => {
    if (asset && asset.preview.startsWith("blob:")) URL.revokeObjectURL(asset.preview);
    setter(null);
  };

  /* Generate（核心发送逻辑，供首图合成 / 聊天输入 / 再来一版共用）。
   * imagePrompt 非空时作为最终绘图指令传给后端；为空则后端用原话 text。
   * structuredOverride 非空时强制带上结构化字段（标题/Logo/二维码/门店底图），
   * 不受 isFirst 限制——「再来一版」用它把首图载荷带回。 */
  const sendGenerate = async (
    text: string,
    refineFromArg: string | null,
    imagePrompt?: string,
    structuredOverride?: ConversationState["firstPayload"],
  ) => {
    if (!text || generating) return;
    lastAttemptRef.current = { text, refine: refineFromArg };
    setError("");

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // 首图合成器的结构化输入只在"新对话第一条"生效；进入对话后转为聊天/调整模式。
    // 例外：structuredOverride（「再来一版」）显式带回首图载荷，不受 isFirst 限制。
    const isFirst = conv.messages.length === 0;
    // 当前轮要用的结构化字段：override 优先（再来一版），否则首图分支用实时表单值，对话中为 null
    const structured: ConversationState["firstPayload"] | null = structuredOverride
      ? structuredOverride
      : isFirst
        ? {
            posterText: buildPosterText(),
            backgroundMode,
            storePhotoPath: backgroundMode === "store_photo" ? storePhoto?.path : undefined,
            logoPath: logoAsset?.path,
            qrPath: qrAsset?.path,
          }
        : null;

    // 重试场景去重：上次失败已追加过同文本的用户气泡，不再重复追加
    const lastMsg = conv.messages[conv.messages.length - 1];
    const alreadyAppended = lastMsg?.role === "user" && lastMsg.content === text;
    const baseMessages = alreadyAppended
      ? conv.messages
      : [...conv.messages, { role: "user" as const, content: text }];
    updateConv({ messages: baseMessages });
    setPrompt("");
    setGenerating(true);
    scrollToBottom();

    try {
      const res = await api.generateImage(
        {
          prompt: text, // 原话：留作历史展示与标题
          image_model: "gpt-image-2",
          ratio: conv.ratio,
          quality: conv.quality,
          images: conv.references.length > 0 ? conv.references.map((r) => r.path) : undefined,
          count: 1, // 一次只出 1 张（禁批量，护住 OpenAI 限额；服务端同样强制）
          refine_from: refineFromArg || undefined,
          add_store_info: conv.addStoreInfo,
          no_text: conv.noText,
          conversation_id: conv.id || undefined,
          image_prompt: imagePrompt || undefined,
          poster_text: structured?.posterText || undefined,
          background_mode: structured?.backgroundMode,
          store_photo_path: structured?.storePhotoPath,
          logo_path: structured?.logoPath,
          qr_path: structured?.qrPath,
        },
        controller.signal,
      );

      const assistantMsg: ConversationMessage = { role: "assistant", content: "", images: res.images };
      const newId = res.conversation_id || conv.id;
      // 参考图不清空：对话级持续生效，用户可手动移除。
      // 首图（isFirst 且非 override）时把本次结构化载荷存进对话态，供「再来一版」复用。
      updateConv({
        id: newId,
        messages: [...baseMessages, assistantMsg],
        refineFrom: res.images?.[0]?.generation_id || refineFromArg,
        ...(isFirst && !structuredOverride && structured ? { firstPayload: structured } : {}),
      });
      // 首图出图后清掉本次扩写结果，避免再次发送时复用旧扩写
      setExpandedPrompt("");
      setExpandNeeds([]);
      setHasExpanded(false);

      setQuotaVersion((v) => v + 1); // 生成完成后实时刷新配额展示

      /* Update URL if this was a new conversation */
      if (conversationId === "new" && newId) {
        router.replace(`/dashboard/posters/${newId}`, { scroll: false });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(getErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  };

  /* 主按钮：先扩写（如开启且未扩写过）→ 展示可改 → 再点出图；或直接出图 */
  const handlePrimaryAction = async () => {
    const text = prompt.trim();
    if (!text || generating || expanding) return;

    // 开关开 且 还没扩写过 → 先扩写，停在预览让用户确认/修改。
    // 用 hasExpanded 而非 expandedPrompt 非空判断：用户清空预览后再点不应重新扩写。
    if (useExpand && !hasExpanded) {
      setError("");
      if (expandAbortRef.current) expandAbortRef.current.abort();
      const controller = new AbortController();
      expandAbortRef.current = controller;
      setExpanding(true);
      try {
        const res = await api.expandPosterPrompt(
          {
            description: text,
            poster_text: buildPosterText() || undefined,
            background_mode: backgroundMode,
            has_logo: !!logoAsset,
            has_qr: !!qrAsset,
            ratio: conv.ratio,
          },
          controller.signal,
        );
        setExpandedPrompt(res.image_prompt || "");
        setExpandNeeds(res.needs || []);
        setHasExpanded(true);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(getErrorMessage(err));
      } finally {
        setExpanding(false);
      }
      return;
    }

    // 已扩写（用「用这个出图」）→ 用扩写后的当前描述出图（即使被清空也按其内容出，不再重扩写）
    if (useExpand && hasExpanded) {
      sendGenerate(text, conv.refineFrom, expandedPrompt);
      return;
    }

    // 开关关 → 直接用原话出图
    sendGenerate(text, conv.refineFrom);
  };

  /* "用我的原话"：跳过扩写，直接用原文出图 */
  const handleUseOriginal = () => {
    const text = prompt.trim();
    if (!text || generating) return;
    sendGenerate(text, conv.refineFrom);
  };

  /* 聊天输入发送（已进入对话后的调整/续写，不走扩写） */
  const handleChatSend = () => sendGenerate(prompt.trim(), conv.refineFrom);

  /* 再来一版：找到该结果前最近一条用户要求，原话重发且不基于底图（出全新构图）。
   * 带回首图结构化载荷（标题/Logo/二维码/门店底图），否则只重发大白话会掉这些。 */
  const handleRegenerate = (msgIdx: number) => {
    for (let i = msgIdx - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (m.role === "user" && m.content) {
        sendGenerate(m.content, null, undefined, conv.firstPayload);
        return;
      }
    }
  };

  /* 把某张生成图加入参考图集（"以后照这张的感觉来"） */
  const addAsReference = (img: GeneratedImage) => {
    if (conv.references.some((r) => r.path === img.poster_url)) return;
    if (conv.references.length >= 5) {
      setError("最多 5 张参考图，请先移除一张");
      return;
    }
    updateConv({
      references: [...conv.references, { path: img.poster_url, preview: api.resolveUrl(img.poster_url) }],
    });
  };

  /* Download：友好命名「门店名_海报_日期时间.jpg」 */
  const handleDownload = async (img: GeneratedImage) => {
    const d = new Date();
    const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}_${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
    const base = safeFileName(`${store?.name || "门店"}_海报_${stamp}`);
    await downloadImage(api.resolveUrl(img.poster_url), base);
  };

  /* PosterIntro 选示例思路 → 回填描述框 */
  const handlePickIdea = (ideaText: string) => {
    handleDescriptionChange(ideaText);
    setShowIntro(false);
  };

  /* Loading */
  if (authLoading || storeLoading) {
    return (
      <div className="mx-auto max-w-4xl">
        <PageHeader title="AI 生图" backHref="/dashboard/posters" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-brand-600" />
        </div>
      </div>
    );
  }
  if (!isAuthenticated) return null;
  if (store === null) {
    return <EmptyStoreGuide description="请先完善门店资料，然后再开始生成图片。" />;
  }

  const breadcrumbTitle = conversationId === "new" ? "新对话" : conv.title;
  const isFirstMessage = conv.messages.length === 0;

  /* 当前底图（"基于此调整"选中的那张）的缩略信息 */
  const refineImage = conv.refineFrom
    ? conv.messages.flatMap((m) => m.images || []).find((img) => img.generation_id === conv.refineFrom) || null
    : null;
  const ratioLabel = sizeOptions.find((s) => s.value === conv.ratio)?.label || conv.ratio;
  const qualityLabel = QUALITY_OPTIONS.find((q) => q.value === conv.quality)?.label || conv.quality;

  /* 首图主按钮文案：扩写中 / 待确认扩写 / 直接出图 */
  const primaryDisabled = generating || expanding || !prompt.trim() || quotaExhausted;
  const primaryLabel = quotaExhausted
    ? "额度已用完"
    : expanding
      ? "AI 优化中…"
      : useExpand && expandedPrompt
        ? "用这个出图"
        : useExpand
          ? "AI 优化描述"
          : "生成";

  return (
    /* 手机端输入区吸底（fixed）后，容器底部 pb 垫高，防止最后一条消息被输入区遮住 */
    <div className={`mx-auto max-w-4xl space-y-4 ${conv.messages.length > 0 ? (conv.refineFrom ? "pb-80" : "pb-56") : ""} lg:pb-0`}>
      {/* 手机端顶栏：深层页底部 Tab 已隐藏，← 是唯一返回出口（桌面端隐藏，由 Breadcrumb 接管） */}
      <PageHeader title={breadcrumbTitle || "AI 生图"} backHref="/dashboard/posters" />
      <div className="flex items-center justify-between gap-2">
        <Breadcrumb
          items={[
            { label: "返回列表", href: "/dashboard/posters" },
            { label: breadcrumbTitle },
          ]}
        />
        {/* 随时重开功能介绍 */}
        <button
          type="button"
          onClick={() => setShowIntro(true)}
          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-full bg-slate-50 px-3 text-xs text-slate-500 active:scale-[0.98] active:bg-slate-100"
        >
          <HelpCircle className="h-3.5 w-3.5" />
          怎么用
        </button>
      </div>

      {loadingDetail ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
        </div>
      ) : (
        <>
          {/* Messages */}
          {conv.messages.length > 0 && (
            <div className="space-y-4">
              {conv.messages.map((msg, idx) => (
                <div
                  key={idx}
                  className={`rounded-2xl border p-4 ${
                    msg.role === "user"
                      ? "bg-brand-50 border-brand-200"
                      : "bg-white border-slate-200"
                  }`}
                >
                  {msg.role === "user" ? (
                    <p className="text-[15px] leading-relaxed text-brand-700 lg:text-sm">{msg.content}</p>
                  ) : (
                    msg.images &&
                    msg.images.length > 0 && (
                      <div className="space-y-3">
                        {msg.images.map((img) => (
                          <div key={img.generation_id}>
                            <img
                              src={api.resolveUrl(img.poster_url)}
                              alt="AI 生成的图片"
                              className="w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity"
                              onClick={() => setLightboxImage(api.resolveUrl(img.poster_url))}
                            />
                            <div className="mt-3 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                onClick={() => updateConv({ refineFrom: img.generation_id })}
                                className={`inline-flex h-10 items-center rounded-xl px-4 text-[13px] active:scale-[0.98] ${
                                  conv.refineFrom === img.generation_id
                                    ? "bg-brand-100 text-brand-700 border border-brand-300"
                                    : "bg-slate-50 text-slate-600 hover:bg-slate-100"
                                }`}
                              >
                                基于此调整
                              </button>
                              <button
                                type="button"
                                disabled={generating}
                                onClick={() => handleRegenerate(idx)}
                                title="用同样的要求再生成一张全新构图"
                                className="inline-flex h-10 items-center rounded-xl px-4 text-[13px] bg-slate-50 text-slate-600 hover:bg-slate-100 active:scale-[0.98] disabled:opacity-50"
                              >
                                再来一版
                              </button>
                              <button
                                type="button"
                                onClick={() => addAsReference(img)}
                                title="加入参考图，后续生成都参考这张的感觉"
                                className={`inline-flex h-10 items-center rounded-xl px-4 text-[13px] border active:scale-[0.98] ${
                                  conv.references.some((r) => r.path === img.poster_url)
                                    ? "bg-emerald-50 text-emerald-600 border-emerald-200"
                                    : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"
                                }`}
                              >
                                {conv.references.some((r) => r.path === img.poster_url) ? "已设为参考" : "用作参考图"}
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  inWeChat
                                    ? setLightboxImage(api.resolveUrl(img.poster_url))
                                    : handleDownload(img)
                                }
                                title={inWeChat ? "微信内请长按图片保存" : undefined}
                                className="inline-flex h-10 items-center rounded-xl px-4 text-[13px] bg-slate-50 text-slate-600 hover:bg-slate-100 active:scale-[0.98]"
                              >
                                <Download className="h-3.5 w-3.5 inline mr-1" />
                                {inWeChat ? "保存图片" : "下载"}
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )
                  )}
                </div>
              ))}

              {/* Generating indicator */}
              {generating && (
                <div className="rounded-2xl bg-white p-4">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-brand-600" />
                    <span className="text-sm text-slate-500">{GEN_STAGES[genStage]}</span>
                    <span className="ml-auto text-xs tabular-nums text-slate-400">{genSeconds}s</span>
                  </div>
                  <p className="mt-1.5 pl-6 text-xs text-slate-400">高清图通常需要 30-60 秒，可以先做别的，结果会留在这里</p>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-center gap-3 rounded-xl border border-red-200 bg-red-50 p-4">
              <p className="flex-1 text-sm text-red-600">{error}</p>
              {lastAttemptRef.current && (
                <button
                  type="button"
                  disabled={generating}
                  onClick={() => lastAttemptRef.current && sendGenerate(lastAttemptRef.current.text, lastAttemptRef.current.refine)}
                  className="inline-flex h-10 shrink-0 items-center rounded-lg border border-red-200 bg-white px-4 text-xs font-medium text-red-600 hover:bg-red-100 active:scale-[0.98] disabled:opacity-50"
                >
                  重试
                </button>
              )}
            </div>
          )}

          {/* Quota（海报走独立额度池：生图比文案贵，单独计数/限额）*/}
          <QuotaBadge mode="poster" refreshKey={quotaVersion} onQuota={(q) => setQuotaRemaining(q.remaining)} />

          {/* Input area：有消息后手机端吸底（fixed+安全区），桌面端保持原 sticky 卡片；首屏（无消息）保持文档流卡片，避免高引导面板被钉死 */}
          <div
            className={
              conv.messages.length > 0
                ? "fixed bottom-0 left-0 right-0 z-20 border-t border-slate-100 bg-white px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] lg:sticky lg:bottom-4 lg:left-auto lg:right-auto lg:rounded-2xl lg:border lg:border-slate-200 lg:p-4 lg:shadow-sm"
                : "rounded-2xl bg-white p-4 shadow-sm"
            }
          >
            {/* 底图提示：让用户明确知道"在哪张图上改"，可一键退出调整模式 */}
            {conv.refineFrom && conv.messages.length > 0 && (
              <div className="mb-3 flex items-center gap-2.5 rounded-md border border-brand-100 bg-brand-50 px-2.5 py-2">
                {refineImage && (
                  <img
                    src={api.resolveUrl(refineImage.poster_url)}
                    alt="当前底图"
                    className="h-10 w-10 rounded object-cover border border-brand-200"
                  />
                )}
                <span className="flex-1 text-xs text-brand-600">
                  将在这张图上调整；参考图与文字要求会一并生效
                </span>
                <button
                  type="button"
                  onClick={() => updateConv({ refineFrom: null })}
                  title="退出调整模式，全新生成"
                  className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-brand-400 hover:bg-brand-100 hover:text-brand-600 active:bg-brand-100"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* 调整方向快捷词：点一下直接发送 */}
            {conv.refineFrom && conv.messages.length > 0 && !generating && (
              <div className="mb-3 flex gap-1.5 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible lg:pb-0">
                {REFINE_PRESETS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => sendGenerate(t, conv.refineFrom)}
                    className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-full bg-slate-50 px-3 text-xs text-slate-600 hover:border-brand-300 hover:bg-brand-50 hover:text-brand-600 active:scale-[0.98] transition-colors"
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}

            {/* ───────── 首图合成器（仅新对话第一条显示） ───────── */}
            {isFirstMessage && (
              <div className="space-y-4">
                <div>
                  <p className="text-sm font-medium text-slate-700">用一句话描述你想要的图</p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    做什么 + 想写什么字 + 想要什么感觉，越具体越好。点右上「怎么用」看示例。
                  </p>
                </div>

                {/* 主描述框 */}
                <textarea
                  rows={3}
                  maxLength={1000}
                  value={prompt}
                  onChange={(e) => handleDescriptionChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.metaKey) {
                      e.preventDefault();
                      handlePrimaryAction();
                    }
                  }}
                  className="w-full rounded-xl bg-[#F2F2F7] px-4 py-3 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 resize-none lg:text-sm"
                  placeholder={'例：周五晚上抢一大战，图上写"报名费10元、赢家拿奖金"，要热血电竞风'}
                />

                {/* 背景来源 */}
                <div>
                  <p className="mb-1.5 text-xs text-slate-500">背景来源</p>
                  <CardSelect
                    value={backgroundMode}
                    onChange={(v) => setBackgroundMode(v as BackgroundMode)}
                    options={BACKGROUND_OPTIONS}
                    columns={2}
                  />
                  {backgroundMode === "store_photo" && (
                    <div className="mt-2.5">
                      {storePhoto ? (
                        <div className="relative inline-block">
                          <img
                            src={storePhoto.preview}
                            alt="门店照"
                            className="h-20 w-20 rounded-xl object-cover border border-slate-200"
                          />
                          <button
                            type="button"
                            onClick={() => clearAsset(storePhoto, setStorePhoto)}
                            aria-label="移除门店照"
                            className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white"
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ) : (
                        <label className="flex h-11 w-fit cursor-pointer items-center gap-1.5 rounded-xl bg-slate-50 px-4 text-sm text-slate-600 active:scale-[0.98] active:bg-slate-100">
                          <Upload className="h-4 w-4" />
                          上传门店照
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            onChange={(e) => {
                              const f = e.target.files?.[0];
                              if (f) uploadSingleAsset(f, setStorePhoto, "门店照上传失败");
                            }}
                          />
                        </label>
                      )}
                      <p className="mt-1.5 text-[11px] text-slate-400">AI 会在你的实拍照上加工出图，更有「就是这家店」的感觉</p>
                    </div>
                  )}
                </div>

                {/* 要写的字（结构化，可折叠） */}
                <div className="rounded-xl border border-slate-100">
                  <button
                    type="button"
                    onClick={() => setShowTextSection((v) => !v)}
                    className="flex min-h-[44px] w-full items-center gap-2 px-3.5 text-sm text-slate-700 active:bg-slate-50"
                  >
                    <Type className="h-4 w-4 text-slate-400" />
                    <span className="font-medium">要写的字</span>
                    <span className="text-xs text-slate-400">把活动信息准确写进图里</span>
                    <ChevronDown className={`ml-auto h-4 w-4 text-slate-400 transition-transform ${showTextSection ? "rotate-180" : ""}`} />
                  </button>
                  {showTextSection && (
                    <div className="space-y-2.5 px-3.5 pb-3.5">
                      <input
                        type="text"
                        maxLength={40}
                        value={posterTitle}
                        onChange={(e) => setPosterTitle(e.target.value)}
                        placeholder="标题，如「周末抢一大战」"
                        className="w-full rounded-xl bg-[#F2F2F7] px-3 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 lg:text-sm"
                      />
                      <textarea
                        rows={3}
                        maxLength={200}
                        value={posterLinesText}
                        onChange={(e) => setPosterLinesText(e.target.value)}
                        placeholder={"活动信息，每行一条\n如：报名费 10 元\n赢家独得全部奖金\n时间：周五 20:00"}
                        className="w-full resize-none rounded-xl bg-[#F2F2F7] px-3 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 lg:text-sm"
                      />
                      <input
                        type="text"
                        maxLength={40}
                        value={posterContact}
                        onChange={(e) => setPosterContact(e.target.value)}
                        placeholder="联系方式，如「电话 138xxxx8888」"
                        className="w-full rounded-xl bg-[#F2F2F7] px-3 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 lg:text-sm"
                      />
                      <p className="text-[11px] text-slate-400">AI 写中文偶有笔误，重要物料发出前请检查文字</p>
                    </div>
                  )}
                </div>

                {/* Logo / 二维码（折叠，默认不带） */}
                <div className="rounded-xl border border-slate-100">
                  <button
                    type="button"
                    onClick={() => setShowBrandSection((v) => !v)}
                    className="flex min-h-[44px] w-full items-center gap-2 px-3.5 text-sm text-slate-700 active:bg-slate-50"
                  >
                    <ImageLogo className="h-4 w-4 text-slate-400" />
                    <span className="font-medium">Logo / 二维码</span>
                    <span className="text-xs text-slate-400">可选，传了会画进图里</span>
                    <ChevronDown className={`ml-auto h-4 w-4 text-slate-400 transition-transform ${showBrandSection ? "rotate-180" : ""}`} />
                  </button>
                  {showBrandSection && (
                    <div className="flex flex-wrap gap-4 px-3.5 pb-3.5">
                      {/* Logo */}
                      <div>
                        <p className="mb-1.5 flex items-center gap-1 text-xs text-slate-500">
                          <ImageLogo className="h-3.5 w-3.5" /> 门店 Logo
                        </p>
                        {logoAsset ? (
                          <div className="relative inline-block">
                            <img src={logoAsset.preview} alt="Logo" className="h-16 w-16 rounded-xl object-cover border border-slate-200" />
                            <button
                              type="button"
                              onClick={() => clearAsset(logoAsset, setLogoAsset)}
                              aria-label="移除 Logo"
                              className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : (
                          <label className="flex h-16 w-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl bg-slate-50 text-[11px] text-slate-500 active:scale-[0.98] active:bg-slate-100">
                            <Upload className="h-4 w-4" />
                            上传
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) uploadSingleAsset(f, setLogoAsset, "Logo 上传失败");
                              }}
                            />
                          </label>
                        )}
                      </div>
                      {/* 二维码 */}
                      <div>
                        <p className="mb-1.5 flex items-center gap-1 text-xs text-slate-500">
                          <QrCode className="h-3.5 w-3.5" /> 二维码
                        </p>
                        {qrAsset ? (
                          <div className="relative inline-block">
                            <img src={qrAsset.preview} alt="二维码" className="h-16 w-16 rounded-xl object-cover border border-slate-200" />
                            <button
                              type="button"
                              onClick={() => clearAsset(qrAsset, setQrAsset)}
                              aria-label="移除二维码"
                              className="absolute -right-1.5 -top-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        ) : (
                          <label className="flex h-16 w-16 cursor-pointer flex-col items-center justify-center gap-1 rounded-xl bg-slate-50 text-[11px] text-slate-500 active:scale-[0.98] active:bg-slate-100">
                            <Upload className="h-4 w-4" />
                            上传
                            <input
                              type="file"
                              accept="image/*"
                              className="hidden"
                              onChange={(e) => {
                                const f = e.target.files?.[0];
                                if (f) uploadSingleAsset(f, setQrAsset, "二维码上传失败");
                              }}
                            />
                          </label>
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* 风格参考图（保留，对话级持续生效） */}
                <div>
                  <p className="mb-1.5 text-xs text-slate-500">风格参考图（可选，AI 会照这个感觉来）</p>
                  <div className="flex flex-wrap items-center gap-2">
                    {conv.references.map((ref, idx) => (
                      <div key={idx} className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                        <img src={ref.preview} alt={`参考图${idx + 1}`} className="h-full w-full object-cover" />
                        <button
                          type="button"
                          onClick={() => removeReference(idx)}
                          aria-label="移除参考图"
                          className="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    ))}
                    {conv.references.length < 5 && (
                      <label className="flex h-12 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-slate-50 px-4 text-sm text-slate-500 active:scale-[0.98] active:bg-slate-100">
                        <Upload className="h-4 w-4" />
                        {conv.references.length === 0 ? "上传参考图" : "添加"}
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            if (e.target.files?.length) handleReferenceUpload(e.target.files);
                          }}
                        />
                      </label>
                    )}
                  </div>
                </div>

                {/* AI 优化描述开关 */}
                <label className="flex items-center gap-2.5 rounded-xl bg-brand-50/60 px-3.5 py-3">
                  <Sparkles className="h-4 w-4 shrink-0 text-brand-600" />
                  <span className="flex-1 text-sm text-slate-700">
                    AI 帮我优化描述
                    <span className="ml-1 text-xs text-slate-400">把你的大白话变成专业绘图指令</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={useExpand}
                    onChange={(e) => {
                      setUseExpand(e.target.checked);
                      // 关掉时清掉已扩写结果，开关语义清晰
                      if (!e.target.checked) {
                        setExpandedPrompt("");
                        setExpandNeeds([]);
                      }
                    }}
                    className="h-5 w-5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                  />
                </label>

                {/* 扩写预览：可改 + 缺口建议 + 用原话 */}
                {useExpand && expandedPrompt && (
                  <div className="space-y-2 rounded-xl border border-brand-100 bg-brand-50/40 p-3.5">
                    <p className="flex items-center gap-1.5 text-xs font-medium text-brand-700">
                      <Sparkles className="h-3.5 w-3.5" />
                      AI 优化后的描述（可改）
                    </p>
                    {expandNeeds.length > 0 && (
                      <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
                        建议补充：{expandNeeds.join("、")}
                      </div>
                    )}
                    <textarea
                      rows={4}
                      value={expandedPrompt}
                      onChange={(e) => setExpandedPrompt(e.target.value)}
                      className="w-full resize-none rounded-xl bg-white px-3 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 lg:text-sm"
                    />
                    <button
                      type="button"
                      onClick={handleUseOriginal}
                      disabled={generating}
                      className="text-xs text-slate-400 underline-offset-2 hover:text-slate-600 hover:underline disabled:opacity-50"
                    >
                      不用优化，用我的原话出图
                    </button>
                  </div>
                )}

                {/* 主按钮：扩写→预览→出图 / 直接出图，单按钮多态 */}
                <button
                  type="button"
                  disabled={primaryDisabled}
                  onClick={handlePrimaryAction}
                  title={quotaExhausted ? "本月额度已用完，联系您的服务商提升" : undefined}
                  className="flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-brand-600 text-base font-semibold text-white active:scale-[0.98] active:bg-brand-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {expanding || generating ? (
                    <Loader2 className="h-5 w-5 animate-spin" />
                  ) : useExpand && expandedPrompt ? (
                    <ImageIcon className="h-5 w-5" />
                  ) : useExpand ? (
                    <Sparkles className="h-5 w-5" />
                  ) : (
                    <ImageIcon className="h-5 w-5" />
                  )}
                  {primaryLabel}
                </button>
              </div>
            )}

            {/* ───────── 聊天输入（已进入对话后的调整/续写） ───────── */}
            {conv.messages.length > 0 && (
              <>
                <div className="flex items-end gap-2">
                  <div className="flex-1">
                    <textarea
                      rows={1}
                      maxLength={1000}
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey) {
                          e.preventDefault();
                          handleChatSend();
                        }
                      }}
                      className="w-full resize-none rounded-xl bg-[#F2F2F7] px-4 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 lg:text-sm"
                      placeholder={conv.refineFrom ? "描述调整内容，如「背景改成深色」" : "描述新的图片需求"}
                    />
                  </div>
                  <button
                    type="button"
                    disabled={generating || !prompt.trim() || quotaExhausted}
                    onClick={handleChatSend}
                    title={quotaExhausted ? "本月额度已用完，联系您的服务商提升" : undefined}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white hover:bg-brand-500 active:scale-[0.98] disabled:opacity-50"
                  >
                    <Send className="h-5 w-5" />
                  </button>
                </div>

                {/* 参考图（对话进行中仍可增删） */}
                <div className="mt-3 flex w-full items-center gap-2 overflow-x-auto pb-1 lg:flex-wrap lg:overflow-visible lg:pb-0">
                  {conv.references.map((ref, idx) => (
                    <div key={idx} className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg">
                      <img src={ref.preview} alt={`参考图${idx + 1}`} className="h-full w-full object-cover" />
                      <button
                        type="button"
                        onClick={() => removeReference(idx)}
                        aria-label="移除参考图"
                        className="absolute right-0.5 top-0.5 flex h-6 w-6 items-center justify-center rounded-full bg-red-500 text-white"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  {conv.references.length > 0 && (
                    <span className="shrink-0 whitespace-nowrap text-[11px] text-slate-400">参考图对本次对话持续生效</span>
                  )}
                  {conv.references.length < 5 && (
                    <label className="flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-xl bg-white px-4 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-700 active:scale-[0.98] lg:h-9 lg:px-3">
                      <Upload className="h-4 w-4" />
                      {conv.references.length === 0 ? "上传参考图" : "添加"}
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        onChange={(e) => {
                          if (e.target.files?.length) handleReferenceUpload(e.target.files);
                        }}
                      />
                    </label>
                  )}
                </div>

              </>
            )}

            {/* 比例 / 质量 / 开关（首图与对话两态共用，showAdvanced 单状态控制） */}
            <div className="mt-3">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="inline-flex min-h-[44px] items-center text-xs text-slate-400 hover:text-slate-600 lg:min-h-0"
              >
                {`比例与质量（${ratioLabel} · ${qualityLabel}）›`}
              </button>
              <Sheet open={showAdvanced} onClose={() => setShowAdvanced(false)} title="高级选项">
                <div className="space-y-4 pb-2">
                  <div>
                    <p className="mb-1.5 text-xs text-slate-500">图片比例</p>
                    <CardSelect
                      value={conv.ratio}
                      onChange={(v) => updateConv({ ratio: v })}
                      options={sizeOptions.map((s) => ({ value: s.value, label: s.label, desc: s.desc }))}
                      columns={4}
                    />
                  </div>
                  <div>
                    <p className="mb-1.5 text-xs text-slate-500">图片质量</p>
                    <CardSelect
                      value={conv.quality}
                      onChange={(v) => updateConv({ quality: v as "low" | "medium" | "high" | "auto" })}
                      options={QUALITY_OPTIONS}
                      columns={4}
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-slate-500">
                    <label className="flex min-h-[44px] items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={conv.addStoreInfo}
                        onChange={(e) => updateConv({ addStoreInfo: e.target.checked })}
                        className="h-5 w-5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                      <span>融入门店信息</span>
                    </label>
                    <label className="flex min-h-[44px] items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={conv.noText}
                        onChange={(e) => updateConv({ noText: e.target.checked })}
                        className="h-5 w-5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                      />
                      <span>禁止生成文字</span>
                    </label>
                  </div>
                </div>
              </Sheet>
            </div>
          </div>
        </>
      )}

      {/* 功能介绍 / 新手引导 */}
      <PosterIntro open={showIntro} onClose={() => setShowIntro(false)} onPickIdea={handlePickIdea} />

      {/* Lightbox */}
      {lightboxImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setLightboxImage(null)}
        >
          <div className="relative max-w-4xl max-h-[90vh]" onClick={(e) => e.stopPropagation()}>
            <img src={lightboxImage} alt="放大查看" className="max-w-full max-h-[90vh] object-contain rounded-lg" />
            <button
              type="button"
              onClick={() => setLightboxImage(null)}
              className="absolute -top-3 -right-3 h-11 w-11 rounded-full bg-white text-slate-700 flex items-center justify-center shadow-lg hover:bg-slate-100 active:scale-[0.98]"
            >
              <X className="h-5 w-5" />
            </button>
            {inWeChat ? (
              <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-md bg-black/70 px-4 py-2 text-sm font-medium text-white shadow-lg">
                长按图片 → 保存图片
              </div>
            ) : (
              <a
                href={lightboxImage}
                download
                className="absolute bottom-4 right-4 flex h-11 items-center gap-1.5 rounded-xl bg-white px-4 text-sm font-medium text-slate-700 shadow-lg hover:bg-slate-50 active:scale-[0.98]"
              >
                <Download className="h-4 w-4" />
                下载
              </a>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function ConversationPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-6 w-6 animate-spin text-brand-600" />
        </div>
      }
    >
      <ConversationPageInner />
    </Suspense>
  );
}
