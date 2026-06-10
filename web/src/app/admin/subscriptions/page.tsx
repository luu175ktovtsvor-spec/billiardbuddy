"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Subscription {
  id: string;
  store_name: string;
  user_phone: string;
  plan_name: string;
  status: string;
  period_start: string;
  period_end: string;
  payment_amount: number;
  payment_note: string;
}

export default function AdminSubscriptionsPage() {
  const [subs, setSubs] = useState<Subscription[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [statusFilter, setStatusFilter] = useState("");
  const [renewModal, setRenewModal] = useState<Subscription | null>(null);
  const [renewMonths, setRenewMonths] = useState(1);
  const [renewNote, setRenewNote] = useState("");
  const [renewAmount, setRenewAmount] = useState("");
  const [renewing, setRenewing] = useState(false);
  const pageSize = 20;
  const token = typeof window !== "undefined" ? api.getToken() : "";

  const fetchSubs = () => {
    setLoading(true);
    const params = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
    if (statusFilter) params.set("status", statusFilter);
    fetch(`${api.baseUrl}/api/v1/admin/subscriptions?${params}`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.json())
      .then((data) => { setSubs(data.items || []); setTotal(data.total || 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchSubs(); }, [page, statusFilter]);

  const handleRenew = async () => {
    if (!renewModal) return;
    setRenewing(true);
    try {
      const params = new URLSearchParams({ months: String(renewMonths) });
      if (renewNote) params.set("payment_note", renewNote);
      if (renewAmount) params.set("payment_amount", renewAmount);
      await fetch(`${api.baseUrl}/api/v1/admin/subscriptions/${renewModal.id}/renew?${params}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setRenewModal(null);
      fetchSubs();
    } catch {} finally { setRenewing(false); }
  };

  const getStatusColor = (status: string, periodEnd: string) => {
    if (status !== "active") return "bg-red-100 text-red-700";
    const daysLeft = (new Date(periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysLeft < 0) return "bg-red-100 text-red-700";
    if (daysLeft < 7) return "bg-amber-100 text-amber-700";
    return "bg-green-100 text-green-700";
  };

  const getStatusLabel = (status: string, periodEnd: string) => {
    if (status !== "active") return "已失效";
    const daysLeft = (new Date(periodEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysLeft < 0) return "已过期";
    if (daysLeft < 7) return "即将到期";
    return "正常";
  };

  if (loading) return <div className="py-20 text-center text-slate-500">加载中...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">订阅管理</h1>

      <div className="flex gap-3 mb-4">
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
          <option value="">全部状态</option>
          <option value="active">活跃</option>
        </select>
      </div>

      <div className="rounded-lg border bg-white shadow-sm">
        <table className="w-full">
          <thead className="border-b bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">门店</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">用户手机</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">套餐</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">状态</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">到期时间</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">收款金额</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {subs.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-3 text-sm">{s.store_name}</td>
                <td className="px-4 py-3 text-sm">{s.user_phone}</td>
                <td className="px-4 py-3 text-sm">{s.plan_name}</td>
                <td className="px-4 py-3 text-sm">
                  <span className={`rounded px-2 py-0.5 text-xs ${getStatusColor(s.status, s.period_end)}`}>
                    {getStatusLabel(s.status, s.period_end)}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-slate-500">{new Date(s.period_end).toLocaleDateString("zh-CN")}</td>
                <td className="px-4 py-3 text-sm">{s.payment_amount ? `¥${s.payment_amount / 100}` : "-"}</td>
                <td className="px-4 py-3 text-sm">
                  <button onClick={() => { setRenewModal(s); setRenewMonths(1); setRenewNote(""); setRenewAmount(""); }} className="text-indigo-600 hover:underline">续费</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-between items-center mt-4">
        <span className="text-sm text-slate-500">共 {total} 条</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1 border rounded text-sm disabled:opacity-50">上一页</button>
          <span className="px-3 py-1 text-sm">第 {page} 页</span>
          <button disabled={subs.length < pageSize} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 border rounded text-sm disabled:opacity-50">下一页</button>
        </div>
      </div>

      {/* 续费弹窗 */}
      {renewModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setRenewModal(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">续费 - {renewModal.store_name}</h3>
            <p className="text-sm text-slate-500 mb-4">当前到期：{new Date(renewModal.period_end).toLocaleDateString("zh-CN")}</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">续费月数</label>
                <input type="number" min={1} max={24} value={renewMonths} onChange={(e) => setRenewMonths(Number(e.target.value))} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">收款备注（选填）</label>
                <input type="text" value={renewNote} onChange={(e) => setRenewNote(e.target.value)} placeholder="如：微信转账" className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">收款金额（选填，单位：分）</label>
                <input type="number" value={renewAmount} onChange={(e) => setRenewAmount(e.target.value)} className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setRenewModal(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50">取消</button>
              <button onClick={handleRenew} disabled={renewing} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50">{renewing ? "续费中..." : "确认续费"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
