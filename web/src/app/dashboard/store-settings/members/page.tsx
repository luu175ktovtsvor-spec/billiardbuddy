"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import { PageHeader } from "@/components/layout/page-header";
import { Copy, Plus, Trash2, ToggleLeft, ToggleRight, UserPlus, Users } from "lucide-react";

interface Member {
  user_id: string;
  name: string | null;
  phone: string;
  role: string;
  joined_at: string;
}

interface Invitation {
  id: string;
  code: string;
  role: string;
  is_active: boolean;
  max_uses: number | null;
  use_count: number;
  expires_at: string | null;
  created_at: string;
}

const ROLE_LABELS: Record<string, string> = {
  owner: "老板",
  manager: "店长",
  assistant_manager: "助教管理",
  coach: "教练",
  frontdesk: "前厅",
  operator: "运营",
};

const ROLE_OPTIONS = ["manager", "assistant_manager", "coach", "frontdesk", "operator"];

export default function MembersPage() {
  const [tab, setTab] = useState<"members" | "invitations">("members");
  const [members, setMembers] = useState<Member[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // 创建邀请码表单
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [newRole, setNewRole] = useState("coach");
  const [newMaxUses, setNewMaxUses] = useState("");
  const [creating, setCreating] = useState(false);

  // 手动添加成员
  const [showAddForm, setShowAddForm] = useState(false);
  const [addPhone, setAddPhone] = useState("");
  const [addRole, setAddRole] = useState("coach");
  const [adding, setAdding] = useState(false);

  const loadMembers = useCallback(async () => {
    try {
      const data = await api.listMembers();
      setMembers(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "加载成员列表失败");
    }
  }, []);

  const loadInvitations = useCallback(async () => {
    try {
      const data = await api.listInvitations();
      setInvitations(data);
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "加载邀请码列表失败");
    }
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([loadMembers(), loadInvitations()]).finally(() => setLoading(false));
  }, [loadMembers, loadInvitations]);

  const handleCreateInvitation = async () => {
    setCreating(true);
    setError("");
    try {
      await api.createInvitation({
        role: newRole,
        max_uses: newMaxUses ? parseInt(newMaxUses) : undefined,
      });
      setShowCreateForm(false);
      setNewMaxUses("");
      await loadInvitations();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "创建邀请码失败");
    } finally {
      setCreating(false);
    }
  };

  const handleToggleInvitation = async (id: string) => {
    try {
      await api.toggleInvitation(id);
      await loadInvitations();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "操作失败");
    }
  };

  const handleDeleteInvitation = async (id: string) => {
    if (!confirm("确定删除此邀请码？")) return;
    try {
      await api.deleteInvitation(id);
      await loadInvitations();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "删除失败");
    }
  };

  const handleChangeRole = async (userId: string, newRole: string) => {
    // 下拉误触即改权限风险大：先确认再生效
    const label = ROLE_LABELS[newRole as keyof typeof ROLE_LABELS] || newRole;
    if (!confirm(`确定把该成员的角色改为「${label}」？权限会立即变更。`)) {
      await loadMembers(); // 还原下拉显示
      return;
    }
    try {
      await api.changeMemberRole(userId, newRole);
      await loadMembers();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "修改角色失败");
    }
  };

  const handleRemoveMember = async (userId: string, name: string) => {
    if (!confirm(`确定移除成员 ${name || ""}？`)) return;
    try {
      await api.removeMember(userId);
      await loadMembers();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "移除失败");
    }
  };

  const handleAddMember = async () => {
    if (!addPhone || addPhone.length < 11) {
      setError("请输入正确的手机号");
      return;
    }
    setAdding(true);
    setError("");
    try {
      await api.addMemberByPhone(addPhone, addRole);
      setShowAddForm(false);
      setAddPhone("");
      await loadMembers();
    } catch (err) {
      setError(err instanceof ApiError ? err.detail : "添加失败");
    } finally {
      setAdding(false);
    }
  };

  const copyInviteLink = (code: string) => {
    const url = `${window.location.origin}/register?invite=${code}`;
    navigator.clipboard.writeText(url);
    alert("邀请链接已复制");
  };

  if (loading) {
    return (
      <>
        <PageHeader title="团队成员" backHref="/dashboard/store-settings" />
        <div className="p-8 text-center text-slate-500">加载中...</div>
      </>
    );
  }

  return (
    <>
      <PageHeader title="团队成员" backHref="/dashboard/store-settings" />
      <div className="mx-auto max-w-4xl space-y-4 lg:space-y-6 lg:p-6">
        {/* 桌面标题 + 操作按钮（手机端标题由 PageHeader 承担，按钮平分一行） */}
        <div className="flex items-center justify-between gap-2">
          <h1 className="hidden text-xl font-semibold text-slate-900 lg:block">团队成员</h1>
          <div className="flex flex-1 gap-2 lg:flex-none">
            <button
              onClick={() => { setShowAddForm(true); setShowCreateForm(false); }}
              className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-green-600 px-3 text-[15px] font-medium text-white transition-colors hover:bg-green-500 active:bg-green-700 lg:h-10 lg:flex-none lg:rounded-lg lg:text-sm"
            >
              <UserPlus className="h-4 w-4" />
              手动添加
            </button>
            <button
              onClick={() => { setShowCreateForm(true); setShowAddForm(false); }}
              className="flex h-11 flex-1 items-center justify-center gap-1.5 rounded-xl bg-brand-600 px-3 text-[15px] font-medium text-white transition-colors hover:bg-brand-500 active:bg-brand-700 lg:h-10 lg:flex-none lg:rounded-lg lg:text-sm"
            >
              <Plus className="h-4 w-4" />
              生成邀请码
            </button>
          </div>
        </div>

        {error && (
          <div className="rounded-xl bg-red-50 p-3 text-sm text-red-600">{error}</div>
        )}

        {/* 手动添加成员表单 */}
        {showAddForm && (
          <div className="rounded-2xl bg-white p-4">
            <h3 className="mb-3 text-[15px] font-medium text-slate-900">通过手机号添加成员</h3>
            <div className="flex flex-col gap-3 lg:flex-row">
              <input
                type="tel"
                maxLength={11}
                value={addPhone}
                onChange={(e) => setAddPhone(e.target.value.replace(/\D/g, ""))}
                placeholder="员工手机号"
                className="h-11 flex-1 rounded-lg px-3 text-[15px]"
              />
              <select
                value={addRole}
                onChange={(e) => setAddRole(e.target.value)}
                className="h-11 rounded-lg bg-white px-3 text-[15px]"
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
              <div className="flex gap-2">
                <button
                  onClick={handleAddMember}
                  disabled={adding}
                  className="h-11 flex-1 rounded-xl bg-green-600 px-4 text-[15px] font-medium text-white hover:bg-green-500 active:bg-green-700 disabled:opacity-50 lg:flex-none lg:rounded-lg lg:text-sm"
                >
                  {adding ? "添加中..." : "添加"}
                </button>
                <button
                  onClick={() => setShowAddForm(false)}
                  className="h-11 rounded-xl px-4 text-[15px] text-slate-600 hover:bg-slate-50 active:bg-slate-100 lg:rounded-lg lg:text-sm"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 创建邀请码表单 */}
        {showCreateForm && (
          <div className="rounded-2xl bg-white p-4">
            <h3 className="mb-3 text-[15px] font-medium text-slate-900">生成邀请码</h3>
            <div className="flex flex-col gap-3 lg:flex-row">
              <select
                value={newRole}
                onChange={(e) => setNewRole(e.target.value)}
                className="h-11 rounded-lg bg-white px-3 text-[15px]"
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>{ROLE_LABELS[r]}</option>
                ))}
              </select>
              <input
                type="number"
                min="1"
                value={newMaxUses}
                onChange={(e) => setNewMaxUses(e.target.value)}
                placeholder="使用次数限制（空=不限）"
                className="h-11 w-full rounded-lg px-3 text-[15px] lg:w-48"
              />
              <div className="flex gap-2">
                <button
                  onClick={handleCreateInvitation}
                  disabled={creating}
                  className="h-11 flex-1 rounded-xl bg-brand-600 px-4 text-[15px] font-medium text-white hover:bg-brand-500 active:bg-brand-700 disabled:opacity-50 lg:flex-none lg:rounded-lg lg:text-sm"
                >
                  {creating ? "生成中..." : "生成"}
                </button>
                <button
                  onClick={() => setShowCreateForm(false)}
                  className="h-11 rounded-xl px-4 text-[15px] text-slate-600 hover:bg-slate-50 active:bg-slate-100 lg:rounded-lg lg:text-sm"
                >
                  取消
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Tab 切换 */}
        <div className="flex gap-1 rounded-xl bg-slate-100 p-1">
          <button
            onClick={() => setTab("members")}
            className={`flex h-10 flex-1 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors ${
              tab === "members" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            <Users className="mr-1.5 inline h-4 w-4" />
            成员 ({members.length})
          </button>
          <button
            onClick={() => setTab("invitations")}
            className={`flex h-10 flex-1 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors ${
              tab === "invitations" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
            }`}
          >
            邀请码 ({invitations.length})
          </button>
        </div>

        {/* 成员列表 */}
        {tab === "members" && (
          <div className="overflow-hidden rounded-2xl bg-white">
            {members.length === 0 ? (
              <div className="p-8 text-center text-slate-400">暂无成员</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {members.map((m) => (
                  <div key={m.user_id} className="flex h-14 items-center justify-between gap-3 px-4">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-brand-100 text-sm font-medium text-brand-600">
                        {(m.name || m.phone).slice(0, 1)}
                      </div>
                      <div className="min-w-0">
                        <p className="truncate text-[15px] font-medium text-slate-900">{m.name || "未设置姓名"}</p>
                        <p className="text-xs text-slate-400">{m.phone}</p>
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <select
                        value={m.role}
                        onChange={(e) => handleChangeRole(m.user_id, e.target.value)}
                        className="h-10 rounded-lg bg-white px-2 text-sm"
                      >
                        {Object.entries(ROLE_LABELS).map(([val, label]) => (
                          <option key={val} value={val}>{label}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleRemoveMember(m.user_id, m.name || m.phone)}
                        className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-500 active:bg-red-50"
                        title="移除成员"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 邀请码列表 */}
        {tab === "invitations" && (
          <div className="overflow-hidden rounded-2xl bg-white">
            {invitations.length === 0 ? (
              <div className="p-8 text-center text-slate-400">暂无邀请码，点击&quot;生成邀请码&quot;创建</div>
            ) : (
              <div className="divide-y divide-slate-100">
                {invitations.map((inv) => (
                  <div key={inv.id} className="flex items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="truncate font-mono text-[15px] font-semibold text-slate-900">{inv.code}</span>
                        <span className="shrink-0 rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-600">
                          {ROLE_LABELS[inv.role] || inv.role}
                        </span>
                        {!inv.is_active && (
                          <span className="shrink-0 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-400">已禁用</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-xs text-slate-400">
                        已使用 {inv.use_count}{inv.max_uses ? `/${inv.max_uses}` : " 次（不限）"}
                        {inv.expires_at && ` · 有效期至 ${new Date(inv.expires_at).toLocaleDateString()}`}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        onClick={() => copyInviteLink(inv.code)}
                        className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-brand-50 hover:text-brand-500 active:bg-brand-50"
                        title="复制邀请链接"
                      >
                        <Copy className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleToggleInvitation(inv.id)}
                        className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 active:bg-slate-100"
                        title={inv.is_active ? "禁用" : "启用"}
                      >
                        {inv.is_active ? (
                          <ToggleRight className="h-4 w-4 text-green-500" />
                        ) : (
                          <ToggleLeft className="h-4 w-4" />
                        )}
                      </button>
                      <button
                        onClick={() => handleDeleteInvitation(inv.id)}
                        className="flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-500 active:bg-red-50"
                        title="删除"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
