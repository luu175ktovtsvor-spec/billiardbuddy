"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface Plan {
  id: string;
  name: string;
  slug: string;
  price_monthly: number;
  generation_limit: number;
  token_limit: number;
  poster_limit: number;
  max_members: number;
  is_active: boolean;
}

export default function AdminPlansPage() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingPlan, setEditingPlan] = useState<Plan | null>(null);
  const [saving, setSaving] = useState(false);
  const token = typeof window !== "undefined" ? api.getToken() : "";

  const fetchPlans = () => {
    setLoading(true);
    fetch(`${api.baseUrl}/api/v1/admin/plans`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.json())
      .then((data) => setPlans(data || []))
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchPlans(); }, []);

  const handleSave = async () => {
    if (!editingPlan) return;
    setSaving(true);
    try {
      const params = new URLSearchParams();
      params.set("name", editingPlan.name);
      params.set("price_monthly", String(editingPlan.price_monthly));
      params.set("generation_limit", String(editingPlan.generation_limit));
      params.set("token_limit", String(editingPlan.token_limit));
      params.set("poster_limit", String(editingPlan.poster_limit));
      params.set("max_members", String(editingPlan.max_members));
      params.set("is_active", String(editingPlan.is_active));
      await fetch(`${api.baseUrl}/api/v1/admin/plans/${editingPlan.id}?${params}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
      setEditingPlan(null);
      fetchPlans();
    } catch {} finally { setSaving(false); }
  };

  if (loading) return <div className="py-20 text-center text-slate-500">加载中...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">套餐管理</h1>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {plans.map((plan) => (
          <div key={plan.id} className={`rounded-lg border bg-white p-6 shadow-sm ${!plan.is_active ? "opacity-50" : ""}`}>
            <div className="flex items-center justify-between mb-2">
              <h3 className="font-bold text-lg">{plan.name}</h3>
              {!plan.is_active && <span className="text-xs bg-red-100 text-red-700 px-2 py-0.5 rounded">已停用</span>}
            </div>
            <p className="text-2xl font-bold my-2">
              ¥{plan.price_monthly / 100}<span className="text-sm font-normal">/月</span>
            </p>
            <ul className="space-y-1 text-sm text-slate-600 mb-4">
              <li>每月 {plan.generation_limit} 次生成</li>
              <li>{plan.token_limit.toLocaleString()} tokens</li>
              <li>{plan.poster_limit} 张海报</li>
              <li>{plan.max_members} 个成员</li>
            </ul>
            <button onClick={() => setEditingPlan({ ...plan })} className="w-full px-3 py-2 text-sm border rounded-lg hover:bg-slate-50">编辑</button>
          </div>
        ))}
      </div>

      {/* 编辑弹窗 */}
      {editingPlan && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setEditingPlan(null)}>
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-lg font-bold mb-4">编辑套餐 - {editingPlan.name}</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">套餐名称</label>
                <input type="text" value={editingPlan.name} onChange={(e) => setEditingPlan({ ...editingPlan, name: e.target.value })} className="w-full rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">月价（分）</label>
                <input type="number" value={editingPlan.price_monthly} onChange={(e) => setEditingPlan({ ...editingPlan, price_monthly: Number(e.target.value) })} className="w-full rounded-lg px-3 py-2 text-sm" />
                <p className="text-xs text-slate-400 mt-1">显示为 ¥{editingPlan.price_monthly / 100}/月</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">每月生成次数</label>
                <input type="number" value={editingPlan.generation_limit} onChange={(e) => setEditingPlan({ ...editingPlan, generation_limit: Number(e.target.value) })} className="w-full rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Token限额</label>
                <input type="number" value={editingPlan.token_limit} onChange={(e) => setEditingPlan({ ...editingPlan, token_limit: Number(e.target.value) })} className="w-full rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">海报限额</label>
                <input type="number" value={editingPlan.poster_limit} onChange={(e) => setEditingPlan({ ...editingPlan, poster_limit: Number(e.target.value) })} className="w-full rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">最大成员数</label>
                <input type="number" value={editingPlan.max_members} onChange={(e) => setEditingPlan({ ...editingPlan, max_members: Number(e.target.value) })} className="w-full rounded-lg px-3 py-2 text-sm" />
              </div>
              <div className="flex items-center gap-2">
                <input type="checkbox" checked={editingPlan.is_active} onChange={(e) => setEditingPlan({ ...editingPlan, is_active: e.target.checked })} className="rounded border-slate-300" />
                <label className="text-sm">启用</label>
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => setEditingPlan(null)} className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50">取消</button>
              <button onClick={handleSave} disabled={saving} className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-500 disabled:opacity-50">{saving ? "保存中..." : "保存"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
