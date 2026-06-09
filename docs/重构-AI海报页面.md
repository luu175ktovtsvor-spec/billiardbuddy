# 重构：AI 海报页面布局

> 目标：三段式布局，删掉场景卡片，修复参考图路径 bug。

---

## 页面结构

```
┌─────────────────────────────────────────────┐
│  顶部：输入区                                 │
│  ┌─────────────────────────────────────┐    │
│  │ [textarea: 描述你想生成的图片]        │    │
│  │ [上传参考图] [比例 ▼] [质量 ▼] [生成] │    │
│  │ [高级选项：融入门店信息 / 禁止文字]   │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  中间：海报展示区                             │
│  ┌─────────────────────────────────────┐    │
│  │                                     │    │
│  │   [生成的海报图片]                   │    │
│  │   [基于此调整] [重新生成] [下载]      │    │
│  │                                     │    │
│  │   [生成的海报图片 2]                 │    │
│  │   [基于此调整] [重新生成] [下载]      │    │
│  │                                     │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  底部：调整输入区（有海报后才显示）            │
│  ┌─────────────────────────────────────┐    │
│  │ [textarea: 描述调整内容]         [➤] │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  历史对话列表                                │
│  ┌─────────────────────────────────────┐    │
│  │ [对话1: 标题...]                     │    │
│  │ [对话2: 标题...]                     │    │
│  └─────────────────────────────────────┘    │
└─────────────────────────────────────────────┘
```

---

## 需要修改的文件

### 1. `web/src/app/dashboard/posters/page.tsx`

**整体改造**：从 entry/conversation 双视图改为单页面三段式。

```tsx
"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import type { SizeOption, GeneratedImage } from "@/types/poster";
import type { StoreResponse } from "@/types/store";
import { ImageIcon, Upload, X, Send, Download, Loader2 } from "lucide-react";
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

  /* Input state */
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("3:4");
  const [quality, setQuality] = useState<"low" | "medium" | "high" | "auto">("auto");
  const [sizeOptions, setSizeOptions] = useState<SizeOption[]>([]);
  const [addStoreInfo, setAddStoreInfo] = useState(false);
  const [noText, setNoText] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

  /* Reference images */
  const [references, setReferences] = useState<Array<{ file: File; path: string; preview: string }>>([]);
  const [referenceUploading, setReferenceUploading] = useState(false);

  /* Generation state */
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState("");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [refineFrom, setRefineFrom] = useState<string | null>(null);

  /* Conversations list */
  const [conversations, setConversations] = useState<ConversationItem[]>([]);

  /* Refs */
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
  }, [messages]);

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

    // Add user message
    const userMsg: ConversationMessage = { role: "user", content: text };
    setMessages((prev) => [...prev, userMsg]);
    setPrompt("");
    setGenerating(true);
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
      if (res.images && res.images.length > 0) {
        setRefineFrom(res.images[0].generation_id);
      }
      references.forEach((r) => URL.revokeObjectURL(r.preview));
      setReferences([]);
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
      a.download = `poster_${img.generation_id}.png`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      window.open(api.resolveUrl(img.poster_url), "_blank");
    }
  };

  /* Load conversation */
  const handleEnterConversation = async (conv: ConversationItem) => {
    setConversationId(conv.id);
    setRefineFrom(null);
    try {
      const detail = await api.getPosterConversationDetail(conv.id);
      const loadedMessages: ConversationMessage[] = [];
      for (const msg of detail.messages) {
        if (msg.prompt) {
          loadedMessages.push({ role: "user", content: msg.prompt });
        }
        loadedMessages.push({
          role: "assistant",
          content: "",
          images: [{ generation_id: msg.generation_id, poster_url: msg.poster_url, created_at: msg.created_at }],
        });
      }
      setMessages(loadedMessages);
    } catch {
      setMessages([]);
    }
    scrollToBottom();
  };

  /* New conversation */
  const handleNewConversation = () => {
    setMessages([]);
    setConversationId(null);
    setRefineFrom(null);
    setPrompt("");
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
    <div className="mx-auto max-w-3xl space-y-6">
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
            {references.map((ref, idx) => (
              <div key={idx} className="relative h-10 w-10 rounded-md border border-slate-200 overflow-hidden">
                <img src={ref.preview} alt={`参考图${idx + 1}`} className="h-full w-full object-cover" />
                <button type="button" onClick={() => removeReference(idx)} className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-red-500 text-white flex items-center justify-center">
                  <X className="h-3 w-3" />
                </button>
              </div>
            ))}
            {references.length < 5 && (
              <label className="flex items-center gap-1.5 cursor-pointer rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-700">
                <Upload className="h-4 w-4" />
                {references.length === 0 ? "上传参考图" : "添加"}
                <input type="file" accept="image/*" multiple className="hidden" onChange={(e) => { if (e.target.files?.length) handleReferenceUpload(e.target.files); }} />
              </label>
            )}
            {referenceUploading && <span className="text-xs text-slate-500">上传中...</span>}
          </div>

          {/* 比例 */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-500">比例</span>
            <select value={ratio} onChange={(e) => setRatio(e.target.value)} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none">
              {sizeOptions.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </select>
          </div>

          {/* 质量 */}
          <div className="flex items-center gap-1.5">
            <span className="text-xs text-slate-500">质量</span>
            <select value={quality} onChange={(e) => setQuality(e.target.value as "low" | "medium" | "high" | "auto")} className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none">
              <option value="low">草稿 (low)</option>
              <option value="medium">标准 (medium)</option>
              <option value="high">高清 (high)</option>
              <option value="auto">自动 (auto)</option>
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

      {/* ─── 错误提示 ─── */}
      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-600">{error}</div>
      )}

      {/* ─── 中间：海报展示区 ─── */}
      {messages.length > 0 && (
        <div className="space-y-4">
          {messages.map((msg, idx) => (
            <div key={idx} className={`rounded-lg border p-4 ${msg.role === "user" ? "bg-indigo-50 border-indigo-200" : "bg-white border-slate-200"}`}>
              {msg.role === "user" ? (
                <p className="text-sm text-indigo-700">{msg.content}</p>
              ) : (
                msg.images && msg.images.length > 0 && (
                  <div className="space-y-3">
                    {msg.images.map((img) => (
                      <div key={img.generation_id}>
                        <img src={api.resolveUrl(img.poster_url)} alt="AI 生成的图片" className="w-full rounded-lg" />
                        <div className="mt-3 flex items-center gap-2">
                          <button type="button" onClick={() => { setRefineFrom(img.generation_id); }} className={`px-3 py-1.5 rounded text-xs ${refineFrom === img.generation_id ? "bg-indigo-100 text-indigo-700 border border-indigo-300" : "bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100"}`}>
                            基于此调整
                          </button>
                          <button type="button" onClick={() => { setRefineFrom(null); }} className="px-3 py-1.5 rounded text-xs bg-slate-50 text-slate-600 border border-slate-200 hover:bg-slate-100">
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
      {messages.length > 0 && (
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
                placeholder={refineFrom ? "描述调整内容，如「背景改成深色」" : "描述新的图片需求"}
              />
            </div>
            <button type="button" disabled={generating || !prompt.trim()} onClick={handleGenerate} className="rounded-xl bg-indigo-600 p-2.5 text-white hover:bg-indigo-500 disabled:opacity-50">
              <Send className="h-4 w-4" />
            </button>
          </div>
          {refineFrom && (
            <p className="mt-1 text-xs text-slate-400">当前基于上一张图片调整</p>
          )}
        </div>
      )}

      {/* ─── 新对话按钮 ─── */}
      {messages.length > 0 && (
        <button type="button" onClick={handleNewConversation} className="text-sm text-indigo-600 hover:text-indigo-700">
          + 开始新对话
        </button>
      )}

      {/* ─── 历史对话列表 ─── */}
      {conversations.length > 0 && messages.length === 0 && (
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <p className="mb-3 text-sm font-medium text-slate-700">最近的对话</p>
          <div className="space-y-3">
            {conversations.slice(0, 5).map((conv) => (
              <div key={conv.id} onClick={() => handleEnterConversation(conv)} className="flex items-center gap-3 rounded-lg border border-slate-100 p-3 hover:border-slate-200 hover:bg-slate-50 cursor-pointer transition-colors">
                {conv.thumbnail_url && (
                  <img src={api.resolveUrl(conv.thumbnail_url)} alt="" className="h-12 w-12 rounded-md object-cover" />
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
  );
}
```

### 2. `server/services/poster_service.py`（修复参考图路径 bug）

**第 137-144 行**，替换为：

```python
    elif reference_image_paths:
        upload_dir = Path(settings.upload_dir)
        for ref_str in reference_image_paths:
            # 前端传的是 /uploads/references/xxx.jpg，去掉 /uploads/ 前缀得到相对路径
            rel = ref_str.removeprefix("/uploads/")
            ref_path = upload_dir / rel
            if not ref_path.resolve().is_relative_to(upload_dir.resolve()):
                raise ValueError("reference_image_path 必须在 uploads/ 目录内")
            if ref_path.exists():
                input_images.append(ref_path.read_bytes())
```

### 3. 删除的文件/代码

- 删除 `server/api/v1/calendar.py` 文件
- `server/api/v1/router.py`：删除 calendar 的 import 和 include_router
- 前端不再调用灵感标签 API（`listInspirationTags`），但后端保留（不删）

---

## 验证

- [ ] 页面三段式布局：顶部输入 → 中间海报 → 底部调整
- [ ] 场景卡片已删除
- [ ] 上传参考图后生成成功（路径 bug 已修复）
- [ ] "基于此调整"按钮高亮显示当前参考图
- [ ] "重新生成"按钮清空参考图
- [ ] 底部输入框有海报后才显示
- [ ] 历史对话列表正常显示
- [ ] 新对话按钮正常工作
- [ ] `pnpm build` 通过
