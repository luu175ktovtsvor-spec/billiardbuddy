"use client";

/**
 * `/` 命令面板（对标 Claude Code 的 slash 补全）：输入以 / 开头时浮在输入框上方，
 * 列出内置命令 + 已安装技能(Skill)，↑↓ 选、回车/Tab 选中、Esc 收起。配色沿用 #10a37f。
 */
import { Sparkles, Command } from "lucide-react";

export type PaletteItem =
  | { kind: "builtin"; name: string; description: string; cn?: string }
  | { kind: "command"; name: string; description: string; whenToUse?: string }
  | { kind: "skill"; name: string; description: string; argHint?: string };

export function SlashPalette({
  items,
  activeIndex,
  title = "命令与技能",
  onSelect,
  onHover,
}: {
  items: PaletteItem[];
  activeIndex: number;
  title?: string;
  onSelect: (item: PaletteItem) => void;
  onHover: (i: number) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="absolute bottom-[calc(100%+8px)] left-0 z-50 max-h-[300px] w-[440px] overflow-y-auto rounded-lg border border-black/[0.1] bg-white p-1.5 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.25)] dark:border-white/[0.1] dark:bg-[#1c1e24] dark:shadow-[0_12px_40px_-10px_rgba(0,0,0,0.7)]">
      <div className="px-2.5 pb-1 pt-1.5 font-mono text-[10px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">
        {title}
      </div>
      {items.map((it, i) => (
        <button
          key={`${it.kind}:${it.name}`}
          type="button"
          onClick={() => onSelect(it)}
          onMouseEnter={() => onHover(i)}
          className={`flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition ${
            i === activeIndex ? "bg-[#10a37f]/10" : "hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
          }`}
        >
          {it.kind === "skill" ? (
            <Sparkles className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
          ) : (
            <Command className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
          )}
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              {/* G.3：中文做主视觉、/英文退成小灰字（中专老板看中文、不记英文斜杠命令） */}
              {it.kind === "builtin" && it.cn ? (
                <>
                  <span className="text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{it.cn}</span>
                  <span className="font-mono text-[11px] text-[#a1a1a6] dark:text-[#6e7077]">/{it.name}</span>
                </>
              ) : (
                <span className="font-mono text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">/{it.name}</span>
              )}
              {it.kind === "skill" && it.argHint && (
                <span className="font-mono text-[11px] text-[#a1a1a6] dark:text-[#6e7077]">{it.argHint}</span>
              )}
              {it.kind === "skill" && (
                <span className="rounded bg-[#10a37f]/10 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-[#10a37f]">技能</span>
              )}
              {it.kind === "command" && (
                <span className="rounded bg-black/[0.05] px-1 py-px text-[9px] font-medium uppercase tracking-wide text-[#86868b] dark:bg-white/[0.06] dark:text-[#8a8c93]">命令</span>
              )}
            </span>
            {it.description && (
              <span className="mt-0.5 block truncate text-[11.5px] text-[#6e6e73] dark:text-[#8a8c93]">{it.description}</span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}
