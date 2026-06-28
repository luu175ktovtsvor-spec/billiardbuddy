"use client";

/**
 * 空状态/欢迎（浅色默认 · 跟随系统）：CC 式专业 agent 基调 + 今日建议 + 起手卡片（点了直接派活）。
 */
import type { LucideIcon } from "lucide-react";
import { MessageSquareText, FolderOpen, Image as ImageIcon, Lightbulb, Monitor, Loader2, Sparkles, Brain, MousePointerClick, Search, History, Trash2, FileClock } from "lucide-react";
import { WELCOME } from "@/lib/agent-copy";
import type { RecentArtifact } from "@/lib/api";

export type StarterCard = {
  Icon: LucideIcon;
  title: string;
  hint: string;
  prompt: string;
};

const DEFAULT_STARTERS: StarterCard[] = [
  { Icon: MessageSquareText, title: "直接说要做什么", hint: "写文案、看报表、整理资料都从这里开始", prompt: "今天店里该干啥，你给我排一下" },
  { Icon: ImageIcon, title: "做图片 / 视频", hint: "海报、封面、朋友圈图，先从一句话生成", prompt: "做一张 9:16 的台球周赛海报，适合发朋友圈" },
];

export function WelcomeScreen({
  greeting = WELCOME.title,
  subtitle = WELCOME.subtitle,
  todaySuggestion,
  todaySuggestionRecId,
  starters = DEFAULT_STARTERS,
  onPick,
  onPickWorkingDir,
  workingDir,
  onDailyDrafts,
  dailyDraftsBusy = false,
  continueTitle,
  onContinueLast,
  recentItems = [],
  onOpenRecent,
  onDeleteRecent,
  onOpenStoreMemory,
  onViewScreen,
  onResearch,
}: {
  greeting?: string;
  subtitle?: string;
  todaySuggestion?: string;
  todaySuggestionRecId?: string; // 今日建议对应的 rec.id：点「帮我写」时回传做"采纳上浮"
  starters?: StarterCard[];
  onPick?: (prompt: string, recId?: string) => void;
  onPickWorkingDir?: () => void;
  workingDir?: string | null;
  onDailyDrafts?: () => void;    // P1-4：点一下让管家把今天能发的内容草稿备好
  dailyDraftsBusy?: boolean;
  continueTitle?: string;
  onContinueLast?: () => void;
  recentItems?: RecentArtifact[];
  onOpenRecent?: (item: RecentArtifact) => void;
  onDeleteRecent?: (item: RecentArtifact) => void;
  onOpenStoreMemory?: () => void;
  onViewScreen?: () => void;
  onResearch?: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-8">
      <div className="-mt-4 w-full max-w-[640px]">
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-black/[0.07] bg-white text-[#007AFF] shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
            <Monitor className="h-6 w-6" />
          </div>
          <div className="text-[22px] font-semibold tracking-tight text-[#1d1d1f] dark:text-[#e6e7e9]">{greeting}</div>
          <div className="mt-1.5 max-w-[440px] text-[13px] leading-relaxed text-[#86868b] dark:text-[#6e7077]">{subtitle}</div>
        </div>

        {todaySuggestion && (
          <div className="mb-3 flex items-center gap-3 rounded-lg border border-[#10a37f]/25 bg-[#10a37f]/[0.06] p-3">
            <Lightbulb className="h-4 w-4 shrink-0 text-[#10a37f]" />
            <div className="min-w-0 flex-1">
              <div className="text-[11px] font-medium tracking-wide text-[#10a37f]">今日建议</div>
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

        {/* P1-4 每日草稿：点一下让管家把今天能发的几条内容备好（后端预生成+缓存，挑着用） */}
        {/* P1-7 首屏别过载:5 连按钮改自适应换行的轻量快捷项(不删功能、读作次级),让 3 张起手卡是主角。 */}
        {(onContinueLast || onDailyDrafts || onOpenStoreMemory || onViewScreen || onResearch) && (
          <div className="mb-3 flex flex-wrap gap-2">
            {onContinueLast && (
              <button
                type="button"
                onClick={onContinueLast}
                className="flex min-w-0 items-center justify-center gap-2 rounded-lg border border-[#007AFF]/20 bg-[#007AFF]/[0.05] px-3 py-2 text-[12.5px] text-[#3a3a3c] shadow-sm transition hover:bg-[#007AFF]/[0.08] active:scale-[0.99] dark:border-[#007AFF]/25 dark:bg-[#007AFF]/[0.08] dark:text-[#c8cace]"
                title={continueTitle ? `继续：${continueTitle}` : "继续上次工作"}
              >
                <History className="h-3.5 w-3.5 shrink-0 text-[#007AFF]" />
                <span className="truncate">继续上次工作</span>
              </button>
            )}
            {onDailyDrafts && (
            <button
              onClick={onDailyDrafts}
              disabled={dailyDraftsBusy}
              className="flex items-center justify-center gap-2 rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-[12.5px] text-[#3a3a3c] shadow-sm transition hover:bg-black/[0.02] active:scale-[0.99] disabled:opacity-60 dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-[#c8cace] dark:hover:bg-white/[0.05]"
            >
              {dailyDraftsBusy
                ? <><Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> <span className="truncate">正在备……</span></>
                : <><Sparkles className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" /> <span className="truncate">不知道今天发啥？帮我备好几条</span></>}
            </button>
            )}
            {onOpenStoreMemory && (
              <button
                type="button"
                onClick={onOpenStoreMemory}
                className="flex items-center justify-center gap-2 rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-[12.5px] text-[#3a3a3c] shadow-sm transition hover:bg-black/[0.02] active:scale-[0.99] dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-[#c8cace] dark:hover:bg-white/[0.05]"
              >
                <Brain className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" /> <span className="truncate">我的球房资料</span>
              </button>
            )}
            {onViewScreen && (
              <button
                type="button"
                onClick={onViewScreen}
                aria-label="看当前屏幕"
                className="flex items-center justify-center gap-2 rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-[12.5px] text-[#3a3a3c] shadow-sm transition hover:bg-black/[0.02] active:scale-[0.99] dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-[#c8cace] dark:hover:bg-white/[0.05]"
              >
                <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" /> <span className="truncate">看当前屏幕</span>
              </button>
            )}
            {onResearch && (
              <button
                type="button"
                onClick={onResearch}
                className="flex items-center justify-center gap-2 rounded-lg border border-black/[0.08] bg-white px-3 py-2 text-[12.5px] text-[#3a3a3c] shadow-sm transition hover:bg-black/[0.02] active:scale-[0.99] dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-[#c8cace] dark:hover:bg-white/[0.05]"
              >
                <Search className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" /> <span className="truncate">查资料</span>
              </button>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <button
            type="button"
            onClick={() => onPick?.(starters[0]?.prompt || "")}
            className="group min-h-[104px] rounded-lg border border-black/[0.07] bg-white p-3 text-left shadow-sm transition hover:border-black/[0.12] hover:bg-black/[0.01] active:scale-[0.99] dark:border-white/[0.07] dark:bg-[#141519] dark:shadow-none dark:hover:border-white/[0.14] dark:hover:bg-[#181a1f]"
          >
            <MessageSquareText className="mb-2 h-4 w-4 text-[#007AFF]" />
            <div className="text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">直接说要做什么</div>
            <div className="mt-1 text-[11.5px] leading-snug text-[#86868b] dark:text-[#6e7077]">一句话交代任务，我来判断要不要读文件、查资料、做图。</div>
          </button>

          <button
            type="button"
            onClick={onPickWorkingDir}
            className={`group min-h-[104px] rounded-lg border p-3 text-left shadow-sm transition active:scale-[0.99] dark:shadow-none ${
              workingDir
                ? "border-[#10a37f]/25 bg-[#10a37f]/[0.06] hover:border-[#10a37f]/40"
                : "border-black/[0.07] bg-white hover:border-black/[0.12] hover:bg-black/[0.01] dark:border-white/[0.07] dark:bg-[#141519] dark:hover:border-white/[0.14] dark:hover:bg-[#181a1f]"
            }`}
          >
            <FolderOpen className={`mb-2 h-4 w-4 ${workingDir ? "text-[#10a37f]" : "text-[#007AFF]"}`} />
            <div className="text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">选择工作文件夹</div>
            <div className="mt-1 text-[11.5px] leading-snug text-[#86868b] dark:text-[#6e7077]">
              {workingDir ? `当前：${workingDir.split(/[\\/]/).pop()}` : "新建或打开一个文件夹，让 AI 默认在这里干活。"}
            </div>
          </button>

          {starters.filter((s) => s.title !== "直接说要做什么").map((s) => (
            <button
              key={s.title}
              onClick={() => onPick?.(s.prompt)}
              className="group min-h-[104px] rounded-lg border border-black/[0.07] bg-white p-3 text-left shadow-sm transition hover:border-black/[0.12] hover:bg-black/[0.01] active:scale-[0.99] dark:border-white/[0.07] dark:bg-[#141519] dark:shadow-none dark:hover:border-white/[0.14] dark:hover:bg-[#181a1f]"
            >
              <s.Icon className="mb-2 h-4 w-4 text-[#007AFF]" />
              <div className="text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{s.title}</div>
              <div className="mt-1 text-[11.5px] leading-snug text-[#86868b] dark:text-[#6e7077]">{s.hint}</div>
            </button>
          ))}
        </div>

        {recentItems.length > 0 && (
          <div className="mt-5">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[11px] font-medium tracking-wide text-[#86868b] dark:text-[#6e7077]">最近作品 / 任务</div>
            </div>
            <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
              {recentItems.slice(0, 4).map((item) => {
                const fileName = item.path?.split(/[\\/]/).pop() || item.title;
                const isFileChange = item.kind === "file_change";
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => onOpenRecent?.(item)}
                    className={`min-w-0 rounded-lg border px-3 py-2 text-left shadow-sm transition active:scale-[0.99] dark:shadow-none ${
                      isFileChange
                        ? "border-[#007AFF]/20 bg-[#007AFF]/[0.04] hover:border-[#007AFF]/35 hover:bg-[#007AFF]/[0.07] dark:border-[#007AFF]/25 dark:bg-[#007AFF]/[0.08]"
                        : "border-black/[0.06] bg-white hover:border-[#10a37f]/30 hover:bg-[#10a37f]/[0.04] dark:border-white/[0.07] dark:bg-[#141519]"
                    }`}
                    title={isFileChange && item.path ? `打开 ${item.path} 的改动对比，可恢复到备份` : undefined}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {isFileChange && <FileClock className="h-3.5 w-3.5 shrink-0 text-[#007AFF]" />}
                        <span className="truncate text-[12.5px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{isFileChange ? fileName : item.title}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <span className={`text-[10.5px] ${isFileChange ? "text-[#007AFF]" : "text-[#10a37f]"}`}>{isFileChange ? "可恢复" : item.subtitle}</span>
                        {onDeleteRecent && item.kind !== "file_change" && (
                          <span
                            role="button"
                            tabIndex={0}
                            aria-label="移入最近删除"
                            title="移入最近删除"
                            onClick={(e) => { e.stopPropagation(); onDeleteRecent(item); }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter" || e.key === " ") {
                                e.preventDefault();
                                e.stopPropagation();
                                onDeleteRecent(item);
                              }
                            }}
                            className="inline-flex h-5 w-5 items-center justify-center rounded-md text-[#a1a1a6] transition hover:bg-[#ff3b30]/10 hover:text-[#ff3b30]"
                          >
                            <Trash2 className="h-3 w-3" />
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[11.5px] text-[#86868b] dark:text-[#6e7077]">
                      {item.kind === "poster" && item.ratio
                        ? `${item.ratio}${item.width && item.height ? ` · ${item.width}x${item.height}` : ""}`
                        : item.kind === "video" && (item.ratio || item.duration)
                          ? [item.ratio, item.duration ? `${item.duration}秒` : ""].filter(Boolean).join(" · ")
                          : item.kind === "file_change"
                            ? `${item.content || "打开改动对比"} · 点击看改前/改后`
                            : item.created_at ? new Date(item.created_at).toLocaleString() : "打开查看"}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
