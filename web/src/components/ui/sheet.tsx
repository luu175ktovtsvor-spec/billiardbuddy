"use client";

import { useEffect } from "react";
import { X } from "lucide-react";

/** 底部抽屉(Bottom Sheet)——手机端替代居中弹窗的标准容器。
 * 从屏幕底部滑出、大圆角、带把手条,点遮罩或 × 关闭;内容超高可滚动。
 * 桌面端同样可用(窄面板居中显示也不难看),无需分支。 */
export function Sheet({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  // 打开时锁定背景滚动
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg rounded-t-2xl bg-white pb-[calc(1rem+env(safe-area-inset-bottom))] shadow-2xl"
        style={{ animation: "slideUp 0.22s ease-out" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* 把手条 */}
        <div className="flex justify-center pt-2.5 pb-1">
          <div className="h-1 w-9 rounded-full bg-slate-200" />
        </div>
        {(title || true) && (
          <div className="flex items-center justify-between px-5 pb-2 pt-1">
            <p className="text-base font-semibold text-slate-900">{title || ""}</p>
            <button
              type="button"
              onClick={onClose}
              aria-label="关闭"
              className="flex h-9 w-9 items-center justify-center rounded-full text-slate-400 active:bg-slate-100"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        )}
        <div className="max-h-[72vh] overflow-y-auto px-5 pb-2">{children}</div>
      </div>
    </div>
  );
}
