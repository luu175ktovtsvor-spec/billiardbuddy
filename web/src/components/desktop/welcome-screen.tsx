"use client";

/**
 * 桌面端欢迎/空状态：问候 + 今日建议（主动出击）+ 起手卡片（点了直接让管家做）+ 短输入提示。
 * 学 Gemini/ChatGPT 的做法——能力靠起手卡片秀，不靠占位符解释。设计图 docs/design/mockups/agent-welcome.html。
 */
import type { LucideIcon } from "lucide-react";
import { FileText, BarChart3, Image as ImageIcon, CalendarDays, Lightbulb } from "lucide-react";

export type StarterCard = {
  Icon: LucideIcon;
  title: string;
  hint: string;
  prompt: string; // 点了发给管家的话
};

const DEFAULT_STARTERS: StarterCard[] = [
  { Icon: FileText, title: "写条周末活动朋友圈", hint: "双人优惠，发圈引流", prompt: "帮我写条周末双人优惠的朋友圈" },
  { Icon: BarChart3, title: "照报表看这月经营", hint: "选张导出的报表，我来诊断", prompt: "照我导出的报表，诊断一下这个月的经营" },
  { Icon: ImageIcon, title: "做张拉新海报", hint: "描述想要的，我生图（先确认）", prompt: "帮我做一张拉新海报" },
  { Icon: CalendarDays, title: "给我一周不重样的朋友圈", hint: "一次出一批，挑着发", prompt: "给我写一周不重样的朋友圈，每天一条" },
];

export function WelcomeScreen({
  greeting = "你好，老板",
  todaySuggestion,
  starters = DEFAULT_STARTERS,
  onPick,
}: {
  greeting?: string;
  todaySuggestion?: string;
  starters?: StarterCard[];
  onPick?: (prompt: string) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-8">
      <div className="-mt-6 w-full max-w-[640px]">
        {/* 图标 + 问候 */}
        <div className="mb-7 flex flex-col items-center text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/agent-icon.png" alt="球房管家" className="mb-4 h-16 w-16 rounded-2xl shadow-sm" />
          <div className="text-[24px] font-semibold text-[#1d1d1f]">{greeting}</div>
          <div className="mt-1 text-[15px] text-[#86868b]">今天想让我帮你做点什么？说一句，或点下面试试。</div>
        </div>

        {/* 今日建议（主动出击） */}
        {todaySuggestion && (
          <div
            className="mb-3 flex items-center gap-3 rounded-xl border p-3.5"
            style={{ borderColor: "#007AFF33", background: "#007AFF0a" }}
          >
            <Lightbulb className="h-5 w-5 shrink-0 text-brand-600" />
            <div className="flex-1">
              <div className="text-[13px] font-medium text-[#1d1d1f]">今日建议</div>
              <div className="mt-0.5 text-[13px] text-[#3a3a3c]">{todaySuggestion}</div>
            </div>
            <button
              onClick={() => onPick?.(todaySuggestion)}
              className="whitespace-nowrap rounded-lg bg-brand-600 px-3.5 py-1.5 text-[13px] text-white transition active:scale-[0.98]"
            >
              帮我写
            </button>
          </div>
        )}

        {/* 起手卡片 */}
        <div className="grid grid-cols-2 gap-2.5">
          {starters.map((s) => (
            <button
              key={s.title}
              onClick={() => onPick?.(s.prompt)}
              className="rounded-xl border border-black/[0.07] bg-white p-3.5 text-left shadow-sm transition hover:bg-black/[0.015] active:scale-[0.99]"
            >
              <s.Icon className="mb-1.5 h-4 w-4 text-brand-600" />
              <div className="text-[13.5px] font-medium text-[#1d1d1f]">{s.title}</div>
              <div className="mt-0.5 text-[12px] text-[#86868b]">{s.hint}</div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
