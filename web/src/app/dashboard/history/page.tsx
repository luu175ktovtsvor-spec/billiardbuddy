"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import type { GenerationHistoryItem, GenerationType } from "@/types/generation-history";
import { CopyButton } from "@/components/generators/copy-button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Star, Clock, ChevronLeft, ChevronRight, X, MessageSquare } from "lucide-react";
import Link from "next/link";

const TYPE_LABELS: Record<string, string> = {
  copywriting: "文案",
  activity: "活动",
  operation: "经营",
  workbench: "工作台",
};

/** 去掉 Markdown 语法，返回纯文本预览 */
function stripMarkdown(text: string): string {
  return text
    .replace(/^#{1,6}\s+/gm, "")       // 去掉标题 #
    .replace(/\*\*(.+?)\*\*/g, "$1")    // 去掉加粗 **
    .replace(/\*(.+?)\*/g, "$1")        // 去掉斜体 *
    .replace(/~~(.+?)~~/g, "$1")        // 去掉删除线 ~~
    .replace(/`{1,3}[^`]*`{1,3}/g, "")  // 去掉代码块
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // 链接保留文字
    .replace(/^[-*+]\s+/gm, "")         // 去掉列表符号
    .replace(/^\d+\.\s+/gm, "")         // 去掉有序列表
    .replace(/^>\s+/gm, "")             // 去掉引用
    .replace(/^---+$/gm, "")            // 去掉分割线
    .replace(/^\|(.+)\|$/gm, "")        // 去掉表格行
    .replace(/^\|[-:\s|]+\|$/gm, "")    // 去掉表格分隔行
    .replace(/\n{3,}/g, "\n\n")         // 多空行压缩
    .trim();
}

const SUB_TYPE_LABELS: Record<string, string> = {
  // 文案
  moments: "朋友圈",
  group_notice: "群公告",
  // 活动
  planning: "活动策划",
  daily_invite: "每日约客",
  activity_promo: "活动推广",
  tournament_notice: "赛事通知",
  recharge_promo: "充值促销",
  afternoon_special: "下午场特惠",
  // 经营场景
  groupbuy_to_private: "团购转私域",
  assistant_promo: "助教推广",
  partner_match: "球友匹配",
  tournament: "赛事活动",
  old_customer_recall: "老客户回访",
  assistant_outreach: "助教约客",
  assistant_booking: "助教预约",
  member_assistant_notice: "助教可约通知",
  game_recommend: "玩法推荐",
  opening_event: "开业活动",
  performance_template: "绩效模板",
  complaint_handling: "投诉处理",
  daily_task_list: "每日任务",
  vip_maintenance: "VIP维护",
  daily_report: "日报",
  monthly_report: "月报",
  training_exam: "培训考核",
  review_meeting: "复盘会议",
  short_video: "短视频",
  frontdesk_sop: "前厅SOP",
  ip_cooperation: "IP合作",
  diagnosis_tool: "诊断工具",
  group_content: "群内容",
  workbench_tasks: "工作台任务",
  qiangyi_battle: "抢一大战",
  tournament_signup: "赛事报名",
  tournament_report: "赛事战报",
  tournament_rules: "赛制说明",
  champion_poster: "冠军海报",
  coaching_promo: "教学推广",
  competition_customer: "竞技客户维护",
  empty_table_promo: "空台促活",
  departure_followup: "离店跟进",
  customer_group_guide: "进群引导",
  opening_closing_sop: "开店闭店SOP",
  equipment_management: "电器管理",
  store_atmosphere: "门店氛围",
  poster_copy: "海报文案",
  sports_event_watching: "看球活动",
  staff_birthday: "员工生日",
  hygiene_check: "卫生检查",
  review_guidance: "好评引导",
  activity_direction: "活动方向",
  business_strategy: "经营策略",
  table_content_plan: "内容规划",
  cart_promotion: "推车促销",
  recruitment: "招聘",
  // 岗位
  boss: "老板",
  manager: "店长",
  assistant_manager: "助教管理",
  coach: "教练",
  frontdesk: "前厅",
  operator: "运营",
};

export default function HistoryPage() {
  const [items, setItems] = useState<GenerationHistoryItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const pageSize = 20;
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [detailItem, setDetailItem] = useState<GenerationHistoryItem | null>(null);

  const fetchHistory = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await api.listGenerations({
        page,
        page_size: pageSize,
        type: typeFilter as GenerationType | undefined,
        is_favorite: showFavoritesOnly || undefined,
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
  }, [page, typeFilter, showFavoritesOnly]);

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
      const token = api.getToken();
      await fetch(`${api.baseUrl}/api/v1/feedback/generations/${id}/feedback`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ rating }),
      });
      setItems((prev) =>
        prev.map((item) =>
          item.id === id ? { ...item, effect_rating: rating } : item
        )
      );
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
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-900">生成历史</h2>
        <div className="flex items-center gap-3">
          {/* Favorite filter toggle */}
          <button
            type="button"
            onClick={() => {
              setShowFavoritesOnly((v) => !v);
              setPage(1);
            }}
            className={`flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors ${
              showFavoritesOnly
                ? "border-amber-200 bg-amber-50 text-amber-600"
                : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            <Star className={`h-3.5 w-3.5 ${showFavoritesOnly ? "fill-amber-600 text-amber-600" : ""}`} />
            只看收藏
          </button>
          {/* Type filter */}
          <select
            value={typeFilter || ""}
            onChange={(e) => {
              setTypeFilter(e.target.value || null);
              setPage(1);
            }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700"
          >
            <option value="">全部类型</option>
            <option value="copywriting">文案</option>
            <option value="activity">活动</option>
            <option value="operation">经营</option>
            <option value="workbench">工作台</option>
            <option value="poster">海报</option>
          </select>
          <button
            onClick={async () => {
              const typeParam = typeFilter ? `?type=${typeFilter}` : "";
              const token = api.getToken();
              const res = await fetch(`${api.baseUrl}/api/v1/generations/export${typeParam}`, {
                headers: { Authorization: `Bearer ${token}` },
              });
              if (!res.ok) return;
              const blob = await res.blob();
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = "generations.csv";
              a.click();
              URL.revokeObjectURL(url);
            }}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
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
          <p className="text-sm text-slate-500">还没有生成记录</p>
        </div>
      )}

      {!loading && !error && items.length > 0 && (
        <div className="space-y-3">
          {items.map((item) => (
            <div
              key={item.id}
              onClick={() => setDetailItem(item)}
              className="rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-300 transition-colors shadow-sm cursor-pointer"
            >
              <div className="mb-2 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-600">
                    {TYPE_LABELS[item.type] || item.type}
                  </span>
                  {item.sub_type && (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-600">
                      {SUB_TYPE_LABELS[item.sub_type] || SUB_TYPE_LABELS[item.sub_type.split(".").pop() || ""] || item.sub_type}
                    </span>
                  )}
                  <span className="text-xs text-slate-400">
                    {new Date(item.created_at).toLocaleString("zh-CN")}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleFeedback(item.id, "good"); }}
                    className={`rounded-md p-1 transition-colors ${item.effect_rating === "good" ? "bg-green-100 text-green-600" : "hover:bg-slate-50 text-slate-400 hover:text-green-600"}`}
                    title="效果好"
                  >
                    👍
                  </button>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleFeedback(item.id, "bad"); }}
                    className={`rounded-md p-1 transition-colors ${item.effect_rating === "bad" ? "bg-red-100 text-red-600" : "hover:bg-slate-50 text-slate-400 hover:text-red-600"}`}
                    title="效果差"
                  >
                    👎
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggleFavorite(item.id, item.is_favorite)}
                    className="rounded-md p-1 hover:bg-slate-50 transition-colors"
                    title={item.is_favorite ? "取消收藏" : "收藏"}
                  >
                    <Star
                      className={`h-4 w-4 ${
                        item.is_favorite
                          ? "fill-amber-600 text-amber-600"
                          : "text-slate-400 hover:text-amber-600"
                      }`}
                    />
                  </button>
                  <CopyButton text={item.content || ""} />
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); handleDelete(item.id); }}
                    className="rounded-md p-1 hover:bg-slate-50 transition-colors text-slate-400 hover:text-red-600"
                    title="删除"
                  >
                    🗑️
                  </button>
                </div>
              </div>
              <p className="line-clamp-3 whitespace-pre-wrap text-sm text-slate-700">
                {stripMarkdown(item.content || "") || "（无内容）"}
              </p>
              {item.model_used && (
                <p className="mt-2 text-xs text-slate-400">
                  模型：{item.model_used}
                  {item.tokens_used ? ` · ${item.tokens_used} tokens` : ""}
                </p>
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
            className="rounded-md border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm text-slate-500">
            {page} / {totalPages}
          </span>
          <button
            type="button"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            className="rounded-md border border-slate-200 bg-white p-2 text-slate-500 hover:bg-slate-50 disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Detail Modal */}
      {detailItem && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setDetailItem(null)}
        >
          <div
            className="relative max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-xl bg-white p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="rounded-full bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-600">
                  {TYPE_LABELS[detailItem.type] || detailItem.type}
                </span>
                {detailItem.sub_type && (
                  <span className="rounded-full bg-emerald-50 px-2.5 py-0.5 text-xs font-medium text-emerald-600">
                    {SUB_TYPE_LABELS[detailItem.sub_type] || SUB_TYPE_LABELS[detailItem.sub_type.split(".").pop() || ""] || detailItem.sub_type}
                  </span>
                )}
                <span className="text-xs text-slate-400">
                  {new Date(detailItem.created_at).toLocaleString("zh-CN")}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setDetailItem(null)}
                className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="mb-4 flex items-center gap-2">
              <button
                type="button"
                onClick={() => handleToggleFavorite(detailItem.id, detailItem.is_favorite)}
                className="rounded-md p-1 hover:bg-slate-50 transition-colors"
              >
                <Star
                  className={`h-4 w-4 ${
                    detailItem.is_favorite
                      ? "fill-amber-600 text-amber-600"
                      : "text-slate-400 hover:text-amber-600"
                  }`}
                />
              </button>
              <CopyButton text={detailItem.content || ""} />
              {detailItem.type === "workbench" && typeof detailItem.input_params?.user_intent === "string" && (
                <Link
                  href={`/dashboard/workbench?intent=${encodeURIComponent(detailItem.input_params.user_intent as string)}`}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 transition-colors"
                >
                  <MessageSquare className="h-4 w-4" />
                  继续对话
                </Link>
              )}
            </div>

            {/* 反馈按钮 */}
            <div className="flex gap-2 mt-4">
              <button
                type="button"
                onClick={() => handleFeedback(detailItem.id, "good")}
                className={`px-3 py-1.5 rounded text-sm ${
                  detailItem.effect_rating === "good"
                    ? "bg-green-100 text-green-700 border border-green-300"
                    : "bg-slate-50 text-slate-600 border border-slate-200 hover:bg-green-50"
                }`}
              >
                👍 效果好
              </button>
              <button
                type="button"
                onClick={() => handleFeedback(detailItem.id, "bad")}
                className={`px-3 py-1.5 rounded text-sm ${
                  detailItem.effect_rating === "bad"
                    ? "bg-red-100 text-red-700 border border-red-300"
                    : "bg-slate-50 text-slate-600 border border-slate-200 hover:bg-red-50"
                }`}
              >
                👎 效果差
              </button>
            </div>

            <div className="prose prose-sm prose-slate max-w-none">
              {detailItem.type === "poster" && detailItem.result ? (
                <div className="flex justify-center">
                  <img
                    src={api.resolveUrl(detailItem.result)}
                    alt="生成的海报"
                    className="max-w-full rounded-lg"
                  />
                </div>
              ) : (
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {detailItem.content || "（无内容）"}
                </ReactMarkdown>
              )}
            </div>

            {detailItem.model_used && (
              <p className="mt-4 border-t border-slate-100 pt-3 text-xs text-slate-400">
                模型：{detailItem.model_used}
                {detailItem.tokens_used ? ` · ${detailItem.tokens_used} tokens` : ""}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
