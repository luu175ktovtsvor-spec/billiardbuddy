"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import type { SizeOption, GeneratedImage } from "@/types/poster";
import type { StoreResponse } from "@/types/store";
import { Breadcrumb } from "@/components/ui/breadcrumb";
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
  references: Array<{ file: File; path: string; preview: string }>;
  addStoreInfo: boolean;
  noText: boolean;
}

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
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);

  /* Refs */
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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

  /* Load size options */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    api.listSizeOptions()
      .then((data) => { if (!cancelled) setSizeOptions(data.sizes || []); })
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
        for (const msg of detail.messages) {
          if (msg.prompt) {
            messages.push({ role: "user", content: msg.prompt });
          }
          messages.push({
            role: "assistant",
            content: "",
            images: [{ generation_id: msg.generation_id, poster_url: msg.poster_url, created_at: msg.created_at }],
          });
        }
        const lastMsg = detail.messages[detail.messages.length - 1];
        setConv({
          id: detail.id,
          title: detail.title,
          messages,
          refineFrom: lastMsg?.generation_id || null,
          ratio: "3:4",
          quality: "auto",
          references: [],
          addStoreInfo: false,
          noText: false,
        });
      })
      .catch(() => {
        if (!cancelled) {
          setConv(createNewConversation());
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
        newRefs.push({ file, path: res.path, preview: URL.createObjectURL(file) });
      }
      updateConv({ references: newRefs });
    } catch {
      setError("参考图上传失败");
    }
  };

  const removeReference = (index: number) => {
    const removed = conv.references[index];
    if (removed) URL.revokeObjectURL(removed.preview);
    updateConv({ references: conv.references.filter((_, i) => i !== index) });
  };

  /* Generate */
  const handleGenerate = async () => {
    const text = prompt.trim();
    if (!text || generating) return;
    setError("");

    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const userMsg: ConversationMessage = { role: "user", content: text };
    updateConv({ messages: [...conv.messages, userMsg] });
    setPrompt("");
    setGenerating(true);
    scrollToBottom();

    try {
      const res = await api.generateImage(
        {
          prompt: text,
          image_model: "gpt-image-2",
          ratio: conv.ratio,
          quality: conv.quality,
          images: conv.references.length > 0 ? conv.references.map((r) => r.path) : undefined,
          count: 1,
          refine_from: conv.refineFrom || undefined,
          add_store_info: conv.addStoreInfo,
          no_text: conv.noText,
          conversation_id: conv.id || undefined,
        },
        controller.signal,
      );

      const assistantMsg: ConversationMessage = { role: "assistant", content: "", images: res.images };
      const newId = res.conversation_id || conv.id;
      updateConv({
        id: newId,
        messages: [...conv.messages, userMsg, assistantMsg],
        refineFrom: res.images?.[0]?.generation_id || conv.refineFrom,
        references: [],
      });

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

  /* Download */
  const handleDownload = async (img: GeneratedImage) => {
    try {
      const url = api.resolveUrl(img.poster_url);
      const res = await fetch(url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `poster_${img.generation_id}.jpg`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(api.resolveUrl(img.poster_url), "_blank");
    }
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
                                onClick={() => updateConv({ refineFrom: null })}
                                className="px-3 py-1.5 rounded text-xs bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100"
                              >
                                重新生成
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
                    <span className="text-sm text-slate-500">正在生成图片...</span>
                  </div>
                </div>
              )}

              <div ref={messagesEndRef} />
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-600">
              {error}
            </div>
          )}

          {/* Input area */}
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm sticky bottom-4">
            {/* First message: full input; subsequent: compact */}
            {conv.messages.length === 0 && (
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
                placeholder="描述你想生成的图片"
              />
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

              {/* Ratio */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">比例</span>
                <select
                  value={conv.ratio}
                  onChange={(e) => updateConv({ ratio: e.target.value })}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
                >
                  {sizeOptions.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </div>

              {/* Quality */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">质量</span>
                <select
                  value={conv.quality}
                  onChange={(e) => updateConv({ quality: e.target.value as "low" | "medium" | "high" | "auto" })}
                  className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="low">草稿</option>
                  <option value="medium">标准</option>
                  <option value="high">高清</option>
                  <option value="auto">自动</option>
                </select>
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

            {/* Advanced options */}
            <div className="mt-2">
              <button
                type="button"
                onClick={() => setShowAdvanced((v) => !v)}
                className="text-xs text-slate-400 hover:text-slate-600"
              >
                {showAdvanced ? "收起选项 ▲" : "高级选项 ▼"}
              </button>
              {showAdvanced && (
                <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={conv.addStoreInfo}
                      onChange={(e) => updateConv({ addStoreInfo: e.target.checked })}
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>融入门店信息</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={conv.noText}
                      onChange={(e) => updateConv({ noText: e.target.checked })}
                      className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                    />
                    <span>禁止生成文字</span>
                  </label>
                </div>
              )}
            </div>

            {/* Refine hint */}
            {conv.refineFrom && conv.messages.length > 0 && (
              <p className="mt-1 text-xs text-slate-400">当前基于上一张图片调整</p>
            )}
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
