"use client";

/**
 * 桌面端底部输入区：权限分段控件（逐项确认 / 自动接受修改 / 跳过确认）+ 短占位符输入框。
 * 权限值仍是后端那套 ask / auto_files / full，只是给老板看的文案换成大白话（不显示技术黑话）。
 */
import { useState } from "react";
import { Paperclip, ArrowUp, AlertTriangle } from "lucide-react";

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
  fullDisk = false,
  onFullDiskChange,
  disabled,
  placeholder = "问问台球运营管家…",
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  permissionMode?: PermissionMode;
  onPermissionChange?: (m: PermissionMode) => void;
  fullDisk?: boolean;
  onFullDiskChange?: (v: boolean) => void;
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

        {/* 完全访问模式：和上面的「权限模式」是两回事——权限模式管"做之前问不问你"，
            这个开关管"AI 能碰的范围"（开了不再限于内容库+你选定的文件，可找/改整台电脑的文件、跑命令）。
            醒目标红警示，默认关。 */}
        <button
          type="button"
          onClick={() => onFullDiskChange?.(!fullDisk)}
          aria-pressed={fullDisk}
          title="完全访问模式：允许 AI 找/改你整台电脑的文件、跑命令，慎用"
          className={`ml-auto inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[12px] transition active:scale-[0.97] ${
            fullDisk
              ? "border-[#ff3b30]/40 bg-[#ff3b30]/[0.08] text-[#ff3b30]"
              : "border-black/[0.08] bg-white text-[#86868b] hover:text-[#1d1d1f]"
          }`}
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          完全访问模式
          <span
            className={`ml-0.5 flex h-4 w-7 shrink-0 items-center rounded-full px-0.5 transition ${
              fullDisk ? "justify-end bg-[#ff3b30]" : "justify-start bg-black/[0.15]"
            }`}
          >
            <span className="h-3 w-3 rounded-full bg-white" />
          </span>
        </button>
      </div>

      {/* 开了完全访问模式：醒目红色警示。和"跳过确认"叠加最危险，提示用户。 */}
      {fullDisk && (
        <p className="mx-auto mb-2.5 flex max-w-[760px] items-start gap-1.5 text-[11px] leading-relaxed text-[#ff3b30]">
          <AlertTriangle className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span>
            完全访问模式已开：AI 不再限于内容库和你选定的文件，可以找/改你整台电脑上的任意文件、还能在你电脑上跑命令。
            功能更强，但误改/误删风险也更大——确定信任再开，平时建议关掉，只让它动你选的文件。
          </span>
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
