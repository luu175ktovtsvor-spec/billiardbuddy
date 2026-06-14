"use client";

import { useState, useEffect } from "react";
import {
  X,
  ImageIcon,
  Sparkles,
  Upload,
  Layers,
  Type,
  Palette,
  RefreshCw,
} from "lucide-react";
import { api } from "@/lib/api";
import type { ShowcaseExample } from "@/types/poster";

interface PosterIntroProps {
  open: boolean;
  onClose: () => void;
  /** 点示例「参考这张思路」→ 把 idea 文本回填到主界面描述框 */
  onPickIdea: (ideaText: string) => void;
}

const STEPS = [
  {
    icon: Type,
    title: "用大白话说清楚",
    desc: "做什么 + 图上想写什么字 + 想要什么感觉，越具体越好。比如「周末双人台费 5 折活动，写上时间和电话，热血电竞风」。",
  },
  {
    icon: Upload,
    title: "想用自家店的照片？",
    desc: "可以上传门店实拍照，让 AI 在你的真实场景上加工出图，比纯生成更有「就是这家店」的感觉。",
  },
  {
    icon: Layers,
    title: "一次出多张",
    desc: "AI 一次能给你几张不同方案，挑一张你最满意的接着用，不用一遍遍重做。",
  },
];

const TIPS = [
  {
    icon: Sparkles,
    text: "把活动时间、价格、联系方式写清楚，AI 才会把这些字准确画进图里。",
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

export function PosterIntro({ open, onClose, onPickIdea }: PosterIntroProps) {
  const [examples, setExamples] = useState<ShowcaseExample[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    api
      .listPosterShowcase()
      .then((res) => {
        if (cancelled) return;
        setExamples(res.examples || []);
      })
      .catch(() => {
        if (cancelled) return;
        setExamples([]);
      })
      .finally(() => {
        if (cancelled) return;
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const handlePick = (ideaText: string) => {
    onPickIdea(ideaText);
    onClose();
  };

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
            描述你想要的，AI 帮你出图——活动海报、节日海报、招聘都行。
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
        {/* 看看能做成什么样 */}
        <section className="mt-2">
          <h2 className="mb-3 text-[17px] font-bold text-slate-900">看看能做成什么样</h2>

          {loading ? (
            <div className="grid grid-cols-2 gap-3">
              {[0, 1].map((i) => (
                <div
                  key={i}
                  className="aspect-[3/4] animate-pulse rounded-2xl bg-slate-200/70"
                />
              ))}
            </div>
          ) : examples.length === 0 ? (
            <div className="rounded-2xl bg-white p-6 text-center text-[15px] text-slate-400">
              示例图即将上线
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {examples.map((ex, i) => (
                <div
                  key={i}
                  className="flex flex-col overflow-hidden rounded-2xl bg-white shadow-sm"
                >
                  {ex.image_url ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={api.resolveUrl(ex.image_url)}
                      alt={ex.idea_text}
                      className="aspect-[3/4] w-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-2 bg-slate-100 px-3 text-center">
                      <ImageIcon className="h-7 w-7 text-slate-300" />
                      <span className="text-[13px] text-slate-400">示例图即将上线</span>
                    </div>
                  )}
                  <div className="flex flex-1 flex-col gap-2 p-3">
                    <p className="line-clamp-2 text-[13px] leading-relaxed text-slate-600">
                      {ex.idea_text}
                    </p>
                    <button
                      type="button"
                      onClick={() => handlePick(ex.idea_text)}
                      className="mt-auto h-9 rounded-xl bg-brand-50 text-[13px] font-medium text-brand-600 active:scale-[0.98] active:bg-brand-100"
                    >
                      参考这张思路
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* 三步就能出图 */}
        <section className="mt-7">
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
                    <span className="text-[13px] font-bold text-brand-600">
                      {i + 1}.
                    </span>
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
                <p className="text-[14px] leading-relaxed text-slate-600">
                  {tip.text}
                </p>
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
