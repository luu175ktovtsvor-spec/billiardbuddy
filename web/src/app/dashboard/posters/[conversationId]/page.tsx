"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { getErrorMessage, downloadImage, safeFileName } from "@/lib/utils";
import { ApiError } from "@/types/api";
import type { SizeOption, GeneratedImage } from "@/types/poster";
import type { StoreResponse } from "@/types/store";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { CardSelect } from "@/components/ui/card-select";
import { QuotaBadge } from "@/components/quota-badge";
import { ImageIcon, Upload, X, Send, Download, Loader2 } from "lucide-react";
import { EmptyStoreGuide } from "@/components/empty-store-guide";

interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  images?: GeneratedImage[];
}

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
}

const QUALITY_OPTIONS = [
  { value: "low", label: "草稿", desc: "快速便宜" },
  { value: "medium", label: "标准", desc: "日常够用" },
  { value: "high", label: "高清", desc: "印刷级" },
  { value: "auto", label: "自动", desc: "模型决定" },
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

/** 通用风格预设：不限台球行业，点击追加到描述文本（用户可见可改） */
const STYLE_PRESETS = [
  { label: "写实人像", prompt: "写实人像摄影风格，自然光影，质感细腻" },
  { label: "日系清新", prompt: "日系小清新风格，柔和色调，干净留白" },
  { label: "赛博霓虹", prompt: "赛博朋克霓虹风格，蓝紫色光效，未来感" },
  { label: "复古海报", prompt: "复古胶片海报风格，颗粒质感，怀旧配色" },
  { label: "3D卡通", prompt: "3D卡通渲染风格，圆润可爱，色彩鲜艳" },
  { label: "电影质感", prompt: "电影感画面，戏剧化布光，宽幅构图" },
  { label: "ins风", prompt: "ins风格，明亮通透，时尚生活感" },
  { label: "黑白高级", prompt: "黑白摄影风格，高对比度，极简高级感" },
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
  const [inspirationTags, setInspirationTags] = useState<Array<{ key: string; label: string; prompt: string; category?: string }>>([]);
  const [prompt, setPrompt] = useState("");
  const [overlayText, setOverlayText] = useState("");
  const [quotaVersion, setQuotaVersion] = useState(0);
  const [genStage, setGenStage] = useState(0);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  /* Refs */
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastAttemptRef = useRef<{ text: string; refine: string | null } | null>(null);

  /* Update conversation state */
  const updateConv = useCallback((patch: Partial<ConversationState>) => {
    setConv((prev) => ({ ...prev, ...patch }));
  }, []);

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

  /* Load size options + 场景灵感标签 */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    api.listSizeOptions()
      .then((data) => { if (!cancelled) setSizeOptions(data.sizes || []); })
      .catch(() => {});
    api.listInspirationTags()
      .then((data) => { if (!cancelled) setInspirationTags(data.tags || []); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isAuthenticated]);

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
        // 用函数式更新保留本地已选设置：新对话首图生成后 URL replace 会重跑本 effect，
        // 硬编码默认值会把用户选的质量/门店信息/禁文字静默重置
        setConv((prev) => ({
          id: detail.id,
          title: detail.title,
          messages,
          refineFrom: lastMsg?.generation_id || null,
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

  /* 等待阶段文案推进（每 9 秒进一档，停在最后一档） */
  useEffect(() => {
    if (!generating) {
      setGenStage(0);
      return;
    }
    const timer = setInterval(
      () => setGenStage((s) => Math.min(s + 1, GEN_STAGES.length - 1)),
      9000,
    );
    return () => clearInterval(timer);
  }, [generating]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }, []);

  /* Reference upload */
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
      updateConv({ references: newRefs });
    } catch {
      setError("参考图上传失败");
    }
  };

  const removeReference = (index: number) => {
    const removed = conv.references[index];
    if (removed && removed.preview.startsWith("blob:")) URL.revokeObjectURL(removed.preview);
    updateConv({ references: conv.references.filter((_, i) => i !== index) });
  };

  /* Generate（核心发送逻辑，供输入框 / 再来一版共用） */
  const sendGenerate = async (text: string, refineFromArg: string | null) => {
    if (!text || generating) return;
    lastAttemptRef.current = { text, refine: refineFromArg };
    setError("");

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // 文字上图（实验）：把要画进图里的文字拼进最终 prompt，输入框保持大白话
    const overlay = overlayText.trim();
    const finalPrompt = overlay
      ? `${text}，在画面中醒目地写上文字：「${overlay}」，文字内容必须一字不差、清晰可读`
      : text;

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
          prompt: finalPrompt,
          image_model: "gpt-image-2",
          ratio: conv.ratio,
          quality: conv.quality,
          images: conv.references.length > 0 ? conv.references.map((r) => r.path) : undefined,
          count: 1,
          refine_from: refineFromArg || undefined,
          add_store_info: conv.addStoreInfo,
          no_text: overlay ? false : conv.noText,
          conversation_id: conv.id || undefined,
        },
        controller.signal,
      );

      const assistantMsg: ConversationMessage = { role: "assistant", content: "", images: res.images };
      const newId = res.conversation_id || conv.id;
      // 参考图不清空：对话级持续生效，用户可手动移除
      updateConv({
        id: newId,
        messages: [...baseMessages, assistantMsg],
        refineFrom: res.images?.[0]?.generation_id || refineFromArg,
      });

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

  const handleGenerate = () => sendGenerate(prompt.trim(), conv.refineFrom);

  /* 再来一版：找到该结果前最近一条用户要求，原话重发且不基于底图（出全新构图） */
  const handleRegenerate = (msgIdx: number) => {
    for (let i = msgIdx - 1; i >= 0; i--) {
      const m = conv.messages[i];
      if (m.role === "user" && m.content) {
        sendGenerate(m.content, null);
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

  /* Loading */
  if (authLoading || storeLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
      </div>
    );
  }
  if (!isAuthenticated) return null;
  if (store === null) {
    return <EmptyStoreGuide description="请先完善门店资料，然后再开始生成图片。" />;
  }

  const breadcrumbTitle = conversationId === "new" ? "新对话" : conv.title;

  /* 当前底图（"基于此调整"选中的那张）的缩略信息 */
  const refineImage = conv.refineFrom
    ? conv.messages.flatMap((m) => m.images || []).find((img) => img.generation_id === conv.refineFrom) || null
    : null;
  const ratioLabel = sizeOptions.find((s) => s.value === conv.ratio)?.label || conv.ratio;
  const qualityLabel = QUALITY_OPTIONS.find((q) => q.value === conv.quality)?.label || conv.quality;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Breadcrumb
        items={[
          { label: "返回列表", href: "/dashboard/posters" },
          { label: breadcrumbTitle },
        ]}
      />

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
                  className={`rounded-lg border p-4 ${
                    msg.role === "user"
                      ? "bg-indigo-50 border-indigo-200"
                      : "bg-white border-slate-200"
                  }`}
                >
                  {msg.role === "user" ? (
                    <p className="text-sm text-indigo-700">{msg.content}</p>
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
                            <div className="mt-3 flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => updateConv({ refineFrom: img.generation_id })}
                                className={`px-3 py-1.5 rounded text-xs ${
                                  conv.refineFrom === img.generation_id
                                    ? "bg-indigo-100 text-indigo-700 border border-indigo-300"
                                    : "bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100"
                                }`}
                              >
                                基于此调整
                              </button>
                              <button
                                type="button"
                                disabled={generating}
                                onClick={() => handleRegenerate(idx)}
                                title="用同样的要求再生成一张全新构图"
                                className="px-3 py-1.5 rounded text-xs bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100 disabled:opacity-50"
                              >
                                再来一版
                              </button>
                              <button
                                type="button"
                                onClick={() => addAsReference(img)}
                                title="加入参考图，后续生成都参考这张的感觉"
                                className={`px-3 py-1.5 rounded text-xs border ${
                                  conv.references.some((r) => r.path === img.poster_url)
                                    ? "bg-emerald-50 text-emerald-600 border-emerald-200"
                                    : "bg-slate-50 text-slate-600 border-slate-200 hover:bg-slate-100"
                                }`}
                              >
                                {conv.references.some((r) => r.path === img.poster_url) ? "已设为参考" : "用作参考图"}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownload(img)}
                                className="px-3 py-1.5 rounded text-xs bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100"
                              >
                                <Download className="h-3 w-3 inline mr-1" />
                                下载
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
                <div className="rounded-lg border border-slate-200 bg-white p-4">
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                    <span className="text-sm text-slate-500">{GEN_STAGES[genStage]}</span>
                  </div>
                  <p className="mt-1.5 pl-6 text-xs text-slate-400">高清图通常需要 30-60 秒，可以先做别的，结果会留在这里</p>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="flex items-center gap-3 rounded-md border border-red-200 bg-red-50 p-4">
              <p className="flex-1 text-sm text-red-600">{error}</p>
              {lastAttemptRef.current && (
                <button
                  type="button"
                  disabled={generating}
                  onClick={() => lastAttemptRef.current && sendGenerate(lastAttemptRef.current.text, lastAttemptRef.current.refine)}
                  className="shrink-0 rounded-md border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-100 disabled:opacity-50"
                >
                  重试
                </button>
              )}
            </div>
          )}

          {/* Quota（生图与文本共用次数池）*/}
          <QuotaBadge refreshKey={quotaVersion} />

          {/* Input area */}
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sticky bottom-4">
            {/* 底图提示：让用户明确知道"在哪张图上改"，可一键退出调整模式 */}
            {conv.refineFrom && conv.messages.length > 0 && (
              <div className="mb-3 flex items-center gap-2.5 rounded-md border border-indigo-100 bg-indigo-50 px-2.5 py-2">
                {refineImage && (
                  <img
                    src={api.resolveUrl(refineImage.poster_url)}
                    alt="当前底图"
                    className="h-10 w-10 rounded object-cover border border-indigo-200"
                  />
                )}
                <span className="flex-1 text-xs text-indigo-600">
                  将在这张图上调整；参考图与文字要求会一并生效
                </span>
                <button
                  type="button"
                  onClick={() => updateConv({ refineFrom: null })}
                  title="退出调整模式，全新生成"
                  className="rounded p-1 text-indigo-400 hover:bg-indigo-100 hover:text-indigo-600"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}

            {/* 调整方向快捷词：点一下直接发送 */}
            {conv.refineFrom && conv.messages.length > 0 && !generating && (
              <div className="mb-3 flex flex-wrap gap-1.5">
                {REFINE_PRESETS.map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => sendGenerate(t, conv.refineFrom)}
                    className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                  >
                    {t}
                  </button>
                ))}
              </div>
            )}

            {/* First message: 引导 + full input; subsequent: compact */}
            {conv.messages.length === 0 && (
              <>
                <div className="mb-3">
                  <p className="text-sm font-medium text-slate-700">用大白话描述你想要的图就行</p>
                  <p className="mt-0.5 text-xs text-slate-400">
                    不只是海报——人像形象照、朋友圈配图、活动图都可以；上传参考图，AI 会「照这个感觉来」。
                  </p>
                </div>

                {inspirationTags.length > 0 && (
                  <div className="mb-3">
                    <p className="mb-1.5 text-xs text-slate-500">场景起稿（点击填入，可再修改）</p>
                    <div className="flex flex-wrap gap-1.5">
                      {inspirationTags.map((tag) => (
                        <button
                          key={tag.key}
                          type="button"
                          onClick={() => setPrompt(tag.prompt)}
                          className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                        >
                          {tag.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mb-3">
                  <p className="mb-1.5 text-xs text-slate-500">叠加风格（点击追加到描述）</p>
                  <div className="flex flex-wrap gap-1.5">
                    {STYLE_PRESETS.map((s) => (
                      <button
                        key={s.label}
                        type="button"
                        onClick={() => setPrompt((p) => (p.trim() ? `${p.trim()}，${s.prompt}` : s.prompt))}
                        className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-600 hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
                      >
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>

                <textarea
                  rows={3}
                  maxLength={1000}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.metaKey) {
                      e.preventDefault();
                      handleGenerate();
                    }
                  }}
                  className="w-full rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 resize-none"
                  placeholder="例：帮我们店的女助教生成一张高级感形象照，球房背景，光线柔和"
                />
              </>
            )}

            {conv.messages.length > 0 && (
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
                        handleGenerate();
                      }
                    }}
                    className="w-full resize-none rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    placeholder={conv.refineFrom ? "描述调整内容，如「背景改成深色」" : "描述新的图片需求"}
                  />
                </div>
                <button
                  type="button"
                  disabled={generating || !prompt.trim()}
                  onClick={handleGenerate}
                  className="rounded-xl bg-indigo-600 p-2.5 text-white hover:bg-indigo-500 disabled:opacity-50"
                >
                  <Send className="h-4 w-4" />
                </button>
              </div>
            )}

            {/* Options row */}
            <div className="mt-3 flex flex-wrap items-center gap-3">
              {/* References */}
              <div className="flex items-center gap-2 flex-wrap">
                {conv.references.map((ref, idx) => (
                  <div key={idx} className="relative h-10 w-10 rounded-md border border-slate-200 overflow-hidden">
                    <img src={ref.preview} alt={`参考图${idx + 1}`} className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={() => removeReference(idx)}
                      className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 text-white flex items-center justify-center"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {conv.references.length > 0 && (
                  <span className="text-[11px] text-slate-400">参考图对本次对话持续生效</span>
                )}
                {conv.references.length < 5 && (
                  <label className="flex items-center gap-1.5 cursor-pointer rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-700">
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

              {/* Generate button (for first message) */}
              {conv.messages.length === 0 && (
                <button
                  type="button"
                  disabled={generating || !prompt.trim()}
                  onClick={handleGenerate}
                  className="ml-auto flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                  生成
                </button>
              )}
            </div>

            {/* Advanced options：比例/质量/开关（CardSelect，替换原生 select） */}
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-xs text-slate-400 hover:text-slate-600"
              >
                {showAdvanced ? "收起选项 ▲" : `比例与质量（${ratioLabel} · ${qualityLabel}）▼`}
              </button>
              {showAdvanced && (
                <div className="mt-3 space-y-3">
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
                  <div>
                    <p className="mb-1.5 text-xs text-slate-500">
                      把文字画进图里 <span className="text-slate-400">（实验功能：AI 写中文偶有笔误，重要物料发出前请检查）</span>
                    </p>
                    <input
                      type="text"
                      maxLength={30}
                      value={overlayText}
                      onChange={(e) => setOverlayText(e.target.value)}
                      placeholder="例：周五晚8点 · 抢一大战"
                      className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
                    />
                  </div>
                  <div className="flex flex-wrap items-center gap-4 text-xs text-slate-500">
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={conv.addStoreInfo}
                        onChange={(e) => updateConv({ addStoreInfo: e.target.checked })}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>融入门店信息</span>
                    </label>
                    <label className={`flex items-center gap-1.5 ${overlayText.trim() ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}>
                      <input
                        type="checkbox"
                        disabled={!!overlayText.trim()}
                        checked={overlayText.trim() ? false : conv.noText}
                        onChange={(e) => updateConv({ noText: e.target.checked })}
                        className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span>禁止生成文字{overlayText.trim() ? "（已填上图文字，自动失效）" : ""}</span>
                    </label>
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

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
              className="absolute -top-3 -right-3 h-8 w-8 rounded-full bg-white text-slate-700 flex items-center justify-center shadow-lg hover:bg-slate-100"
            >
              <X className="h-4 w-4" />
            </button>
            <a
              href={lightboxImage}
              download
              className="absolute bottom-4 right-4 flex items-center gap-1.5 rounded-md bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-lg hover:bg-slate-50"
            >
              <Download className="h-4 w-4" />
              下载
            </a>
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
          <Loader2 className="h-6 w-6 animate-spin text-indigo-600" />
        </div>
      }
    >
      <ConversationPageInner />
    </Suspense>
  );
}
