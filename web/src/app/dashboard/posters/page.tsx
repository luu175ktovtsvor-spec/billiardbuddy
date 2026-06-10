"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import type { SizeOption, GeneratedImage } from "@/types/poster";
import type { StoreResponse } from "@/types/store";
import { ImageIcon, Upload, X, Send, Download, Loader2, Plus, MessageSquare, ZoomIn } from "lucide-react";
import { EmptyStoreGuide } from "@/components/empty-store-guide";

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

interface ConversationState {
  id: string | null;
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
    messages: [],
    refineFrom: null,
    ratio: "3:4",
    quality: "auto",
    references: [],
    addStoreInfo: false,
    noText: false,
  };
}

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

  /* Input state (global) */
  const [prompt, setPrompt] = useState("");
  const [sizeOptions, setSizeOptions] = useState<SizeOption[]>([]);
  const [showAdvanced, setShowAdvanced] = useState(false);

  /* Conversations management */
  const [conversationsMap, setConversationsMap] = useState<Map<string, ConversationState>>(new Map());
  const [currentId, setCurrentId] = useState<string>("new");
  const [conversations, setConversations] = useState<ConversationItem[]>([]);

  /* Generation state (global) */
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");

  /* Lightbox */
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  /* Refs */
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  /* Current conversation shortcut */
  const current = conversationsMap.get(currentId) || createNewConversation();
  const updateCurrent = (patch: Partial<ConversationState>) => {
    setConversationsMap(prev => {
      const next = new Map(prev);
      next.set(currentId, { ...current, ...patch });
      return next;
    });
  };

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

  /* Pre-fill from URL */
  useEffect(() => {
    const urlPrompt = searchParams.get("prompt");
    if (urlPrompt) setPrompt(urlPrompt);
  }, [searchParams]);

  /* Load size options and conversations */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    Promise.all([
      api.listSizeOptions().catch(() => ({ sizes: [] })),
      api.listPosterConversations().catch(() => ({ conversations: [] })),
    ]).then(([sizesData, convsData]) => {
      if (cancelled) return;
      setSizeOptions(sizesData.sizes || []);
      setConversations(convsData.conversations || []);
    });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  /* Auto scroll */
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [current.messages]);

  const scrollToBottom = useCallback(() => {
    setTimeout(() => messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }), 100);
  }, []);

  /* Reference upload */
  const handleReferenceUpload = async (files: FileList | File[]) => {
    const fileArray = Array.from(files);
    if (current.references.length + fileArray.length > 5) {
      setError("最多上传 5 张参考图");
      return;
    }
    try {
      const newRefs = [...current.references];
      for (const file of fileArray) {
        const res = await api.uploadReferenceImage(file);
        newRefs.push({ file, path: res.path, preview: URL.createObjectURL(file) });
      }
      updateCurrent({ references: newRefs });
    } catch {
      setError("参考图上传失败");
    }
  };

  const removeReference = (index: number) => {
    const removed = current.references[index];
    if (removed) URL.revokeObjectURL(removed.preview);
    updateCurrent({ references: current.references.filter((_, i) => i !== index) });
  };

  /* Generate */
  const handleGenerate = async () => {
    const text = prompt.trim();
    if (!text || generating) return;
    setError("");

    // abort old request
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // Add user message
    updateCurrent({ messages: [...current.messages, { role: "user", content: text }] });
    setPrompt("");
    setGenerating(true);
    scrollToBottom();

    try {
      const res = await api.generateImage({
        prompt: text,
        image_model: "gpt-image-2",
        ratio: current.ratio,
        quality: current.quality,
        images: current.references.length > 0 ? current.references.map(r => r.path) : undefined,
        count: 1,
        refine_from: current.refineFrom || undefined,
        add_store_info: current.addStoreInfo,
        no_text: current.noText,
        conversation_id: current.id || undefined,
      }, controller.signal);

      const assistantMsg: ConversationMessage = { role: "assistant", content: "", images: res.images };
      updateCurrent({
        id: res.conversation_id || current.id,
        messages: [...current.messages, { role: "user", content: text }, assistantMsg],
        refineFrom: res.images?.[0]?.generation_id || current.refineFrom,
        references: [],  // 清空参考图
      });

      // Refresh conversations list
      api.listPosterConversations().then(data => setConversations(data.conversations || [])).catch(() => {});
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

  /* New conversation */
  const handleNewConversation = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    const newId = `new_${Date.now()}`;
    setConversationsMap(prev => {
      const next = new Map(prev);
      next.set(newId, createNewConversation());
      return next;
    });
    setCurrentId(newId);
    setGenerating(false);
    setPrompt("");
  };

  /* Switch to history conversation */
  const handleSwitchConversation = async (conv: ConversationItem) => {
    // If it's already loaded, just switch
    if (conversationsMap.has(conv.id)) {
      setCurrentId(conv.id);
      return;
    }

    try {
      const detail = await api.getPosterConversationDetail(conv.id);
      const lastMsg = detail.messages[detail.messages.length - 1];

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

      setConversationsMap(prev => {
        const next = new Map(prev);
        next.set(conv.id, {
          id: conv.id,
          messages,
          refineFrom: lastMsg?.generation_id || null,
          ratio: "3:4",
          quality: "auto",
          references: [],
          addStoreInfo: false,
          noText: false,
        });
        return next;
      });
      setCurrentId(conv.id);
    } catch {
      // If loading fails, just create empty
      handleNewConversation();
    }
  };

  /* Loading states */
  if (authLoading || storeLoading) {
    return <div className="flex items-center justify-center py-20"><p className="text-slate-500">加载中...</p></div>;
  }
  if (!isAuthenticated) return null;
  if (store === null) {
    return <EmptyStoreGuide description="请先完善门店资料，然后再开始生成图片。" />;
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex gap-6">
        {/* ─── 左侧：主区域 ─── */}
        <div className="flex-1 min-w-0 space-y-4">
          {/* ─── 顶部：输入区 ─── */}
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
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

            <div className="mt-3 flex flex-wrap items-center gap-3">
              {/* 参考图 */}
              <div className="flex items-center gap-2 flex-wrap">
                {current.references.map((ref, idx) => (
                  <div key={idx} className="relative h-10 w-10 rounded-md border border-slate-200 overflow-hidden">
                    <img src={ref.preview} alt={`参考图${idx + 1}`} className="h-full w-full object-cover" />
                    <button type="button" onClick={() => removeReference(idx)} className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 text-white flex items-center justify-center">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
                {current.references.length < 5 && (
                  <label className="flex items-center gap-1.5 cursor-pointer rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-700">
                    <Upload className="h-4 w-4" />
                    {current.references.length === 0 ? "上传参考图" : "添加"}
                    <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) handleReferenceUpload(e.target.files); }} />
                  </label>
                )}
              </div>

              {/* 比例 */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">比例</span>
                <select value={current.ratio} onChange={(e) => updateCurrent({ ratio: e.target.value })} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none">
                  {sizeOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
              </div>

              {/* 质量 */}
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-slate-500">质量</span>
                <select value={current.quality} onChange={(e) => updateCurrent({ quality: e.target.value as "low" | "medium" | "high" | "auto" })} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none">
                  <option value="low">草稿</option>
                  <option value="medium">标准</option>
                  <option value="high">高清</option>
                  <option value="auto">自动</option>
                </select>
              </div>

              {/* 生成按钮 */}
              <button type="button" disabled={generating || !prompt.trim()} onClick={handleGenerate} className="ml-auto flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed">
                {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImageIcon className="h-4 w-4" />}
                生成
              </button>
            </div>

            {/* 高级选项 */}
            <div className="mt-2">
              <button type="button" onClick={() => setShowAdvanced((v) => !v)} className="text-xs text-slate-400 hover:text-slate-600">
                {showAdvanced ? "收起选项 ▲" : "高级选项 ▼"}
              </button>
              {showAdvanced && (
                <div className="mt-2 flex flex-wrap items-center gap-4 text-xs text-slate-500">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={current.addStoreInfo} onChange={(e) => updateCurrent({ addStoreInfo: e.target.checked })} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                    <span>融入门店信息</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input type="checkbox" checked={current.noText} onChange={(e) => updateCurrent({ noText: e.target.checked })} className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                    <span>禁止生成文字</span>
                  </label>
                </div>
              )}
            </div>
          </div>

          {/* ─── 错误提示 ─── */}
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-600">{error}</div>
          )}

          {/* ─── 中间：海报展示区 ─── */}
          {current.messages.length > 0 && (
            <div className="space-y-4">
              {current.messages.map((msg, idx) => (
                <div key={idx} className={`rounded-lg border p-4 ${msg.role === "user" ? "bg-indigo-50 border-indigo-200" : "bg-white border-slate-200"}`}>
                  {msg.role === "user" ? (
                    <p className="text-sm text-indigo-700">{msg.content}</p>
                  ) : (
                    msg.images && msg.images.length > 0 && (
                      <div className="space-y-3">
                        {msg.images.map((img) => (
                          <div key={img.generation_id}>
                            <img src={api.resolveUrl(img.poster_url)} alt="AI 生成的图片" className="w-full rounded-lg cursor-pointer hover:opacity-90 transition-opacity" onClick={() => setLightboxImage(api.resolveUrl(img.poster_url))} />
                            <div className="mt-3 flex items-center gap-2">
                              <button type="button" onClick={() => updateCurrent({ refineFrom: img.generation_id })} className={`px-3 py-1.5 rounded text-xs ${current.refineFrom === img.generation_id ? "bg-indigo-100 text-indigo-700 border border-indigo-300" : "bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100"}`}>
                                基于此调整
                              </button>
                              <button type="button" onClick={() => updateCurrent({ refineFrom: null })} className="px-3 py-1.5 rounded text-xs bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100">
                                重新生成
                              </button>
                              <button type="button" onClick={() => handleDownload(img)} className="px-3 py-1.5 rounded text-xs bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100">
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

              {/* 生成中指示器 */}
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

          {/* ─── 底部：调整输入区（有海报后才显示）─── */}
          {current.messages.length > 0 && (
            <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
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
                    placeholder={current.refineFrom ? "描述调整内容，如「背景改成深色」" : "描述新的图片需求"}
                  />
                </div>
                <button type="button" disabled={generating || !prompt.trim()} onClick={handleGenerate} className="rounded-xl bg-indigo-600 p-2.5 text-white hover:bg-indigo-500 disabled:opacity-50">
                  <Send className="h-4 w-4" />
                </button>
              </div>
              {current.refineFrom && (
                <p className="mt-1 text-xs text-slate-400">当前基于上一张图片调整</p>
              )}
            </div>
          )}
        </div>

        {/* ─── 右侧：对话列表 ─── */}
        <div className="w-64 shrink-0 hidden lg:block">
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm sticky top-4">
            <div className="border-b border-slate-100 p-3">
              <button
                type="button"
                onClick={handleNewConversation}
                className="w-full flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
              >
                <Plus className="h-4 w-4" />
                新对话
              </button>
            </div>
            <div className="max-h-[calc(100vh-200px)] overflow-y-auto">
              {conversations.length === 0 ? (
                <div className="p-4 text-center text-sm text-slate-400">
                  暂无对话记录
                </div>
              ) : (
                <div className="divide-y divide-slate-100">
                  {conversations.map((conv) => (
                    <div
                      key={conv.id}
                      className={`relative group p-3 hover:bg-slate-50 transition-colors ${currentId === conv.id ? "bg-indigo-50" : ""}`}
                    >
                      <button
                        type="button"
                        onClick={() => handleSwitchConversation(conv)}
                        className="w-full text-left"
                      >
                        <div className="flex items-start gap-2">
                          {conv.thumbnail_url ? (
                            <img src={api.resolveUrl(conv.thumbnail_url)} alt="" className="h-10 w-10 rounded object-cover shrink-0" />
                          ) : (
                            <div className="h-10 w-10 rounded bg-slate-100 flex items-center justify-center shrink-0">
                              <MessageSquare className="h-4 w-4 text-slate-400" />
                            </div>
                          )}
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-slate-700 truncate">{conv.title}</p>
                            <p className="text-xs text-slate-400">
                              {conv.message_count} 轮 · {new Date(conv.updated_at).toLocaleDateString("zh-CN")}
                            </p>
                          </div>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={async (e) => {
                          e.stopPropagation();
                          if (!confirm("确定删除这个对话？")) return;
                          try {
                            await api.deletePosterConversation(conv.id);
                            setConversations(prev => prev.filter(c => c.id !== conv.id));
                          } catch {
                            // 静默处理
                          }
                        }}
                        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 text-xs text-slate-400 hover:text-red-600 transition-opacity"
                      >
                        删除
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
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
