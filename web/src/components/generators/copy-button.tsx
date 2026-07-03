"use client";

import { useState } from "react";
import { Copy, Check, AlertCircle } from "lucide-react";
import { markdownToPlainText, copyPlainText } from "@/lib/utils";

type CopyState = "idle" | "copied" | "failed";

export function CopyButton({
  text,
  label = "一键复制",
  copiedLabel = "已复制",
  hint = "去微信粘贴吧",
  iconOnly = false,
}: {
  text: string;
  label?: string;
  copiedLabel?: string;
  hint?: string;
  /** C3：动作栏收敛成纯图标常驻位——只留图标，靠 title 做 hover 提示，文字不再上墙。 */
  iconOnly?: boolean;
}) {
  const [state, setState] = useState<CopyState>("idle");

  const handleCopy = async () => {
    // 复制纯文本：粘到微信不带 Markdown 记号
    const ok = await copyPlainText(markdownToPlainText(text));
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), ok ? 3000 : 4500);
  };

  const idleTitle = state === "copied" ? copiedLabel : state === "failed" ? "复制失败" : label;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleCopy}
        title={iconOnly ? idleTitle : undefined}
        className={
          iconOnly
            ? `flex h-7 w-7 items-center justify-center rounded-md transition active:scale-[0.97] ${
                state === "copied"
                  ? "text-emerald-600"
                  : state === "failed"
                    ? "text-red-600"
                    : "text-[#86868b] hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:text-[#8a8c93] dark:hover:bg-white/[0.06] dark:hover:text-[#e6e7e9]"
              }`
            : `inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                state === "copied"
                  ? "bg-emerald-50 text-emerald-600 border border-emerald-200"
                  : state === "failed"
                    ? "bg-red-50 text-red-600 border border-red-200"
                    : "bg-white text-slate-700 hover:bg-slate-50"
              }`
        }
      >
        {state === "copied" ? (
          <>
            <Check className="h-4 w-4" />
            {!iconOnly && copiedLabel}
          </>
        ) : state === "failed" ? (
          <>
            <AlertCircle className="h-4 w-4" />
            {!iconOnly && "复制失败"}
          </>
        ) : (
          <>
            <Copy className="h-4 w-4" />
            {!iconOnly && label}
          </>
        )}
      </button>
      {state === "copied" && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-3 py-1.5 bg-slate-900 text-white text-xs rounded-md whitespace-nowrap z-50" style={{animation: "fadeIn 0.2s ease-in"}}>
          {hint}
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-slate-900 rotate-45" />
        </div>
      )}
      {state === "failed" && (
        <div className="absolute top-full left-1/2 -translate-x-1/2 mt-2 px-3 py-1.5 bg-slate-900 text-white text-xs rounded-md whitespace-nowrap z-50" style={{animation: "fadeIn 0.2s ease-in"}}>
          请长按文字手动复制
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-slate-900 rotate-45" />
        </div>
      )}
    </div>
  );
}
