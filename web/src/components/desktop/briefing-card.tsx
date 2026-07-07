"use client";

/**
 * C-Task-5 C1 当日店况简报：欢迎屏里的低噪建议行。
 * AI 可以先开口，但首屏最多露一条可执行建议，避免主对话入口变成卡片看板。
 */
import { Lightbulb, ArrowRight, X, FileSpreadsheet, Volume2 } from "lucide-react";
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
  reportHint,
  onDiagnoseReport,
  onDismissReport,
  onReadAloud,
  onStopReadAloud,
  reading = false,
}: {
  greeting: string;
  weekday: string;
  items: DashboardRecommendation[];
  onPick: (prompt: string, recId?: string) => void;
  onDismiss: (recId: string) => void;
  reportHint?: { name: string; path: string }; // C1 首启特例：检测到的报表，出现在洞察行之上
  onDiagnoseReport?: (path: string, name: string) => void;
  onDismissReport?: () => void;
  // D-Task-8 读给我听：只桌面版有(electron?.tts 判空后才传)，点喇叭念 greeting。
  onReadAloud?: (content: string, key: string) => void;
  onStopReadAloud?: () => void;
  // 是否正在念这条 greeting——由 chat-shell 层的单一 readingKey 状态源算出来传入，本组件不自
  // 己攥一份 reading 状态（避免和对话流各管一份、组件卸载/切视图时互相打架或漏管）。
  reading?: boolean;
}) {
  // 「没东西可说就不硬凑」：滤掉纯兜底 default_generate；首屏最多露 1 条，剩下交给对话继续展开。
  const insights = items.filter((r) => r.id !== "default_generate").slice(0, 1);
  if (insights.length === 0 && !reportHint) return null;

  return (
    <div className="border-y border-black/[0.06] py-2 dark:border-white/[0.06]">
      <div className="mb-1.5 flex items-center gap-1.5">
        <Lightbulb className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
        <span className="text-[11px] font-medium tracking-wide text-[#10a37f]">
          今日店况{weekday && WEEKDAY_CN[weekday] ? ` · ${WEEKDAY_CN[weekday]}` : ""}
        </span>
      </div>
      {greeting && (
        <div className="mb-2 flex items-start gap-1.5">
          <div className="flex-1 text-[12.5px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]">{greeting}</div>
          {onReadAloud && (
            <button
              type="button"
              onClick={() => {
                if (reading) {
                  onStopReadAloud?.();
                } else {
                  onReadAloud(greeting, "greeting");
                }
              }}
              aria-label={reading ? "停止朗读" : "读给我听"}
              title={reading ? "停止朗读" : "读给我听"}
              className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-md transition active:scale-[0.97] ${
                reading
                  ? "bg-[#10a37f]/15 text-[#10a37f]"
                  : "text-[#a1a1a6] hover:bg-black/[0.04] hover:text-[#10a37f] dark:hover:bg-white/[0.06]"
              }`}
            >
              <Volume2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}
      {reportHint && onDiagnoseReport && (
        <div className="flex items-start gap-2 border-t border-black/[0.06] py-2 dark:border-white/[0.06]">
          <FileSpreadsheet className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
          <div className="min-w-0 flex-1 text-[12.5px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]">
            我看到一份《{reportHint.name}》，要不要我先给你一句话诊断？
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              onClick={() => onDiagnoseReport(reportHint.path, reportHint.name)}
              className="app-primary-action flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-[11.5px] transition active:scale-[0.98]"
            >
              诊断一下 <ArrowRight className="h-3 w-3" />
            </button>
            {onDismissReport && (
              <button
                type="button"
                onClick={onDismissReport}
                aria-label="不感兴趣"
                title="不感兴趣，今天先不提"
                className="flex h-6 w-6 items-center justify-center rounded-md text-[#a1a1a6] transition hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:hover:bg-white/[0.06] dark:hover:text-[#e6e7e9]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        </div>
      )}
      <div className={reportHint ? "" : "border-t border-black/[0.05] dark:border-white/[0.05]"}>
        {insights.map((r) => {
          const label = SOURCE_LABEL[r.category ?? "focus"] ?? "今日运营";
          return (
            <div
              key={r.id}
              className="flex items-start gap-2 border-b border-black/[0.05] py-2 last:border-b-0 dark:border-white/[0.05]"
            >
              <div className="min-w-0 flex-1">
                <div className="mb-0.5 flex items-center gap-1.5">
                  <span
                    title="为什么给你推这条"
                    className="shrink-0 rounded bg-[#10a37f]/10 px-1.5 py-0.5 text-[10px] font-medium text-[#10a37f]"
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
                  className="app-primary-action flex items-center gap-1 whitespace-nowrap rounded-md px-2.5 py-1 text-[11.5px] transition active:scale-[0.98]"
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
