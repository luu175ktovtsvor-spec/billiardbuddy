"use client";

import { useEffect, useState } from "react";
import { Loader2, Wallet, Coins } from "lucide-react";
import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { PageHeader } from "@/components/layout/page-header";

type Cost = {
  month: string;
  total_tokens: number;
  total_count: number;
  est_cost_yuan: number;
  rate_per_m_tokens: number;
  by_feature: { feature: string; tokens: number; count: number }[];
};

const fmtTokens = (n: number) => (n >= 10000 ? (n / 10000).toFixed(n >= 100000 ? 0 : 1) + " 万" : String(n));

export default function UsagePage() {
  const [data, setData] = useState<Cost | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");

  useEffect(() => {
    let cancelled = false;
    api
      .getCost()
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setErr(getErrorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const maxT = data && data.by_feature.length ? Math.max(1, ...data.by_feature.map((f) => f.tokens)) : 1;

  return (
    <div className="mx-auto max-w-2xl pb-10">
      <PageHeader title="用量" />

      {loading ? (
        <div className="flex items-center justify-center py-20 text-slate-400">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      ) : err ? (
        <p className="px-1 py-10 text-center text-sm text-rose-500">{err}</p>
      ) : data ? (
        <div className="flex flex-col gap-4">
          {/* 总览卡 */}
          <div className="rounded-2xl bg-gradient-to-br from-brand-600 to-brand-500 px-5 py-5 text-white shadow-sm">
            <p className="flex items-center gap-1.5 text-[13px] opacity-90">
              <Wallet className="h-4 w-4" /> {data.month} · 本月 AI 用量（粗估）
            </p>
            <p className="mt-1 text-[34px] font-bold leading-tight">¥{data.est_cost_yuan}</p>
            <div className="mt-2 flex gap-5 text-[13px] opacity-90">
              <span>用了 {fmtTokens(data.total_tokens)} tokens</span>
              <span>生成 {data.total_count} 次</span>
            </div>
          </div>

          {/* 说明：token精确、花费粗估 */}
          <p className="flex items-start gap-1.5 rounded-xl bg-amber-50 px-3 py-2.5 text-[12.5px] leading-relaxed text-amber-700">
            <Coins className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              token 数是<b>精确</b>的（逐条记的）；花费按 ¥{data.rate_per_m_tokens}/百万 tokens <b>粗估</b>——
              你用的是自己的模型 key，实际花费以你的供应商账单为准。
            </span>
          </p>

          {/* 按功能拆 */}
          {data.by_feature.length > 0 && (
            <div className="rounded-2xl bg-white px-4 py-4 shadow-sm">
              <p className="mb-3 text-[13px] font-medium text-slate-500">这个月花在哪了</p>
              <div className="flex flex-col gap-2.5">
                {data.by_feature.map((f) => (
                  <div key={f.feature}>
                    <div className="mb-1 flex items-baseline justify-between text-[13px]">
                      <span className="text-slate-700">{f.feature}</span>
                      <span className="text-slate-400">
                        {fmtTokens(f.tokens)} · {f.count} 次
                      </span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-slate-100">
                      <div
                        className="h-full rounded-full bg-brand-500"
                        style={{ width: `${Math.max(4, Math.round((f.tokens / maxT) * 100))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {data.total_count === 0 && (
            <p className="px-1 py-6 text-center text-sm text-slate-400">这个月还没用过，去对话里让管家干点活吧。</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
