"use client";

/**
 * D-Task-4：定时任务管理面板——让老板能建/看/删/开关"到点自动跑一条 AI 任务"（每早文案/每周报/
 * 每天汇总），跑完系统会弹通知，无人值守只出成品不对外。落点仿 store-memory-panel.tsx（独立
 * fixed 抽屉），入口挂在 chat-shell 顶部条("我的球房资料"/"最近删除"旁边)。
 *
 * 文案大白话去黑话：schedule_kind/schedule_spec/cron/UTC 这些技术词一律不出现在界面上，
 * 只留"每天几点/每周几几点/每隔多少分钟"人话。
 */
import { useEffect, useState } from "react";
import { Clock, Loader2, Plus, Trash2, X } from "lucide-react";

import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import type { ScheduleKind, ScheduledTaskItem } from "@/lib/api";
import { ConfirmDialog } from "./confirm-dialog";

const INPUT =
  "w-full rounded-lg border border-black/[0.08] bg-black/[0.02] px-3 py-2 text-[13px] text-[#1d1d1f] outline-none transition placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#e6e7e9] dark:placeholder:text-[#56585f]";
const NUM_INPUT =
  "w-14 rounded-lg border border-black/[0.08] bg-black/[0.02] px-2 py-1.5 text-center text-[13px] text-[#1d1d1f] outline-none transition focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-white/[0.03] dark:text-[#e6e7e9]";

const WEEKDAY_LABELS = ["一", "二", "三", "四", "五", "六", "日"];

function pad2(n: number | undefined): string {
  return String(n ?? 0).padStart(2, "0");
}

/** 数字输入框清空/非法输入会得 NaN，JSON.stringify 会把 NaN 变成 null，后端会静默兜底成 0
 * 让用户无感知（见 CLAUDE.md 铁律）。这里挡在 state 这一层：解析不出数字就退回合理默认值，
 * 绝不让 NaN 进 state。 */
function toSafeInt(raw: string, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/** 把 schedule_kind + schedule_spec 翻成大白话，绝不露 cron/UTC 这类词。 */
function scheduleLabel(kind: string, spec: Record<string, number>): string {
  if (kind === "daily") return `每天 ${pad2(spec.hour)}:${pad2(spec.minute)}`;
  if (kind === "weekly") {
    const wd = ((spec.weekday ?? 0) % 7 + 7) % 7;
    return `每周${WEEKDAY_LABELS[wd]} ${pad2(spec.hour)}:${pad2(spec.minute)}`;
  }
  if (kind === "interval") return `每隔 ${spec.minutes ?? 60} 分钟`;
  return "自定义规则";
}

function fmtNextRun(iso: string | null): string {
  if (!iso) return "还没排上";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "还没排上";
  return `下次 ${d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false })}`;
}

function statusPill(status: string | null): { text: string; cls: string } {
  if (status === "success") return { text: "上次成功", cls: "bg-[#10a37f]/12 text-[#10a37f]" };
  if (status === "error") return { text: "上次没跑成", cls: "bg-[#ff3b30]/12 text-[#ff3b30]" };
  return { text: "还没跑过", cls: "bg-black/[0.05] text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]" };
}

/** 紧凑开关(非 <select>，macOS 风格小圆钮) */
function Switch({ on, onToggle, title }: { on: boolean; onToggle: () => void; title?: string }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={title}
      aria-pressed={on}
      className={`relative h-5 w-9 shrink-0 rounded-full transition ${on ? "bg-[#10a37f]" : "bg-black/[0.15] dark:bg-white/[0.18]"}`}
    >
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${on ? "left-[18px]" : "left-0.5"}`} />
    </button>
  );
}

/** 三态/多态分段选择(替代原生 <select>) */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap gap-0.5 rounded-lg bg-black/[0.035] p-0.5 dark:bg-white/[0.05]">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition ${
            value === v
              ? "bg-white text-[#1d1d1f] shadow-sm dark:bg-[#24262d] dark:text-[#e6e7e9]"
              : "text-[#6e6e73] hover:bg-white/60 dark:text-[#8a8c93] dark:hover:bg-white/[0.06]"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function ScheduledTasksPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tasks, setTasks] = useState<ScheduledTaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTaskItem | null>(null);

  // 新建表单
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [instruction, setInstruction] = useState("");
  const [kind, setKind] = useState<ScheduleKind>("daily");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(0);
  const [intervalMinutes, setIntervalMinutes] = useState(60);
  const [billiardsMode, setBilliardsMode] = useState(false);
  const [creating, setCreating] = useState(false);

  async function refresh() {
    setLoading(true);
    try {
      const rows = await api.getScheduledTasks();
      setTasks(rows);
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setMsg(null);
    (async () => {
      try {
        const rows = await api.getScheduledTasks();
        if (!cancelled) setTasks(rows);
      } catch (e) {
        if (!cancelled) setMsg({ kind: "err", text: getErrorMessage(e) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  if (!open) return null;

  function resetForm() {
    setName("");
    setInstruction("");
    setKind("daily");
    setHour(9);
    setMinute(0);
    setWeekday(0);
    setIntervalMinutes(60);
    setBilliardsMode(false);
  }

  function buildSpec(): Record<string, number> {
    if (kind === "daily") return { hour: Math.min(Math.max(hour, 0), 23), minute: Math.min(Math.max(minute, 0), 59) };
    if (kind === "weekly") return { weekday: Math.min(Math.max(weekday, 0), 6), hour: Math.min(Math.max(hour, 0), 23), minute: Math.min(Math.max(minute, 0), 59) };
    return { minutes: Math.max(intervalMinutes, 1) };
  }

  async function createTask() {
    const n = name.trim();
    const ins = instruction.trim();
    if (!n || !ins) {
      setMsg({ kind: "err", text: "先填个名字和要它干啥的指令" });
      return;
    }
    setCreating(true);
    setMsg(null);
    try {
      await api.createScheduledTask({
        name: n,
        instruction: ins,
        schedule_kind: kind,
        schedule_spec: buildSpec(),
        billiards_mode: billiardsMode,
      });
      resetForm();
      setShowForm(false);
      await refresh();
      setMsg({ kind: "ok", text: "定时任务建好了，到点会自动跑" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setCreating(false);
    }
  }

  async function toggleEnabled(t: ScheduledTaskItem) {
    setBusyId(t.id);
    setMsg(null);
    try {
      const updated = await api.updateScheduledTask(t.id, { enabled: !t.enabled });
      setTasks((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setBusyId(null);
    }
  }

  async function confirmDelete() {
    const t = deleteTarget;
    if (!t) return;
    setDeleteTarget(null);
    setBusyId(t.id);
    setMsg(null);
    try {
      await api.deleteScheduledTask(t.id);
      setTasks((prev) => prev.filter((x) => x.id !== t.id));
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setBusyId(null);
    }
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  return (
    <aside className="fixed right-0 top-0 z-[62] flex h-full w-[420px] max-w-[92vw] flex-col border-l border-black/[0.08] bg-white shadow-2xl dark:border-white/[0.08] dark:bg-[#16181d]">
      <div className="app-drag app-titlebar-safe-right flex h-[44px] items-center justify-between border-b border-black/[0.08] px-4 dark:border-white/[0.06]">
        <div className="flex items-center gap-2 font-mono text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
          <Clock className="h-4 w-4 text-[#10a37f]" /> 定时任务
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
          让管家到点自动帮你干一件事——比如每天早上写今日文案、每周一出周报。软件开着的时候才会跑，跑完会弹通知告诉你。
        </p>

        <button
          type="button"
          onClick={() => setShowForm((v) => !v)}
          className="mb-3 inline-flex items-center gap-1.5 rounded-lg bg-[#10a37f] px-3 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-[#0d8c6d] active:scale-[0.98]"
        >
          <Plus className="h-3.5 w-3.5" /> {showForm ? "收起" : "新建定时任务"}
        </button>

        {showForm && (
          <div className="mb-4 rounded-lg border border-black/[0.06] bg-black/[0.015] p-3 dark:border-white/[0.06] dark:bg-white/[0.02]">
            <div className="mb-2.5">
              <label className="mb-1 block text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">起个名字</label>
              <input className={INPUT} value={name} onChange={(e) => setName(e.target.value)} placeholder="比如：每日文案" />
            </div>
            <div className="mb-2.5">
              <label className="mb-1 block text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">到点了要它干啥</label>
              <textarea
                className={`${INPUT} min-h-[64px] resize-none`}
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="比如：每天早上 9 点，自动帮我写一条今日朋友圈文案"
              />
            </div>
            <div className="mb-2.5">
              <label className="mb-1 block text-[12px] font-medium text-[#6e6e73] dark:text-[#9a9ca3]">多久跑一次</label>
              <Segmented
                value={kind}
                onChange={setKind}
                options={[["daily", "每天几点"], ["weekly", "每周几几点"], ["interval", "每隔多少分钟"]] as const}
              />
            </div>

            {kind !== "interval" ? (
              <div className="mb-2.5 flex flex-wrap items-center gap-2">
                {kind === "weekly" && (
                  <div className="inline-flex flex-wrap gap-0.5 rounded-lg bg-black/[0.035] p-0.5 dark:bg-white/[0.05]">
                    {WEEKDAY_LABELS.map((l, i) => (
                      <button
                        key={l}
                        type="button"
                        onClick={() => setWeekday(i)}
                        className={`rounded-md px-2 py-1 text-[12px] font-medium transition ${
                          weekday === i
                            ? "bg-white text-[#1d1d1f] shadow-sm dark:bg-[#24262d] dark:text-[#e6e7e9]"
                            : "text-[#6e6e73] hover:bg-white/60 dark:text-[#8a8c93] dark:hover:bg-white/[0.06]"
                        }`}
                      >
                        周{l}
                      </button>
                    ))}
                  </div>
                )}
                <span className="text-[12px] text-[#6e6e73] dark:text-[#9a9ca3]">几点</span>
                <input type="number" min={0} max={23} className={NUM_INPUT} value={hour}
                  onChange={(e) => setHour(toSafeInt(e.target.value, 0))} />
                <span className="text-[12px] text-[#6e6e73] dark:text-[#9a9ca3]">:</span>
                <input type="number" min={0} max={59} className={NUM_INPUT} value={minute}
                  onChange={(e) => setMinute(toSafeInt(e.target.value, 0))} />
              </div>
            ) : (
              <div className="mb-2.5 flex items-center gap-2">
                <span className="text-[12px] text-[#6e6e73] dark:text-[#9a9ca3]">每隔</span>
                <input type="number" min={1} className={NUM_INPUT} value={intervalMinutes}
                  onChange={(e) => setIntervalMinutes(toSafeInt(e.target.value, 1))} />
                <span className="text-[12px] text-[#6e6e73] dark:text-[#9a9ca3]">分钟跑一次</span>
              </div>
            )}

            <div className="mb-1 flex items-center justify-between gap-2">
              <span className="text-[12px] text-[#6e6e73] dark:text-[#9a9ca3]">带上台球运营经验来干这件事</span>
              <Switch on={billiardsMode} onToggle={() => setBilliardsMode((v) => !v)} />
            </div>

            <button
              type="button"
              onClick={() => void createTask()}
              disabled={creating || !name.trim() || !instruction.trim()}
              className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-[#10a37f] px-3 py-2 text-[13px] font-medium text-white transition hover:bg-[#0d8c6d] disabled:opacity-50"
            >
              {creating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
              建好这条任务
            </button>
          </div>
        )}

        {msg && <div className={`mb-2 text-[12px] ${msg.kind === "ok" ? "text-[#10a37f]" : "text-[#ff3b30]"}`}>{msg.text}</div>}

        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-[#86868b]" /></div>
        ) : tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/[0.1] px-3 py-6 text-center text-[12.5px] text-[#86868b] dark:border-white/[0.1] dark:text-[#6e7077]">
            还没有定时任务。可以让我每天早上自动写文案、每周一出周报。
          </div>
        ) : (
          <div className="space-y-2">
            {tasks.map((t) => {
              const pill = statusPill(t.last_run_status);
              const isExpanded = expanded.has(t.id);
              const summary = t.last_result_summary || "";
              const truncated = summary.length > 60 && !isExpanded ? `${summary.slice(0, 60)}…` : summary;
              return (
                <div key={t.id} className="rounded-lg border border-black/[0.06] bg-black/[0.015] p-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
                  <div className="mb-1 flex items-center justify-between gap-2">
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{t.name}</span>
                    <Switch
                      on={t.enabled}
                      onToggle={() => void toggleEnabled(t)}
                      title={t.enabled ? "点一下暂停" : "点一下开启"}
                    />
                  </div>
                  <div className="mb-1.5 text-[12px] leading-relaxed text-[#6e6e73] dark:text-[#9a9ca3]">{t.instruction}</div>
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
                    <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]">
                      {scheduleLabel(t.schedule_kind, t.schedule_spec)}
                    </span>
                    {t.enabled && (
                      <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]">
                        {fmtNextRun(t.next_run_at)}
                      </span>
                    )}
                    <span className={`rounded px-1.5 py-0.5 ${pill.cls}`}>{pill.text}</span>
                    {t.billiards_mode && (
                      <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]">带台球经验</span>
                    )}
                  </div>
                  {summary && (
                    <div className="mb-1.5 rounded bg-black/[0.02] p-2 text-[11.5px] leading-relaxed text-[#3a3a3c] dark:bg-white/[0.03] dark:text-[#c8cace]">
                      {truncated}
                      {summary.length > 60 && (
                        <button type="button" onClick={() => toggleExpand(t.id)} className="ml-1.5 text-[#10a37f]">
                          {isExpanded ? "收起" : "看全文"}
                        </button>
                      )}
                    </div>
                  )}
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => setDeleteTarget(t)}
                      disabled={busyId === t.id}
                      className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-[#86868b] transition hover:bg-[#ff3b30]/10 hover:text-[#ff3b30] disabled:opacity-50"
                    >
                      {busyId === t.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                      删除
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        title="删除这条定时任务？"
        message={`「${deleteTarget?.name || ""}」删掉后就不会再自动跑了，不能恢复。`}
        confirmLabel="删除"
        destructive
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </aside>
  );
}
