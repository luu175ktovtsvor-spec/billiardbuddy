"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface QuotaInfo {
  limit: number;
  used: number;
  remaining: number;
  planName: string | null;
}

type QuotaMode = "generation" | "poster";

/**
 * 配额徽标：显示"试用版/套餐名 · 本月剩余 N/M 次"，余量不足时升级为提额引导。
 * mode="poster" 时改读海报独立额度池（单位"张"，并提示生图更耗额度）。
 * refreshKey 变化时重新拉取（生成完成后 +1 即可实时刷新）。
 * onQuota：把配额回传给宿主页面（额度用尽时禁用生成按钮，免得用户点了再撞 429）。
 */
export function QuotaBadge({
  refreshKey = 0,
  mode = "generation",
  onQuota,
}: {
  refreshKey?: number;
  mode?: QuotaMode;
  onQuota?: (quota: QuotaInfo) => void;
}) {
  const [quota, setQuota] = useState<QuotaInfo | null>(null);
  const isPoster = mode === "poster";
  const unit = isPoster ? "张" : "次";
  const what = isPoster ? "海报" : "";

  useEffect(() => {
    let cancelled = false;
    api
      .getQuota()
      .then((res) => {
        if (cancelled) return;
        const info = isPoster
          ? {
              limit: res.monthly_poster_limit,
              used: res.monthly_posters_used,
              remaining: res.posters_remaining,
              planName: res.plan_name,
            }
          : {
              limit: res.monthly_generation_limit,
              used: res.monthly_generations_used,
              remaining: res.remaining,
              planName: res.plan_name,
            };
        setQuota(info);
        onQuota?.(info);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // onQuota 是宿主每次渲染的新箭头函数,放进依赖会无限请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, isPoster]);

  if (!quota) return null;

  const planLabel = quota.planName || "试用版";
  const ratioLow = quota.remaining / Math.max(quota.limit, 1) <= 0.2;
  // 文案池大(几百次)，绝对阈值≤5 合理；海报池小(3~60张)，全新 3/3 也撞≤5 会误报黄，故用相对阈值
  const low = quota.remaining > 0 && (isPoster ? (ratioLow || quota.remaining <= 1) : (quota.remaining <= 5 || ratioLow));

  if (quota.remaining <= 0) {
    return (
      <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
        <p className="text-xs text-red-700">
          {planLabel} · 本月{what}额度已用完（{quota.limit} {unit}）。
          {isPoster ? "生图算力成本较高，" : "觉得好用？"}联系您的服务商提升额度，立即生效。
        </p>
      </div>
    );
  }

  if (low) {
    return (
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <p className="text-xs text-amber-700">
          {planLabel} · 本月{what}仅剩 {quota.remaining} {unit}。
          {isPoster ? "生图较耗额度，" : ""}额度不够用？联系您的服务商提升。
        </p>
      </div>
    );
  }

  return (
    <p className="mb-3 text-xs text-slate-400">
      {planLabel} · 本月{what}剩余 {quota.remaining}/{quota.limit} {unit}
      {isPoster ? "（生图较耗额度，按张计）" : ""}
    </p>
  );
}
