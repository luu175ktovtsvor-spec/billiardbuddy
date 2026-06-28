"use client";

/**
 * 单窗口 Codex 风外壳：slim 侧栏（会话/设置）+ 主区（transcript + composer）+ 可选右侧预览。
 * 浅色为默认、跟随系统深浅色（dark: 变体）。仅桌面端渲染；整窗自己掌控外观。
 * 顶部留给原生红绿灯（Electron titleBarStyle:'hiddenInset'），可拖拽区用 .app-drag。
 */
import { Plus, Settings, Cpu, Terminal, Trash2, PanelsTopLeft, Wand2 } from "lucide-react";

import { useHorizontalResize } from "./use-resize";

export type DesktopConversation = {
  id: string;
  title: string;
  subtitle?: string;
  group?: string;
};

export function DesktopSidebar({
  storeName = "我的台球房",
  monthlySpend,
  modelLabel,
  advancedMode = false,
  conversations = [],
  activeId,
  onNewChat,
  onNewWorkspace,
  onOpenStudio,
  onSelect,
  onDelete,
  onOpenSettings,
}: {
  storeName?: string;
  monthlySpend?: string;
  modelLabel?: string;
  advancedMode?: boolean;
  conversations?: DesktopConversation[];
  activeId?: string;
  onNewChat?: () => void;
  onNewWorkspace?: () => void;
  onOpenStudio?: () => void;
  onSelect?: (id: string) => void;
  onDelete?: (id: string) => void;
  onOpenSettings?: () => void;
}) {
  const groups: { name: string; items: DesktopConversation[] }[] = [];
  for (const c of conversations) {
    const name = c.group || "最近";
    let g = groups.find((x) => x.name === name);
    if (!g) { g = { name, items: [] }; groups.push(g); }
    g.items.push(c);
  }

  const { width, onHandleMouseDown } = useHorizontalResize({
    storageKey: "desktop.sidebarWidth", defaultWidth: 244, min: 200, max: 420, edge: "right",
  });

  return (
    <aside style={{ width }} className="relative flex shrink-0 flex-col border-r border-black/[0.08] bg-[#f5f5f7] dark:border-white/[0.06] dark:bg-[#0b0c0e]">
      <div className="app-drag h-[40px]" />
      <div className="app-drag flex items-center gap-2 px-3.5 pb-3">
        <span className="flex h-6 w-6 items-center justify-center rounded-md bg-[#10a37f]/15 text-[#10a37f]">
          <Terminal className="h-3.5 w-3.5" />
        </span>
        <span className="font-mono text-[13px] font-medium tracking-tight text-[#1d1d1f] dark:text-[#e6e7e9]">本机 AI 助手</span>
      </div>

      <div className="flex gap-1.5 px-2.5">
        <button
          onClick={onNewChat}
          className="app-no-drag flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-black/[0.08] bg-white px-2.5 text-[12.5px] text-[#3a3a3c] shadow-sm transition hover:bg-black/[0.02] active:scale-[0.99] dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-[#c8cace] dark:shadow-none dark:hover:bg-white/[0.05]"
        >
          <Plus className="h-3.5 w-3.5 text-[#10a37f]" /> 新会话
        </button>
        {onOpenStudio && (
          <button
            onClick={onOpenStudio}
            title="打开生成工作室（做图/改图）"
            aria-label="生成工作室"
            className="app-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-black/[0.08] bg-white text-[#86868b] shadow-sm transition hover:bg-black/[0.02] hover:text-[#10a37f] active:scale-[0.99] dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-[#6e7077] dark:shadow-none dark:hover:bg-white/[0.05] dark:hover:text-[#10a37f]"
          >
            <Wand2 className="h-3.5 w-3.5" />
          </button>
        )}
        {onNewWorkspace && (
          <button
            onClick={onNewWorkspace}
            title="新开一个独立工作台窗口"
            aria-label="新工作台"
            className="app-no-drag flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-black/[0.08] bg-white text-[#86868b] shadow-sm transition hover:bg-black/[0.02] hover:text-[#10a37f] active:scale-[0.99] dark:border-white/[0.08] dark:bg-white/[0.02] dark:text-[#6e7077] dark:shadow-none dark:hover:bg-white/[0.05] dark:hover:text-[#10a37f]"
          >
            <PanelsTopLeft className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <div className="mt-3 flex-1 overflow-y-auto px-1.5">
        {groups.map((g) => (
          <div key={g.name} className="mb-2.5">
            <div className="mb-1 px-2 text-[11px] font-medium tracking-wide text-[#a1a1a6] dark:text-[#54565d]">{g.name}</div>
            {g.items.map((c) => (
              <div
                key={c.id}
                className={`group app-no-drag mb-px flex items-center rounded-md transition ${
                  c.id === activeId
                    ? "bg-black/[0.06] text-[#1d1d1f] dark:bg-white/[0.07] dark:text-[#e6e7e9]"
                    : "text-[#6e6e73] hover:bg-black/[0.04] dark:text-[#9a9ca3] dark:hover:bg-white/[0.035]"
                }`}
              >
                <button
                  onClick={() => onSelect?.(c.id)}
                  aria-label={`打开会话 ${c.title}`}
                  className="min-w-0 flex-1 px-2.5 py-1.5 text-left"
                >
                  <div className="truncate text-[12.5px]">{c.title}</div>
                </button>
                {onDelete && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onDelete(c.id); }}
                    aria-label="删除会话"
                    title="删除这条会话"
                    className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded text-[#86868b] opacity-0 transition hover:bg-black/[0.08] hover:text-[#d93025] group-hover:opacity-100 dark:text-[#6e7077] dark:hover:bg-white/[0.08]"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>

      {/* 普通路径只显示"AI 已就绪"，不甩模型品牌名(技术词)给非技术老板；高级模式才露真实模型名。 */}
      <button
        onClick={onOpenSettings}
        className="app-no-drag mx-1.5 mb-1 mt-1.5 flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.04]"
        aria-label={advancedMode && modelLabel ? `正在用模型 ${modelLabel}，点击修改` : "AI 已就绪，点击打开设置"}
      >
        <Cpu className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
        {advancedMode && modelLabel ? (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-[#6e6e73] dark:text-[#9a9ca3]">{modelLabel}</span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-[11px] text-[#6e6e73] dark:text-[#9a9ca3]">AI 已就绪</span>
        )}
      </button>

      <div className="flex items-center gap-2 border-t border-black/[0.08] p-2.5 dark:border-white/[0.06]">
        <div className="flex h-6 w-6 items-center justify-center rounded-md bg-[#10a37f]/15 text-[11px] font-semibold text-[#10a37f]">
          {storeName.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-[#3a3a3c] dark:text-[#c8cace]">{storeName}</div>
          {/* 别提醒花钱:默认藏花费,只在高级模式露(和上面模型名同档) */}
          {advancedMode && monthlySpend && (
            <div className="truncate font-mono text-[10.5px] text-[#86868b] dark:text-[#6e7077]">本月 ≈ {monthlySpend}</div>
          )}
        </div>
        <button
          onClick={onOpenSettings}
          className="app-no-drag flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] transition hover:bg-black/[0.06] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
          aria-label="设置"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
      <div
        onMouseDown={onHandleMouseDown}
        className="app-no-drag absolute right-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-[#10a37f]/40"
        title="拖拽调整侧栏宽度"
      />
    </aside>
  );
}

/** 整窗外壳：sidebar + main（+ 可选右侧预览）。浅色默认、跟随系统，铺满 Electron 窗口。 */
export function DesktopShell({
  sidebar,
  children,
  preview,
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  preview?: React.ReactNode;
}) {
  return (
    <div className="flex h-screen w-full overflow-hidden bg-white text-[#1d1d1f] antialiased dark:bg-[#0e0f11] dark:text-[#e6e7e9]">
      {sidebar}
      <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-[#0e0f11]">{children}</main>
      {preview}
    </div>
  );
}
