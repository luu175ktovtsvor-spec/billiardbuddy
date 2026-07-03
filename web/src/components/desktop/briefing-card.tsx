"use client";

/**
 * C-Task-5 C1 当日店况简报卡：欢迎屏单行「今日建议」banner 的升级版——
 * AI 先开口，多条洞察，每条带「出处/为什么推它」+ 去做 + 不感兴趣，没内容不硬凑。
 */
import { Lightbulb, ArrowRight, X } from "lucide-react";
import type { DashboardRecommendation } from "@/types/dashboard";

// category → 「出处/为什么推它」标签（诚实版：说清依据、立信任）
const SOURCE_LABEL: Record<string, string> = {
  store: "店情专属",
  festival: "节日营销",
  stage: "成长阶段",
  report: "日报提醒",
  setup: "完善资料",
  gap: "补个短板",
  frequent: "你常用",
  good: "复刻好评",
  focus: "今日运营",
};
const WEEKDAY_CN: Record<string, string> = {
  Monday: "周一",
  Tuesday: "周二",
  Wednesday: "周三",
  Thursday: "周四",
  Friday: "周五",
  Saturday: "周六",
  Sunday: "周日",
};

export function BriefingCard({
  greeting,
  weekday,
  items,
  onPick,
  onDismiss,
}: {
  greeting: string;
  weekday: string;
  items: DashboardRecommendation[];
  onPick: (prompt: string, recId?: string) => void;
  onDismiss: (recId: string) => void;
}) {
  // 「没东西可说就不硬凑」：滤掉纯兜底 default_generate；空了整卡不出
  const insights = items.filter((r) => r.id !== "default_generate").slice(0, 3);
  if (insights.length === 0) return null;

  return (
    <div className="rounded-lg border border-[#10a37f]/25 bg-[#10a37f]/[0.06] p-3">
      <div className="mb-2 flex items-center gap-1.5">
        <Lightbulb className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
        <span className="text-[11px] font-medium tracking-wide text-[#10a37f]">
          今日店况{weekday && WEEKDAY_CN[weekday] ? ` · ${WEEKDAY_CN[weekday]}` : ""}
        </span>
      </div>
      {greeting && (
        <div className="mb-2.5 text-[12.5px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]">{greeting}</div>
      )}
      <div className="flex flex-col gap-2">
        {insights.map((r) => {
          const label = SOURCE_LABEL[r.category ?? "focus"] ?? "今日运营";
          return (
            <div
              key={r.id}
              className="flex items-start gap-2 rounded-md border border-black/[0.05] bg-white/70 p-2.5 dark:border-white/[0.06] dark:bg-white/[0.03]"
            >
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex items-center gap-1.5">
                  <span
                    title="为什么给你推这条"
                    className="shrink-0 rounded-full bg-[#10a37f]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#10a37f]"
                  >
                    {label}
                  </span>
                  <span className="truncate text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{r.title}</span>
                </div>
                {r.description && (
                  <div className="truncate text-[11.5px] text-[#86868b] dark:text-[#6e7077]">{r.description}</div>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  onClick={() => onPick(r.description || r.title, r.id)}
                  className="flex items-center gap-1 whitespace-nowrap rounded-md bg-[#10a37f] px-2.5 py-1 text-[11.5px] text-white transition hover:bg-[#0e906f] active:scale-[0.98]"
                >
                  去做 <ArrowRight className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  onClick={() => onDismiss(r.id)}
                  aria-label="不感兴趣"
                  title="不感兴趣，今天先不提这条"
                  className="flex h-6 w-6 items-center justify-center rounded-md text-[#a1a1a6] transition hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:hover:bg-white/[0.06] dark:hover:text-[#e6e7e9]"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
