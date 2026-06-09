"use client";

import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
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
    return <div className="p-8 text-center text-slate-500">加载中...</div>;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold text-slate-900">团队成员</h1>
        <div className="flex gap-2">
          <button
            onClick={() => { setShowAddForm(true); setShowCreateForm(false); }}
            className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-sm font-medium text-white hover:bg-green-500"
          >
            <UserPlus className="h-4 w-4" />
            手动添加
          </button>
          <button
            onClick={() => { setShowCreateForm(true); setShowAddForm(false); }}
            className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500"
          >
            <Plus className="h-4 w-4" />
            生成邀请码
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-lg bg-red-50 p-3 text-sm text-red-600">{error}</div>
      )}

      {/* 手动添加成员表单 */}
      {showAddForm && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 font-medium text-slate-900">通过手机号添加成员</h3>
          <div className="flex gap-3">
            <input
              type="tel"
              maxLength={11}
              value={addPhone}
              onChange={(e) => setAddPhone(e.target.value.replace(/\D/g, ""))}
              placeholder="员工手机号"
              className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <select
              value={addRole}
              onChange={(e) => setAddRole(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
            >
              {ROLE_OPTIONS.map((r) => (
                <option key={r} value={r}>{ROLE_LABELS[r]}</option>
              ))}
            </select>
            <button
              onClick={handleAddMember}
              disabled={adding}
              className="rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-500 disabled:opacity-50"
            >
              {adding ? "添加中..." : "添加"}
            </button>
            <button
              onClick={() => setShowAddForm(false)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* 创建邀请码表单 */}
      {showCreateForm && (
        <div className="rounded-lg border border-slate-200 bg-white p-4">
          <h3 className="mb-3 font-medium text-slate-900">生成邀请码</h3>
          <div className="flex gap-3">
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm"
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
              className="w-48 rounded-lg border border-slate-200 px-3 py-2 text-sm"
            />
            <button
              onClick={handleCreateInvitation}
              disabled={creating}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {creating ? "生成中..." : "生成"}
            </button>
            <button
              onClick={() => setShowCreateForm(false)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
            >
              取消
            </button>
          </div>
        </div>
      )}

      {/* Tab 切换 */}
      <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
        <button
          onClick={() => setTab("members")}
          className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
            tab === "members" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          <Users className="mr-1.5 inline h-4 w-4" />
          成员 ({members.length})
        </button>
        <button
          onClick={() => setTab("invitations")}
          className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
            tab === "invitations" ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-700"
          }`}
        >
          邀请码 ({invitations.length})
        </button>
      </div>

      {/* 成员列表 */}
      {tab === "members" && (
        <div className="rounded-lg border border-slate-200 bg-white">
          {members.length === 0 ? (
            <div className="p-8 text-center text-slate-400">暂无成员</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {members.map((m) => (
                <div key={m.user_id} className="flex items-center justify-between px-4 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-indigo-100 text-sm font-medium text-indigo-600">
                      {(m.name || m.phone).slice(0, 1)}
                    </div>
                    <div>
                      <p className="text-sm font-medium text-slate-900">{m.name || "未设置姓名"}</p>
                      <p className="text-xs text-slate-400">{m.phone}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <select
                      value={m.role}
                      onChange={(e) => handleChangeRole(m.user_id, e.target.value)}
                      className="rounded border border-slate-200 px-2 py-1 text-xs"
                    >
                      {Object.entries(ROLE_LABELS).map(([val, label]) => (
                        <option key={val} value={val}>{label}</option>
                      ))}
                    </select>
                    <button
                      onClick={() => handleRemoveMember(m.user_id, m.name || m.phone)}
                      className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
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
        <div className="rounded-lg border border-slate-200 bg-white">
          {invitations.length === 0 ? (
            <div className="p-8 text-center text-slate-400">暂无邀请码，点击&quot;生成邀请码&quot;创建</div>
          ) : (
            <div className="divide-y divide-slate-100">
              {invitations.map((inv) => (
                <div key={inv.id} className="flex items-center justify-between px-4 py-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-slate-900">{inv.code}</span>
                      <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-600">
                        {ROLE_LABELS[inv.role] || inv.role}
                      </span>
                      {!inv.is_active && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-400">已禁用</span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-400">
                      已使用 {inv.use_count}{inv.max_uses ? `/${inv.max_uses}` : " 次（不限）"}
                      {inv.expires_at && ` · 有效期至 ${new Date(inv.expires_at).toLocaleDateString()}`}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => copyInviteLink(inv.code)}
                      className="rounded p-1.5 text-slate-400 hover:bg-indigo-50 hover:text-indigo-500"
                      title="复制邀请链接"
                    >
                      <Copy className="h-4 w-4" />
                    </button>
                    <button
                      onClick={() => handleToggleInvitation(inv.id)}
                      className="rounded p-1.5 text-slate-400 hover:bg-slate-100"
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
                      className="rounded p-1.5 text-slate-400 hover:bg-red-50 hover:text-red-500"
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
  );
}
