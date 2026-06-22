"use client";

/** 版本条：◀ 上一版 · 「第 N/共 M 版」点开时间线跳任意一版 · ▶ 下一版。 */
import { useState } from "react";
import { ChevronLeft, ChevronRight, History, Check } from "lucide-react";

import type { Version } from "./use-version-history";

export function VersionBar<T>({
  versions,
  index,
  onGoto,
}: {
  versions: Version<T>[];
  index: number;
  onGoto: (i: number) => void;
}) {
  const [open, setOpen] = useState(false);
  if (versions.length <= 1) return null; // 只有"最初"一版时不显示
  return (
    <div className="relative inline-flex items-center gap-0.5">
      <button
        type="button"
        onClick={() => onGoto(index - 1)}
        disabled={index <= 0}
        title="上一版"
        className="flex h-6 w-6 items-center justify-center rounded text-[#86868b] transition hover:bg-black/[0.05] hover:text-[#1d1d1f] disabled:opacity-30 dark:text-[#9a9ca3] dark:hover:bg-white/[0.06]"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="版本历史"
        className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11.5px] text-[#6e6e73] transition hover:bg-black/[0.05] hover:text-[#1d1d1f] dark:text-[#9a9ca3] dark:hover:bg-white/[0.06]"
      >
        <History className="h-3 w-3" /> 第 {index} / 共 {versions.length - 1} 版
      </button>
      <button
        type="button"
        onClick={() => onGoto(index + 1)}
        disabled={index >= versions.length - 1}
        title="下一版"
        className="flex h-6 w-6 items-center justify-center rounded text-[#86868b] transition hover:bg-black/[0.05] hover:text-[#1d1d1f] disabled:opacity-30 dark:text-[#9a9ca3] dark:hover:bg-white/[0.06]"
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>

      {open && (
        <>
          <button type="button" aria-hidden tabIndex={-1} onClick={() => setOpen(false)} className="fixed inset-0 z-40 cursor-default" />
          <div className="absolute bottom-[calc(100%+6px)] left-0 z-50 max-h-[260px] w-[240px] overflow-auto rounded-xl border border-black/[0.1] bg-white p-1.5 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.25)] dark:border-white/[0.1] dark:bg-[#1c1e24]">
            <div className="px-2 pb-1 pt-0.5 font-mono text-[10px] uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">版本历史</div>
            {versions.map((v, i) => (
              <button
                key={i}
                type="button"
                onClick={() => { onGoto(i); setOpen(false); }}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05] ${
                  i === index ? "text-[#10a37f]" : "text-[#1d1d1f] dark:text-[#c8cace]"
                }`}
              >
                <Check className={`h-3.5 w-3.5 shrink-0 ${i === index ? "text-[#10a37f]" : "text-transparent"}`} />
                <span className="shrink-0 font-mono text-[11px] text-[#b0b0b5] dark:text-[#56585f]">{i === 0 ? "原" : `v${i}`}</span>
                <span className="min-w-0 flex-1 truncate">{v.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
