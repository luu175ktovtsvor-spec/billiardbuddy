"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Sparkles,
  ImageIcon,
  Clock,
  Settings,
} from "lucide-react";

const NAV = [
  { href: "/dashboard", icon: LayoutDashboard, label: "首页" },
  { href: "/dashboard/workbench", icon: Sparkles, label: "AI 工作台" },
  { href: "/dashboard/posters", icon: ImageIcon, label: "AI 生图" },
  { href: "/dashboard/history", icon: Clock, label: "生成历史" },
  { href: "/dashboard/store-settings", icon: Settings, label: "门店设置" },
];

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex lg:w-60 lg:flex-col lg:fixed lg:inset-y-0 bg-sidebar text-white">
      {/* Logo */}
      <div className="flex h-16 items-center gap-3 px-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500">
          <span className="text-sm font-bold text-white">AI</span>
        </div>
        <span className="text-sm font-semibold text-white">球房运营助手</span>
      </div>

      <div className="h-px bg-white/10" />

      {/* Navigation */}
      <nav className="flex-1 space-y-1 px-3 py-4">
        {NAV.map((item) => {
          const isActive =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors ${
                isActive
                  ? "bg-white/10 text-white"
                  : "text-slate-400 hover:bg-white/5 hover:text-slate-200"
              }`}
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="border-t border-white/10 p-4">
        <p className="text-xs text-slate-500">球房 AI 运营助手 v1.0</p>
      </div>
    </aside>
  );
}
