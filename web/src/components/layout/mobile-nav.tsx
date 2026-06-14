"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  MessageCircle,
  Sparkles,
  ImageIcon,
  User,
  Plus,
  PenLine,
  LayoutGrid,
  Users,
  FileText,
  BookOpen,
} from "lucide-react";
import { Sheet } from "@/components/ui/sheet";

// 底部一级 tab:今日 / AI助手 / [+] / 工作台 / 我的(历史移入「我的」页)
const NAV_LEFT = [
  { href: "/dashboard", icon: LayoutDashboard, label: "今日" },
  { href: "/dashboard/chat", icon: MessageCircle, label: "AI助手" },
];
const NAV_RIGHT = [
  { href: "/dashboard/workbench", icon: Sparkles, label: "工作台" },
  { href: "/dashboard/store-settings", icon: User, label: "我的" },
];

/** 深层任务页(生成/详情/向导/对话)隐藏底部 Tab:
 * 进入任务即沉浸,顶部 PageHeader 的 ← 是唯一出路——手机 App 标准习语。
 * chat 也算深层:它要独占底部放输入框,和 tab 栏冲突,所以点 AI助手 tab
 * 进的是全屏对话(像微信点进聊天隐藏 tab 栏)。 */
const DEEP_PREFIXES = [
  "/dashboard/workbench/",
  "/dashboard/posters/",
  "/dashboard/history/",
  "/dashboard/store-settings/",
  "/dashboard/report/",
  "/dashboard/chat",
];

export function MobileNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [createOpen, setCreateOpen] = useState(false);

  const isDeep = DEEP_PREFIXES.some((p) => pathname.startsWith(p));
  if (isDeep) return null;

  const renderItem = (item: { href: string; icon: typeof User; label: string }) => {
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

          {/* 中央生成总闸:最高频动作放拇指热区 */}
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

      {/* 生成总闸抽屉:四种生成方式平铺,从轻到重 */}
      <Sheet open={createOpen} onClose={() => setCreateOpen(false)} title="想做点什么？">
        <div className="grid grid-cols-2 gap-3 pb-3">
          <button
            type="button"
            onClick={() => { setCreateOpen(false); router.push("/dashboard/report"); }}
            className="col-span-2 flex items-center gap-3 rounded-2xl bg-brand-50 px-4 py-4 active:scale-[0.98] transition-transform"
          >
            <FileText className="h-7 w-7 shrink-0 text-brand-600" />
            <span className="flex flex-col text-left">
              <span className="text-[15px] font-medium text-slate-900">写今天的日报</span>
              <span className="text-xs text-slate-500">填几个数，AI 帮你写好导 Excel</span>
            </span>
          </button>
          <button
            type="button"
            onClick={() => { setCreateOpen(false); router.push("/dashboard/chat"); }}
            className="flex flex-col items-center gap-2 rounded-2xl bg-brand-50 px-4 py-5 active:scale-[0.97] transition-transform"
          >
            <PenLine className="h-7 w-7 text-brand-600" />
            <span className="text-[15px] font-medium text-slate-900">问 AI 帮我写</span>
            <span className="text-center text-xs text-slate-500">直接说需求，对话式</span>
          </button>
          <button
            type="button"
            onClick={() => { setCreateOpen(false); router.push("/dashboard/workbench"); }}
            className="flex flex-col items-center gap-2 rounded-2xl bg-slate-100 px-4 py-5 active:scale-[0.97] transition-transform"
          >
            <LayoutGrid className="h-7 w-7 text-slate-700" />
            <span className="text-[15px] font-medium text-slate-900">按场景选卡片</span>
            <span className="text-center text-xs text-slate-500">朋友圈/日报/赛事…</span>
          </button>
          <button
            type="button"
            onClick={() => { setCreateOpen(false); router.push("/dashboard/workbench/collaborate"); }}
            className="flex flex-col items-center gap-2 rounded-2xl bg-slate-100 px-4 py-5 active:scale-[0.97] transition-transform"
          >
            <Users className="h-7 w-7 text-slate-700" />
            <span className="text-[15px] font-medium text-slate-900">出一套完整方案</span>
            <span className="text-center text-xs text-slate-500">开业/大活动/复盘</span>
          </button>
          <button
            type="button"
            onClick={() => { setCreateOpen(false); router.push("/dashboard/posters/new"); }}
            className="flex flex-col items-center gap-2 rounded-2xl bg-amber-50 px-4 py-5 active:scale-[0.97] transition-transform"
          >
            <ImageIcon className="h-7 w-7 text-amber-600" />
            <span className="text-[15px] font-medium text-slate-900">做张海报</span>
            <span className="text-center text-xs text-slate-500">AI 生图 / 活动海报</span>
          </button>
        </div>
        <button
          type="button"
          onClick={() => { setCreateOpen(false); router.push("/dashboard/guide"); }}
          className="flex w-full items-center justify-center gap-1.5 pb-2 text-sm text-slate-400 active:text-slate-600"
        >
          <BookOpen className="h-4 w-4" />使用指南
        </button>
      </Sheet>
    </>
  );
}
