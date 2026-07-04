"use client";

/**
 * G-b 首次开箱引导：真·首次启动才出现一次的两步轻量提示条——欢迎 → 引导点一张场景卡看它现场干活。
 * 不是弹窗、不挡任何操作，就是欢迎屏顶部一条可随时跳过的横条。触发/收起的状态和 localStorage
 * （agent_onboarding_seen）都归 chat-shell.tsx 统一管，这里只管画两种文案 + 两个按钮。
 * ⚠️ 按 A4 拍板，不再加"选工作文件夹"这类开场仪式——两步就是欢迎语 + 指一下卡片，别加第三步。
 */
import { Sparkles, X } from "lucide-react";

export type OnboardingStep = "welcome" | "point-card";

export function OnboardingBanner({
  step,
  onAdvance,
  onDismiss,
}: {
  step: OnboardingStep;
  onAdvance: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className="mx-auto mb-3 flex w-full max-w-[640px] items-center gap-3 rounded-lg border border-[#10a37f]/20 bg-[#10a37f]/[0.05] px-3.5 py-2.5 text-[12.5px] text-[#1d1d1f] shadow-sm dark:border-[#10a37f]/25 dark:bg-[#10a37f]/[0.08] dark:text-[#e6e7e9]">
      <Sparkles className="h-4 w-4 shrink-0 text-[#10a37f]" />
      <span className="flex-1 leading-snug">
        {step === "welcome"
          ? "我能帮你把电脑上的事办完——写文案、做图、剪视频、整理文件都行，想先看我现场做一次？"
          : "挑一张下面的卡片点一下，我现场做给你看。"}
      </span>
      {step === "welcome" && (
        <button
          type="button"
          onClick={onAdvance}
          className="shrink-0 rounded-md bg-[#10a37f] px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-[#0d8a6b] active:scale-[0.97]"
        >
          看看
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={step === "welcome" ? "跳过引导" : "知道了"}
        title={step === "welcome" ? "跳过" : "知道了"}
        className="shrink-0 rounded-md px-1.5 py-1 text-[#86868b] transition hover:bg-black/[0.04] hover:text-[#1d1d1f] dark:hover:bg-white/[0.06] dark:hover:text-[#e6e7e9]"
      >
        {step === "welcome" ? <span className="text-[12px]">跳过</span> : <X className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}
