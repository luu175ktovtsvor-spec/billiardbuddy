"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Bookmark, Plus, X, ChevronRight, Sparkles, Trash2 } from "lucide-react";
import { ROLE_TASKS } from "@/lib/role-workbench-config";

interface MyTemplate {
  id: string;
  title: string;
  intent: string;
  role: string;
  /** 关联的任务卡 ID：有则"使用"直达卡片页带上需求，一键重跑 */
  cardId?: string;
  createdAt: string;
}

/** 没有 cardId 的旧模板：取该岗位第一张卡片兜底（工作台首页不读 intent 参数，直跳卡片页才能带上需求） */
function resolveCardId(t: MyTemplate): string | null {
  if (t.cardId) return t.cardId;
  const tasks = ROLE_TASKS[t.role as keyof typeof ROLE_TASKS];
  return tasks?.[0]?.id || null;
}

const STORAGE_KEY = "my_templates";

function loadTemplates(): MyTemplate[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  } catch {
    return [];
  }
}

function saveTemplates(templates: MyTemplate[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(templates));
}

export function MyTemplates() {
  const [templates, setTemplates] = useState<MyTemplate[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newIntent, setNewIntent] = useState("");
  const [newRole, setNewRole] = useState("manager");

  useEffect(() => {
    setTemplates(loadTemplates());
  }, []);

  const handleAdd = () => {
    if (!newTitle.trim() || !newIntent.trim()) return;
    const newTemplate: MyTemplate = {
      id: Date.now().toString(),
      title: newTitle.trim(),
      intent: newIntent.trim(),
      role: newRole,
      createdAt: new Date().toISOString(),
    };
    const updated = [...templates, newTemplate];
    saveTemplates(updated);
    setTemplates(updated);
    setNewTitle("");
    setNewIntent("");
    // 保持表单打开，方便连续添加
  };

  const handleDelete = (id: string) => {
    const updated = templates.filter((t) => t.id !== id);
    saveTemplates(updated);
    setTemplates(updated);
  };

  if (templates.length === 0 && !showAdd) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
        <div className="px-4 py-3 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <Bookmark className="h-5 w-5 text-indigo-600" />
            <h3 className="font-semibold text-slate-900">我的模板</h3>
          </div>
        </div>
        <div className="p-6 text-center">
          <p className="text-sm text-slate-500 mb-3">保存常用需求，下次直接用</p>
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-50 px-3 py-2 text-sm font-medium text-indigo-600 hover:bg-indigo-100"
          >
            <Plus className="h-4 w-4" />
            添加第一个模板
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-200 bg-white shadow-sm">
      <div className="px-4 py-3 border-b border-slate-100">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Bookmark className="h-5 w-5 text-indigo-600" />
            <h3 className="font-semibold text-slate-900">我的模板</h3>
            <span className="text-xs text-slate-400">{templates.length}个</span>
          </div>
          <button
            type="button"
            onClick={() => setShowAdd(!showAdd)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-indigo-600 hover:bg-indigo-50"
          >
            <Plus className="h-3 w-3" />
            添加
          </button>
        </div>
      </div>

      {/* 添加模板表单 */}
      {showAdd && (
        <div className="border-b border-slate-100 p-4 bg-slate-50">
          <div className="space-y-3">
            <input
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="模板名称（如：每日朋友圈）"
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <input
              type="text"
              value={newIntent}
              onChange={(e) => setNewIntent(e.target.value)}
              placeholder="需求描述（如：帮我写一条朋友圈，语气轻松幽默）"
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
            />
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value)}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm"
            >
              <option value="manager">店长</option>
              <option value="assistant_manager">助教管理</option>
              <option value="coach">教练</option>
              <option value="frontdesk">前厅</option>
              <option value="boss">老板</option>
              <option value="operator">运营</option>
            </select>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={handleAdd}
                disabled={!newTitle.trim() || !newIntent.trim()}
                className="flex-1 rounded-md bg-indigo-600 px-3 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                保存
              </button>
              <button
                type="button"
                onClick={() => setShowAdd(false)}
                className="rounded-md border border-slate-200 px-3 py-2 text-sm text-slate-600 hover:bg-slate-50"
              >
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 模板列表 */}
      <div className="divide-y divide-slate-50">
        {templates.map((t) => (
          <div key={t.id} className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-slate-900">{t.title}</p>
              <p className="text-xs text-slate-500 truncate">{t.intent}</p>
            </div>
            <Link
              href={(() => {
                const cardId = resolveCardId(t);
                // 直达卡片页并带上需求（工作台首页不读 intent，旧链接是死链）
                return cardId
                  ? `/dashboard/workbench/${cardId}?intent=${encodeURIComponent(t.intent)}`
                  : `/dashboard/workbench`;
              })()}
              className="shrink-0 inline-flex items-center gap-1 rounded-md bg-indigo-50 px-2.5 py-1.5 text-xs font-medium text-indigo-600 hover:bg-indigo-100 transition-colors"
            >
              <Sparkles className="h-3 w-3" />
              使用
            </Link>
            <button
              type="button"
              onClick={() => handleDelete(t.id)}
              className="shrink-0 p-1 text-slate-400 hover:text-red-500 transition-colors"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
