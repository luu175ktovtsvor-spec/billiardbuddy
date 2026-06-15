"use client";

import { X, ImageIcon, Sparkles, Upload, Type, Palette, RefreshCw } from "lucide-react";

interface PosterIntroProps {
  open: boolean;
  onClose: () => void;
}

// 不给"套模板"，只告诉用户具体怎么填、能做什么。
const STEPS = [
  {
    icon: Type,
    title: "用大白话说清楚",
    desc: "做什么海报 + 图上要写哪些字 + 想要什么感觉。比如「招助教，写上待遇和电话，温馨有活力」——说得越具体，出得越准。",
  },
  {
    icon: Upload,
    title: "想用自家店照片、放 Logo / 二维码？",
    desc: "可以上传门店实拍照，让 AI 在你的真实场景上加工；也能传 Logo、二维码，AI 会清晰地画进图里。",
  },
  {
    icon: Sparkles,
    title: "系统帮你优化，选清晰度出图",
    desc: "开着「AI 帮我优化描述」，系统会把你的大白话变成更专业的绘图描述（可改）；再选草稿 / 标准 / 高清，点出图就行。",
  },
];

const TIPS = [
  {
    icon: Sparkles,
    text: "活动时间、价格、联系方式写清楚，AI 才能把这些字准确画进图里。",
  },
  {
    icon: Palette,
    text: "说清你要的风格——热血电竞风、高端金色、喜庆红金……风格定了出图才稳。",
  },
  {
    icon: RefreshCw,
    text: "不满意别重头来，点「基于此调整」接着改，AI 会在上一张基础上继续优化。",
  },
];

export function PosterIntro({ open, onClose }: PosterIntroProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-[#F2F2F7] pb-28 lg:pb-32">
      {/* 顶部 */}
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 bg-[#F2F2F7]/95 px-4 pt-[calc(1rem+env(safe-area-inset-top))] pb-3 backdrop-blur">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-[22px] font-bold leading-tight text-slate-900">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-50">
              <ImageIcon className="h-5 w-5 text-brand-600" />
            </span>
            用一句话，做出台球房海报
          </h1>
          <p className="mt-1.5 text-[15px] leading-relaxed text-slate-500">
            活动海报、节日海报、招聘海报，或用你的门店照做图——把要的说清楚，AI 帮你出。
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-400 active:scale-[0.98] active:bg-slate-200/60"
        >
          <X className="h-6 w-6" />
        </button>
      </div>

      <div className="mx-auto max-w-2xl px-4">
        {/* 三步就能出图 */}
        <section className="mt-2">
          <h2 className="mb-3 text-[17px] font-bold text-slate-900">三步就能出图</h2>
          <div className="space-y-3">
            {STEPS.map((step, i) => (
              <div
                key={i}
                className="flex items-start gap-3 rounded-2xl bg-white p-4 shadow-sm"
              >
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-brand-50">
                  <step.icon className="h-5 w-5 text-brand-600" />
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="flex items-center gap-1.5 text-[15px] font-semibold text-slate-900">
                    <span className="text-[13px] font-bold text-brand-600">{i + 1}.</span>
                    {step.title}
                  </h3>
                  <p className="mt-1 text-[14px] leading-relaxed text-slate-500">
                    {step.desc}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* 怎么写效果好 */}
        <section className="mt-7">
          <h2 className="mb-3 text-[17px] font-bold text-slate-900">怎么写效果好</h2>
          <div className="space-y-2.5">
            {TIPS.map((tip, i) => (
              <div
                key={i}
                className="flex items-start gap-3 rounded-2xl bg-white p-4 shadow-sm"
              >
                <tip.icon className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
                <p className="text-[14px] leading-relaxed text-slate-600">{tip.text}</p>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* 底部吸底 */}
      <div className="fixed inset-x-0 bottom-0 z-10 border-t border-slate-200/70 bg-white/95 px-4 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur">
        <div className="mx-auto max-w-2xl">
          <button
            type="button"
            onClick={onClose}
            className="h-12 w-full rounded-xl bg-brand-600 text-[16px] font-semibold text-white active:scale-[0.98] active:bg-brand-700"
          >
            开始使用
          </button>
        </div>
      </div>
    </div>
  );
}
