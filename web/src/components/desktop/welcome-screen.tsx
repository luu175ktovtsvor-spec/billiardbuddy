"use client";

/**
 * 空状态/欢迎（浅色默认 · 跟随系统）：CC 式专业 agent 基调 + 今日建议 + 起手卡片（点了直接派活）。
 */
import type { LucideIcon } from "lucide-react";
import { MessageSquareText, Image as ImageIcon, Lightbulb, Monitor, Loader2, Sparkles, Brain, MousePointerClick, Search, History, Trash2, FileClock, FileSpreadsheet, Star, Users, Clapperboard, FolderCog } from "lucide-react";
import { WELCOME } from "@/lib/agent-copy";
import type { RecentArtifact } from "@/lib/api";

export type StarterCard = {
  Icon: LucideIcon;
  title: string;
  hint: string;
  prompt: string;
};

// C2 场景卡·台球套（6 张，计划钦定场景，别删别换主题）：文案写老板的事、不写 AI 功能名，
// prompt 是"提示词代写"起手——需要用户补料的（报表/差评），让管家先开口问用户要料。
export const BILLIARDS_STARTERS: StarterCard[] = [
  { Icon: MessageSquareText, title: "写今晚的朋友圈", hint: "一句话交代场景，我来写今晚能发的", prompt: "帮我写一条今晚能发的朋友圈，突出今晚到店的理由" },
  { Icon: ImageIcon, title: "做张周末对抗赛海报", hint: "9:16 竖版，适合发朋友圈和群", prompt: "做一张 9:16 的周末台球对抗赛海报，适合发朋友圈" },
  { Icon: FileSpreadsheet, title: "把这份报表读给我听", hint: "把经营报表挑成你听得懂的几句", prompt: "我发你一份经营报表，帮我读一下，挑 3 个我最该关注的问题（报表我发给你、或告诉你在电脑哪）" },
  { Icon: Star, title: "顾客差评帮我回", hint: "真诚、不甩锅、能挽回的回复", prompt: "顾客给了条差评，帮我写一条真诚、不甩锅、能挽回的平台回复（差评内容我发给你）" },
  { Icon: Users, title: "策划散客转会员活动", hint: "把散客变成储值会员的活动", prompt: "帮我策划一个把散客转成储值会员的活动方案，力度合理、赠送别过度" },
  { Icon: Clapperboard, title: "剪条 15 秒氛围短视频", hint: "台球房氛围燃剪，适合抖音", prompt: "帮我剪一条 15 秒左右的台球房氛围短视频，适合发抖音、视频号同城" },
];

// C2 场景卡·通用套（5 张，不挂台球知识库时展示）
export const GENERIC_STARTERS: StarterCard[] = [
  { Icon: FolderCog, title: "整理这个文件夹", hint: "归归类、该改名的改名", prompt: "帮我整理一下这个文件夹，把文件归归类、该改名的改名（文件夹拖给我、或告诉我路径）" },
  { Icon: FileSpreadsheet, title: "把这份报表读给我听", hint: "表格/报表挑重点讲给你听", prompt: "我发你一份表格或报表，帮我读一下，挑几个重点讲给我听" },
  { Icon: MessageSquareText, title: "写一段文案", hint: "说用途和大概意思，我来写", prompt: "帮我写一段文案，我说用途和大概意思" },
  { Icon: ImageIcon, title: "做张图", hint: "一句话生成，海报/封面都行", prompt: "帮我做一张图，我说要什么样的" },
  { Icon: Search, title: "上网帮我查点东西", hint: "查完给你挑重点", prompt: "帮我上网查一下：（我说查什么）" },
];

export function WelcomeScreen({
  greeting = WELCOME.title,
  subtitle = WELCOME.subtitle,
  todaySuggestion,
  todaySuggestionRecId,
  starters,
  billiardsMode = false,
  onPick,
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
  billiardsMode?: boolean; // 挂台球知识库时展示台球 6 张场景卡，否则展示通用 5 张
  onPick?: (prompt: string, recId?: string) => void;
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
  const cards = starters ?? (billiardsMode ? BILLIARDS_STARTERS : GENERIC_STARTERS);
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
        {/* P1-7 首屏别过载:5 连按钮改自适应换行的轻量快捷项(不删功能、读作次级),让起手卡是主角。
            A4:工作文件夹卡已撤(零仪式,首启自动建作品文件夹,用户不用选),起手卡从 3 张变 2 张。 */}
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
                ? <><Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin" /> <span className="truncate">正在准备…</span></>
                : <><Sparkles className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" /> <span className="truncate">帮我准备今天能发的内容</span></>}
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

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {cards.map((s) => (
            <button
              key={s.title}
              type="button"
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
