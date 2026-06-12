"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { getTopCards, ROLE_LABELS, ROLE_TASKS } from "@/lib/role-workbench-config";
import { SceneIconTile } from "@/lib/scene-icons";
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
  ChevronRight,
  Crown,
  Clock,
  Lightbulb,
  Zap,
} from "lucide-react";
import { OnboardingGuide } from "@/components/onboarding-guide";
import { ContentCalendar } from "@/components/content-calendar";
import { MyTemplates } from "@/components/my-templates";

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
        <h2 className="text-xl font-bold text-slate-900">
          {hourGreeting()}
          {user?.name ? `，${user.name}` : ""}
        </h2>
        {dashboard && (
          <p className="mt-1 text-[15px] text-slate-500 lg:text-sm">
            {store?.name ? `${store.name}。` : ""}
            {dashboard.greeting}
          </p>
        )}
      </div>

      {/* 今日建议：后端 9 条规则引擎的推荐（此前从未渲染），取前 3 条 */}
      {!loading && store && dashboard && dashboard.recommendations.length > 0 && (
        <div className="mb-6 rounded-2xl border border-brand-100 bg-brand-50/50 p-4">
          <div className="mb-3 flex items-center gap-2">
            <Lightbulb className="h-5 w-5 text-brand-600" />
            <p className="text-[15px] font-semibold text-slate-800 lg:text-sm">今天建议做这几件事</p>
          </div>
          <div className="space-y-2">
            {pickTopRecommendations(dashboard.recommendations).map((rec) => (
              <Link
                key={rec.id}
                href={recommendationHref(rec)}
                className="flex min-h-[56px] items-center gap-3 rounded-xl bg-white border border-slate-100 px-3.5 py-3 transition-colors active:bg-slate-100"
              >
                <SceneIconTile hint={rec.title || rec.description} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="text-[15px] font-medium text-slate-800 lg:text-sm">{rec.title}</p>
                    {rec.priority === "high" && (
                      <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-600">优先</span>
                    )}
                  </div>
                  <p className="truncate text-[13px] text-slate-400 lg:text-xs">{rec.description}</p>
                </div>
                <span className="flex shrink-0 items-center gap-0.5 text-[13px] font-medium text-brand-600 lg:text-xs">
                  {rec.action_label}
                  <ChevronRight className="h-4 w-4" />
                </span>
              </Link>
            ))}
          </div>
        </div>
      )}

      {/* 加载中 */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-brand-600" />
          <span className="ml-3 text-[15px] text-slate-500 lg:text-sm">加载今日工作台...</span>
        </div>
      )}

      {!loading && (
        <>
          {/* 无门店状态：引导卡片 */}
          {(store === null || (storeError && !store)) && (
            <div className="space-y-6">
              <div className="rounded-2xl border border-brand-200 bg-white p-6 sm:p-8 shadow-sm">
                <div className="flex flex-col items-center text-center">
                  <Store className="mb-4 h-14 w-14 text-brand-600" />
                  <h3 className="mb-2 text-lg font-bold text-slate-900">
                    先完善门店资料，AI 才能帮你生成内容
                  </h3>
                  <p className="mb-6 max-w-md text-[15px] text-slate-500 lg:text-sm">
                    门店名称、价格、地址、Logo
                    和二维码会影响文案和海报效果。建议先花 3 分钟填写核心资料。
                  </p>

                  <div className="mb-6 w-full max-w-sm space-y-2 text-left">
                    {[
                      "填写门店名称、地址、电话",
                      "填写价格、会员卡和门店优势",
                      "上传 Logo 和微信二维码",
                    ].map((step, i) => (
                      <div key={i} className="flex items-center gap-3 rounded-lg bg-slate-50 px-4 py-3">
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand-600 text-xs font-bold text-white">
                          {i + 1}
                        </span>
                        <span className="text-[15px] text-slate-700 lg:text-sm">{step}</span>
                      </div>
                    ))}
                  </div>

                  <Link
                    href="/dashboard/store-settings"
                    className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-600 px-6 text-[15px] font-medium text-white hover:bg-brand-500 active:scale-[0.98] transition-transform lg:text-sm"
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
                    <h3 className="text-[17px] font-semibold text-slate-900 lg:text-base">常用任务</h3>
                  </div>
                  <div className="flex gap-3 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden lg:grid lg:grid-cols-3 lg:overflow-visible lg:pb-0">
                    {topCards.map((card) => {
                      const count = usageCounts[card.id] || 0;
                      return (
                        <button
                          key={card.id}
                          onClick={() => router.push(`/dashboard/workbench/${card.id}`)}
                          className="flex w-44 shrink-0 items-start gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-left hover:border-brand-200 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 active:scale-[0.98] cursor-pointer lg:w-auto"
                        >
                          <SceneIconTile hint={card.title} size="sm" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[15px] font-medium text-slate-900 truncate lg:text-sm">{card.title}</p>
                            <p className="mt-0.5 truncate text-xs text-slate-500">
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
              <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between gap-2 mb-4">
                  <div className="flex min-w-0 items-center gap-2">
                    <Store className="h-5 w-5 shrink-0 text-brand-600" />
                    <h3 className="truncate text-[17px] font-semibold text-slate-900 lg:text-base">{store.name}</h3>
                  </div>
                  <span
                    className={`shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${
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
                  <>
                    <div className="grid grid-cols-4 gap-2 text-center">
                      <div className="py-1">
                        <p className="text-2xl font-bold text-slate-900">
                          {dashboard.summary.total_generations}
                        </p>
                        <p className="text-[13px] text-slate-500 lg:text-xs">累计生成</p>
                      </div>
                      <div className="py-1">
                        <p className="text-2xl font-bold text-slate-900">
                          {dashboard.summary.today_generations}
                        </p>
                        <p className="text-[13px] text-slate-500 lg:text-xs">今日生成</p>
                      </div>
                      <Link href="/dashboard/history" className="rounded-lg py-1 hover:bg-slate-50 active:bg-slate-100 transition-colors">
                        <p className="text-2xl font-bold text-amber-500">
                          {dashboard.summary.favorite_count}
                        </p>
                        <p className="text-[13px] text-slate-500 lg:text-xs">收藏</p>
                      </Link>
                      <Link href="/dashboard/history" className="rounded-lg py-1 hover:bg-slate-50 active:bg-slate-100 transition-colors">
                        <p className="text-2xl font-bold text-emerald-500">
                          {dashboard.summary.good_count}
                        </p>
                        <p className="text-[13px] text-slate-500 lg:text-xs">效果好</p>
                      </Link>
                    </div>
                    <p className="mt-2 text-center text-xs text-slate-400">标过「效果好」的内容，AI 正在学习它们的风格</p>
                  </>
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
                <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <Crown className="h-5 w-5 text-amber-500" />
                      <h3 className="text-[17px] font-semibold text-slate-900 lg:text-base">本月使用情况</h3>
                    </div>
                    <span className="text-xs text-slate-400">
                      {new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long" })}
                    </span>
                  </div>

                  <div className="space-y-3">
                    {/* 成就视角：先看产出，再看余量 */}
                    {quota.used > 0 && (
                      <p className="text-[15px] text-slate-600 lg:text-sm">
                        本月已产出 <span className="text-2xl font-bold text-brand-600">{quota.used}</span> 条运营内容
                        <span className="text-xs text-slate-400">
                          ，按每条手写 20 分钟算，约省下 {Math.max(0.5, Math.round((quota.used * 20 / 60) * 2) / 2)} 小时
                        </span>
                      </p>
                    )}
                    {/* 生成次数 */}
                    <div>
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[15px] text-slate-600 lg:text-sm">AI 内容生成</span>
                        <span className="text-[15px] font-semibold text-slate-900 lg:text-sm">
                          {quota.used} / {quota.limit}
                        </span>
                      </div>
                      <div className="h-2.5 w-full rounded-full bg-slate-100 lg:h-2">
                        <div
                          className={`h-2.5 rounded-full transition-all lg:h-2 ${
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
                      <div className="flex items-center gap-2 rounded-xl bg-red-50 p-3">
                        <AlertCircle className="h-4 w-4 shrink-0 text-red-500" />
                        <p className="text-[15px] text-red-700 lg:text-sm">本月额度已用完，下月1日自动重置</p>
                      </div>
                    ) : quota.remaining <= 5 ? (
                      <div className="flex items-center gap-2 rounded-xl bg-amber-50 p-3">
                        <Clock className="h-4 w-4 shrink-0 text-amber-500" />
                        <p className="text-[15px] text-amber-700 lg:text-sm">本月剩余 {quota.remaining} 次，请合理使用</p>
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
                <div className="rounded-2xl border border-brand-200 bg-brand-50 p-4">
                  <div className="flex items-start gap-2">
                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                    <div>
                      {dashboard.tips.map((tip, i) => (
                        <p key={i} className="text-[15px] text-slate-700 lg:text-sm">
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
