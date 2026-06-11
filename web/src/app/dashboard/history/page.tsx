"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import type { GenerationHistoryItem, GenerationType } from "@/types/generation-history";
import { CopyButton } from "@/components/generators/copy-button";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Star, Clock, ChevronLeft, ChevronRight, X, MessageSquare, Sparkles } from "lucide-react";
import Link from "next/link";
import { ROLE_TASKS } from "@/lib/role-workbench-config";
import { markdownToPlainText } from "@/lib/utils";
import { useToast } from "@/components/ui/toast";

const TYPE_LABELS: Record<string, string> = {
  copywriting: "文案",
  activity: "活动",
  operation: "经营",
  workbench: "工作台",
  poster: "海报",
};

/** "继续对话"跳转：按 prompt_key 找回原任务卡片并带上原始意图；找不到（自由输入等）则不显示入口 */
function continueHref(item: GenerationHistoryItem): string | null {
  if (item.type !== "workbench") return null;
  const params = (item.input_params || {}) as Record<string, unknown>;
  const intent = params.user_intent;
  const promptKey = params.prompt_key;
  if (typeof intent !== "string" || !intent) return null;
  if (typeof promptKey !== "string" || !promptKey) return null;
  for (const tasks of Object.values(ROLE_TASKS)) {
    const card = tasks.find((t) => t.promptKey === promptKey);
    if (card) {
      return `/dashboard/workbench/${card.id}?intent=${encodeURIComponent(intent)}`;
    }
  }
  return null;
}

/** 保存历史记录为"我的模板"：按 prompt_key 找回任务卡，沉淀为可一键重跑的模板 */
function saveItemAsTemplate(item: GenerationHistoryItem): boolean {
  const params = (item.input_params || {}) as Record<string, unknown>;
  const intent = typeof params.user_intent === "string" ? params.user_intent : "";
  if (!intent) return false;
  const promptKey = typeof params.prompt_key === "string" ? params.prompt_key : "";
  let cardId: string | undefined;
  let title = intent.slice(0, 12);
  let role = typeof params.role === "string" ? params.role : "manager";
  for (const tasks of Object.values(ROLE_TASKS)) {
    const card = tasks.find((t) => t.promptKey && t.promptKey === promptKey);
    if (card) {
      cardId = card.id;
      title = card.title;
      role = card.role;
      break;
    }
  }
  try {
    const templates = JSON.parse(localStorage.getItem("my_templates") || "[]");
    templates.push({
      id: Date.now().toString(),
      title,
      intent,
      role,
      cardId,
      createdAt: new Date().toISOString(),
    });
    localStorage.setItem("my_templates", JSON.stringify(templates));
    return true;
  } catch {
    return false;
  }
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
  const [showGoodOnly, setShowGoodOnly] = useState(false);
  const [detailItem, setDetailItem] = useState<GenerationHistoryItem | null>(null);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [repurposing, setRepurposing] = useState<string | null>(null);
  const [repurposeResult, setRepurposeResult] = useState<{ label: string; content: string } | null>(null);
  const { toast } = useToast();

  const handleDetailRepurpose = async (id: string, platform: string, label: string) => {
    setRepurposing(platform);
    setRepurposeResult(null);
    try {
      const res = await api.repurposeContent(id, platform);
      setRepurposeResult({ label, content: res.content });
    } catch (err) {
      toast(err instanceof ApiError ? err.detail : "转换失败，请重试", "error");
    } finally {
      setRepurposing(null);
    }
  };

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

  // 打开/切换详情时清掉上一条的变体结果
  useEffect(() => {
    setRepurposeResult(null);
    setRepurposing(null);
  }, [detailItem?.id]);

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
      // 详情弹窗打开时同步图标状态
      setDetailItem((prev) =>
        prev && prev.id === id ? { ...prev, is_favorite: res.is_favorite } : prev
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
      setDetailItem((prev) =>
        prev && prev.id === id ? { ...prev, effect_rating: rating } : prev
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
  const detailContinueHref = detailItem ? continueHref(detailItem) : null;

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-900">生成历史</h2>
        <div className="flex items-center gap-3">
          {/* 关键词搜索 */}
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
            className="w-44 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none"
          />
          {search && (
            <button
              type="button"
              onClick={() => { setSearch(""); setSearchInput(""); setPage(1); }}
              className="rounded-lg border border-indigo-200 bg-indigo-50 px-2.5 py-1.5 text-sm text-indigo-600 hover:bg-indigo-100"
            >
              「{search}」✕
            </button>
          )}
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
          <button
            type="button"
            onClick={() => { setShowGoodOnly((v) => !v); setPage(1); }}
            title="标过「效果好」的内容——AI 正在学习这些内容的风格"
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-sm transition-colors ${
              showGoodOnly
                ? "border-green-200 bg-green-50 text-green-600"
                : "border-slate-200 bg-white text-slate-500 hover:bg-slate-50"
            }`}
          >
            👍 只看效果好
          </button>
          {/* Type filter — pill buttons */}
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-white p-1">
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
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  typeFilter === t.value
                    ? "bg-indigo-600 text-white"
                    : "text-slate-500 hover:text-slate-700"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <button
            onClick={async () => {
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
                    onClick={(e) => { e.stopPropagation(); handleToggleFavorite(item.id, item.is_favorite); }}
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
                  <span onClick={(e) => e.stopPropagation()}>
                    <CopyButton text={item.content || ""} />
                  </span>
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
                {markdownToPlainText(item.content || "") || "（无内容）"}
              </p>
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
              {detailContinueHref && (
                <Link
                  href={detailContinueHref}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 transition-colors"
                >
                  <MessageSquare className="h-4 w-4" />
                  继续对话
                </Link>
              )}
              {detailItem.type === "workbench" && typeof detailItem.input_params?.user_intent === "string" && (
                <button
                  type="button"
                  onClick={() => {
                    const ok = saveItemAsTemplate(detailItem);
                    toast(ok ? "已存为我的模板，首页点「使用」一键重跑" : "保存失败", ok ? "success" : "error");
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 transition-colors"
                >
                  <Sparkles className="h-4 w-4" />
                  存为模板
                </button>
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

            {/* 一键变体：旧爆款 30 秒转成其他平台版本 */}
            {detailItem.type !== "poster" && (
              <div className="mt-4 rounded-md border border-slate-100 bg-slate-50 p-3">
                <p className="mb-2 text-xs text-slate-500">把这条转成其他平台格式：</p>
                <div className="flex flex-wrap gap-2">
                  {[
                    { platform: "douyin", label: "抖音文案" },
                    { platform: "xiaohongshu", label: "小红书" },
                    { platform: "group_notice", label: "群公告" },
                    { platform: "wechat_moments", label: "朋友圈" },
                  ].map((p) => (
                    <button
                      key={p.platform}
                      type="button"
                      disabled={repurposing !== null}
                      onClick={() => handleDetailRepurpose(detailItem.id, p.platform, p.label)}
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

          </div>
        </div>
      )}
    </div>
  );
}
