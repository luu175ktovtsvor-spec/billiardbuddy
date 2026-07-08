"use client";

/**
 * 空状态/欢迎（浅色默认 · 跟随系统）：专业 agent 基调 + 轻量快捷入口。
 */
import { Loader2, Sparkles, Database, MousePointerClick, Search, History } from "lucide-react";
import { WELCOME } from "@/lib/agent-copy";
import type { DashboardRecommendation } from "@/types/dashboard";
import { BriefingCard } from "./briefing-card";

const quickActionClass =
  "inline-flex h-7 min-w-0 items-center justify-center gap-1.5 rounded-md px-2 text-[12px] text-[#6e6e73] transition hover:bg-black/[0.04] hover:text-[#1d1d1f] active:scale-[0.98] disabled:opacity-60 dark:text-[#8e9198] dark:hover:bg-white/[0.06] dark:hover:text-[#e6e7e9]";
const quickActionIconClass = "h-3.5 w-3.5 shrink-0 text-[#10a37f]";

export function WelcomeScreen({
  greeting = WELCOME.title,
  subtitle = WELCOME.subtitle,
  briefing,
  reportHint,
  onDiagnoseReport,
  onDismissReport,
  billiardsMode = false,
  onPick,
  onDismissRec,
  onDailyDrafts,
  dailyDraftsBusy = false,
  continueTitle,
  onContinueLast,
  onOpenStoreMemory,
  onViewScreen,
  onResearch,
  onReadAloud,
  onStopReadAloud,
  readingKey,
}: {
  greeting?: string;
  subtitle?: string;
  briefing?: { greeting: string; weekday: string; items: DashboardRecommendation[] }; // 当日店况简报（C1）：AI 先开口的多条洞察
  reportHint?: { name: string; path: string }; // C1 首启特例：检测到的报表提示，出现在简报卡顶部
  onDiagnoseReport?: (path: string, name: string) => void; // 点「诊断一下」：授权读该文件 + 发诊断指令
  onDismissReport?: () => void; // 点「不感兴趣」：当天不再提示
  billiardsMode?: boolean; // 挂台球知识库时展示店况简报；主对话首屏不再展示场景卡。
  onPick?: (prompt: string, recId?: string) => void;
  onDismissRec?: (recId: string) => void; // 简报卡「不感兴趣」：故障安全踩一下、后端记今天收起
  onDailyDrafts?: () => void;    // P1-4：点一下让管家把今天能发的内容草稿备好
  dailyDraftsBusy?: boolean;
  continueTitle?: string;
  onContinueLast?: () => void;
  onOpenStoreMemory?: () => void;
  onViewScreen?: () => void;
  onResearch?: () => void;
  // D-Task-8 读给我听：只桌面版有(electron?.tts 判空后才传)，透传给简报卡念 greeting。
  // key 由调用方传回(简报卡固定用 "greeting")，readingKey 是 chat-shell 层的单一状态源，
  // 用来判断"现在念的是不是我这条"，简报卡自己不用管 reading 状态。
  onReadAloud?: (content: string, key: string) => void;
  onStopReadAloud?: () => void;
  readingKey?: string | number | null;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-8">
      <div className="-mt-4 w-full max-w-[600px]">
        <div className="mb-6 flex flex-col items-center text-center">
          <div className="text-[22px] font-semibold tracking-tight text-[#1d1d1f] dark:text-[#e6e7e9]">{greeting}</div>
          <div className="mt-1.5 max-w-[440px] text-[13px] leading-relaxed text-[#86868b] dark:text-[#6e7077]">{subtitle}</div>
        </div>

        {billiardsMode && (briefing || reportHint) && onPick && onDismissRec && (
          <div className="mb-3">
            <BriefingCard
              greeting={briefing?.greeting ?? ""}
              weekday={briefing?.weekday ?? ""}
              items={briefing?.items ?? []}
              onPick={onPick}
              onDismiss={onDismissRec}
              reportHint={reportHint}
              onDiagnoseReport={onDiagnoseReport}
              onDismissReport={onDismissReport}
              onReadAloud={onReadAloud}
              onStopReadAloud={onStopReadAloud}
              reading={readingKey === "greeting"}
            />
          </div>
        )}

        {/* P1-4 每日草稿：点一下让管家把今天能发的几条内容备好（后端预生成+缓存，挑着用） */}
        {/* P1-7 首屏别过载：快捷能力改成 Work Buddy / Codex 式轻量 action，不再堆按钮卡片。 */}
        {(onContinueLast || onDailyDrafts || onOpenStoreMemory || onViewScreen || onResearch) && (
          <div className="mb-4 flex flex-wrap justify-center gap-1">
            {onContinueLast && (
              <button
                type="button"
                onClick={onContinueLast}
                className={quickActionClass}
                title={continueTitle ? `继续：${continueTitle}` : "继续上次工作"}
              >
                <History className={quickActionIconClass} />
                <span className="truncate">继续上次工作</span>
              </button>
            )}
            {onDailyDrafts && (
            <button
              onClick={onDailyDrafts}
              disabled={dailyDraftsBusy}
              className={quickActionClass}
            >
              {dailyDraftsBusy
                ? <><Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> <span className="truncate">正在准备</span></>
                : <><Sparkles className={quickActionIconClass} /> <span className="truncate">准备今日内容</span></>}
            </button>
            )}
            {onOpenStoreMemory && (
              <button
                type="button"
                onClick={onOpenStoreMemory}
                className={quickActionClass}
              >
                <Database className={quickActionIconClass} /> <span className="truncate">资料库</span>
              </button>
            )}
            {onViewScreen && (
              <button
                type="button"
                onClick={onViewScreen}
                aria-label="看当前屏幕"
                className={quickActionClass}
              >
                <MousePointerClick className={quickActionIconClass} /> <span className="truncate">看当前屏幕</span>
              </button>
            )}
            {onResearch && (
              <button
                type="button"
                onClick={onResearch}
                className={quickActionClass}
              >
                <Search className={quickActionIconClass} /> <span className="truncate">查资料</span>
              </button>
            )}
          </div>
        )}

      </div>
    </div>
  );
}
