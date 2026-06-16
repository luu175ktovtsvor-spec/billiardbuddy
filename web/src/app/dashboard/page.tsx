"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import { ROLE_TASKS } from "@/lib/role-workbench-config";
import { SceneIconTile } from "@/lib/scene-icons";
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

/** 推荐类目 → 标签 + 配色（让老板一眼知道"为什么推这个"） */
const CATEGORY_META: Record<string, { label: string; cls: string }> = {
  stage: { label: "阶段重点", cls: "bg-cyan-50 text-cyan-600" },
  focus: { label: "今日重点", cls: "bg-brand-50 text-brand-600" },
  frequent: { label: "常用", cls: "bg-slate-100 text-slate-500" },
  gap: { label: "补缺口", cls: "bg-amber-50 text-amber-600" },
  good: { label: "效果好", cls: "bg-emerald-50 text-emerald-600" },
  setup: { label: "完善资料", cls: "bg-red-50 text-red-500" },
  festival: { label: "节日", cls: "bg-pink-50 text-pink-500" },
  report: { label: "日报", cls: "bg-violet-50 text-violet-600" },
};

/**
 * 取前 N 条推荐，类目多样化，并**优先"懂这家店此刻"的个性化推荐**，再到通用周几建议：
 * 节日(时效) → 日报(时效) → 上次效果好复刻 → 你常用 → 补缺口 → 成长阶段/完善资料 → 通用周几重点(兜底)。
 * 这样活跃店首屏看到的是贴合自己的内容，而非"周X推什么"的通用日历；新店没有行为信号时，
 * 个性化项天然为空、自然回落到周几引导，不会变差。每类限量，避免一屏全是同一种。
 */
function pickTopRecommendations(recs: DashboardRecommendation[], n = 5): DashboardRecommendation[] {
  const CAP: Record<string, number> = { report: 1, stage: 2, focus: 3, frequent: 1, gap: 2, good: 1, setup: 1, festival: 2 };
  // 个性化("懂你"：good/frequent/gap)排在通用"周几重点"(focus)之前；festival/report 时效性强仍靠前。
  const RANK: Record<string, number> = { festival: 0, report: 1, good: 2, frequent: 3, gap: 4, stage: 5, setup: 5, focus: 6 };
  const rank = (r: DashboardRecommendation) => RANK[r.category || "focus"] ?? 6;
  const ordered = [...recs].sort((a, b) => rank(a) - rank(b));
  const seen = new Set<string>();
  const catCount: Record<string, number> = {};
  const out: DashboardRecommendation[] = [];
  for (const r of ordered) {
    if (seen.has(r.id)) continue;
    const cat = r.category || "focus";
    if (CAP[cat] != null && (catCount[cat] || 0) >= CAP[cat]) continue;
    seen.add(r.id);
    catCount[cat] = (catCount[cat] || 0) + 1;
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
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
} from "lucide-react";
import { OnboardingGuide } from "@/components/onboarding-guide";
import { MyTemplates } from "@/components/my-templates";

export default function DashboardPage() {
  const { user } = useAuth();
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [dashboard, setDashboard] = useState<DashboardTodayResponse | null>(null);
  const [dashboardError, setDashboardError] = useState(false);
  const [storeError, setStoreError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [quota, setQuota] = useState<{ used: number; limit: number; remaining: number } | null>(null);

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

    return () => { cancelled = true; };
  }, []);

  const isNewUser = store === null || (store && store.completeness < 30);

  return (
    <div>
      {/* 首次登录引导 */}
      {isNewUser && <OnboardingGuide />}

      {/* 顶部欢迎区：带名字/店名/时段的问候，"工具"变"搭档" */}
      <div className="mb-6">
        <h2 className="text-[28px] font-bold tracking-tight text-slate-900 lg:text-2xl">
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

      {/* 今日推荐：后端规则引擎 + 行为信号（你常用/补缺口），类目多样取前 5 条 */}
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
                    {CATEGORY_META[rec.category || "focus"] && (
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${CATEGORY_META[rec.category || "focus"].cls}`}>
                        {CATEGORY_META[rec.category || "focus"].label}
                      </span>
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
                      "填写台费、充值规则和门店优势",
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
              {/* 门店状态卡片 */}
              <div className="rounded-2xl bg-white p-5 shadow-sm">
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
                <div className="rounded-2xl bg-white p-5 shadow-sm">
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
