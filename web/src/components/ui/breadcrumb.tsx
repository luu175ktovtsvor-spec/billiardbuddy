"use client";

import Link from "next/link";
import { ChevronLeft } from "lucide-react";

export interface BreadcrumbItem {
  label: string;
  href?: string; // 无 href 则为当前页（不可点击）
}

export function Breadcrumb({ items }: { items: BreadcrumbItem[] }) {
  return (
    <nav className="flex items-center gap-1.5 text-sm text-slate-500 mb-4">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-slate-300">/</span>}
          {item.href ? (
            <Link
              href={item.href}
              className="flex items-center gap-1 hover:text-indigo-600 transition-colors"
            >
              {i === 0 && <ChevronLeft className="h-3.5 w-3.5" />}
              {item.label}
            </Link>
          ) : (
            <span className="text-slate-900 font-medium">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}
