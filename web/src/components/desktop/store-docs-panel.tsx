"use client";

/**
 * D-Task-6：店铺资料库面板——老板选一个装着合同/价目表/排班表/进货单的文件夹，后台自动语义索引，
 * 之后对话里 AI 能翻这些文件回答、带出处。跟"台球行业知识库"(懂行业打法的那套)分开——这个是
 * "懂你家"：只认老板自己选的这个文件夹里的文档。落点仿 scheduled-tasks-panel.tsx(独立 fixed 抽屉)，
 * 入口挂在 chat-shell 顶部条("我的球房资料"/"定时任务"/"最近删除"旁边)。
 *
 * 选文件夹复用现成 Electron IPC files:pick({directory:true})(D-Task-4 之前就有，不改壳)。
 * 索引在后台跑：PUT/reindex 调用返回时 status 已经是 indexing，这里轮询 GET 直到变
 * ready/error 才停(别一直轮)。
 */
import { useEffect, useRef, useState } from "react";
import { FolderOpen, Loader2, RefreshCw, Trash2, X } from "lucide-react";

import { api } from "@/lib/api";
import type { StoreDocLibraryItem } from "@/lib/api";
import { useDesktop } from "@/hooks/use-desktop";
import { getErrorMessage } from "@/lib/utils";
import { ConfirmDialog } from "./confirm-dialog";

const POLL_MS = 2500;

/** last_indexed_at 可能是无时区后缀的 ISO 串(SQLite 丢 tzinfo，同 D-Task-4 定时任务遇到的坑)——
 * 没有 +/Z/±HH:MM 后缀时当 UTC 处理再转本地显示，避免差 8 小时。这字段不关键，解析不出就留空。 */
function fmtIndexedAt(iso: string | null): string {
  if (!iso) return "";
  const hasTz = /Z$/i.test(iso) || /[+-]\d{2}:\d{2}$/.test(iso);
  const d = new Date(hasTz ? iso : `${iso}Z`);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

const EMPTY_ITEM: StoreDocLibraryItem = {
  folder_path: null, status: "idle", indexed_file_count: 0, indexed_chunk_count: 0,
  last_indexed_at: null, last_error: null,
};

function statusView(item: StoreDocLibraryItem | null): { text: string; cls: string } {
  if (!item || item.status === "idle") {
    return { text: "还没设置", cls: "bg-black/[0.05] text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]" };
  }
  if (item.status === "indexing") {
    return { text: "正在整理你的资料…", cls: "bg-[#007AFF]/12 text-[#007AFF]" };
  }
  if (item.status === "error") {
    return { text: "出错了", cls: "bg-[#ff3b30]/12 text-[#ff3b30]" };
  }
  return { text: `已就绪 · ${item.indexed_file_count} 个文件`, cls: "bg-[#10a37f]/12 text-[#10a37f]" };
}

export function StoreDocsPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { electron } = useDesktop();
  const [item, setItem] = useState<StoreDocLibraryItem | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<"pick" | "reindex" | "clear" | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [clearConfirm, setClearConfirm] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  function stopPoll() {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }

  // 首次打开(或重开)拉一次现状
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setMsg(null);
    (async () => {
      try {
        const row = await api.getStoreDocs();
        if (!cancelled) setItem(row);
      } catch (e) {
        if (!cancelled) setMsg({ kind: "err", text: getErrorMessage(e) });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [open]);

  // 轮询：只要现状是 indexing 就每 2.5s 查一次，变成 ready/error 立刻停，面板关闭也停。
  useEffect(() => {
    if (!open || item?.status !== "indexing") { stopPoll(); return; }
    let cancelled = false;
    pollRef.current = setInterval(() => {
      api.getStoreDocs().then((row) => {
        if (cancelled) return;
        setItem(row);
        if (row.status !== "indexing") stopPoll();
      }).catch(() => { /* 单次轮询失败先不打断，下一轮再试 */ });
    }, POLL_MS);
    return () => { cancelled = true; stopPoll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.status]);

  // 卸载兜底清定时器
  useEffect(() => () => stopPoll(), []);

  if (!open) return null;

  async function pickFolder() {
    if (!electron?.files?.pick) {
      setMsg({ kind: "err", text: "选文件夹需要桌面版。" });
      return;
    }
    setBusy("pick");
    setMsg(null);
    try {
      const r = await electron.files.pick({ directory: true, title: "选一个装着你店里资料的文件夹" });
      if (r.canceled || !r.paths?.length) return;
      const row = await api.setStoreDocsFolder(r.paths[0]);
      setItem(row);
      setMsg({ kind: "ok", text: "开始整理了，弄好会显示文件数" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function reindex() {
    setBusy("reindex");
    setMsg(null);
    try {
      const row = await api.reindexStoreDocs();
      setItem(row);
      setMsg({ kind: "ok", text: "重新整理中…" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  async function clear() {
    setClearConfirm(false);
    setBusy("clear");
    setMsg(null);
    try {
      await api.clearStoreDocs();
      setItem(EMPTY_ITEM);
      setMsg({ kind: "ok", text: "已清除" });
    } catch (e) {
      setMsg({ kind: "err", text: getErrorMessage(e) });
    } finally {
      setBusy(null);
    }
  }

  const sv = statusView(item);
  const hasFolder = !!item?.folder_path;
  const isIndexing = item?.status === "indexing";

  return (
    <aside className="fixed right-0 top-0 z-[62] flex h-full w-[420px] max-w-[92vw] flex-col border-l border-black/[0.08] bg-white shadow-2xl dark:border-white/[0.08] dark:bg-[#16181d]">
      <div className="app-drag app-titlebar-safe-right flex h-[44px] items-center justify-between border-b border-black/[0.08] px-4 dark:border-white/[0.06]">
        <div className="flex items-center gap-2 font-mono text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">
          <FolderOpen className="h-4 w-4 text-[#10a37f]" /> 店铺资料库
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
          把你店里的合同、价目表、排班表、进货单放一个文件夹，我就能随时帮你查、答问题时告诉你依据哪份文件。
          这跟「台球行业知识库」不是一回事——那个是我懂台球这行的打法，这个是我懂你家店的资料。
        </p>

        {loading ? (
          <div className="flex justify-center py-6"><Loader2 className="h-4 w-4 animate-spin text-[#86868b]" /></div>
        ) : !hasFolder ? (
          <div className="mb-3 rounded-lg border border-dashed border-black/[0.1] px-3 py-6 text-center text-[12.5px] text-[#86868b] dark:border-white/[0.1] dark:text-[#6e7077]">
            还没设置店铺资料。选一个放着你店里文档的文件夹，我就能帮你查了。
          </div>
        ) : (
          <div className="mb-3 rounded-lg border border-black/[0.06] bg-black/[0.015] p-3 dark:border-white/[0.06] dark:bg-white/[0.02]">
            <div className="mb-1.5 flex items-center gap-2">
              <span
                className="min-w-0 flex-1 truncate text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]"
                title={item?.folder_path || ""}
              >
                {baseName(item?.folder_path || "")}
              </span>
              {isIndexing && <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#007AFF]" />}
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[10.5px]">
              <span className={`rounded px-1.5 py-0.5 ${sv.cls}`}>{sv.text}</span>
              {item?.status === "ready" && item.last_indexed_at && fmtIndexedAt(item.last_indexed_at) && (
                <span className="rounded bg-black/[0.05] px-1.5 py-0.5 text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]">
                  {fmtIndexedAt(item.last_indexed_at)}整理的
                </span>
              )}
            </div>
            {item?.status === "error" && item.last_error && (
              <div className="mt-1.5 rounded bg-[#ff3b30]/[0.06] p-2 text-[11.5px] leading-relaxed text-[#ff3b30]">
                没弄成：{item.last_error}
              </div>
            )}
          </div>
        )}

        {msg && <div className={`mb-2 text-[12px] ${msg.kind === "ok" ? "text-[#10a37f]" : "text-[#ff3b30]"}`}>{msg.text}</div>}

        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => void pickFolder()}
            disabled={busy !== null || isIndexing}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#10a37f] px-3 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-[#0d8c6d] disabled:opacity-50"
          >
            {busy === "pick" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
            {hasFolder ? "换一个文件夹" : "选文件夹"}
          </button>
          {hasFolder && (
            <>
              <button
                type="button"
                onClick={() => void reindex()}
                disabled={busy !== null || isIndexing}
                title="文件夹里加了新文件？点这个让我重新看一遍"
                className="inline-flex items-center gap-1.5 rounded-lg border border-black/[0.08] px-3 py-1.5 text-[12.5px] font-medium text-[#3a3a3c] transition hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/[0.08] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
              >
                {busy === "reindex" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                重新整理
              </button>
              <button
                type="button"
                onClick={() => setClearConfirm(true)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] text-[#86868b] transition hover:bg-[#ff3b30]/10 hover:text-[#ff3b30] disabled:opacity-50"
              >
                {busy === "clear" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                清除
              </button>
            </>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={clearConfirm}
        title="清除店铺资料？"
        message="文件夹里的原文件不会删，但我会忘记里面的内容，以后就查不到了。"
        confirmLabel="清除"
        destructive
        onConfirm={() => void clear()}
        onCancel={() => setClearConfirm(false)}
      />
    </aside>
  );
}
