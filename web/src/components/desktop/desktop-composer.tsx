"use client";

/**
 * 桌面端底部输入区：权限分段控件（都先问我 / 日常自己做 / 全部自己做）+ 短占位符输入框。
 * 权限值仍是后端那套 ask / auto_files / full，只是给老板看的文案换成大白话（不显示技术黑话）。
 */
import { useState } from "react";
import { Paperclip, ArrowUp } from "lucide-react";

export type PermissionMode = "ask" | "auto_files" | "full";

// 用词照搬 Claude Code 的权限模式概念（default/acceptEdits/bypassPermissions），忠实翻译、不自己编：
const MODES: { value: PermissionMode; label: string }[] = [
  { value: "ask", label: "逐项确认" },        // ≈ Claude default：每步都问
  { value: "auto_files", label: "自动接受修改" }, // ≈ Claude acceptEdits：自动接受改动，花钱/对外仍问
  { value: "full", label: "跳过确认" },        // ≈ Claude bypassPermissions：免确认
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

      {/* 切到「跳过确认」(full) 时明确告知：做海报会直接花老板自己的 BYOK 生图 Key 的钱（B-5，配合后端一轮花钱上限闸）。 */}
      {permissionMode === "full" && (
        <p className="mx-auto mb-2.5 max-w-[760px] text-[11px] leading-relaxed text-amber-600">
          ⚠️ 跳过确认后，做海报会直接用你的 Key 花钱生图、不再逐张问你（同一次任务里出图超过设定张数才会再弹确认）。这是你自己的生图账号，留意余额。
        </p>
      )}

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
