"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Star, ChevronLeft, MessageSquare, Download } from "lucide-react";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import type { GenerationHistoryItem } from "@/types/generation-history";
import { CopyButton } from "@/components/generators/copy-button";
import { typeLabel, subTypeLabel, continueHref } from "@/lib/history-labels";
import { downloadImage, safeFileName } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";

const REPURPOSE_PLATFORMS = [
  { platform: "douyin", label: "抖音文案" },
  { platform: "xiaohongshu", label: "小红书" },
  { platform: "group_notice", label: "群公告" },
  { platform: "wechat_moments", label: "朋友圈" },
];

export default function HistoryDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();
  const id = params.id as string;

  const [item, setItem] = useState<GenerationHistoryItem | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [repurposing, setRepurposing] = useState<string | null>(null);
  const [repurposeResult, setRepurposeResult] = useState<{ label: string; content: string } | null>(null);

  const fetchDetail = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.getGeneration(id);
      setItem(res);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        setError("这条记录不存在或已删除");
      } else {
        setError("加载失败，请重试");
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchDetail();
  }, [fetchDetail]);

  const handleToggleFavorite = async () => {
    if (!item) return;
    try {
      const res = await api.toggleFavorite(item.id);
      setItem({ ...item, is_favorite: res.is_favorite });
    } catch {
      // silent
    }
  };

  const handleFeedback = async (rating: "good" | "bad") => {
    if (!item) return;
    try {
      await api.submitFeedback(item.id, rating);
      setItem({ ...item, effect_rating: rating });
      toast(rating === "good" ? "已记录，之后会多写这种" : "已记录，之后会避开这种", "success");
    } catch {
      // silent
    }
  };

  const handleRepurpose = async (platform: string, label: string) => {
    if (!item) return;
    setRepurposing(platform);
    setRepurposeResult(null);
    try {
      const res = await api.repurposeContent(item.id, platform);
      setRepurposeResult({ label, content: res.content });
    } catch (err) {
      toast(err instanceof ApiError ? err.detail : "转换失败，请重试", "error");
    } finally {
      setRepurposing(null);
    }
  };

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 text-center text-sm text-slate-400">加载中…</div>
    );
  }

  if (error || !item) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10 text-center">
        <p className="mb-4 text-sm text-slate-500">{error || "记录不存在"}</p>
        <button
          type="button"
          onClick={() => router.push("/dashboard/history")}
          className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-4 py-2 text-sm text-slate-600 hover:bg-slate-50"
        >
          <ChevronLeft className="h-4 w-4" />
          返回历史记录
        </button>
      </div>
    );
  }

  const href = continueHref(item);
  const isPoster = item.type === "poster" && !!item.result;

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      {/* 顶部返回 + 元信息 */}
      <div className="mb-5 flex items-center justify-between">
        <button
          type="button"
          onClick={() => router.push("/dashboard/history")}
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-indigo-600 transition-colors"
        >
          <ChevronLeft className="h-4 w-4" />
          历史记录
        </button>
        <div className="flex items-center gap-2">
          <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-600">
            {typeLabel(item.type)}
          </span>
          {item.sub_type && (
            <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-600">
              {subTypeLabel(item)}
            </span>
          )}
          <span className="text-xs text-slate-400">
            {new Date(item.created_at).toLocaleString("zh-CN")}
          </span>
        </div>
      </div>

      {/* 操作栏 */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleToggleFavorite}
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
        >
          <Star
            className={`h-4 w-4 ${
              item.is_favorite ? "fill-amber-500 text-amber-500" : "text-slate-400"
            }`}
          />
          {item.is_favorite ? "已收藏" : "收藏"}
        </button>
        {!isPoster && <CopyButton text={item.content || ""} />}
        {href && (
          <Link
            href={href}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
          >
            <MessageSquare className="h-4 w-4" />
            继续对话
          </Link>
        )}
      </div>

      {/* 反馈 */}
      <div className="mb-4 flex gap-2">
        <button
          type="button"
          onClick={() => handleFeedback("good")}
          className={`rounded px-3 py-1.5 text-sm ${
            item.effect_rating === "good"
              ? "border border-green-300 bg-green-100 text-green-700"
              : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-green-50"
          }`}
        >
          👍 效果好
        </button>
        <button
          type="button"
          onClick={() => handleFeedback("bad")}
          className={`rounded px-3 py-1.5 text-sm ${
            item.effect_rating === "bad"
              ? "border border-red-300 bg-red-100 text-red-700"
              : "border border-slate-200 bg-slate-50 text-slate-600 hover:bg-red-50"
          }`}
        >
          👎 效果差
        </button>
      </div>

      {/* 一键变体 */}
      {!isPoster && (
        <div className="mb-5 rounded-lg border border-slate-100 bg-slate-50 p-4">
          <p className="mb-2 text-xs text-slate-500">把这条转成其他平台格式：</p>
          <div className="flex flex-wrap gap-2">
            {REPURPOSE_PLATFORMS.map((p) => (
              <button
                key={p.platform}
                type="button"
                disabled={repurposing !== null}
                onClick={() => handleRepurpose(p.platform, p.label)}
                className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs text-slate-600 hover:border-indigo-300 hover:text-indigo-600 disabled:opacity-50 transition-colors"
              >
                {repurposing === p.platform ? "转换中..." : p.label}
              </button>
            ))}
          </div>
          {repurposeResult && (
            <div className="mt-3 rounded-md border border-indigo-100 bg-white p-3">
              <div className="mb-1.5 flex items-center justify-between">
                <p className="text-xs font-medium text-indigo-600">{repurposeResult.label}版</p>
                <CopyButton text={repurposeResult.content} />
              </div>
              <p className="whitespace-pre-wrap text-sm text-slate-700">{repurposeResult.content}</p>
            </div>
          )}
        </div>
      )}

      {/* 内容 */}
      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {isPoster ? (
          <div className="flex flex-col items-center gap-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={api.resolveUrl(item.result!)} alt="生成的海报" className="max-w-full rounded-lg" />
            <button
              type="button"
              onClick={() => {
                const stamp = (item.created_at || "").slice(0, 10).replace(/-/g, "");
                downloadImage(api.resolveUrl(item.result!), safeFileName(`海报_${stamp}`));
              }}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              <Download className="h-4 w-4" />
              下载图片
            </button>
          </div>
        ) : (
          <div className="prose prose-sm prose-slate max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {item.content || "（无内容）"}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
