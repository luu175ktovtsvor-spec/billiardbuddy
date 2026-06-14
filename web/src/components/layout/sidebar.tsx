"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  Sparkles,
  ImageIcon,
  Clock,
  Settings,
  Users,
  MessageCircle,
  Workflow,
  FileText,
} from "lucide-react";

const NAV = [
  { href: "/dashboard", icon: LayoutDashboard, label: "首页" },
  { href: "/dashboard/chat", icon: MessageCircle, label: "AI 助手" },
  { href: "/dashboard/workbench", icon: Sparkles, label: "AI 工作台" },
  { href: "/dashboard/report", icon: FileText, label: "日报" },
  { href: "/dashboard/workbench/collaborate", icon: Workflow, label: "多人协作" },
  { href: "/dashboard/posters", icon: ImageIcon, label: "AI 生图" },
  { href: "/dashboard/history", icon: Clock, label: "生成历史" },
  { href: "/dashboard/store-settings", icon: Settings, label: "门店设置" },
  { href: "/dashboard/store-settings/members", icon: Users, label: "团队成员" },
];

/* 桌面侧边栏:iOS/macOS 系统设置式浅灰侧栏——
 * 选中项=白色圆角块+tint 蓝图标,未选中=灰字,无边框无深色块。 */
export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="hidden lg:flex lg:w-60 lg:flex-col lg:fixed lg:inset-y-0 border-r border-black/5 bg-sidebar">
      {/* Logo */}
      <div className="flex h-16 items-center gap-3 px-6">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600">
          <span className="text-sm">🎱</span>
        </div>
        <span className="text-sm font-semibold text-slate-900">球房运营助手</span>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {NAV.map((item) => {
          const isActive =
            item.href === "/dashboard"
              ? pathname === "/dashboard"
              : pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                isActive
                  ? "bg-white font-medium text-slate-900 shadow-sm"
                  : "text-slate-600 hover:bg-sidebar-hover"
              }`}
            >
              <item.icon className={`h-4 w-4 ${isActive ? "text-brand-600" : "text-slate-400"}`} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Bottom */}
      <div className="p-4">
        <p className="text-xs text-slate-400">球房 AI 运营助手 v1.0</p>
      </div>
    </aside>
  );
}
