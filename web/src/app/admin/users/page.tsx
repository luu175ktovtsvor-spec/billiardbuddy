"use client";

import { formatDateTime } from "@/lib/utils";
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

interface UserDetail {
  user: User;
  store: { id: string; name: string; city: string } | null;
  subscription: { plan_name: string; status: string; period_end: string; payment_amount: number; payment_note: string } | null;
  quota: { monthly_generation_limit: number; monthly_generations_used: number; monthly_tokens_used: number } | null;
  stats: { total_generations: number };
  recent_generations: { id: string; type: string; sub_type: string; created_at: string }[];
}

interface Plan {
  id: string;
  name: string;
  slug: string;
  price_monthly: number;
  is_active: boolean;
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const pageSize = 20;

  // 用户详情
  const [detailUser, setDetailUser] = useState<UserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // 开通订阅弹窗
  const [showActivateModal, setShowActivateModal] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string | null>(null);

  // 调整配额弹窗（不动套餐，直接给单店提额）
  const [showQuotaModal, setShowQuotaModal] = useState(false);
  const [quotaUserId, setQuotaUserId] = useState<string | null>(null);
  const [quotaGenLimit, setQuotaGenLimit] = useState("");
  const [quotaSaving, setQuotaSaving] = useState(false);
  const [quotaError, setQuotaError] = useState("");

  // 重置密码弹窗
  const [showResetModal, setShowResetModal] = useState(false);
  const [resetUserId, setResetUserId] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [resetSaving, setResetSaving] = useState(false);
  const [resetError, setResetError] = useState("");
  const [plans, setPlans] = useState<Plan[]>([]);
  const [selectedPlanSlug, setSelectedPlanSlug] = useState("free");
  const [months, setMonths] = useState(1);
  const [paymentNote, setPaymentNote] = useState("");
  const [paymentAmount, setPaymentAmount] = useState("");
  const [activating, setActivating] = useState(false);

  const token = typeof window !== "undefined" ? api.getToken() : "";

  const fetchUsers = () => {
    setLoading(true);
    fetch(`${api.baseUrl}/api/v1/admin/users?page=${page}&page_size=${pageSize}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then((res) => res.json())
      .then((data) => { setUsers(data.items || []); setTotal(data.total || 0); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchUsers(); }, [page]);

  useEffect(() => {
    fetch(`${api.baseUrl}/api/v1/admin/plans`, { headers: { Authorization: `Bearer ${token}` } })
      .then((res) => res.json())
      .then((data) => setPlans((data || []).filter((p: Plan) => p.is_active))) // 开通下拉只给可用套餐
      .catch(() => {});
  }, []);

  const filteredUsers = users.filter((u) =>
    search ? u.phone.includes(search) || (u.name && u.name.includes(search)) : true
  );

  const handleViewDetail = async (userId: string) => {
    setDetailLoading(true);
    try {
      const res = await fetch(`${api.baseUrl}/api/v1/admin/users/${userId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { setDetailUser(null); alert("加载用户详情失败"); return; } // 否则把错误JSON当data渲染会崩
      const data = await res.json();
      setDetailUser(data);
    } catch { setDetailUser(null); }
    finally { setDetailLoading(false); }
  };

  const handleToggleStatus = async (userId: string) => {
    try {
      const res = await fetch(`${api.baseUrl}/api/v1/admin/users/${userId}/status`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) { alert("操作失败，请重试"); return; }
      fetchUsers();
    } catch { alert("网络错误，请重试"); }
  };

  const handleActivate = async () => {
    if (!selectedUserId) return;
    setActivating(true);
    try {
      const params = new URLSearchParams({ plan_slug: selectedPlanSlug, months: String(months) });
      if (paymentNote) params.set("payment_note", paymentNote);
      if (paymentAmount) params.set("payment_amount", paymentAmount);
      const res = await fetch(`${api.baseUrl}/api/v1/admin/users/${selectedUserId}/activate?${params}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const d = await res.json().catch(() => null);
        alert(d?.detail || "开通失败，请重试"); // 静默会让"看似开通成功实则没扣费/没开通"
        return;
      }
      setShowActivateModal(false);
      setSelectedUserId(null);
      fetchUsers();
    } catch { alert("网络错误，请重试"); } finally { setActivating(false); }
  };

  const handleAdjustQuota = async () => {
    if (!quotaUserId) return;
    setQuotaSaving(true);
    setQuotaError("");
    try {
      const params = new URLSearchParams();
      if (quotaGenLimit) params.set("generation_limit", quotaGenLimit);
      const res = await fetch(`${api.baseUrl}/api/v1/admin/users/${quotaUserId}/quota?${params}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setQuotaError(data?.detail || `调整失败 (${res.status})`);
        return;
      }
      setShowQuotaModal(false);
      setQuotaUserId(null);
      setQuotaGenLimit("");
    } catch {
      setQuotaError("网络错误，请重试");
    } finally {
      setQuotaSaving(false);
    }
  };

  const handleResetPassword = async () => {
    if (!resetUserId) return;
    if (newPassword.length < 8) { setResetError("新密码至少 8 位"); return; }
    if (!confirm("确定将该用户密码重置为新密码?用户数据不受影响")) return;
    setResetSaving(true);
    setResetError("");
    try {
      const res = await fetch(`${api.baseUrl}/api/v1/admin/users/${resetUserId}/password?new_password=${encodeURIComponent(newPassword)}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setResetError(data?.detail || `重置失败 (${res.status})`);
        return;
      }
      setShowResetModal(false);
      setResetUserId(null);
      setNewPassword("");
      alert("已重置，请把新密码告知用户");
    } catch {
      setResetError("网络错误，请重试");
    } finally {
      setResetSaving(false);
    }
  };

  if (loading) return <div className="py-20 text-center text-slate-500">加载中...</div>;

  return (
    <div>
      <h1 className="text-2xl font-bold mb-6">用户管理</h1>

      <div className="mb-4">
        <input type="text" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="搜索手机号或名称..." className="w-full max-w-sm rounded-lg px-4 py-2 text-sm focus:border-brand-500 focus:outline-none" />
      </div>

      <div className="rounded-lg border bg-white shadow-sm">
        <table className="w-full">
          <thead className="border-b bg-slate-50">
            <tr>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">手机号</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">名称</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">状态</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">角色</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">注册时间</th>
              <th className="px-4 py-3 text-left text-sm font-medium text-slate-600">操作</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {filteredUsers.map((u) => (
              <tr key={u.id}>
                <td className="px-4 py-3 text-sm">{u.phone}</td>
                <td className="px-4 py-3 text-sm">{u.name || "-"}</td>
                <td className="px-4 py-3 text-sm">
                  <span className={`rounded px-2 py-0.5 text-xs ${u.is_active ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}>
                    {u.is_active ? "正常" : "已禁用"}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm">
                  {u.is_admin ? <span className="rounded bg-brand-100 px-2 py-0.5 text-xs text-brand-700">管理员</span> : <span className="text-slate-500">用户</span>}
                </td>
                <td className="px-4 py-3 text-sm text-slate-500">{new Date(u.created_at).toLocaleDateString("zh-CN")}</td>
                <td className="px-4 py-3 text-sm">
                  <div className="flex gap-2">
                    <button onClick={() => handleViewDetail(u.id)} className="text-brand-600 hover:underline">详情</button>
                    <button onClick={() => { setSelectedUserId(u.id); setShowActivateModal(true); }} className="text-brand-600 hover:underline">开通订阅</button>
                    <button onClick={() => { setQuotaUserId(u.id); setQuotaError(""); setShowQuotaModal(true); }} className="text-brand-600 hover:underline">调整配额</button>
                    <button onClick={() => { setResetUserId(u.id); setNewPassword(""); setResetError(""); setShowResetModal(true); }} className="text-brand-600 hover:underline">重置密码</button>
                    <button onClick={() => handleToggleStatus(u.id)} className={`${u.is_active ? "text-red-600" : "text-green-600"} hover:underline`}>
                      {u.is_active ? "禁用" : "启用"}
                    </button>
                  </div>
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
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="px-3 py-1 border rounded text-sm disabled:opacity-50">上一页</button>
          <span className="px-3 py-1 text-sm">第 {page} 页</span>
          <button disabled={filteredUsers.length < pageSize} onClick={() => setPage((p) => p + 1)} className="px-3 py-1 border rounded text-sm disabled:opacity-50">下一页</button>
        </div>
      </div>

      {/* 用户详情弹窗 */}
      {detailUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={() => setDetailUser(null)}>
          <div className="w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-xl bg-white p-6 shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold">用户详情</h3>
              <button onClick={() => setDetailUser(null)} className="text-slate-400 hover:text-slate-600">✕</button>
            </div>
            {detailLoading ? <p className="text-slate-500">加载中...</p> : (
              <div className="space-y-4">
                <div className="rounded-lg border p-3">
                  <p className="text-sm font-medium text-slate-700 mb-2">基本信息</p>
                  <p className="text-sm text-slate-600">手机号：{detailUser.user.phone}</p>
                  <p className="text-sm text-slate-600">名称：{detailUser.user.name || "-"}</p>
                  <p className="text-sm text-slate-600">状态：<span className={detailUser.user.is_active ? "text-green-600" : "text-red-600"}>{detailUser.user.is_active ? "正常" : "已禁用"}</span></p>
                  <p className="text-sm text-slate-600">注册时间：{formatDateTime(detailUser.user.created_at)}</p>
                </div>
                {detailUser.store && (
                  <div className="rounded-lg border p-3">
                    <p className="text-sm font-medium text-slate-700 mb-2">门店信息</p>
                    <p className="text-sm text-slate-600">门店名：{detailUser.store.name}</p>
                    <p className="text-sm text-slate-600">城市：{detailUser.store.city}</p>
                  </div>
                )}
                {detailUser.subscription && (
                  <div className="rounded-lg border p-3">
                    <p className="text-sm font-medium text-slate-700 mb-2">订阅信息</p>
                    <p className="text-sm text-slate-600">套餐：{detailUser.subscription.plan_name}</p>
                    <p className="text-sm text-slate-600">状态：<span className={detailUser.subscription.status === "active" ? "text-green-600" : "text-red-600"}>{detailUser.subscription.status}</span></p>
                    <p className="text-sm text-slate-600">到期时间：{new Date(detailUser.subscription.period_end).toLocaleDateString("zh-CN")}</p>
                  </div>
                )}
                {detailUser.quota && (
                  <div className="rounded-lg border p-3">
                    <p className="text-sm font-medium text-slate-700 mb-2">使用量</p>
                    <p className="text-sm text-slate-600">本月生成：{detailUser.quota.monthly_generations_used} / {detailUser.quota.monthly_generation_limit}</p>
                    <p className="text-sm text-slate-600">总生成次数：{detailUser.stats.total_generations}</p>
                  </div>
                )}
                {detailUser.recent_generations.length > 0 && (
                  <div className="rounded-lg border p-3">
                    <p className="text-sm font-medium text-slate-700 mb-2">最近生成记录</p>
                    {detailUser.recent_generations.slice(0, 5).map((g) => (
                      <p key={g.id} className="text-xs text-slate-500">{g.type}/{g.sub_type} - {formatDateTime(g.created_at)}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 开通订阅弹窗 */}
      {showActivateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold mb-4">开通订阅</h3>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">选择套餐</label>
                <select value={selectedPlanSlug} onChange={(e) => setSelectedPlanSlug(e.target.value)} className="w-full rounded-lg px-3 py-2 text-sm">
                  {plans.map((p) => <option key={p.slug} value={p.slug}>{p.name} (¥{p.price_monthly / 100}/月)</option>)}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">开通月数</label>
                <input type="number" min={1} max={12} value={months} onChange={(e) => setMonths(Number(e.target.value))} className="w-full rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">收款备注（选填）</label>
                <input type="text" value={paymentNote} onChange={(e) => setPaymentNote(e.target.value)} placeholder="如：微信转账" className="w-full rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">收款金额（选填，单位：分）</label>
                <input type="number" value={paymentAmount} onChange={(e) => setPaymentAmount(e.target.value)} placeholder="单位：分" className="w-full rounded-lg px-3 py-2 text-sm" />
              </div>
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => { setShowActivateModal(false); setSelectedUserId(null); }} className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50">取消</button>
              <button onClick={handleActivate} disabled={activating} className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-500 disabled:opacity-50">{activating ? "开通中..." : "确认开通"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 调整配额弹窗：不动套餐，直接给该用户门店的本月上限提额（试用转化场景） */}
      {showQuotaModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold mb-1">调整配额</h3>
            <p className="text-xs text-slate-400 mb-4">设置该门店每月可生成次数，立即生效。token 用量上限会自动按次数配套，无需单独设置。开通/续费套餐会重新覆盖此值。</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">每月生成次数上限</label>
                <input type="number" min={0} value={quotaGenLimit} onChange={(e) => setQuotaGenLimit(e.target.value)} placeholder="如：100（试用默认 30）" className="w-full rounded-lg px-3 py-2 text-sm" />
              </div>
              {quotaError && <p className="text-xs text-red-600">{quotaError}</p>}
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => { setShowQuotaModal(false); setQuotaUserId(null); setQuotaError(""); }} className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50">取消</button>
              <button onClick={handleAdjustQuota} disabled={quotaSaving || !quotaGenLimit} className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-500 disabled:opacity-50">{quotaSaving ? "保存中..." : "确认调整"}</button>
            </div>
          </div>
        </div>
      )}

      {/* 重置密码弹窗：管理员代用户设置新密码，用户数据不受影响 */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-bold mb-1">重置密码</h3>
            <p className="text-xs text-slate-400 mb-4">为该用户设置新密码，重置后请把新密码告知用户。</p>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">新密码（至少 8 位）</label>
                <input type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} placeholder="输入新密码" className="w-full rounded-lg px-3 py-2 text-sm" />
              </div>
              {resetError && <p className="text-xs text-red-600">{resetError}</p>}
            </div>
            <div className="flex justify-end gap-3 mt-6">
              <button onClick={() => { setShowResetModal(false); setResetUserId(null); setNewPassword(""); setResetError(""); }} className="px-4 py-2 text-sm border rounded-lg hover:bg-slate-50">取消</button>
              <button onClick={handleResetPassword} disabled={resetSaving || newPassword.length < 8} className="px-4 py-2 text-sm bg-brand-600 text-white rounded-lg hover:bg-brand-500 disabled:opacity-50">{resetSaving ? "重置中..." : "确认重置"}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
