"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

interface User {
  id: string;
  phone: string;
  name: string | null;
  is_active: boolean;
  is_admin: boolean;
  created_at: string;
}

interface Plan {
  id: string;
  name: string;
  slug: string;
  price_monthly: number;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const pageSize = 20;

  // 开通订阅弹窗
  const [showActivateModal, setShowActivateModal] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPlanSlug, setSelectedPlanSlug] = useState("free");
  const [months, setMonths] = useState(1);
  const [paymentNote, setPaymentNote] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [activating, setActivating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const token = api.getToken();
    fetch(`${api.baseUrl}/api/v1/admin/users?page=${page}&page_size=${pageSize}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data) => {
        if (!cancelled) {
          setUsers(data.items || []);
          setTotal(data.total || 0);
        }
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [page]);

  // 加载套餐列表
  useEffect(() => {
    const token = api.getToken();
    fetch(`${api.baseUrl}/api/v1/admin/plans`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data) => setPlans(data || []))
      .catch(() => {});
  }, []);

  const filteredUsers = users.filter((u) =>
    search ? u.phone.includes(search) || (u.name && u.name.includes(search)) : true
  );

  const handleActivate = async () => {
    if (!selectedUserId) return;
    setActivating(true);
    try {
      const token = api.getToken();
      const params = new URLSearchParams({
        plan_slug: selectedPlanSlug,
        months: String(months),
      });
      if (paymentNote) params.set("payment_note", paymentNote);
      if (paymentAmount) params.set("payment_amount", paymentAmount);

      await fetch(`${api.baseUrl}/api/v1/admin/users/${selectedUserId}/activate?${params}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      setShowActivateModal(false);
      setSelectedUserId(null);
      // 刷新列表
      setPage(page); // 触发 useEffect
    } catch {
      // 静默处理
    } finally {
      setActivating(false);
    }
  };

  if (loading) return <div className="py-20 text-center text-slate-500">加载中...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">用户管理</h1>

      {/* 搜索 */}
      <div className="mb-4">
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="搜索手机号或名称..."
          className="w-full max-w-sm rounded-lg border border-slate-200 px-4 py-2 text-sm focus:border-indigo-500 focus:outline-none"
        />
      </div>

      <div className="rounded-lg border bg-white shadow-sm">
        <table className="w-full">
          <thead className="border-b bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">手机号</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">名称</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">角色</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">注册时间</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredUsers.map((user) => (
              <tr key={user.id}>
                <td className="px-4 py-3 text-sm">{user.phone}</td>
                <td className="px-4 py-3 text-sm">{user.name || "-"}</td>
                <td className="px-4 py-3 text-sm">
                  {user.is_admin ? (
                    <span className="rounded bg-indigo-100 px-2 py-0.5 text-xs text-indigo-700">管理员</span>
                  ) : (
                    <span className="text-slate-500">用户</span>
                  )}
                </td>
                <td className="px-4 py-3 text-sm text-slate-500">
                  {new Date(user.created_at).toLocaleDateString("zh-CN")}
                </td>
                <td className="px-4 py-3 text-sm">
                  <button
                    onClick={() => {
                      setSelectedUserId(user.id);
                      setShowActivateModal(true);
                    }}
                    className="text-indigo-600 hover:underline text-sm"
                  >
                    开通订阅
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 分页 */}
      <div className="flex justify-between items-center mt-4">
        <span className="text-sm text-slate-500">共 {total} 个用户</span>
        <div className="flex gap-2">
          <button
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="px-3 py-1 border rounded text-sm disabled:opacity-50"
          >
            上一页
          </button>
          <span className="px-3 py-1 text-sm">第 {page} 页</span>
          <button
            disabled={filteredUsers.length < pageSize}
            onClick={() => setPage((p) => p + 1)}
            className="px-3 py-1 border rounded text-sm disabled:opacity-50"
          >
            下一页
          </button>
        </div>
      </div>

      {/* 开通订阅弹窗 */}
      {showActivateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold mb-4">开通订阅</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">选择套餐</label>
                <select
                  value={selectedPlanSlug}
                  onChange={(e) => setSelectedPlanSlug(e.target.value)}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                >
                  {plans.map((p) => (
                    <option key={p.slug} value={p.slug}>
                      {p.name} (¥{p.price_monthly / 100}/月)
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">开通月数</label>
                <input
                  type="number"
                  min={1}
                  max={12}
                  value={months}
                  onChange={(e) => setMonths(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">收款备注（选填）</label>
                <input
                  type="text"
                  value={paymentNote}
                  onChange={(e) => setPaymentNote(e.target.value)}
                  placeholder="如：微信转账"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">收款金额（选填）</label>
                <input
                  type="number"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                  placeholder="单位：分"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm"
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => {
                  setShowActivateModal(false);
                  setSelectedUserId(null);
                }}
                className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50"
              >
                取消
              </button>
              <button
                onClick={handleActivate}
                disabled={activating}
                className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-500 disabled:opacity-50"
              >
                {activating ? "开通中..." : "确认开通"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
