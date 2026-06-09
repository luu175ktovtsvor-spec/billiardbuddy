"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import type { StoreResponse } from "@/types/store";
import type { DashboardRecommendation, DashboardTodayResponse } from "@/types/dashboard";
import {
  Sparkles,
  Store,
  History,
  ImageIcon,
  Loader2,
  AlertCircle,
  ArrowRight,
  TrendingUp,
  FileText,
  CheckCircle,
} from "lucide-react";
import { OnboardingGuide } from "@/components/onboarding-guide";

const PRIORITY_COLORS: Record<string, string> = {
  high: "bg-red-50 border border-red-200 text-red-600",
  medium: "bg-amber-50 border border-amber-200 text-amber-600",
  low: "bg-slate-50 border border-slate-200 text-slate-500",
};

const PRIORITY_LABELS: Record<string, string> = {
  high: "优先",
  medium: "推荐",
  low: "可选",
};

function recommendationHref(rec: DashboardRecommendation): string {
  const params = new URLSearchParams();
  const payload = rec.suggested_payload ?? {};

  if (rec.action_type === "generate_copywriting") {
    const subType = typeof payload.sub_type === "string" ? payload.sub_type : "moments";
    params.set("intent", subType === "group_notice" ? "发一条群公告" : "发一条朋友圈");
  } else if (rec.action_type === "generate_activity") {
    params.set("intent", "策划一个活动");
  } else if (rec.action_type === "generate_operation") {
    params.set("intent", "生成运营内容");
  } else if (rec.action_type === "generate_workbench") {
    if (typeof payload.user_intent === "string") {
      params.set("intent", payload.user_intent);
    }
  } else if (rec.action_type === "generate_poster") {
    return "/dashboard/posters";
  }

  for (const [key, value] of Object.entries(payload)) {
    if (key === "sub_type" || key === "user_intent") continue;
    if (typeof value === "string" && value.trim()) {
      params.set(key, value);
    }
  }

  const qs = params.toString();
  return qs ? `/dashboard/workbench?${qs}` : "/dashboard/workbench";
}

export default function DashboardPage() {
  const { user } = useAuth();
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [dashboard, setDashboard] = useState<DashboardTodayResponse | null>(null);
  const [dashboardError, setDashboardError] = useState(false);
  const [storeError, setStoreError] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function loadData() {
      setLoading(true);
      const [storeResult, dashResult] = await Promise.allSettled([
        api.getMyStore(),
        api.getTodayDashboard(),
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

      {/* 顶部欢迎区 */}
      <div className="mb-6">
        <h2 className="text-xl font-bold text-slate-900">今日工作台</h2>
        {dashboard && (
          <p className="mt-1 text-sm text-slate-500">{dashboard.greeting}</p>
        )}
      </div>

      {/* 加载中 */}
      {loading && (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="h-8 w-8 animate-spin text-indigo-600" />
          <span className="ml-3 text-slate-500">加载今日工作台...</span>
        </div>
      )}

      {!loading && (
        <>
          {/* 无门店状态：引导卡片 */}
          {(store === null || (storeError && !store)) && (
            <div className="space-y-6">
              <div className="rounded-lg border border-indigo-200 bg-white p-6 sm:p-8 shadow-sm">
                <div className="flex flex-col items-center text-center">
                  <Store className="mb-4 h-14 w-14 text-indigo-600" />
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
                        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-indigo-600 text-xs font-bold text-white">
                          {i + 1}
                        </span>
                        <span className="text-sm text-slate-700">{step}</span>
                      </div>
                    ))}
                  </div>

                  <Link
                    href="/dashboard/store-settings"
                    className="inline-flex items-center gap-2 rounded-md bg-indigo-600 px-5 py-2.5 text-sm font-medium text-white hover:bg-indigo-500"
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
              <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
                <div className="flex items-center justify-between mb-4">
                  <div className="flex items-center gap-2">
                    <Store className="h-5 w-5 text-indigo-600" />
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

                {/* 统计信息 */}
                {dashboard ? (
                  <div className="grid grid-cols-3 gap-4 text-center">
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
                    <div>
                      {dashboard.summary.latest_generation_at ? (
                        <>
                          <p className="text-sm font-medium text-slate-900">
                            {new Date(dashboard.summary.latest_generation_at).toLocaleTimeString(
                              "zh-CN",
                              { hour: "2-digit", minute: "2-digit" }
                            )}
                          </p>
                          <p className="text-xs text-slate-500">最近生成</p>
                        </>
                      ) : (
                        <>
                          <p className="text-sm text-slate-400">-</p>
                          <p className="text-xs text-slate-500">暂无记录</p>
                        </>
                      )}
                    </div>
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

              {/* 今日推荐区 */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <TrendingUp className="h-5 w-5 text-indigo-600" />
                  <h3 className="font-semibold text-slate-900">今日推荐</h3>
                </div>

                {dashboard && dashboard.recommendations.length > 0 ? (
                  <div className="space-y-3">
                    {dashboard.recommendations.map((rec) => (
                      <div
                        key={rec.id}
                        className="rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-300 transition-colors shadow-sm"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span
                                className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${
                                  PRIORITY_COLORS[rec.priority] || PRIORITY_COLORS.medium
                                }`}
                              >
                                {PRIORITY_LABELS[rec.priority] || rec.priority}
                              </span>
                              <span className="font-medium text-slate-900">{rec.title}</span>
                            </div>
                            <p className="text-sm text-slate-500">{rec.description}</p>
                          </div>
                          <Link
                            href={recommendationHref(rec)}
                            className="shrink-0 inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3.5 py-2 text-sm font-medium text-white hover:bg-indigo-500"
                          >
                            {rec.action_label}
                            <ArrowRight className="h-3.5 w-3.5" />
                          </Link>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : dashboardError ? (
                  <div className="rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
                    <AlertCircle className="mx-auto h-8 w-8 text-amber-600 mb-2" />
                    <p className="text-sm text-slate-500">今日推荐加载失败，请稍后重试</p>
                  </div>
                ) : (
                  <div className="rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
                    <p className="text-sm text-slate-500">
                      今天暂无特别推荐，可以随时生成运营内容。
                    </p>
                  </div>
                )}
              </div>

              {/* Tips 提示 */}
              {dashboard && dashboard.tips.length > 0 && (
                <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
                  <div className="flex items-start gap-2">
                    <CheckCircle className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
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

          {/* 快捷入口 */}
          <div className={store ? "" : "opacity-50"}>
            {!store && (
              <h3 className="mb-3 text-sm font-medium text-slate-400">快捷入口</h3>
            )}
            {store && (
              <h3 className="mb-3 font-semibold text-slate-900">快捷入口</h3>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Link
                href="/dashboard/workbench"
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 hover:border-indigo-200 transition-colors shadow-sm"
              >
                <Sparkles className="h-5 w-5 shrink-0 text-indigo-600" />
                <div>
                  <p className="text-sm font-medium text-slate-900">AI 运营内容生成</p>
                  <p className="text-xs text-slate-500">文案、群公告、活动方案</p>
                </div>
              </Link>

              <Link
                href="/dashboard/posters"
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 hover:border-indigo-200 transition-colors shadow-sm"
              >
                <ImageIcon className="h-5 w-5 shrink-0 text-indigo-600" />
                <div>
                  <p className="text-sm font-medium text-slate-900">AI 生图</p>
                  <p className="text-xs text-slate-500">自动合成宣传海报</p>
                </div>
              </Link>

              <Link
                href="/dashboard/history"
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 hover:border-indigo-200 transition-colors shadow-sm"
              >
                <History className="h-5 w-5 shrink-0 text-indigo-600" />
                <div>
                  <p className="text-sm font-medium text-slate-900">生成历史</p>
                  <p className="text-xs text-slate-500">查看历史生成内容</p>
                </div>
              </Link>

              <Link
                href="/dashboard/store-settings"
                className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-4 hover:border-indigo-200 transition-colors shadow-sm"
              >
                <FileText className="h-5 w-5 shrink-0 text-indigo-600" />
                <div>
                  <p className="text-sm font-medium text-slate-900">门店资料</p>
                  <p className="text-xs text-slate-500">编辑门店信息和上传素材</p>
                </div>
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
