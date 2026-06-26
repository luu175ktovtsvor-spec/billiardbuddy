"use client";

import { useEffect, useRef } from "react";

export function ConfirmDialog({
  open,
  title,
  message,
  confirmLabel = "确认",
  cancelLabel = "取消",
  destructive,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) btnRef.current?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-[70] bg-black/30 dark:bg-black/50" onClick={onCancel} role="dialog" data-modal-open />
      <div className="fixed left-1/2 top-1/2 z-[71] w-[340px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-black/[0.1] bg-white p-5 shadow-2xl dark:border-white/[0.1] dark:bg-[#1c1e24]">
        <h3 className="text-[14px] font-semibold text-[#1d1d1f] dark:text-[#e6e7e9]">{title}</h3>
        {message && <p className="mt-1.5 text-[13px] leading-relaxed text-[#6e6e73] dark:text-[#9a9ca3]">{message}</p>}
        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-md border border-black/[0.1] bg-white px-4 py-1.5 text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
          >
            {cancelLabel}
          </button>
          <button
            ref={btnRef}
            type="button"
            onClick={onConfirm}
            className={`rounded-md px-4 py-1.5 text-[13px] font-medium text-white transition active:scale-[0.98] ${
              destructive
                ? "bg-[#ff3b30] hover:bg-[#e0342b]"
                : "bg-[#10a37f] hover:bg-[#0e906f]"
            }`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </>
  );
}
