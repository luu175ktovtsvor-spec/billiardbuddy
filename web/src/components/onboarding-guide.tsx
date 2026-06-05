"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { X, ChevronRight, Building2, Sparkles, Copy } from "lucide-react";

const STORAGE_KEY = "onboarding_dismissed";

const STEPS = [
  {
    icon: Building2,
    title: "完善门店核心资料",
    desc: "填写门店名称、地址、球桌信息等基础数据，让 AI 了解你的球房。",
    action: "去完善",
    href: "/dashboard/store-settings",
  },
  {
    icon: Sparkles,
    title: "生成第一条朋友圈",
    desc: "用 AI 工作台一键生成朋友圈文案，体验 AI 如何帮球房做运营。",
    action: "去生成",
    href: "/dashboard/workbench",
  },
  {
    icon: Copy,
    title: "复制使用",
    desc: "生成结果可以一键复制，直接发到朋友圈、群聊，开始你的 AI 运营之旅！",
    action: null,
    href: null,
  },
];

export function OnboardingGuide() {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (!localStorage.getItem(STORAGE_KEY)) {
      setVisible(true);
    }
  }, []);

  const dismiss = () => {
    localStorage.setItem(STORAGE_KEY, "1");
    setVisible(false);
  };

  if (!visible) return null;

  const current = STEPS[step];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="relative w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <button
          type="button"
          onClick={dismiss}
          className="absolute top-3 right-3 rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Progress dots */}
        <div className="mb-5 flex items-center justify-center gap-2">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-2 rounded-full transition-all ${
                i === step ? "w-6 bg-indigo-600" : i < step ? "w-2 bg-indigo-300" : "w-2 bg-slate-200"
              }`}
            />
          ))}
        </div>

        {/* Step content */}
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-indigo-50">
            <current.icon className="h-7 w-7 text-indigo-600" />
          </div>
          <h3 className="mb-1 text-lg font-bold text-slate-900">{current.title}</h3>
          <p className="text-sm text-slate-500 leading-relaxed">{current.desc}</p>
        </div>

        {/* Step number */}
        <p className="mb-4 text-center text-xs text-slate-400">
          第 {step + 1} 步，共 {STEPS.length} 步
        </p>

        {/* Actions */}
        <div className="flex items-center justify-between">
          {step > 0 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="rounded-md px-4 py-2 text-sm text-slate-500 hover:text-slate-700"
            >
              上一步
            </button>
          ) : (
            <button
              type="button"
              onClick={dismiss}
              className="rounded-md px-4 py-2 text-sm text-slate-400 hover:text-slate-600"
            >
              跳过
            </button>
          )}

          {step < STEPS.length - 1 ? (
            current.href ? (
              <Link
                href={current.href}
                onClick={dismiss}
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
              >
                {current.action}
                <ChevronRight className="h-4 w-4" />
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => setStep((s) => s + 1)}
                className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
              >
                下一步
                <ChevronRight className="h-4 w-4" />
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={dismiss}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              开始使用
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
