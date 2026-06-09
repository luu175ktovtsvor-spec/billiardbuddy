"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import type { InspirationTag, SizeOption, GeneratedImage } from "@/types/poster";
import type { StoreResponse } from "@/types/store";
import { ImageIcon, Upload, X, ArrowLeft, Send, Download, Loader2 } from "lucide-react";
import { EmptyStoreGuide } from "@/components/empty-store-guide";

/* ─── Types ─── */
interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  images?: GeneratedImage[];
}

interface ConversationItem {
  id: string;
  title: string;
  message_count: number;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
}

/* ─── Main page ─── */
export default function PostersPageWrapper() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>}>
      <PostersPage />
    </Suspense>
  );
}

function PostersPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const searchParams = useSearchParams();

  /* Store */
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [storeLoading, setStoreLoading] = useState(true);

  /* View mode */
  const [viewMode, setViewMode] = useState<"entry" | "conversation">("entry");

  /* Entry page */
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("3:4");
  const [quality, setQuality] = useState<"low" | "medium" | "high" | "auto">("auto");
  const [inspirationTags, setInspirationTags] = useState<InspirationTag[]>([]);
  const [sizeOptions, setSizeOptions] = useState<SizeOption[]>([]);
  const [conversations, setConversations] = useState<ConversationItem[]>([]);

  /* Reference images */
  const [references, setReferences] = useState<Array<{ file: File; path: string; preview: string }>>([]);
  const [referenceUploading, setReferenceUploading] = useState(false);

  /* Generation options */
  const [addStoreInfo, setAddStoreInfo] = useState(false);
  const [noText, setNoText] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  /* Conversation */
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [refineFrom, setRefineFrom] = useState<string | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

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

  /* Pre-fill prompt from URL params */
  useEffect(() => {
    const urlPrompt = searchParams.get("prompt");
    if (urlPrompt) {
      setPrompt(urlPrompt);
      setViewMode("conversation");
    }
  }, [searchParams]);

  /* Load tags, sizes, conversations */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    Promise.all([
      api.listInspirationTags().catch(() => ({ tags: [] })),
      api.listSizeOptions().catch(() => ({ sizes: [] })),
      api.listPosterConversations().catch(() => ({ conversations: [] })),
    ]).then(([tagsData, sizesData, convsData]) => {
      if (cancelled) return;
      setInspirationTags(tagsData.tags || []);
      setSizeOptions(sizesData.sizes || []);
      setConversations(convsData.conversations || []);
    });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  /* Auto scroll to bottom */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /* Scroll to bottom helper */
  const scrollToBottom = useCallback(() => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }, []);

  /* Reference upload */
  const handleReferenceUpload = async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (references.length + fileArray.length > 5) {
      setError("最多上传 5 张参考图");
      return;
    }
    setReferenceUploading(true);
    try {
      for (const file of fileArray) {
        const res = await api.uploadReferenceImage(file);
        setReferences((prev) => [...prev, { file, path: res.path, preview: URL.createObjectURL(file) }]);
      }
    } catch {
      setError("参考图上传失败");
    } finally {
      setReferenceUploading(false);
    }
  };

  const removeReference = (index: number) => {
    setReferences((prev) => {
      const removed = prev[index];
      if (removed) URL.revokeObjectURL(removed.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  /* Generate / send message */
  const handleGenerate = async (messagePrompt?: string) => {
    const text = (messagePrompt || prompt).trim();
    if (!text || generating) return;
    setError("");

    // Cancel any ongoing request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Add user message
    const userMsg: ConversationMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setPrompt("");
    setGenerating(true);

    // Switch to conversation view if in entry mode
    if (viewMode === "entry") {
      setViewMode("conversation");
    }

    scrollToBottom();

    try {
      const res = await api.generateImage({
        prompt: text,
        image_model: "gpt-image-2",
        ratio,
        quality,
        images: references.length > 0 ? references.map((r) => r.path) : undefined,
        count: 1,
        refine_from: refineFrom || undefined,
        add_store_info: addStoreInfo,
        no_text: noText,
        conversation_id: conversationId || undefined,
      }, controller.signal);

      const assistantMsg: ConversationMessage = { role: "assistant", content: "", images: res.images };
      setMessages((prev) => [...prev, assistantMsg]);
      setConversationId(res.conversation_id || null);
      // 将 refineFrom 设为最新生成的图片，支持连续调整
      if (res.images && res.images.length > 0) {
        setRefineFrom(res.images[0].generation_id);
      }
      // 清空参考图，防止跨轮次残留
      references.forEach((r) => URL.revokeObjectURL(r.preview));
      setReferences([]);
    } catch (err) {
      // Ignore abort errors (user clicked generate again)
      if (err instanceof DOMException && err.name === "AbortError") {
        return;
      }
      setError(getErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  };

  /* Handle tag click */
  const handleTagClick = (tag: InspirationTag) => {
    setPrompt(tag.prompt);
    setViewMode("conversation");
    scrollToBottom();
  };

  /* Download image */
  const handleDownload = async (img: GeneratedImage) => {
    try {
      const url = api.resolveUrl(img.poster_url);
      const res = await fetch(url);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `poster_${img.generation_id}.png`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(api.resolveUrl(img.poster_url), "_blank");
    }
  };

  /* Enter conversation from history */
  const handleEnterConversation = async (conv: ConversationItem) => {
    setConversationId(conv.id);
    setViewMode("conversation");
    setRefineFrom(null);

    try {
      const detail = await api.getPosterConversationDetail(conv.id);
      // Reconstruct messages from history
      const loadedMessages: ConversationMessage[] = [];
      for (const msg of detail.messages) {
        // User message (the prompt that generated this image)
        if (msg.prompt) {
          loadedMessages.push({ role: "user", content: msg.prompt });
        }
        // Assistant message (the generated image)
        loadedMessages.push({
          role: "assistant",
          content: "",
          images: [{ generation_id: msg.generation_id, poster_url: msg.poster_url, created_at: msg.created_at }],
        });
      }
      setMessages(loadedMessages);
    } catch {
      // If loading fails, start with empty conversation
      setMessages([]);
    }

    scrollToBottom();
  };

  /* Back to entry */
  const handleBackToEntry = () => {
    setViewMode("entry");
    setConversationId(null);
    setRefineFrom(null);
    setMessages([]);
    // Reload conversations
    api.listPosterConversations().then((data) => {
      setConversations(data.conversations || []);
    }).catch(() => {});
  };

  /* ─── Loading states ─── */
  if (authLoading || storeLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-slate-500">加载中...</p>
      </div>
    );
  }

  if (!isAuthenticated) return null;

  if (store === null) {
    return <EmptyStoreGuide description="请先完善门店资料，然后再开始生成图片。" />;
  }

  /* ─── Conversation View ─── */
  if (viewMode === "conversation") {
    return (
      <div className="mx-auto flex h-[calc(100vh-8rem)] max-w-3xl flex-col">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-slate-200 px-4 py-3">
          <button
            type="button"
            onClick={handleBackToEntry}
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h2 className="text-sm font-semibold text-slate-900">AI 生图对话</h2>
            {conversationId && (
              <p className="text-xs text-slate-400">对话进行中</p>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4">
          {messages.length === 0 && (
            <div className="flex h-full items-center justify-center">
              <p className="text-sm text-slate-400">描述你想要的海报，AI 会帮你生成</p>
            </div>
          )}

          {messages.map((msg, idx) => (
            <div key={idx} className={`mb-4 flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
              <div className={`max-w-[85%] rounded-2xl px-4 py-3 ${
                msg.role === "user"
                  ? "bg-indigo-600 text-white"
                  : "bg-slate-100 text-slate-900"
              }`}>
                {msg.content && (
                  <p className="text-sm whitespace-pre-wrap">{msg.content}</p>
                )}
                {msg.images && msg.images.length > 0 && (
                  <div className="mt-2 space-y-3">
                    {msg.images.map((img) => (
                      <div key={img.generation_id}>
                        <img
                          src={api.resolveUrl(img.poster_url)}
                          alt="AI 生成的图片"
                          className="w-full rounded-lg"
                        />
                        <div className="mt-2 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setRefineFrom(img.generation_id);
                              setPrompt("");
                              scrollToBottom();
                              document.querySelector("textarea")?.focus();
                            }}
                            className="inline-flex items-center gap-1 rounded-md bg-white/20 px-2 py-1 text-xs text-indigo-100 hover:bg-white/30"
                          >
                            基于此调整
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setRefineFrom(null);
                              setPrompt("");
                              scrollToBottom();
                              document.querySelector("textarea")?.focus();
                            }}
                            className="inline-flex items-center gap-1 rounded-md bg-white/20 px-2 py-1 text-xs text-indigo-100 hover:bg-white/30"
                          >
                            重新生成
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDownload(img)}
                            className="inline-flex items-center gap-1 rounded-md bg-white/20 px-2 py-1 text-xs text-indigo-100 hover:bg-white/30"
                          >
                            <Download className="h-3 w-3" />
                            下载
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}

          {/* Generating indicator */}
          {generating && (
            <div className="mb-4 flex justify-start">
              <div className="rounded-2xl bg-slate-100 px-4 py-3">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin text-indigo-600" />
                  <span className="text-sm text-slate-500">正在生成图片...</span>
                </div>
              </div>
            </div>
          )}

          {error && (
            <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-600">
              {error}
            </div>
          )}

          <div ref={messagesEndRef} />
        </div>

        {/* Input bar */}
        <div className="border-t border-slate-200 bg-white px-4 py-3">
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
                placeholder="描述调整内容，如「背景改成深色」"
              />
            </div>
            <button
              type="button"
              disabled={generating || !prompt.trim()}
              onClick={() => handleGenerate()}
              className="rounded-xl bg-indigo-600 p-2.5 text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              <Send className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  /* ─── Entry View ─── */
  return (
    <div className="mx-auto max-w-4xl">
      {/* Page header */}
      <div className="mb-6 flex items-center gap-2">
        <ImageIcon className="h-5 w-5 text-indigo-600" />
        <h2 className="text-xl font-bold text-slate-900">AI 生图</h2>
      </div>

      <div className="space-y-6">
        {/* ─── Input area ─── */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <textarea
            rows={4}
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

          {/* Controls row */}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {/* Reference images */}
            <div className="flex items-center gap-2 flex-wrap">
              {references.map((ref, idx) => (
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
              {references.length < 5 && (
                <label className="flex items-center gap-1.5 cursor-pointer rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-700">
                  <Upload className="h-4 w-4" />
                  {references.length === 0 ? "上传参考图" : "添加"}
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
              {referenceUploading && <span className="text-xs text-slate-500">上传中...</span>}
            </div>

            {/* Ratio selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">比例</span>
              <select
                value={ratio}
                onChange={(e) => setRatio(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
              >
                {sizeOptions.map((s) => (
                  <option key={s.value} value={s.value}>{s.label}</option>
                ))}
              </select>
            </div>

            {/* Quality selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">质量</span>
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value as "low" | "medium" | "high" | "auto")}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
              >
                <option value="low">草稿 (low)</option>
                <option value="medium">标准 (medium)</option>
                <option value="high">高清 (high)</option>
                <option value="auto">自动 (auto)</option>
              </select>
            </div>

            {/* Generate button */}
            <button
              type="button"
              disabled={generating || !prompt.trim()}
              onClick={() => handleGenerate()}
              className="ml-auto flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <ImageIcon className="h-4 w-4" />
              生成
            </button>
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
                  <input type="checkbox" checked={addStoreInfo} onChange={(e) => setAddStoreInfo(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                  <span>融入门店信息</span>
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={noText} onChange={(e) => setNoText(e.target.checked)} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                  <span>禁止生成文字</span>
                </label>
              </div>
            )}
          </div>
        </div>

        {/* ─── Scene cards ─── */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <p className="mb-3 text-sm font-medium text-slate-700">选一个场景开始</p>
          {(() => {
            // 按分类分组
            const categories: Record<string, typeof inspirationTags> = {};
            inspirationTags.forEach((tag) => {
              const cat = tag.category || "其他";
              if (!categories[cat]) categories[cat] = [];
              categories[cat].push(tag);
            });
            return Object.entries(categories).map(([cat, tags]) => (
              <div key={cat} className="mb-3 last:mb-0">
                <p className="mb-2 text-xs font-medium text-slate-400">{cat}</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {tags.map((tag) => (
                    <button
                      key={tag.key}
                      type="button"
                      onClick={() => handleTagClick(tag)}
                      className="flex flex-col items-start rounded-lg border border-slate-200 p-3 text-left hover:border-indigo-300 hover:bg-indigo-50/50 transition-all"
                    >
                      <span className="text-sm font-medium text-slate-700">{tag.label}</span>
                      <span className="mt-0.5 text-xs text-slate-400 line-clamp-2">{tag.prompt.substring(0, 30)}...</span>
                    </button>
                  ))}
                </div>
              </div>
            ));
          })()}
        </div>

        {/* ─── Error ─── */}
        {error && (
          <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-600">
            {error}
          </div>
        )}

        {/* ─── Recent conversations ─── */}
        {conversations.length > 0 && (
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <p className="mb-3 text-sm font-medium text-slate-700">最近的对话</p>
            <div className="space-y-3">
              {conversations.slice(0, 5).map((conv) => (
                <div
                  key={conv.id}
                  onClick={() => handleEnterConversation(conv)}
                  className="flex items-center gap-3 rounded-lg border border-slate-100 p-3 hover:border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors"
                >
                  {conv.thumbnail_url && (
                    <img
                      src={api.resolveUrl(conv.thumbnail_url)}
                      alt=""
                      className="h-12 w-12 rounded-md object-cover"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <p className="truncate text-sm font-medium text-slate-700">{conv.title}</p>
                    <p className="text-xs text-slate-400">
                      {conv.message_count} 轮 · {new Date(conv.updated_at).toLocaleDateString("zh-CN")}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
