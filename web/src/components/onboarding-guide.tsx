"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { X, ChevronRight, Building2, Sparkles, Copy, Calendar, MessageSquare, BookOpen } from "lucide-react";

const STORAGE_KEY = "onboarding_dismissed";

const STEPS = [
  {
    icon: Building2,
    title: "完善门店核心资料",
    desc: "填写门店名称、地址、球桌信息等基础数据，让 AI 了解你的球房。资料越完整，AI 生成的内容越精准。",
    action: "去完善",
    href: "/dashboard/store-settings",
  },
  {
    icon: Sparkles,
    title: "生成第一条朋友圈",
    desc: "点击直达「今日朋友圈」任务卡，需求已替你填好，点生成就能看到 AI 为你的球房逐字写出文案。",
    action: "去生成",
    href: "/dashboard/workbench/mgr-daily-moments",
  },
  {
    icon: MessageSquare,
    title: "试试多轮优化",
    desc: "生成后如果不满意，可以直接在结果下方输入修改意见，AI 会基于上一条继续优化，直到你满意为止。",
    action: null,
    href: null,
  },
  {
    icon: Copy,
    title: "一键复制使用",
    desc: "生成结果可以一键复制，直接发到朋友圈、群聊。系统会提示\"去微信粘贴吧\"，方便你快速使用。",
    action: null,
    href: null,
  },
  {
    icon: Calendar,
    title: "查看今日推荐",
    desc: "每天打开 Dashboard，系统会根据星期和你的使用习惯推荐今天的运营动作，不用自己想该发什么。",
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="relative w-full max-w-md rounded-2xl bg-white p-6 shadow-xl">
        <button
          type="button"
          onClick={dismiss}
          className="absolute top-2 right-2 flex h-10 w-10 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 active:bg-slate-100"
        >
          <X className="h-5 w-5" />
        </button>

        {/* Progress dots */}
        <div className="mb-5 flex items-center justify-center gap-2">
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={`h-2 rounded-full transition-all ${
                i === step ? "w-6 bg-brand-600" : i < step ? "w-2 bg-brand-300" : "w-2 bg-slate-200"
              }`}
            />
          ))}
        </div>

        {/* Step content */}
        <div className="mb-5 flex flex-col items-center text-center">
          <div className="mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-brand-50">
            <current.icon className="h-7 w-7 text-brand-600" />
          </div>
          <h3 className="mb-1 text-lg font-bold text-slate-900">{current.title}</h3>
          <p className="text-[15px] text-slate-500 leading-relaxed lg:text-sm">{current.desc}</p>
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
              className="h-11 rounded-xl px-4 text-[15px] text-slate-500 hover:text-slate-700 active:bg-slate-100 lg:text-sm"
            >
              上一步
            </button>
          ) : (
            <button
              type="button"
              onClick={dismiss}
              className="h-11 rounded-xl px-4 text-[15px] text-slate-400 hover:text-slate-600 active:bg-slate-100 lg:text-sm"
            >
              跳过
            </button>
          )}

          {step < STEPS.length - 1 ? (
            current.href ? (
              <Link
                href={current.href}
                onClick={dismiss}
                className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-brand-600 px-5 text-[15px] font-medium text-white hover:bg-brand-500 active:scale-[0.98] transition-transform lg:text-sm"
              >
                {current.action}
                <ChevronRight className="h-4 w-4" />
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => setStep((s) => s + 1)}
                className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-brand-600 px-5 text-[15px] font-medium text-white hover:bg-brand-500 active:scale-[0.98] transition-transform lg:text-sm"
              >
                下一步
                <ChevronRight className="h-4 w-4" />
              </button>
            )
          ) : (
            <button
              type="button"
              onClick={dismiss}
              className="inline-flex h-11 items-center gap-1.5 rounded-xl bg-brand-600 px-5 text-[15px] font-medium text-white hover:bg-brand-500 active:scale-[0.98] transition-transform lg:text-sm"
            >
              开始使用
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
