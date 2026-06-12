"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { getTopCards, ROLE_LABELS, ROLE_TASKS } from "@/lib/role-workbench-config";
import type { RoleTaskCard } from "@/lib/role-workbench-config";
import type { StoreResponse } from "@/types/store";
import type { DashboardTodayResponse, DashboardRecommendation } from "@/types/dashboard";

/** 推荐项跳转：有 prompt_key 就直达原任务卡片带需求（一键复刻），否则用后端给的 URL */
function recommendationHref(rec: DashboardRecommendation): string {
  const payload = (rec.suggested_payload || {}) as Record<string, unknown>;
  const promptKey = typeof payload.prompt_key === "string" ? payload.prompt_key : null;
  const recIntent = typeof payload.user_intent === "string" ? payload.user_intent : null;
  if (promptKey) {
    for (const tasks of Object.values(ROLE_TASKS)) {
      const card = tasks.find((t) => t.promptKey && t.promptKey === promptKey);
      if (card) {
        return `/dashboard/workbench/${card.id}${recIntent ? `?intent=${encodeURIComponent(recIntent)}` : ""}`;
      }
    }
  }
  return rec.action_url || "/dashboard/workbench";
}

/**
 * 推荐取前 N 条的策略（不是简单截断）：
 * - 资料/上传类提醒最多占 1 条——资料不全的店不被"完善资料"天天霸屏
 * - "上次效果好一键复刻"是最个性化的推荐，优先露出（后端规则序里它排最后，截断会永远看不到）
 * - 其余按 high > medium 排
 */
function pickTopRecommendations(recs: DashboardRecommendation[], n = 3): DashboardRecommendation[] {
  const festival = recs.filter((r) => r.id === "festival");
  const setup = recs.filter((r) => r.action_type === "edit_store").slice(0, 1);
  const repeatGood = recs.filter((r) => r.id === "repeat_good");
  const rest = recs
    .filter((r) => r.id !== "festival" && r.action_type !== "edit_store" && r.id !== "repeat_good")
    .sort((a, b) => (a.priority === "high" ? 0 : 1) - (b.priority === "high" ? 0 : 1));
  const seen = new Set<string>();
  return [...festival, ...setup, ...repeatGood, ...rest]
    .filter((r) => !seen.has(r.id) && seen.add(r.id))
    .slice(0, n);
}

function hourGreeting(): string {
  const h = new Date().getHours();
  if (h < 6) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 14) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}
import {
  Store,
  Loader2,
  AlertCircle,
  ArrowRight,
  CheckCircle,
  Crown,
  Clock,
  Zap,
} from "lucide-react";
import { OnboardingGuide } from "@/components/onboarding-guide";
import { ContentCalendar } from "@/components/content-calendar";
import { MyTemplates } from "@/components/my-templates";

/** 默认 emoji，sceneTags 里没有匹配时用这个 */
const DEFAULT_EMOJI = "📋";

/** 尝试从 sceneTags 里挑一个合适的 emoji */
function pickEmoji(sceneTags: string[]): string {
  const tagEmojiMap: Record<string, string> = {
    朋友圈: "📱",
    日常: "☀️",
    门店品牌: "🏪",
    老客户: "🤝",
    私聊: "💬",
    回访: "📞",
    邀约: "📨",
    会员群: "👥",
    空台: "🎱",
    促活: "🔥",
    竞技群: "🏆",
    约局: "🎯",
    撮合: "🫂",
    助教: "🎓",
    推广: "📣",
    周赛: "🏅",
    活动: "🎉",
    赛事: "🏟️",
    员工群: "📋",
    管理: "📊",
    SOP: "✅",
    日报: "📝",
    汇报: "📈",
    看球: "📺",
    生日: "🎂",
    关怀: "❤️",
    团购: "🛒",
    评分: "⭐",
    品类: "📦",
    爆款: "💥",
    定价: "💰",
    新助教: "🆕",
    预约: "📅",
    短视频: "🎬",
    获客: "🧲",
    维护: "🔧",
    PK: "⚔️",
    激励: "💪",
    招聘: "👥",
    合规: "📜",
    业绩: "📊",
    复盘: "🔍",
    转化: "📈",
    培训: "📖",
    筛选: "🔎",
    新人: "🌱",
    加微信: "📱",
    新客: "✨",
    前厅: "🏢",
    话术: "🎙️",
    搭子: "👬",
    进群: "📲",
    投诉: "⚠️",
    安抚: "🫶",
    开店: "🔑",
    检查: "🔍",
    闭店: "🌙",
    价格: "💲",
    桌型: "🎱",
    设备: "🔧",
    推车: "🛒",
    促销: "🏷️",
    跟进: "📞",
    私域: "🔒",
    卫生: "🧹",
    电器: "⚡",
    节能: "🌱",
    老板: "👔",
    简报: "📋",
    经营: "📈",
    周计划: "📅",
    月报: "📊",
    方向: "🧭",
    投资: "💰",
    回报: "📈",
    运营: "🎯",
    内容: "✍️",
    计划: "📅",
    素材: "🎨",
    氛围: "🎶",
    预热: "🔥",
    抖音: "🎵",
    矩阵: "🔗",
    直播: "📡",
    教练: "🏅",
    公告: "📢",
    报名: "📝",
    赛前: "⏰",
    轻竞技: "🎯",
    乔氏: "🎱",
    斯诺克: "🎱",
    战报: "📰",
    抢一大战: "⚔️",
    好评: "⭐",
    引导: "👆",
    教学: "📚",
    新手: "🌟",
    入门: "🚀",
    散客: "🧑",
    接待: "🤝",
    小游戏: "🎮",
    娱乐: "😄",
  };
  for (const tag of sceneTags) {
    if (tagEmojiMap[tag]) return tagEmojiMap[tag];
  }
  return DEFAULT_EMOJI;
}

/** 从 localStorage 读取使用次数 */
function getUsageCounts(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem("workbench_card_usage") || "{}");
  } catch {
    return {};
  }
}

export default function DashboardPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [dashboard, setDashboard] = useState<DashboardTodayResponse | null>(null);
  const [dashboardError, setDashboardError] = useState(false);
  const [storeError, setStoreError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [quota, setQuota] = useState<{ used: number; limit: number; remaining: number } | null>(null);
  const [topCards, setTopCards] = useState<RoleTaskCard[]>([]);
  const [usageCounts, setUsageCounts] = useState<Record<string, number>>({});

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoading(true);
      const [storeResult, dashResult, quotaResult] = await Promise.allSettled([
        api.getMyStore(),
        api.getTodayDashboard(),
        api.getQuota(),
      ]);

      if (cancelled) return;

      if (storeResult.status === "fulfilled") {
        setStore(storeResult.value);
      } else {
        if (storeResult.reason?.status === 404) {
          setStore(null);
        } else {
          setStoreError(true);
        }
      }

      if (dashResult.status === "fulfilled") {
        setDashboard(dashResult.value);
        setDashboardError(false);
      } else {
        setDashboardError(true);
      }

      if (quotaResult.status === "fulfilled") {
        setQuota({ used: quotaResult.value.monthly_generations_used, limit: quotaResult.value.monthly_generation_limit, remaining: quotaResult.value.remaining });
      }

      setLoading(false);
    }

    loadData();

    // 加载常用卡片（仅客户端）
    setTopCards(getTopCards(6));
    setUsageCounts(getUsageCounts());

    return () => { cancelled = true; };
  }, []);

  const isNewUser = store === null || (store && store.completeness < 30);

  return (
    <div>
      {/* 首次登录引导 */}
      {isNewUser && <OnboardingGuide />}

      {/* 顶部欢迎区：带名字/店名/时段的问候，"工具"变"搭档" */}
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-900">今日工作台</h2>
        {dashboard && (
          <p className="mt-1 text-sm text-slate-500">
            {hourGreeting()}
            {user?.name ? `，${user.name}` : ""}
            {store?.name ? `。${store.name}` : "。"}
            {dashboard.greeting}
          </p>
        )}
      </div>

      {/* 今日建议：后端 9 条规则引擎的推荐（此前从未渲染），取前 3 条 */}
      {!loading && store && dashboard && dashboard.recommendations.length > 0 && (
        <div className="mb-6 rounded-lg border border-brand-100 bg-brand-50/50 p-4">
          <p className="mb-2.5 text-sm font-semibold text-slate-800">📌 今天建议做这几件事</p>
          <div className="space-y-2">
            {pickTopRecommendations(dashboard.recommendations).map((rec) => (
              <div key={rec.id} className="flex items-center gap-3 rounded-md bg-white border border-slate-100 px-3 py-2.5">
                {rec.priority === "high" && <span className="h-2 w-2 shrink-0 rounded-full bg-red-500" />}
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-slate-800">{rec.title}</p>
                  <p className="truncate text-xs text-slate-400">{rec.description}</p>
                </div>
                <Link
                  href={recommendationHref(rec)}
                  className="shrink-0 rounded-md bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-500 transition-colors"
                >
                  {rec.action_label}
                </Link>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 加载中 */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
          <span className="ml-3 text-slate-500">加载今日工作台...</span>
        </div>
      )}

      {!loading && (
        <>
          {/* 无门店状态：引导卡片 */}
          {(store === null || (storeError && !store)) && (
            <div className="space-y-6">
              <div className="rounded-lg border border-brand-200 bg-white p-6 sm:p-8 shadow-sm">
                <div className="flex flex-col items-center text-center">
                  <Store className="mb-4 h-14 w-14 text-brand-600" />
                  <h3 className="mb-2 text-lg font-bold text-slate-900">
                    先完善门店资料，AI 才能帮你生成内容
                  </h3>
                  <p className="mb-6 max-w-md text-sm text-slate-500">
                    门店名称、价格、地址、Logo
                    和二维码会影响文案和海报效果。建议先花 3 分钟填写核心资料。
                  </p>

                  <div className="mb-6 w-full max-w-sm space-y-2 text-left">
                    {[
                      "填写门店名称、地址、电话",
                      "填写价格、会员卡和门店优势",
                      "上传 Logo 和微信二维码",
                    ].map((step, i) => (
                      <div key={i} className="flex items-center gap-3 rounded-md bg-slate-50 px-4 py-2.5">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">
                          {i + 1}
                        </span>
                        <span className="text-sm text-slate-700">{step}</span>
                      </div>
                    ))}
                  </div>

                  <Link
                    href="/dashboard/store-settings"
                    className="inline-flex items-center gap-2 rounded-md bg-brand-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-brand-500"
                  >
                    去完善门店资料
                    <ArrowRight className="h-4 w-4" />
                  </Link>
                </div>
              </div>
            </div>
          )}

          {/* 有门店 */}
          {store && (
            <div className="space-y-6">
              {/* 常用任务 */}
              {topCards.length > 0 && (
                <div>
                  <div className="flex items-center gap-2 mb-3">
                    <Zap className="h-5 w-5 text-brand-600" />
                    <h3 className="font-semibold text-slate-900">常用任务</h3>
                  </div>
                  <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                    {topCards.map((card) => {
                      const emoji = pickEmoji(card.sceneTags);
                      const count = usageCounts[card.id] || 0;
                      return (
                        <button
                          key={card.id}
                          onClick={() => router.push(`/dashboard/workbench/${card.id}`)}
                          className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-4 text-left hover:border-brand-200 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 active:scale-[0.98] cursor-pointer"
                        >
                          <span className="mt-0.5 text-xl leading-none shrink-0">{emoji}</span>
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-slate-900 truncate">{card.title}</p>
                            <p className="mt-0.5 text-xs text-slate-500">
                              {ROLE_LABELS[card.role]}
                              {count > 0 && (
                                <span className="ml-1.5 text-slate-400">· 使用 {count} 次</span>
                              )}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* 门店状态卡片 */}
              <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Store className="h-5 w-5 text-brand-600" />
                    <h3 className="font-semibold text-slate-900">{store.name}</h3>
                  </div>
                  <span
                    className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                      (dashboard?.store_completeness ?? store.completeness) >= 70
                        ? "bg-emerald-50 border border-emerald-200 text-emerald-600"
                        : (dashboard?.store_completeness ?? store.completeness) >= 40
                          ? "bg-amber-50 border border-amber-200 text-amber-600"
                          : "bg-red-50 border border-red-200 text-red-600"
                    }`}
                  >
                    完整度 {dashboard?.store_completeness ?? store.completeness}%
                  </span>
                </div>

                {/* 统计信息：累计/今日 + 沉淀资产（收藏/效果好可点击直达） */}
                {dashboard ? (
                  <div className="grid grid-cols-4 gap-3 text-center">
                    <div>
                      <p className="text-2xl font-bold text-slate-900">
                        {dashboard.summary.total_generations}
                      </p>
                      <p className="text-xs text-slate-500">累计生成</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-slate-900">
                        {dashboard.summary.today_generations}
                      </p>
                      <p className="text-xs text-slate-500">今日生成</p>
                    </div>
                    <Link href="/dashboard/history" className="rounded-md hover:bg-slate-50 transition-colors">
                      <p className="text-2xl font-bold text-amber-500">
                        {dashboard.summary.favorite_count}
                      </p>
                      <p className="text-xs text-slate-500">收藏</p>
                    </Link>
                    <Link href="/dashboard/history" className="rounded-md hover:bg-slate-50 transition-colors" title="标过「效果好」的内容，AI 正在学习它们的风格">
                      <p className="text-2xl font-bold text-emerald-500">
                        {dashboard.summary.good_count}
                      </p>
                      <p className="text-xs text-slate-500">效果好</p>
                    </Link>
                  </div>
                ) : dashboardError ? (
                  <div className="flex items-center gap-2 text-sm text-amber-600">
                    <AlertCircle className="h-4 w-4" />
                    统计数据加载失败
                  </div>
                ) : null}

                {store.address && (
                  <p className="mt-3 text-xs text-slate-400 truncate">地址：{store.address}</p>
                )}
              </div>

              {/* 订阅状态卡片 */}
              {quota && (
                <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Crown className="h-5 w-5 text-amber-500" />
                      <h3 className="font-semibold text-slate-900">本月使用情况</h3>
                    </div>
                    <span className="text-xs text-slate-400">
                      {new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long" })}
                    </span>
                  </div>

                  <div className="space-y-3">
                    {/* 成就视角：先看产出，再看余量 */}
                    {quota.used > 0 && (
                      <p className="text-sm text-slate-600">
                        本月已产出 <span className="font-semibold text-brand-600">{quota.used}</span> 条运营内容
                        <span className="text-xs text-slate-400">
                          ，按每条手写 20 分钟算，约省下 {Math.max(0.5, Math.round((quota.used * 20 / 60) * 2) / 2)} 小时
                        </span>
                      </p>
                    )}
                    {/* 生成次数 */}
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-sm text-slate-600">AI 内容生成</span>
                        <span className="text-sm font-medium text-slate-900">
                          {quota.used} / {quota.limit}
                        </span>
                      </div>
                      <div className="h-2 w-full rounded-full bg-slate-100">
                        <div
                          className={`h-2 rounded-full transition-all ${
                            quota.used / quota.limit >= 0.9
                              ? "bg-red-500"
                              : quota.used / quota.limit >= 0.7
                              ? "bg-amber-500"
                              : "bg-brand-500"
                          }`}
                          style={{ width: `${Math.min((quota.used / quota.limit) * 100, 100)}%` }}
                        />
                      </div>
                    </div>

                    {/* 状态提示 */}
                    {quota.remaining <= 0 ? (
                      <div className="flex items-center gap-2 rounded-md bg-red-50 p-3">
                        <AlertCircle className="h-4 w-4 text-red-500" />
                        <p className="text-sm text-red-700">本月额度已用完，下月1日自动重置</p>
                      </div>
                    ) : quota.remaining <= 5 ? (
                      <div className="flex items-center gap-2 rounded-md bg-amber-50 p-3">
                        <Clock className="h-4 w-4 text-amber-500" />
                        <p className="text-sm text-amber-700">本月剩余 {quota.remaining} 次，请合理使用</p>
                      </div>
                    ) : null}

                    {/* 到期提醒 */}
                    <div className="flex items-center justify-between text-xs text-slate-400">
                      <span>如需提升额度，请联系管理员</span>
                    </div>
                  </div>
                </div>
              )}

              {/* 内容日历 */}
              <ContentCalendar />

              {/* 我的模板 */}
              <MyTemplates />

              {/* Tips 提示 */}
              {dashboard && dashboard.tips.length > 0 && (
                <div className="rounded-lg border border-brand-200 bg-brand-50 p-4">
                  <div className="flex items-start gap-2">
                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                    <div>
                      {dashboard.tips.map((tip, i) => (
                        <p key={i} className="text-sm text-slate-700">
                          {tip}
                        </p>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
