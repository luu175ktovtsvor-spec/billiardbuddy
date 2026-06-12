"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Sparkles,
  ImageIcon,
  Clock,
  User,
  Plus,
  PenLine,
} from "lucide-react";
import { Sheet } from "@/components/ui/sheet";

const NAV_LEFT = [
  { href: "/dashboard", icon: LayoutDashboard, label: "今日" },
  { href: "/dashboard/workbench", icon: Sparkles, label: "工作台" },
];
const NAV_RIGHT = [
  { href: "/dashboard/history", icon: Clock, label: "历史" },
  { href: "/dashboard/store-settings", icon: User, label: "我的" },
];

/** 深层任务页(生成/详情/向导)隐藏底部 Tab:
 * 进入任务即沉浸,顶部 PageHeader 的 ← 是唯一出路——这是手机 App 的标准习语。
 * 列表页(workbench/posters/history/store-settings 本身)保留 Tab。 */
const DEEP_PREFIXES = [
  "/dashboard/workbench/",
  "/dashboard/posters/",
  "/dashboard/history/",
  "/dashboard/store-settings/",
  "/dashboard/chat",
];

export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);

  const isDeep = DEEP_PREFIXES.some((p) => pathname.startsWith(p));
  if (isDeep) return null;

  const renderItem = (item: { href: string; icon: typeof Clock; label: string }) => {
    const isActive =
      item.href === "/dashboard"
        ? pathname === "/dashboard"
        : pathname.startsWith(item.href);
    return (
      <Link
        key={item.href}
        href={item.href}
        className={`flex min-w-[56px] flex-col items-center gap-0.5 px-2 pt-1.5 pb-1 text-[11px] transition-colors ${
          isActive ? "text-brand-600 font-medium" : "text-slate-400 active:text-slate-600"
        }`}
      >
        <item.icon className="h-[22px] w-[22px]" />
        <span>{item.label}</span>
      </Link>
    );
  };

  return (
    <>
      <nav className="fixed bottom-0 left-0 right-0 z-30 border-t border-black/10 bg-white/85 backdrop-blur-xl pb-[env(safe-area-inset-bottom)] lg:hidden">
        <div className="flex items-center justify-around px-1">
          {NAV_LEFT.map(renderItem)}

          {/* 中央生成按钮:最高频动作放拇指热区 */}
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            aria-label="生成"
            className="relative -mt-5 flex h-[52px] w-[52px] items-center justify-center rounded-full bg-brand-600 text-white shadow-lg shadow-brand-600/30 active:scale-95 transition-transform"
          >
            <Plus className="h-7 w-7" />
          </button>

          {NAV_RIGHT.map(renderItem)}
        </div>
      </nav>

      {/* 生成入口抽屉 */}
      <Sheet open={createOpen} onClose={() => setCreateOpen(false)} title="想做点什么？">
        <div className="grid grid-cols-2 gap-3 pb-3">
          <button
            type="button"
            onClick={() => {
              setCreateOpen(false);
              router.push("/dashboard/chat");
            }}
            className="flex flex-col items-center gap-2 rounded-2xl bg-brand-50 px-4 py-5 active:scale-[0.97] transition-transform"
          >
            <PenLine className="h-7 w-7 text-brand-600" />
            <span className="text-[15px] font-medium text-slate-900">问 AI · 写文案</span>
            <span className="text-xs text-slate-500">直接说需求,对话式出成品</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setCreateOpen(false);
              router.push("/dashboard/posters/new");
            }}
            className="flex flex-col items-center gap-2 rounded-2xl bg-amber-50 px-4 py-5 active:scale-[0.97] transition-transform"
          >
            <ImageIcon className="h-7 w-7 text-amber-600" />
            <span className="text-[15px] font-medium text-slate-900">做海报</span>
            <span className="text-xs text-slate-500">AI 生图 / 活动海报…</span>
          </button>
        </div>
      </Sheet>
    </>
  );
}
