"use client";

/**
 * 桌面端（Electron）macOS 风外壳：左侧毛玻璃侧栏 + 主区（+ 可选右侧预览栏）。
 * 仅在 useDesktop().isDesktop 下渲染；手机网页版走原有布局，二者物理隔离、互不影响。
 * 设计图见 docs/design/mockups/agent-*.html、规范见 docs/design/桌面Agent-macOS设计规范.md。
 * 真机 macOS 质感（无边框窗口 + 原生红绿灯 + 毛玻璃）由 Electron titleBarStyle:'hiddenInset' + vibrancy 提供，
 * 顶部 52px 留给原生红绿灯；可拖拽区用 .app-drag（见 globals.css）。
 */
import { Plus, Settings } from "lucide-react";

export type DesktopConversation = {
  id: string;
  title: string;
  subtitle?: string;
  group?: string; // "今天" / "前 7 天" …
};

export function DesktopSidebar({
  storeName = "我的台球房",
  monthlySpend,
  conversations = [],
  activeId,
  onNewChat,
  onSelect,
  onOpenSettings,
}: {
  storeName?: string;
  monthlySpend?: string;
  conversations?: DesktopConversation[];
  activeId?: string;
  onNewChat?: () => void;
  onSelect?: (id: string) => void;
  onOpenSettings?: () => void;
}) {
  // 按 group 分组保序
  const groups: { name: string; items: DesktopConversation[] }[] = [];
  for (const c of conversations) {
    const name = c.group || "最近";
    let g = groups.find((x) => x.name === name);
    if (!g) {
      g = { name, items: [] };
      groups.push(g);
    }
    g.items.push(c);
  }

  return (
    <aside className="flex w-[240px] shrink-0 flex-col border-r border-black/[0.07] bg-sidebar/85 backdrop-blur-2xl">
      {/* 顶部：留给原生红绿灯 + App 名（可拖拽移动窗口） */}
      <div className="app-drag flex h-[52px] items-center" />
      <div className="app-drag flex items-center gap-2 px-4 pb-2">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/agent-icon.png" alt="球房管家" className="h-7 w-7 rounded-lg object-cover" />
        <div className="text-[15px] font-semibold text-[#1d1d1f]">球房管家</div>
      </div>

      {/* 新对话 */}
      <div className="px-3">
        <button
          onClick={onNewChat}
          className="app-no-drag flex h-9 w-full items-center justify-center gap-1.5 rounded-lg bg-white/70 text-[13px] text-[#1d1d1f] shadow-sm transition hover:bg-white active:scale-[0.98]"
        >
          <Plus className="h-4 w-4 text-brand-600" /> 新对话
        </button>
      </div>

      {/* 会话列表 */}
      <div className="mt-3 flex-1 overflow-y-auto px-2">
        {groups.map((g) => (
          <div key={g.name} className="mb-2">
            <div className="mb-1 px-2 text-[11px] text-[#86868b]">{g.name}</div>
            {g.items.map((c) => (
              <button
                key={c.id}
                onClick={() => onSelect?.(c.id)}
                className={`mb-0.5 block w-full rounded-lg px-3 py-2 text-left transition ${
                  c.id === activeId ? "bg-black/[0.06]" : "hover:bg-black/[0.04]"
                }`}
              >
                <div className="truncate text-[13px] text-[#1d1d1f]">{c.title}</div>
                {c.subtitle && (
                  <div className="mt-0.5 truncate text-[11px] text-[#86868b]">{c.subtitle}</div>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>

      {/* 底部：门店 + 本月用量（不显示 BYOK 黑话）+ 设置 */}
      <div className="flex items-center gap-2 border-t border-black/[0.07] p-3">
        <div className="flex h-7 w-7 items-center justify-center rounded-full bg-brand-600/15 text-[12px] font-semibold text-brand-600">
          {storeName.slice(0, 1)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] text-[#1d1d1f]">{storeName}</div>
          {monthlySpend && (
            <div className="truncate text-[11px] text-[#86868b]">本月 AI 用量 ≈ {monthlySpend}</div>
          )}
        </div>
        <button
          onClick={onOpenSettings}
          className="app-no-drag flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] hover:bg-black/[0.06]"
          aria-label="设置"
        >
          <Settings className="h-4 w-4" />
        </button>
      </div>
    </aside>
  );
}

/** 整窗外壳：sidebar + main（+ 可选右侧预览）。填满 Electron 窗口。 */
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
    <div className="flex h-screen w-full overflow-hidden bg-white text-[#1d1d1f]">
      {sidebar}
      <main className="flex min-w-0 flex-1 flex-col border-r border-black/[0.07] bg-white">{children}</main>
      {preview}
    </div>
  );
}
