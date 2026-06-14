"use client";

import Link from "next/link";
import { FileText, Sparkles, ImageIcon, Brain, Store, ChevronRight } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";

const FEATURES = [
  { icon: Sparkles, color: "text-brand-600 bg-brand-50", title: "岗位工作台", desc: "按你的岗位选场景卡片，朋友圈/群公告/活动/话术一点就出。" },
  { icon: FileText, color: "text-violet-600 bg-violet-50", title: "日报（新）", desc: "填几个数（或说一句话），AI 帮你写好总结/问题/计划，一键导出 Excel 发老板群。" },
  { icon: ImageIcon, color: "text-amber-600 bg-amber-50", title: "AI 海报", desc: "AI 生图 + 自动叠门店 Logo/二维码，活动海报几秒钟出。" },
  { icon: Brain, color: "text-emerald-600 bg-emerald-50", title: "店脑", desc: "越用越懂你的店——它会记住你的门店情况，下次生成更贴合。" },
];

const STEPS = [
  { n: 1, title: "先填门店资料", desc: "资料越全，AI 生成越准。门店设置里花几分钟填一遍。", href: "/dashboard/store-settings", cta: "去填资料" },
  { n: 2, title: "写日报 / 发内容", desc: "下班填一份日报，或在工作台选个场景出文案。填几个数 AI 替你写。", href: "/dashboard/report", cta: "写今天的日报" },
  { n: 3, title: "导出 / 复制发出去", desc: "日报导 Excel 发老板群，文案一键复制发朋友圈/客户群。", href: null, cta: null },
];

const TIPS = [
  "懒得填表？日报页有「说一句话」——把今天的数随口一报，AI 自动填好。",
  "生成的内容觉得好，点个「效果好」，它会越来越懂你的偏好。",
  "微信里下载 Excel 没反应，点右上角「···」用浏览器打开即可。",
];

export default function GuidePage() {
  return (
    <div className="mx-auto max-w-2xl pb-10">
      <PageHeader title="使用指南" backHref="/dashboard" />

      {/* Hero */}
      <section className="mb-6 rounded-2xl bg-gradient-to-br from-brand-500 to-brand-600 p-6 text-white">
        <h1 className="text-[22px] font-semibold">欢迎用球房 AI 运营助手 🎱</h1>
        <p className="mt-1.5 text-[15px] text-white/90">
          帮你把每天重复的运营活儿——写文案、出海报、写日报——交给 AI，你只管把生意做大。
        </p>
      </section>

      {/* 三步上手 */}
      <section className="mb-6">
        <h2 className="mb-2.5 text-[15px] font-semibold text-slate-900">三步上手</h2>
        <div className="space-y-2.5">
          {STEPS.map((s) => (
            <div key={s.n} className="flex items-start gap-3 rounded-2xl bg-white p-4">
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-50 text-sm font-semibold text-brand-600">
                {s.n}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[15px] font-medium text-slate-900">{s.title}</p>
                <p className="mt-0.5 text-sm text-slate-500">{s.desc}</p>
                {s.href && s.cta && (
                  <Link
                    href={s.href}
                    className="mt-2 inline-flex items-center gap-0.5 text-sm font-medium text-brand-600 active:opacity-70"
                  >
                    {s.cta}
                    <ChevronRight className="h-4 w-4" />
                  </Link>
                )}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 核心功能 */}
      <section className="mb-6">
        <h2 className="mb-2.5 text-[15px] font-semibold text-slate-900">能帮你做什么</h2>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="flex items-start gap-3 rounded-2xl bg-white p-4">
              <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${f.color}`}>
                <f.icon className="h-5 w-5" />
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-medium text-slate-900">{f.title}</p>
                <p className="mt-0.5 text-sm text-slate-500">{f.desc}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 小贴士 */}
      <section className="mb-6">
        <h2 className="mb-2.5 text-[15px] font-semibold text-slate-900">小贴士</h2>
        <div className="space-y-2 rounded-2xl bg-white p-4">
          {TIPS.map((t, i) => (
            <p key={i} className="flex gap-2 text-sm text-slate-600">
              <span className="text-brand-500">·</span>
              {t}
            </p>
          ))}
        </div>
      </section>

      {/* 门店资料入口 */}
      <Link
        href="/dashboard/store-settings"
        className="flex items-center gap-3 rounded-2xl bg-white p-4 active:scale-[0.99] transition-transform"
      >
        <Store className="h-5 w-5 text-slate-400" />
        <span className="flex-1 text-[15px] font-medium text-slate-900">完善门店资料</span>
        <ChevronRight className="h-5 w-5 text-slate-300" />
      </Link>
    </div>
  );
}
