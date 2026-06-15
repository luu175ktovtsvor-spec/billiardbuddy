"use client";

import Link from "next/link";
import { Store } from "lucide-react";

interface EmptyStoreGuideProps {
  /** Custom description text. Defaults to a generic message. */
  description?: string;
}

export function EmptyStoreGuide({
  description = "请先完善门店资料，AI 才能根据你的门店生成内容。",
}: EmptyStoreGuideProps) {
  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <Store className="mx-auto mb-4 h-12 w-12 text-slate-400" />
      <h2 className="mb-2 text-lg font-semibold text-slate-900">
        还没有门店资料
      </h2>
      <p className="mb-6 text-sm text-slate-500">{description}</p>
      <Link
        href="/dashboard/store-settings"
        className="inline-flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-3 text-sm font-medium text-white transition-transform hover:bg-brand-500 active:scale-[0.98]"
      >
        去完善门店资料
      </Link>
    </div>
  );
}
