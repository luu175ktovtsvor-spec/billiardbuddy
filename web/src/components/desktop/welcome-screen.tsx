"use client";

/**
 * 空状态/欢迎（浅色默认 · 跟随系统）：CC 式专业 agent 基调 + 今日建议 + 起手卡片（点了直接派活）。
 */
import type { LucideIcon } from "lucide-react";
import { FileText, BarChart3, Image as ImageIcon, CalendarDays, Lightbulb, Terminal } from "lucide-react";
import { WELCOME } from "@/lib/agent-copy";

export type StarterCard = {
  Icon: LucideIcon;
  title: string;
  hint: string;
  prompt: string;
};

const DEFAULT_STARTERS: StarterCard[] = [
  { Icon: FileText, title: "写条周末活动朋友圈", hint: "双人优惠，发圈引流", prompt: "帮我写条周末双人优惠的朋友圈" },
  { Icon: BarChart3, title: "照报表看这月经营", hint: "选张导出的报表，我来诊断", prompt: "照我导出的报表，诊断一下这个月的经营" },
  { Icon: ImageIcon, title: "做张拉新海报", hint: "描述想要的，我生图（先确认）", prompt: "帮我做一张拉新海报" },
  { Icon: CalendarDays, title: "一周不重样的朋友圈", hint: "一次出一批，挑着发", prompt: "给我写一周不重样的朋友圈，每天一条" },
];

export function WelcomeScreen({
  greeting = WELCOME.title,
  subtitle = WELCOME.subtitle,
  todaySuggestion,
  todaySuggestionRecId,
  starters = DEFAULT_STARTERS,
  onPick,
}: {
  greeting?: string;
  subtitle?: string;
  todaySuggestion?: string;
  todaySuggestionRecId?: string; // 今日建议对应的 rec.id：点「帮我写」时回传做"采纳上浮"
  starters?: StarterCard[];
  onPick?: (prompt: string, recId?: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-8">
      <div className="-mt-4 w-full max-w-[600px]">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-black/[0.07] bg-white text-[#10a37f] shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
            <Terminal className="h-6 w-6" />
          </div>
          <div className="text-[22px] font-semibold tracking-tight text-[#1d1d1f] dark:text-[#e6e7e9]">{greeting}</div>
          <div className="mt-1.5 max-w-[440px] text-[13px] leading-relaxed text-[#86868b] dark:text-[#6e7077]">{subtitle}</div>
        </div>

        {todaySuggestion && (
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-[#10a37f]/25 bg-[#10a37f]/[0.06] p-3">
            <Lightbulb className="h-4 w-4 shrink-0 text-[#10a37f]" />
            <div className="min-w-0 flex-1">
              <div className="font-mono text-[10px] uppercase tracking-wider text-[#10a37f]">今日建议</div>
              <div className="mt-0.5 truncate text-[12.5px] text-[#3a3a3c] dark:text-[#c8cace]">{todaySuggestion}</div>
            </div>
            <button
              onClick={() => onPick?.(todaySuggestion, todaySuggestionRecId)}
              className="whitespace-nowrap rounded-md bg-[#10a37f] px-3 py-1.5 text-[12px] text-white transition hover:bg-[#0e906f] active:scale-[0.98]"
            >
              帮我写
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          {starters.map((s) => (
            <button
              key={s.title}
              onClick={() => onPick?.(s.prompt)}
              className="group rounded-lg border border-black/[0.07] bg-white p-3 text-left shadow-sm transition hover:border-black/[0.12] hover:bg-black/[0.01] active:scale-[0.99] dark:border-white/[0.07] dark:bg-[#141519] dark:shadow-none dark:hover:border-white/[0.14] dark:hover:bg-[#181a1f]"
            >
              <s.Icon className="mb-1.5 h-4 w-4 text-[#10a37f]" />
              <div className="text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{s.title}</div>
              <div className="mt-0.5 text-[11.5px] text-[#86868b] dark:text-[#6e7077]">{s.hint}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
