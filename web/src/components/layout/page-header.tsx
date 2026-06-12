"use client";

import { useRouter } from "next/navigation";
import { ChevronLeft } from "lucide-react";

/** 移动端页面顶栏(微信式):← 返回 + 居中标题 + 右侧动作位。
 * 仅手机显示(lg:hidden);桌面端继续用 Breadcrumb。
 * 深层页(生成页/详情页)配合 MobileNav 自动隐藏底部 Tab,形成"进入任务"的沉浸感。 */
export function PageHeader({
  title,
  backHref,
  right,
}: {
  title: string;
  /** 指定返回目标;不传则 router.back() */
  backHref?: string;
  right?: React.ReactNode;
}) {
  const router = useRouter();

  return (
    <div className="sticky top-0 z-30 -mx-4 mb-4 flex h-12 items-center border-b border-slate-100 bg-white/95 px-1 backdrop-blur-sm sm:-mx-6 lg:hidden">
      <button
        type="button"
        onClick={() => (backHref ? router.push(backHref) : router.back())}
        aria-label="返回"
        className="flex h-11 w-11 shrink-0 items-center justify-center text-slate-600 active:bg-slate-100 rounded-full"
      >
        <ChevronLeft className="h-6 w-6" />
      </button>
      <p className="absolute left-1/2 max-w-[60%] -translate-x-1/2 truncate text-center text-base font-semibold text-slate-900">
        {title}
      </p>
      <div className="ml-auto flex items-center pr-2">{right}</div>
    </div>
  );
}
