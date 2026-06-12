"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface DashboardStats {
  total_users: number;
  total_stores: number;
  total_generations: number;
}

interface RevenueStats {
  month_revenue: number;
  total_revenue: number;
  month_count: number;
  expiring_soon: number;
  expired: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [revenue, setRevenue] = useState<RevenueStats | null>(null);
  const [loading, setLoading] = useState(true);
  const token = typeof window !== "undefined" ? api.getToken() : "";

  useEffect(() => {
    Promise.all([
      fetch(`${api.baseUrl}/api/v1/admin/dashboard`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()),
      fetch(`${api.baseUrl}/api/v1/admin/revenue`, { headers: { Authorization: `Bearer ${token}` } }).then((r) => r.json()),
    ])
      .then(([s, r]) => { setStats(s); setRevenue(r); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <div className="py-20 text-center text-slate-500">加载中...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">管理员总览</h1>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-8">
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">总用户数</p>
          <p className="text-3xl font-bold text-slate-900">{stats?.total_users ?? 0}</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">总门店数</p>
          <p className="text-3xl font-bold text-slate-900">{stats?.total_stores ?? 0}</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">总生成次数</p>
          <p className="text-3xl font-bold text-slate-900">{stats?.total_generations ?? 0}</p>
        </div>
        <div className="rounded-lg border bg-white p-6 shadow-sm">
          <p className="text-sm text-slate-500">本月收入</p>
          <p className="text-3xl font-bold text-emerald-600">¥{((revenue?.month_revenue || 0) / 100).toLocaleString()}</p>
        </div>
      </div>

      {(revenue?.expiring_soon || revenue?.expired) ? (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 mb-6">
          <p className="text-sm font-medium text-amber-700">
            ⚠️ {revenue?.expiring_soon || 0} 个订阅即将到期（7天内），{revenue?.expired || 0} 个已过期
          </p>
          <a href="/admin/subscriptions" className="text-sm text-brand-600 hover:underline mt-1 inline-block">去查看 →</a>
        </div>
      ) : null}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <a href="/admin/users" className="rounded-lg border bg-white p-6 shadow-sm hover:shadow-md transition-shadow">
          <h3 className="font-bold text-lg mb-2">用户管理</h3>
          <p className="text-sm text-slate-500">查看用户、开通订阅、禁用/启用</p>
        </a>
        <a href="/admin/subscriptions" className="rounded-lg border bg-white p-6 shadow-sm hover:shadow-md transition-shadow">
          <h3 className="font-bold text-lg mb-2">订阅管理</h3>
          <p className="text-sm text-slate-500">查看订阅状态、续费、到期提醒</p>
        </a>
        <a href="/admin/plans" className="rounded-lg border bg-white p-6 shadow-sm hover:shadow-md transition-shadow">
          <h3 className="font-bold text-lg mb-2">套餐管理</h3>
          <p className="text-sm text-slate-500">编辑套餐价格和权益</p>
        </a>
        <a href="/admin/revenue" className="rounded-lg border bg-white p-6 shadow-sm hover:shadow-md transition-shadow">
          <h3 className="font-bold text-lg mb-2">收入统计</h3>
          <p className="text-sm text-slate-500">查看收入数据和到期提醒</p>
        </a>
      </div>
    </div>
  );
}
