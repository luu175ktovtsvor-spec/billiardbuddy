"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import type { GenerationHistoryItem, GenerationType } from "@/types/generation-history";
import { CopyButton } from "@/components/generators/copy-button";
import { Star, Clock, ChevronLeft, ChevronRight } from "lucide-react";
import { typeLabel, subTypeLabel } from "@/lib/history-labels";
import { markdownToPlainText, formatDateTime } from "@/lib/utils";
import { isWeChat } from "@/lib/wechat";
import { useToast } from "@/components/ui/toast";

/** 海报行展示名:用户命名 > prompt 前 18 字 > 兜底"海报" */
function displayTitle(item: GenerationHistoryItem): string {
  if (item.title) return item.title;
  const prompt = item.input_params?.prompt;
  if (typeof prompt === "string" && prompt.trim()) return prompt.trim().slice(0, 18);
  return "海报";
}

export default function HistoryPage() {
  const [items, setItems] = useState<GenerationHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [showGoodOnly, setShowGoodOnly] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const { toast } = useToast();
  const router = useRouter();

  // 首页"我的收藏 → 全部"带 ?favorite=1 进入时，自动只看收藏
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("favorite") === "1") {
      setShowFavoritesOnly(true);
    }
  }, []);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listGenerations({
        page,
        page_size: pageSize,
        type: typeFilter as GenerationType | undefined,
        is_favorite: showFavoritesOnly || undefined,
        effect_rating: showGoodOnly ? "good" : undefined,
        search: search || undefined,
      });
      setItems(res.items);
      setTotal(res.total);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
        setItems([]);
        setTotal(0);
      } else {
        setError("加载失败，请重试");
      }
    } finally {
      setLoading(false);
    }
  }, [page, typeFilter, showFavoritesOnly, showGoodOnly, search]);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const handleToggleFavorite = async (id: string, currentStatus: boolean) => {
    try {
      const res = await api.toggleFavorite(id);
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, is_favorite: res.is_favorite } : item
        )
      );
    } catch {
      // 静默处理
    }
  };

  const handleFeedback = async (id: string, rating: "good" | "bad") => {
    try {
      await api.submitFeedback(id, rating);
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, effect_rating: rating } : item
        )
      );
      if (rating === "good") {
        toast("已存入门店金牌范文，AI 之后会参考这条的风格", "success");
      }
    } catch {
      // 静默处理
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("确定删除这条记录？")) return;
    try {
      await api.deleteGeneration(id);
      setItems((prev) => prev.filter((item) => item.id !== id));
    } catch {
      // 静默处理
    }
  };

  const totalPages = Math.ceil(total / pageSize);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 space-y-3">
        <h2 className="text-xl font-bold text-slate-900">生成历史</h2>
        {/* 第一行：关键词搜索占满 */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                setSearch(searchInput.trim());
                setPage(1);
              }
            }}
            placeholder="搜索内容关键词，回车"
            className="h-11 min-w-0 flex-1 rounded-xl bg-white px-4 text-[15px] text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(""); setSearchInput(""); setPage(1); }}
              className="h-11 max-w-[40%] shrink-0 truncate rounded-xl border border-brand-200 bg-brand-50 px-3 text-sm text-brand-600 hover:bg-brand-100 active:scale-[0.98]"
            >
              「{search}」✕
            </button>
          )}
        </div>
        {/* 第二行：全部筛选 chips 一条横向滚动行，导出 CSV 在行尾 */}
        <div className="-mx-4 flex items-center gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden sm:-mx-6 sm:px-6 lg:mx-0 lg:flex-wrap lg:px-0">
          {/* Favorite filter toggle */}
          <button
            type="button"
            onClick={() => {
              setShowFavoritesOnly((v) => !v);
              setPage(1);
            }}
            className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium transition-colors active:scale-[0.98] ${
              showFavoritesOnly
                ? "border-amber-200 bg-amber-50 text-amber-600"
                : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            <Star className={`h-3.5 w-3.5 ${showFavoritesOnly ? "fill-amber-600 text-amber-600" : ""}`} />
            只看收藏
          </button>
          <button
            type="button"
            onClick={() => { setShowGoodOnly((v) => !v); setPage(1); }}
            title="标过「效果好」的内容——AI 正在学习这些内容的风格"
            className={`flex h-9 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm transition-colors active:scale-[0.98] ${
              showGoodOnly
                ? "border-green-200 bg-green-50 text-green-600"
                : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            👍 只看效果好
          </button>
          {/* Type filter — pill chips */}
          {[
            { value: null, label: "全部" },
            { value: "copywriting", label: "文案" },
            { value: "activity", label: "活动" },
            { value: "operation", label: "经营" },
            { value: "workbench", label: "工作台" },
            { value: "poster", label: "海报" },
          ].map((t) => (
            <button
              key={t.value ?? "all"}
              type="button"
              onClick={() => { setTypeFilter(t.value); setPage(1); }}
              className={`h-9 shrink-0 rounded-full border px-3.5 text-sm font-medium transition-colors active:scale-[0.98] ${
                typeFilter === t.value
                  ? "border-brand-600 bg-brand-600 text-white"
                  : "border-slate-200 bg-white text-slate-500 hover:text-slate-700"
              }`}
            >
              {t.label}
            </button>
          ))}
          <button
            onClick={async () => {
              if (isWeChat()) {
                toast("微信内无法下载文件，请用手机浏览器或电脑打开后导出", "error");
                return;
              }
              try {
                const blob = await api.exportGenerations(typeFilter || undefined);
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = "generations.csv";
                a.click();
                URL.revokeObjectURL(url);
              } catch {
                toast("导出失败，请稍后重试", "error");
              }
            }}
            className="h-9 shrink-0 rounded-full bg-slate-100 px-3.5 text-sm text-slate-700 hover:bg-slate-50 active:scale-[0.98]"
          >
            导出 CSV
          </button>
        </div>
      </div>

      {loading && (
        <div className="py-20 text-center text-slate-500">加载中...</div>
      )}

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 p-4 text-sm text-red-600">
          {error}
        </div>
      )}

      {!loading && !error && items.length === 0 && (
        <div className="py-20 text-center">
          <Clock className="mx-auto mb-3 h-10 w-10 text-slate-400" />
          <p className="text-[15px] text-slate-500">还没有生成记录</p>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              onClick={() => router.push(`/dashboard/history/${item.id}`)}
              className="rounded-2xl bg-white p-4 hover:border-slate-300 transition active:scale-[0.98] shadow-sm cursor-pointer"
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-xs font-medium text-brand-600">
                    {typeLabel(item.type)}
                  </span>
                  {item.sub_type && (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-600">
                      {subTypeLabel(item)}
                    </span>
                  )}
                  <span className="text-xs text-slate-400">
                    {formatDateTime(item.created_at)}
                  </span>
                </div>
                <div className="ml-auto flex items-center">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleFeedback(item.id, "good"); }}
                    className={`flex h-10 w-10 items-center justify-center rounded-full text-base transition-colors ${item.effect_rating === "good" ? "bg-green-100 text-green-600" : "hover:bg-slate-50 active:bg-slate-100 text-slate-400 hover:text-green-600"}`}
                    title="效果好"
                  >
                    👍
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleFeedback(item.id, "bad"); }}
                    className={`flex h-10 w-10 items-center justify-center rounded-full text-base transition-colors ${item.effect_rating === "bad" ? "bg-red-100 text-red-600" : "hover:bg-slate-50 active:bg-slate-100 text-slate-400 hover:text-red-600"}`}
                    title="效果差"
                  >
                    👎
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleToggleFavorite(item.id, item.is_favorite); }}
                    className="flex h-10 w-10 items-center justify-center rounded-full hover:bg-slate-50 active:bg-slate-100 transition-colors"
                    title={item.is_favorite ? "取消收藏" : "收藏"}
                  >
                    <Star
                      className={`h-5 w-5 ${
                        item.is_favorite
                          ? "fill-amber-600 text-amber-600"
                          : "text-slate-400 hover:text-amber-600"
                      }`}
                    />
                  </button>
                  <span onClick={(e) => e.stopPropagation()} className="[&_button]:h-10 [&_button]:rounded-full">
                    <CopyButton text={item.content || ""} />
                  </span>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                    className="flex h-10 w-10 items-center justify-center rounded-full text-base hover:bg-slate-50 active:bg-slate-100 transition-colors text-slate-400 hover:text-red-600"
                    title="删除"
                  >
                    🗑️
                  </button>
                </div>
              </div>
              {item.type === "poster" ? (
                <div className="flex items-center gap-3">
                  {item.result && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={api.resolveUrl(item.result)}
                      alt=""
                      className="h-14 w-14 shrink-0 rounded-lg object-cover"
                    />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[15px] font-semibold text-slate-900">{displayTitle(item)}</p>
                    <p className="text-xs text-slate-400">{formatDateTime(item.created_at)}</p>
                  </div>
                </div>
              ) : (
                <>
                  {item.title && (
                    <p className="text-[15px] font-semibold text-slate-900">{item.title}</p>
                  )}
                  <p className="line-clamp-3 whitespace-pre-wrap text-[15px] text-slate-700">
                    {markdownToPlainText(item.content || "") || "（无内容）"}
                  </p>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-2">
          <button
            type="button"
            disabled={page <= 1}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-slate-500 hover:bg-slate-50 active:bg-slate-100 disabled:opacity-30"
          >
            <ChevronLeft className="h-5 w-5" />
          </button>
          <span className="text-sm text-slate-500">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="flex h-11 w-11 items-center justify-center rounded-xl bg-white text-slate-500 hover:bg-slate-50 active:bg-slate-100 disabled:opacity-30"
          >
            <ChevronRight className="h-5 w-5" />
          </button>
        </div>
      )}

    </div>
  );
}
