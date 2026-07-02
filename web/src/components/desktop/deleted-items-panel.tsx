"use client";

import { useEffect, useState } from "react";
import { Loader2, RotateCcw, Trash2, X } from "lucide-react";

import { api, type RecentArtifact } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";

export function DeletedItemsPanel({
  open,
  onClose,
  onRestored,
}: {
  open: boolean;
  onClose: () => void;
  onRestored?: () => void;
}) {
  const [items, setItems] = useState<RecentArtifact[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function refresh() {
    try {
      const r = await api.listDeletedItems(40);
      setItems(r.items || []);
    } catch (e) {
      setErr(getErrorMessage(e));
    }
  }

  useEffect(() => { if (open) void refresh(); }, [open]);

  async function restore(item: RecentArtifact) {
    setBusy(`r-${item.id}`); setErr(null);
    try {
      await api.restoreDeletedItem({
        id: item.id,
        conversation_id: item.kind === "file_change" ? item.path : item.kind === "task" ? item.conversation_id : undefined,
        kind: item.kind,
      });
      await refresh();
      onRestored?.();
    } catch (e) {
      setErr(getErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function purge(item: RecentArtifact) {
    setBusy(`p-${item.id}`); setErr(null);
    try {
      await api.purgeDeletedItem({ id: item.id, conversation_id: item.kind === "task" ? item.conversation_id : undefined, kind: item.kind });
      await refresh();
    } catch (e) {
      setErr(getErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function clearAll() {
    if (!items.length || busy) return;
    const ok = window.confirm("清空后，这里的会话、作品、门店资料和已删除文件备份将无法恢复。确定清空最近删除？");
    if (!ok) return;
    setBusy("clear"); setErr(null);
    try {
      await api.clearDeletedItems();
      await refresh();
      onRestored?.();
    } catch (e) {
      setErr(getErrorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  if (!open) return null;

  return (
    <aside className="fixed right-0 top-0 z-[63] flex h-full w-[420px] max-w-[92vw] flex-col border-l border-black/[0.08] bg-white shadow-2xl dark:border-white/[0.08] dark:bg-[#16181d]">
      <div className="app-drag app-titlebar-safe-right flex h-[44px] items-center justify-between border-b border-black/[0.08] px-4 dark:border-white/[0.06]">
        <div className="font-mono text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">最近删除</div>
        <div className="app-no-drag flex items-center gap-1.5">
          {items.length > 0 && (
            <button
              type="button"
              onClick={() => void clearAll()}
              disabled={busy === "clear"}
              className="flex h-7 items-center gap-1 rounded-md px-2 text-[12px] text-[#ff3b30] transition hover:bg-[#ff3b30]/10 disabled:opacity-50"
            >
              {busy === "clear" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              清空
            </button>
          )}
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
          删除的会话、作品和门店资料先放在这里。恢复后会回到原来的位置；彻底删除后就不再显示。
        </p>
        {err && <div className="mb-2 text-[12px] text-[#ff3b30]">{err}</div>}
        {items.length === 0 ? (
          <div className="rounded-lg border border-dashed border-black/[0.1] px-3 py-6 text-center text-[12.5px] text-[#86868b] dark:border-white/[0.1] dark:text-[#6e7077]">
            这里现在是空的。
          </div>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={`${item.kind}-${item.id}`} className="rounded-lg border border-black/[0.06] bg-black/[0.015] p-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{item.title}</div>
                    <div className="mt-0.5 text-[11.5px] text-[#86868b] dark:text-[#6e7077]">{item.subtitle}</div>
                  </div>
                </div>
                <div className="mt-2 flex justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={() => void restore(item)}
                    disabled={busy === `r-${item.id}`}
                    className="flex h-8 items-center gap-1 rounded-md bg-[#10a37f] px-2.5 text-[12px] text-white transition hover:bg-[#0d8c6d] disabled:opacity-50"
                  >
                    {busy === `r-${item.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                    恢复
                  </button>
                  <button
                    type="button"
                    onClick={() => void purge(item)}
                    disabled={busy === `p-${item.id}`}
                    className="flex h-8 items-center gap-1 rounded-md border border-[#ff3b30]/25 px-2.5 text-[12px] text-[#ff3b30] transition hover:bg-[#ff3b30]/10 disabled:opacity-50"
                  >
                    {busy === `p-${item.id}` ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                    彻底删除
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
