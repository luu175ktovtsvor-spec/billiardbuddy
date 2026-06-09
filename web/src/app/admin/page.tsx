"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface DashboardStats {
  total_users: number;
  total_stores: number;
  total_generations: number;
}

export default function AdminDashboard() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const token = api.getToken();
    fetch(`${api.baseUrl}/api/v1/admin/dashboard`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setStats(data); })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  if (loading) return <div className="py-20 text-center text-slate-500">加载中...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">管理员总览</h1>
      <div className="grid grid-cols-3 gap-6">
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
      </div>
    </div>
  );
}
