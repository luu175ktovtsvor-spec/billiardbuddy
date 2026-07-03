"use client";

/**
 * C3：回答底部按钮太多(最多冒 10 个)收敛用——常驻留 2~3 个高频纯图标，
 * 其余次要动作(右侧打开/保存成品/导出到电脑/转成任务/这条不太合适…)收进一个「…」溢出菜单。
 * macOS 风格下拉：点外部/Esc 关，键盘可达(原生 button + role=menu)，z 层级低于 toast(z-[100])。
 */
import { useEffect, useState } from "react";
import { MoreHorizontal, type LucideIcon } from "lucide-react";

export type OverflowMenuItem = {
  key: string;
  label: string;
  Icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
};

export function OverflowMenu({
  items,
  title = "更多",
}: {
  items: OverflowMenuItem[];
  title?: string;
}) {
  const [open, setOpen] = useState(false);

  // Esc 关闭；只在打开时挂监听，关闭时自动清理，避免每条消息都常驻一个全局监听器。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (items.length === 0) return null;

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex h-7 w-7 items-center justify-center rounded-md transition active:scale-[0.97] ${
          open
            ? "bg-black/[0.04] text-[#1d1d1f] dark:bg-white/[0.06] dark:text-[#e6e7e9]"
            : "text-[#86868b] hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:text-[#8a8c93] dark:hover:bg-white/[0.06] dark:hover:text-[#e6e7e9]"
        }`}
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {open && (
        <>
          {/* 点外部关闭：全屏透明层，z-40 低于下面菜单本体(z-50)，也低于 toast(z-[100]) */}
          <button type="button" aria-hidden tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div
            role="menu"
            className="absolute right-0 top-[calc(100%+6px)] z-50 w-[180px] rounded-lg border border-black/[0.1] bg-white p-1.5 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.25)] dark:border-white/[0.1] dark:bg-[#1c1e24] dark:shadow-[0_12px_40px_-10px_rgba(0,0,0,0.7)]"
          >
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onClick();
                }}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-[12.5px] font-medium text-[#1d1d1f] transition hover:bg-black/[0.04] active:scale-[0.99] disabled:opacity-40 dark:text-[#c8cace] dark:hover:bg-white/[0.05]"
              >
                <item.Icon className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#8a8c93]" />
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
