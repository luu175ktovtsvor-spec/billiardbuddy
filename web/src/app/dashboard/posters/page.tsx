"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import type { ImageModel, InspirationTag, SizeOption, GeneratedImage, ImageGenerateResponse } from "@/types/poster";
import type { StoreResponse } from "@/types/store";
import { ImageIcon, Upload, RefreshCw, Download, X, MessageSquare, Loader2 } from "lucide-react";
import { EmptyStoreGuide } from "@/components/empty-store-guide";
import Link from "next/link";

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

  /* Form */
  const [prompt, setPrompt] = useState("");
  const [ratio, setRatio] = useState("3:4");
  const [imageModel, setImageModel] = useState("");

  /* Reference images */
  const [references, setReferences] = useState<Array<{ file: File; path: string; preview: string }>>([]);
  const [referenceUploading, setReferenceUploading] = useState(false);

  /* Logo upload */
  const [logoUploading, setLogoUploading] = useState(false);

  /* Data from API */
  const [imageModels, setImageModels] = useState<ImageModel[]>([]);
  const [inspirationTags, setInspirationTags] = useState<InspirationTag[]>([]);
  const [sizeOptions, setSizeOptions] = useState<SizeOption[]>([]);
  const [dataLoading, setDataLoading] = useState(true);

  /* Generation */
  const [generating, setGenerating] = useState(false);
  const [results, setResults] = useState<GeneratedImage[]>([]);
  const [error, setError] = useState("");
  const [refineFrom, setRefineFrom] = useState<string | null>(null);

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

  /* Pre-fill prompt from URL params (e.g. from workbench page) */
  useEffect(() => {
    const urlPrompt = searchParams.get("prompt");
    if (urlPrompt) setPrompt(urlPrompt);
  }, [searchParams]);

  /* Load image models, tags, sizes */
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setDataLoading(true);
    Promise.all([
      api.listImageModels().catch(() => ({ models: [] })),
      api.listInspirationTags().catch(() => ({ tags: [] })),
      api.listSizeOptions().catch(() => ({ sizes: [] })),
    ]).then(([modelsData, tagsData, sizesData]) => {
      if (cancelled) return;
      setImageModels(modelsData.models || []);
      setInspirationTags(tagsData.tags || []);
      setSizeOptions(sizesData.sizes || []);
      if (modelsData.models?.length > 0 && !imageModel) {
        setImageModel(modelsData.models[0].id);
      }
    }).finally(() => { if (!cancelled) setDataLoading(false); });
    return () => { cancelled = true; };
  }, [isAuthenticated, imageModel]);

  /* Handle reference image upload */
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

  /* Handle tag click */
  const handleTagClick = (tag: InspirationTag) => {
    setPrompt(tag.prompt);
  };

  /* Logo upload */
  const handleLogoUpload = async (file: File) => {
    setLogoUploading(true);
    try {
      const res = await api.uploadLogo(file);
      // 更新 store 状态
      if (store) {
        setStore({ ...store, logo_url: res.url });
      }
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLogoUploading(false);
    }
  };

  /* Generate */
  const handleGenerate = async () => {
    if (!prompt.trim()) return;
    setError("");
    setResults([]);
    setGenerating(true);

    try {
      const res: ImageGenerateResponse = await api.generateImage({
        prompt: prompt.trim(),
        image_model: imageModel,
        ratio,
        reference_image_paths: references.length > 0 ? references.map((r) => r.path) : undefined,
        count: 2,
        refine_from: refineFrom || undefined,
      });
      setResults(res.images);
      setRefineFrom(null); // 清除调整状态
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setGenerating(false);
    }
  };

  /* Download all images via fetch+blob (works for cross-origin OSS images) */
  const handleDownloadAll = async () => {
    for (const img of results) {
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
        // Fallback: open in new tab
        window.open(api.resolveUrl(img.poster_url), "_blank");
      }
    }
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
    return <EmptyStoreGuide description="请先完善门店资料，Logo 和二维码会自动叠加到生成的图片上。" />;
  }

  /* Group models by provider */
  const aliyunModels = imageModels.filter((m) => m.provider === "aliyun");
  const openaiModels = imageModels.filter((m) => m.provider === "openai");

  /* ─── Main content ─── */
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
              {references.length > 0 && (
                <span className="text-xs text-slate-400">{references.length}/5</span>
              )}
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

            {/* Model selector */}
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-slate-500">模型</span>
              <select
                value={imageModel}
                onChange={(e) => setImageModel(e.target.value)}
                className="rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-sm text-slate-900 focus:border-indigo-500 focus:outline-none"
              >
                {aliyunModels.length > 0 && (
                  <optgroup label="阿里云百炼">
                    {aliyunModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.name} — {m.desc}</option>
                    ))}
                  </optgroup>
                )}
                {openaiModels.length > 0 && (
                  <optgroup label="OpenAI">
                    {openaiModels.map((m) => (
                      <option key={m.id} value={m.id}>{m.name} — {m.desc}</option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            {/* Model recommendation hint */}
            {imageModels.find((m) => m.id === imageModel)?.best_for && (
              <div className="text-xs text-indigo-600 bg-indigo-50 rounded-md px-2 py-1">
                推荐：{imageModels.find((m) => m.id === imageModel)?.best_for}
              </div>
            )}

            {/* Generate button */}
            <button
              type="button"
              disabled={generating || !prompt.trim()}
              onClick={handleGenerate}
              className="ml-auto flex items-center gap-2 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {generating ? (
                <>
                  <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  生成中...
                </>
              ) : (
                <>
                  <ImageIcon className="h-4 w-4" />
                  生成
                </>
              )}
            </button>
          </div>

          {/* Store info hint */}
          <div className="mt-3 flex items-center gap-2 text-xs text-slate-500">
            <span>门店信息自动叠加：</span>
            {store?.logo_url ? (
              <span className="text-emerald-600">Logo ✓</span>
            ) : (
              <label className="flex items-center gap-1 cursor-pointer text-red-600 hover:text-red-700">
                <span>Logo 未设置</span>
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleLogoUpload(f);
                  }}
                />
                <span className="underline">上传</span>
              </label>
            )}
            {store?.qrcode_url ? <span className="text-emerald-600">二维码 ✓</span> : <span className="text-red-600">二维码 未设置</span>}
            {logoUploading && <span className="text-indigo-600">上传中...</span>}
          </div>
          {/* Refine mode indicator */}
          {refineFrom && (
            <div className="mt-2 flex items-center gap-2 rounded-md bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
              <span>正在基于已生成图片调整</span>
              <button
                type="button"
                onClick={() => setRefineFrom(null)}
                className="ml-auto text-indigo-500 hover:text-indigo-700"
              >
                取消调整
              </button>
            </div>
          )}
        </div>

        {/* ─── Inspiration tags ─── */}
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <p className="mb-2 text-sm font-medium text-slate-700">试试这些</p>
          <div className="flex flex-wrap gap-2">
            {inspirationTags.map((tag) => (
              <button
                key={tag.key}
                type="button"
                onClick={() => handleTagClick(tag)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-500 hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-600 transition-colors"
              >
                {tag.label}
              </button>
            ))}
          </div>
        </div>

        {/* ─── Error ─── */}
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-4">
            <p className="text-sm text-red-600">{error}</p>
          </div>
        )}

        {/* ─── Generating state ─── */}
        {generating && results.length === 0 && (
          <div className="flex items-center justify-center rounded-lg border border-slate-200 bg-white py-16 shadow-sm">
            <div className="text-center">
              <svg className="mx-auto mb-3 h-8 w-8 animate-spin text-indigo-600" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <p className="text-sm text-slate-500">AI 正在生成图片...</p>
            </div>
          </div>
        )}

        {/* ─── Results ─── */}
        {results.length > 0 && !generating && (
          <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
            <div className="border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-700">生成结果</h3>
            </div>

            <div className="flex gap-4 p-4 justify-center">
              {results.map((img) => (
                <div key={img.generation_id} className="flex-1 max-w-sm">
                  <div className="overflow-hidden rounded-md bg-white">
                    <img
                      src={api.resolveUrl(img.poster_url)}
                      alt="AI 生成的图片"
                      className="w-full object-contain"
                    />
                  </div>
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-xs text-slate-400">
                      {new Date(img.created_at).toLocaleString("zh-CN")}
                    </span>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => {
                          setRefineFrom(img.generation_id);
                          setPrompt("");
                          setError("");
                          // 滚动到输入区
                          document.querySelector("textarea")?.focus();
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-indigo-200 bg-indigo-50 px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-100"
                      >
                        基于此调整
                      </button>
                      <a
                        href={api.resolveUrl(img.poster_url)}
                        download
                        className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                      >
                        <Download className="h-3 w-3" />
                        下载
                      </a>
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-slate-100 px-4 py-3">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleGenerate}
                  className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-50 hover:text-slate-700"
                >
                  <RefreshCw className="h-4 w-4" />
                  重新生成
                </button>
                <Link
                  href={`/dashboard/workbench?intent=${encodeURIComponent("为刚生成的海报配一段朋友圈文案")}&extra_note=${encodeURIComponent(`海报描述：${prompt}`)}`}
                  className="inline-flex items-center gap-1.5 rounded-md border border-indigo-200 bg-indigo-50 px-3 py-1.5 text-sm text-indigo-600 hover:bg-indigo-100"
                >
                  <MessageSquare className="h-4 w-4" />
                  生成配套文案
                </Link>
              </div>
              <button
                type="button"
                onClick={handleDownloadAll}
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500"
              >
                <Download className="h-4 w-4" />
                下载全部
              </button>
            </div>
          </div>
        )}

        {/* ─── Empty state ─── */}
        {results.length === 0 && !generating && !error && (
          <div className="flex items-center justify-center rounded-lg border border-dashed border-slate-200 bg-white py-16">
            <p className="text-sm text-slate-500">输入描述后点击生成</p>
          </div>
        )}
      </div>
    </div>
  );
}
