"use client";

import { useEffect, useState } from "react";
import { Brain, Check, Loader2, Plus, Sparkles, Trash2, X } from "lucide-react";

import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import type { StoreMemoryItem } from "@/types/store";

const INPUT =
  "w-full rounded-lg border border-black/[0.08] bg-black/[0.02] px-3 py-2 text-[13px] text-[#1d1d1f] outline-none transition placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#e6e7e9] dark:placeholder:text-[#56585f]";

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

export function StoreMemoryPanel({
  open,
  onClose,
  workingDir,
}: {
  open: boolean;
  onClose: () => void;
  workingDir?: string | null;
}) {
  const [memories, setMemories] = useState<StoreMemoryItem[]>([]);
  const [newRule, setNewRule] = useState("");
  const [quickStore, setQuickStore] = useState("");
  const [quickStage, setQuickStage] = useState("");
  const [quickPositioning, setQuickPositioning] = useState("");
  const [scope, setScope] = useState<"global" | "working_dir">("global");
  const [busy, setBusy] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  async function refresh() {
    try { setMemories(await api.getStoreMemory()); } catch { setMemories([]); }
  }

  useEffect(() => { if (open) void refresh(); }, [open]);
  useEffect(() => {
    if (!workingDir && scope === "working_dir") setScope("global");
  }, [scope, workingDir]);

  const scopedWorkingDir = scope === "working_dir" ? workingDir || undefined : undefined;

  async function addRule() {
    const c = newRule.trim();
    if (!c) return;
    setBusy("add"); setMsg(null);
    try {
      await api.addStoreMemory(c, "semantic", scopedWorkingDir);
      setNewRule("");
      await refresh();
      setMsg({ kind: "ok", text: scope === "working_dir" ? "已记到当前工作文件夹" : "已记下" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function addQuickProfile() {
    const store = quickStore.trim();
    const stage = quickStage.trim();
    const positioning = quickPositioning.trim();
    if (!store && !stage && !positioning) return;
    const parts = [
      store ? `店名/城市：${store}` : "",
      stage ? `门店阶段：${stage}` : "",
      positioning ? `主定位：${positioning}` : "",
    ].filter(Boolean);
    setBusy("quick-profile"); setMsg(null);
    try {
      await api.addStoreMemory(`我的球房资料：${parts.join("；")}`, "semantic", scopedWorkingDir);
      setQuickStore("");
      setQuickStage("");
      setQuickPositioning("");
      await refresh();
      setMsg({ kind: "ok", text: scope === "working_dir" ? "已保存为当前工作文件夹的球房资料" : "已保存为我确认的球房资料" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function saveEdit() {
    if (!editId) return;
    const c = editText.trim();
    if (!c) { setEditId(null); return; }
    setBusy(editId); setMsg(null);
    try {
      await api.updateStoreMemory(editId, c);
      setEditId(null);
      await refresh();
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function deleteMemory(id: string) {
    setBusy(id); setMsg(null);
    try {
      await api.deleteStoreMemory(id);
      await refresh();
      setMsg({ kind: "ok", text: "已移到最近删除" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function confirmMemory(id: string) {
    setBusy(id); setMsg(null);
    try {
      await api.confirmStoreMemory(id);
      await refresh();
      setMsg({ kind: "ok", text: "已确认，会用于后续回答" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;
  const order = { pending: 0, manual: 1, auto: 2 } as const;
  const sorted = [...memories].sort((a, b) => (order[a.source] ?? 3) - (order[b.source] ?? 3));

  return (
    <aside className="fixed right-0 top-0 z-[62] flex h-full w-[420px] max-w-[92vw] flex-col border-l border-black/[0.08] bg-white shadow-2xl dark:border-white/[0.08] dark:bg-[#16181d]">
      <div className="app-drag app-titlebar-safe-right flex h-[44px] items-center justify-between border-b border-black/[0.08] px-4 dark:border-white/[0.06]">
        <div className="flex items-center gap-2 font-mono text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
          <Brain className="h-4 w-4 text-[#10a37f]" /> 我的球房资料
        </div>
        <button
          type="button"
          onClick={onClose}
          className="app-no-drag flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] transition hover:bg-black/[0.06] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
          aria-label="关闭"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="mb-3 text-[12.5px] leading-relaxed text-[#6e6e73] dark:text-[#9a9ca3]">
          这里是 AI 记住的门店事实和你的偏好。“待确认”的内容不会影响回答，确认后才会用于后续文案、海报、报表诊断。
        </p>

        <div className="mb-3 rounded-lg border border-black/[0.06] bg-black/[0.015] p-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
          <div className="mb-2 text-[12px] font-medium text-[#3a3a3c] dark:text-[#c8cace]">这次新增资料用在哪里</div>
          <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-black/[0.035] p-1 dark:bg-white/[0.04]">
            <button
              type="button"
              onClick={() => setScope("global")}
              className={`rounded-md px-2 py-1.5 text-[12px] transition ${
                scope === "global"
                  ? "bg-white text-[#1d1d1f] shadow-sm dark:bg-[#24262d] dark:text-[#e6e7e9]"
                  : "text-[#6e6e73] hover:bg-white/60 dark:text-[#8a8c93] dark:hover:bg-white/[0.06]"
              }`}
            >
              全部工作台
            </button>
            <button
              type="button"
              onClick={() => workingDir && setScope("working_dir")}
              disabled={!workingDir}
              className={`rounded-md px-2 py-1.5 text-[12px] transition disabled:cursor-not-allowed disabled:opacity-45 ${
                scope === "working_dir"
                  ? "bg-white text-[#1d1d1f] shadow-sm dark:bg-[#24262d] dark:text-[#e6e7e9]"
                  : "text-[#6e6e73] hover:bg-white/60 dark:text-[#8a8c93] dark:hover:bg-white/[0.06]"
              }`}
              title={workingDir ? workingDir : "先选择工作文件夹，再保存当前项目资料"}
            >
              当前工作文件夹
            </button>
          </div>
          <div className="mt-2 text-[11.5px] leading-relaxed text-[#86868b] dark:text-[#8a8c93]">
            {scope === "working_dir" && workingDir
              ? `只在「${baseName(workingDir)}」这个工作文件夹里使用，避免污染其它项目。`
              : workingDir
                ? "全局资料会用于所有工作台；项目资料请切到「当前工作文件夹」。"
                : "还没选工作文件夹；现在新增的是全局资料。"}
          </div>
        </div>

        <div className="mb-3 rounded-lg border border-[#007AFF]/15 bg-[#007AFF]/[0.045] p-3 dark:border-[#66aaff]/20 dark:bg-[#66aaff]/[0.08]">
          <div className="mb-2 flex items-center gap-1.5 text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">
            <Sparkles className="h-3.5 w-3.5 text-[#007AFF]" />
            3 个问题快速补全
          </div>
          <div className="grid gap-2">
            <input
              className={INPUT}
              value={quickStore}
              onChange={(e) => setQuickStore(e.target.value)}
              placeholder="店名/城市，比如：星河台球 · 泉州丰泽"
            />
            <input
              className={INPUT}
              value={quickStage}
              onChange={(e) => setQuickStage(e.target.value)}
              placeholder="门店阶段，比如：新店开业 / 老店翻新 / 旺季拉新"
            />
            <input
              className={INPUT}
              value={quickPositioning}
              onChange={(e) => setQuickPositioning(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void addQuickProfile(); }}
              placeholder="主定位，比如：竞技客户 / 助教服务 / 同城社交"
            />
          </div>
          <div className="mt-2 flex items-center justify-between gap-2">
            <span className="text-[11.5px] leading-relaxed text-[#6e6e73] dark:text-[#9a9ca3]">可以跳过，后面也能慢慢补；保存后会用于后续文案、海报和报表判断。</span>
            <button
              type="button"
              onClick={() => void addQuickProfile()}
              disabled={busy === "quick-profile" || (!quickStore.trim() && !quickStage.trim() && !quickPositioning.trim())}
              className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg bg-[#007AFF] px-3 text-[12px] font-medium text-white transition hover:bg-[#0066d6] disabled:opacity-50"
            >
              {busy === "quick-profile" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
              保存资料
            </button>
          </div>
        </div>

        <div className="mb-3 flex gap-1.5">
          <input
            className={INPUT}
            value={newRule}
            onChange={(e) => setNewRule(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void addRule(); }}
            placeholder="比如：我店 26 张台，主做竞技客户"
          />
          <button
            type="button"
            onClick={() => void addRule()}
            disabled={busy === "add" || !newRule.trim()}
            className="flex h-9 w-10 shrink-0 items-center justify-center rounded-lg bg-[#10a37f] text-white transition hover:bg-[#0d8c6d] disabled:opacity-50"
            aria-label="添加"
          >
            {busy === "add" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          </button>
        </div>

        {msg && <div className={`mb-2 text-[12px] ${msg.kind === "ok" ? "text-[#10a37f]" : "text-[#ff3b30]"}`}>{msg.text}</div>}

        {sorted.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/[0.1] px-3 py-6 text-center text-[12.5px] text-[#86868b] dark:border-white/[0.1] dark:text-[#6e7077]">
            还没有资料。先补 1 条最关键的：店名/城市、门店阶段、主定位，后面再慢慢加。
          </div>
        ) : (
          <div className="space-y-2">
            {sorted.map((m) => (
              <div key={m.id} className="rounded-lg border border-black/[0.06] bg-black/[0.015] p-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10.5px] ${
                    m.source === "pending"
                      ? "bg-[#d4901f]/12 text-[#b9770f] dark:text-[#e0b84a]"
                      : m.source === "manual"
                        ? "bg-[#10a37f]/12 text-[#10a37f]"
                        : "bg-black/[0.05] text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]"
                    }`}>
                      {m.source === "pending" ? "待确认" : m.source === "manual" ? "我确认的" : "AI学到"}
                    </span>
                    {m.scope_label && (
                      <span className="truncate rounded bg-black/[0.035] px-1.5 py-0.5 text-[10.5px] text-[#86868b] dark:bg-white/[0.05] dark:text-[#8a8c93]">
                        {m.scope_label}
                      </span>
                    )}
                  </div>
                  <span className="text-[10.5px] text-[#a1a1a6]">{m.type_label}</span>
                </div>
                {editId === m.id ? (
                  <input
                    className={INPUT}
                    value={editText}
                    autoFocus
                    onChange={(e) => setEditText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") void saveEdit(); if (e.key === "Escape") setEditId(null); }}
                  />
                ) : (
                  <div className="text-[13px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]">{m.content}</div>
                )}
                <div className="mt-2 flex justify-end gap-1.5">
                  {m.source === "pending" && (
                    <button
                      type="button"
                      onClick={() => void confirmMemory(m.id)}
                      disabled={busy === m.id}
                      className="flex h-7 items-center gap-1 rounded-md bg-[#10a37f] px-2 text-[12px] text-white transition hover:bg-[#0d8c6d] disabled:opacity-50"
                    >
                      {busy === m.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                      确认
                    </button>
                  )}
                  {editId === m.id ? (
                    <button type="button" onClick={() => void saveEdit()} className="rounded-md px-2 py-1 text-[12px] font-medium text-[#10a37f]">保存</button>
                  ) : (
                    <button type="button" onClick={() => { setEditId(m.id); setEditText(m.content); }} className="rounded-md px-2 py-1 text-[12px] text-[#86868b] transition hover:bg-black/[0.04] hover:text-[#10a37f] dark:hover:bg-white/[0.06]">修改</button>
                  )}
                  <button
                    type="button"
                    onClick={() => void deleteMemory(m.id)}
                    disabled={busy === m.id}
                    className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-[#86868b] transition hover:bg-[#ff3b30]/10 hover:text-[#ff3b30] disabled:opacity-50"
                  >
                    {busy === m.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    删除
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
