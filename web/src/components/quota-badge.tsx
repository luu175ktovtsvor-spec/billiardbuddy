"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface QuotaInfo {
  limit: number;
  used: number;
  remaining: number;
  planName: string | null;
}

/**
 * 配额徽标：显示"试用版/套餐名 · 本月剩余 N/M 次"，余量不足时升级为提额引导。
 * refreshKey 变化时重新拉取（生成完成后 +1 即可实时刷新）。
 * onQuota：把配额回传给宿主页面（额度用尽时禁用生成按钮，免得用户点了再撞 429）。
 */
export function QuotaBadge({
  refreshKey = 0,
  onQuota,
}: {
  refreshKey?: number;
  onQuota?: (quota: QuotaInfo) => void;
}) {
  const [quota, setQuota] = useState<QuotaInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getQuota()
      .then((res) => {
        if (cancelled) return;
        const info = {
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
  }, [refreshKey]);

  if (!quota) return null;

  const planLabel = quota.planName || "试用版";
  const low = quota.remaining > 0 && (quota.remaining <= 5 || quota.remaining / Math.max(quota.limit, 1) <= 0.2);

  if (quota.remaining <= 0) {
    return (
      <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
        <p className="text-xs text-red-700">
          {planLabel} · 本月额度已用完（{quota.limit} 次）。觉得好用？联系您的服务商提升额度，立即生效。
        </p>
      </div>
    );
  }

  if (low) {
    return (
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3">
        <p className="text-xs text-amber-700">
          {planLabel} · 本月仅剩 {quota.remaining} 次。额度不够用？联系您的服务商提升。
        </p>
      </div>
    );
  }

  return (
    <p className="mb-3 text-xs text-slate-400">
      {planLabel} · 本月剩余 {quota.remaining}/{quota.limit} 次
    </p>
  );
}
