"use client";

/**
 * 后台任务抽屉：展示 TS Agent 后台任务与媒体任务进度。
 * 这里不替代对话流，只负责“跑到哪了 / 有没有失败 / 能不能取消 / 结果在哪”。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { CheckCircle2, CircleAlert, Clock3, Loader2, RefreshCw, Square, X } from "lucide-react";

import { api, type BackgroundTaskItem } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { ConfirmDialog } from "./confirm-dialog";

function taskStatusLabel(status: BackgroundTaskItem["status"]): { text: string; cls: string; Icon: typeof Clock3 } {
  if (status === "completed") return { text: "已完成", cls: "bg-[#10a37f]/12 text-[#10a37f]", Icon: CheckCircle2 };
  if (status === "failed") return { text: "失败", cls: "bg-[#ff3b30]/12 text-[#ff3b30]", Icon: CircleAlert };
  if (status === "cancelled") return { text: "已取消", cls: "bg-black/[0.05] text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]", Icon: Square };
  if (status === "queued") return { text: "排队中", cls: "bg-[#007AFF]/10 text-[#007AFF]", Icon: Clock3 };
  return { text: "运行中", cls: "bg-[#10a37f]/12 text-[#10a37f]", Icon: Loader2 };
}

function kindLabel(kind?: string): string {
  if (!kind) return "后台任务";
  if (kind === "generate" || kind === "edit" || kind === "variations") return "图片任务";
  if (kind === "i2v" || kind === "video" || kind === "video_render" || kind === "video_auto_plan" || kind === "video_inventory") return "视频任务";
  if (kind.includes("agent")) return "子代理";
  return kind;
}

function fmtTime(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function resultSummary(result: unknown): string {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object" || Array.isArray(result)) return String(result);
  const record = result as Record<string, unknown>;
  const urls = Array.isArray(record.urls) ? record.urls.filter((x): x is string => typeof x === "string") : [];
  const images = Array.isArray(record.images) ? record.images.length : 0;
  const message = typeof record.message === "string" ? record.message : "";
  if (urls.length > 0) return `${message ? `${message} ` : ""}${urls.length} 个结果`;
  if (images > 0) return `${images} 张图片`;
  return message || JSON.stringify(record).slice(0, 160);
}

function firstResultUrl(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  const urls = Array.isArray(record.urls) ? record.urls : [];
  const firstUrl = urls.find((x): x is string => typeof x === "string");
  if (firstUrl) return firstUrl;
  const images = Array.isArray(record.images) ? record.images : [];
  for (const img of images) {
    if (img && typeof img === "object" && typeof (img as Record<string, unknown>).poster_url === "string") {
      return (img as Record<string, string>).poster_url;
    }
  }
  return null;
}

function isActive(status: BackgroundTaskItem["status"]): boolean {
  return status === "queued" || status === "running";
}

function progressOf(task: BackgroundTaskItem): number {
  if (typeof task.progress === "number" && Number.isFinite(task.progress)) return Math.max(0, Math.min(100, task.progress));
  if (task.status === "completed") return 100;
  return 0;
}

export function BackgroundTasksPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tasks, setTasks] = useState<BackgroundTaskItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [cancelTarget, setCancelTarget] = useState<BackgroundTaskItem | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const activeCount = useMemo(() => tasks.filter((t) => isActive(t.status)).length, [tasks]);

  const refresh = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await api.listBackgroundTasks({ limit: 50 });
      setTasks(res.tasks);
      if (!quiet) setMsg(null);
    } catch (e) {
      if (!quiet) setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setMsg(null);
    (async () => {
      try {
        const res = await api.listBackgroundTasks({ limit: 50 });
        if (!cancelled) setTasks(res.tasks);
      } catch (e) {
        if (!cancelled) setMsg({ kind: "err", text: getErrorMessage(e) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    const timer = window.setInterval(() => {
      void refresh(true);
    }, activeCount > 0 ? 1500 : 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeCount, open, refresh]);

  if (!open) return null;

  async function confirmCancel() {
    const task = cancelTarget;
    if (!task) return;
    setCancelTarget(null);
    setBusyId(task.id);
    try {
      await api.cancelBackgroundTask(task.id);
      setMsg({ kind: "ok", text: "已请求停止" });
      await refresh(true);
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <aside className="fixed right-0 top-0 z-[62] flex h-full w-[420px] max-w-[92vw] flex-col border-l border-black/[0.08] bg-white shadow-2xl dark:border-white/[0.08] dark:bg-[#16181d]">
      <div className="app-drag app-titlebar-safe-right flex h-[44px] items-center justify-between border-b border-black/[0.08] px-4 dark:border-white/[0.06]">
        <div className="flex items-center gap-2 font-mono text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
          {activeCount > 0 ? <Loader2 className="h-4 w-4 animate-spin text-[#10a37f]" /> : <Clock3 className="h-4 w-4 text-[#10a37f]" />}
          后台任务
          {activeCount > 0 && <span className="rounded bg-[#10a37f]/10 px-1.5 py-0.5 text-[10px] text-[#10a37f]">{activeCount}</span>}
        </div>
        <div className="app-no-drag flex items-center gap-1">
          <button
            type="button"
            onClick={() => void refresh()}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] transition hover:bg-black/[0.06] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
            aria-label="刷新"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] transition hover:bg-black/[0.06] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        <p className="mb-3 text-[12.5px] leading-relaxed text-[#6e6e73] dark:text-[#9a9ca3]">
          做图、做视频、子代理研究这些慢活会在这里继续跑。任务完成或失败后也能回来找。
        </p>

        {msg && <div className={`mb-2 text-[12px] ${msg.kind === "ok" ? "text-[#10a37f]" : "text-[#ff3b30]"}`}>{msg.text}</div>}

        {loading && tasks.length === 0 ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-[#86868b]" /></div>
        ) : tasks.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/[0.1] px-3 py-6 text-center text-[12.5px] text-[#86868b] dark:border-white/[0.1] dark:text-[#6e7077]">
            暂时没有后台任务。
          </div>
        ) : (
          <div className="space-y-2">
            {tasks.map((task) => {
              const state = taskStatusLabel(task.status);
              const p = progressOf(task);
              const summary = task.error || resultSummary(task.result);
              const url = firstResultUrl(task.result);
              const isImg = !!url && /\.(svg|png|jpe?g|webp|gif)(?:$|\?)/i.test(url);
              return (
                <div key={task.id} className="rounded-lg border border-black/[0.06] bg-black/[0.015] p-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
                  <div className="mb-1.5 flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{task.title}</div>
                      <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[10.5px]">
                        <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]">{kindLabel(task.kind)}</span>
                        <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]">{fmtTime(task.updatedAt)}</span>
                        <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${state.cls}`}>
                          <state.Icon className={`h-3 w-3 ${task.status === "running" ? "animate-spin" : ""}`} />
                          {state.text}
                        </span>
                      </div>
                    </div>
                    {isActive(task.status) && (
                      <button
                        type="button"
                        onClick={() => setCancelTarget(task)}
                        disabled={busyId === task.id}
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#86868b] transition hover:bg-[#ff3b30]/10 hover:text-[#ff3b30] disabled:opacity-50"
                        aria-label="停止任务"
                      >
                        {busyId === task.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
                      </button>
                    )}
                  </div>

                  {(task.stage || isActive(task.status)) && (
                    <div className="mb-1.5">
                      <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-black/[0.06] dark:bg-white/[0.08]">
                        <div className="h-full rounded-full bg-[#10a37f] transition-all" style={{ width: `${p}%` }} />
                      </div>
                      <div className="text-[11.5px] text-[#6e6e73] dark:text-[#9a9ca3]">{task.stage || "处理中…"}</div>
                    </div>
                  )}

                  {summary && (
                    <div className={`rounded bg-black/[0.02] p-2 text-[11.5px] leading-relaxed dark:bg-white/[0.03] ${task.error ? "text-[#ff3b30]" : "text-[#3a3a3c] dark:text-[#c8cace]"}`}>
                      {summary}
                    </div>
                  )}

                  {url && (
                    <div className="mt-2 overflow-hidden rounded-md border border-black/[0.06] dark:border-white/[0.06]">
                      {isImg ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={api.resolveUrl(url)} alt="" className="max-h-44 w-full object-contain bg-white dark:bg-[#0e0f11]" />
                      ) : (
                        <a href={api.resolveUrl(url)} target="_blank" rel="noreferrer" className="block px-2 py-2 text-[12px] text-[#10a37f]">
                          打开结果
                        </a>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!cancelTarget}
        title="停止这个后台任务？"
        message={`「${cancelTarget?.title || ""}」会收到停止请求；如果它已经交给外部生成服务，可能需要等服务端返回后才结束。`}
        confirmLabel="停止"
        destructive
        onConfirm={() => void confirmCancel()}
        onCancel={() => setCancelTarget(null)}
      />
    </aside>
  );
}
