"use client";

/**
 * 桌面端底部输入区：权限分段控件（都先问我 / 日常自己做 / 全部自己做）+ 短占位符输入框。
 * 权限值仍是后端那套 ask / auto_files / full，只是给老板看的文案换成大白话（不显示技术黑话）。
 */
import { useState } from "react";
import { Paperclip, ArrowUp } from "lucide-react";

export type PermissionMode = "ask" | "auto_files" | "full";

const MODES: { value: PermissionMode; label: string }[] = [
  { value: "ask", label: "都先问我" },
  { value: "auto_files", label: "日常自己做" },
  { value: "full", label: "全部自己做" },
];

export function DesktopComposer({
  value,
  onChange,
  onSend,
  permissionMode = "ask",
  onPermissionChange,
  disabled,
  placeholder = "问问球房管家…",
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  permissionMode?: PermissionMode;
  onPermissionChange?: (m: PermissionMode) => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [composing, setComposing] = useState(false);

  return (
    <div className="px-5 pb-4 pt-2">
      {/* 权限分段控件 */}
      <div className="mx-auto mb-2.5 flex max-w-[760px] items-center gap-2">
        <span className="text-[11px] text-[#86868b]">权限</span>
        <div className="inline-flex rounded-lg bg-black/[0.05] p-0.5 text-[12px]">
          {MODES.map((m) => (
            <button
              key={m.value}
              onClick={() => onPermissionChange?.(m.value)}
              className={`rounded-md px-3 py-1 transition ${
                permissionMode === m.value ? "bg-white text-[#1d1d1f] shadow-sm" : "text-[#86868b]"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <span className="text-[11px] text-[#86868b]">· 群发、对外发布始终先问你</span>
      </div>

      {/* 输入框 */}
      <div className="mx-auto flex max-w-[760px] items-end gap-2 rounded-xl border border-black/[0.07] bg-white px-3 py-2 shadow-sm">
        <button className="flex h-8 w-8 items-center justify-center rounded-md text-[#86868b] hover:bg-black/[0.05]" aria-label="附件">
          <Paperclip className="h-[18px] w-[18px]" />
        </button>
        <textarea
          rows={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={() => setComposing(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !composing) {
              e.preventDefault();
              if (!disabled && value.trim()) onSend();
            }
          }}
          placeholder={placeholder}
          className="flex-1 resize-none bg-transparent py-1.5 text-[14px] text-[#1d1d1f] outline-none placeholder:text-[#b0b0b5]"
        />
        <button
          onClick={() => !disabled && value.trim() && onSend()}
          disabled={disabled || !value.trim()}
          className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white transition active:scale-[0.95] disabled:opacity-40"
          aria-label="发送"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
