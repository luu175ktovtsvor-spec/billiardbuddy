"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface RevenueStats {
  month_revenue: number;
  total_revenue: number;
  month_count: number;
  expiring_soon: number;
  expired: number;
}

export default function AdminRevenuePage() {
  const [stats, setStats] = useState<RevenueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const token = typeof window !== "undefined" ? api.getToken() : "";

  useEffect(() => {
    fetch(`${api.baseUrl}/api/v1/admin/revenue`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.json())
      .then((data) => setStats(data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="py-20 text-center text-slate-500">加载中...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">收入统计</h1>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-6 mb-8">
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">本月收入</p>
          <p className="text-3xl font-bold text-slate-900">¥{((stats?.month_revenue || 0) / 100).toLocaleString()}</p>
          <p className="text-xs text-slate-400 mt-1">{stats?.month_count || 0} 笔</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">累计收入</p>
          <p className="text-3xl font-bold text-slate-900">¥{((stats?.total_revenue || 0) / 100).toLocaleString()}</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">即将到期（7天内）</p>
          <p className="text-3xl font-bold text-amber-600">{stats?.expiring_soon || 0}</p>
          <p className="text-xs text-slate-400 mt-1">个订阅</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">已过期</p>
          <p className="text-3xl font-bold text-red-600">{stats?.expired || 0}</p>
          <p className="text-xs text-slate-400 mt-1">个订阅</p>
        </div>
      </div>

      <div className="rounded-lg border bg-white p-6 shadow-sm">
        <h2 className="text-lg font-bold mb-4">说明</h2>
        <ul className="space-y-2 text-sm text-slate-600">
          <li>• 收入按每笔收款流水统计，开通和续费各计一笔，计入实际收款月份</li>
          <li>• 如需查看详细收款记录，请到「订阅管理」页面</li>
          <li>• 「即将到期」指7天内到期的活跃订阅，建议主动联系续费</li>
        </ul>
      </div>
    </div>
  );
}
