"use client";

/**
 * G-b 首次开箱引导：真·首次启动才出现一次的两步轻量提示条——欢迎 → 给一个低噪任务示例。
 * 不是弹窗、不挡任何操作，就是欢迎屏顶部一条可随时跳过的横条。触发/收起的状态和 localStorage
 * （agent_onboarding_seen）都归 chat-shell.tsx 统一管，这里只管画两种文案 + 两个按钮。
 * ⚠️ 按 A4 拍板，不再加"选工作文件夹"这类开场仪式——两步就是欢迎语 + 一个可跳过示例，别加第三步。
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
    <div className="mx-auto mb-2 flex w-full max-w-[640px] items-center justify-center gap-2 px-3 py-1.5 text-[12px] text-[#6e6e73] dark:text-[#8e9198]">
      <Sparkles className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
      <span className="flex-1 leading-snug">
        {step === "welcome"
          ? "可以先从一个小任务开始：改代码、跑测试、整理文件或查资料。想先看一次示例？"
          : "在输入框里描述任务就能开始；需要动文件或跑命令时，我会按当前权限处理。"}
      </span>
      {step === "welcome" && (
        <button
          type="button"
          onClick={onAdvance}
          className="app-primary-action shrink-0 rounded-md px-2.5 py-1 text-[12px] font-medium transition active:scale-[0.97]"
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
