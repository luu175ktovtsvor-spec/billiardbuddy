import Link from "next/link";
import {
  Sparkles,
  ImageIcon,
  CalendarCheck,
  Heart,
  MessageCircle,
  MousePointerClick,
  MessageSquareText,
  Copy,
} from "lucide-react";

/* 球房夜场感落地页:
 * 首屏墨绿台呢底 + 痛点大字 + 暖金 CTA → 浅色区真实产出示例(朋友圈/群公告样式)
 * → 3 步流程 → 六岗位 → FAQ → 吸底 CTA(手机)。
 * 原则:不编造数据(无虚构门店数/好评数),示例内容遵守内容合规(不含编造优惠)。 */

const ROLES = [
  { role: "老板", tasks: "经营简报 · 月度汇报 · 投资回报分析" },
  { role: "店长", tasks: "日报周报 · 活动策划 · 老客维护" },
  { role: "助教管理", tasks: "助教推广 · 招聘文案 · PK 方案" },
  { role: "教练", tasks: "赛事通知 · 赛后战报 · 好评引导" },
  { role: "前厅", tasks: "团购核销话术 · 投诉安抚 · 开闭店 SOP" },
  { role: "运营", tasks: "朋友圈计划 · 短视频文案 · 平台运营" },
];

const FAQS = [
  {
    q: "要下载 App 吗？",
    a: "不用。微信里直接打开这个网址就能用，手机电脑都行。可以把链接发给自己的「文件传输助手」，随用随点。",
  },
  {
    q: "收费吗？",
    a: "注册就送 30 次免费生成，不绑卡。够你把朋友圈、群公告、海报都试一遍，觉得好用再联系我们开通。",
  },
  {
    q: "生成的内容会不会千篇一律？",
    a: "不会。AI 会先读你的门店资料（位置、桌型、客群、价格、风格），写出来的就是你店里的事，不是模板套话。",
  },
  {
    q: "我的门店数据安全吗？",
    a: "每家门店数据完全隔离，只有你和你授权的员工能看到。我们不做自动群发，所有内容由你确认后自己发出。",
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white pb-20 lg:pb-0">
      {/* ───── 首屏:墨绿台呢 ───── */}
      <div className="relative overflow-hidden bg-gradient-to-b from-brand-950 via-brand-900 to-brand-950">
        {/* 台球点缀:彩球微光 */}
        <div className="pointer-events-none absolute inset-0" aria-hidden>
          <div className="absolute -left-16 top-24 h-48 w-48 rounded-full bg-brand-600/30 blur-3xl" />
          <div className="absolute right-0 top-64 h-56 w-56 rounded-full bg-amber-500/10 blur-3xl" />
          <div className="absolute left-[12%] top-[18%] h-3 w-3 rounded-full bg-red-500/70" />
          <div className="absolute right-[18%] top-[12%] h-2.5 w-2.5 rounded-full bg-amber-400/80" />
          <div className="absolute right-[10%] top-[42%] h-2 w-2 rounded-full bg-sky-400/60" />
          <div className="absolute left-[20%] top-[55%] h-2 w-2 rounded-full bg-white/40" />
        </div>

        {/* Header */}
        <header className="relative mx-auto flex max-w-6xl items-center justify-between px-5 py-4 sm:px-6">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-white/10 text-base">
              🎱
            </span>
            <span className="text-base font-bold text-white">球房 AI 运营助手</span>
          </div>
          <Link
            href="/login"
            className="rounded-full border border-white/20 px-4 py-1.5 text-sm text-white/90 active:bg-white/10"
          >
            登录
          </Link>
        </header>

        {/* Hero */}
        <section className="relative mx-auto max-w-6xl px-5 pb-16 pt-12 sm:px-6 sm:pb-24 sm:pt-20 lg:text-center">
          <p className="mb-4 inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1 text-xs font-medium text-amber-300">
            <Sparkles className="h-3.5 w-3.5" />
            专为台球房打造
          </p>
          <h1 className="mb-4 text-[32px] font-bold leading-[1.25] text-white sm:text-5xl sm:leading-[1.2]">
            朋友圈不知道发什么？
            <br />
            活动不会策划？
          </h1>
          <p className="mb-2 text-lg font-medium text-brand-100 sm:text-xl">
            台球房的运营活，AI 替你干。
          </p>
          <p className="mb-8 text-[15px] leading-relaxed text-brand-200/80 sm:mx-auto sm:max-w-xl">
            文案、海报、活动方案、员工话术——说一句需求，30 秒出成品，复制就能发。
          </p>
          <div className="flex flex-col items-start gap-3 sm:items-center">
            <Link
              href="/register"
              className="inline-flex h-[52px] w-full max-w-xs items-center justify-center rounded-xl bg-amber-400 text-[17px] font-bold text-brand-950 shadow-lg shadow-amber-400/25 active:scale-[0.98] transition-transform sm:w-auto sm:px-10"
            >
              免费试用 · 送 30 次生成
            </Link>
            <p className="text-xs text-brand-200/70">
              微信里直接打开就能用 · 不用下载 App · 注册即用
            </p>
          </div>
        </section>
      </div>

      {/* ───── 真实产出示例 ───── */}
      <section className="mx-auto max-w-6xl px-5 py-14 sm:px-6 sm:py-20">
        <h2 className="mb-2 text-center text-[22px] font-bold text-slate-900 sm:text-3xl">
          生成出来的东西，长这样
        </h2>
        <p className="mb-8 text-center text-sm text-slate-500">
          一键复制 → 微信粘贴，直接能发
        </p>

        <div className="grid gap-5 sm:grid-cols-2 lg:mx-auto lg:max-w-4xl">
          {/* 朋友圈样式卡 */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="mb-3 text-xs font-medium text-brand-600">朋友圈文案 · 晚间邀约</p>
            <div className="flex gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-brand-600 text-lg">
                🎱
              </span>
              <div className="min-w-0">
                <p className="text-[15px] font-semibold text-brand-700">老张台球俱乐部</p>
                <p className="mt-1 text-[15px] leading-relaxed text-slate-800">
                  周五晚上，店里人齐了，灯一开台呢绿得发亮。
                  下班别窝家里，来打两把，输的请汽水。
                  想找搭子的私我，给你拼个水平差不多的🎱
                </p>
                <div className="mt-3 flex items-center gap-4 text-xs text-slate-400">
                  <span>10分钟前</span>
                  <span className="ml-auto flex items-center gap-1">
                    <Heart className="h-3.5 w-3.5" /> 23
                  </span>
                  <span className="flex items-center gap-1">
                    <MessageCircle className="h-3.5 w-3.5" /> 8
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* 群公告样式卡 */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <p className="mb-3 text-xs font-medium text-brand-600">群公告 · 周赛报名</p>
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="mb-1 text-xs text-slate-400">店长 @所有人</p>
              <p className="text-[15px] leading-relaxed text-slate-800">
                🏆 本周六晚 7 点，店内周赛照常开打
                <br />
                ① 群里接龙报名，满 16 人开赛
                <br />
                ② 冠军奖品到店公示
                <br />
                ③ 新朋友想参加，回复「报名」就行
                <br />
                打完一起宵夜，输赢都热闹 🎱
              </p>
            </div>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-slate-400">
          以上为示例样式 · 实际内容基于你的门店资料生成，写的是你店里的事
        </p>
      </section>

      {/* ───── 3 步流程 ───── */}
      <section className="bg-slate-50 py-14 sm:py-20">
        <div className="mx-auto max-w-6xl px-5 sm:px-6">
          <h2 className="mb-10 text-center text-[22px] font-bold text-slate-900 sm:text-3xl">
            三步，活就干完了
          </h2>
          <div className="grid gap-4 sm:grid-cols-3 lg:mx-auto lg:max-w-4xl">
            {[
              {
                icon: MousePointerClick,
                step: "1",
                title: "选场景",
                desc: "朋友圈 / 群公告 / 活动 / 海报 / 话术，按岗位分好类，点就行",
              },
              {
                icon: MessageSquareText,
                step: "2",
                title: "说需求",
                desc: "像跟员工交代事情一样说一句，比如「周五晚上想拉点人来」",
              },
              {
                icon: Copy,
                step: "3",
                title: "复制发微信",
                desc: "30 秒出成品，一键复制粘到微信；海报长按保存发圈",
              },
            ].map((s) => (
              <div key={s.step} className="rounded-2xl bg-white p-6 shadow-sm">
                <div className="mb-3 flex items-center gap-3">
                  <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
                    <s.icon className="h-5 w-5" />
                  </span>
                  <span className="text-2xl font-bold text-brand-200">{s.step}</span>
                </div>
                <h3 className="mb-1 text-[17px] font-semibold text-slate-900">{s.title}</h3>
                <p className="text-sm leading-relaxed text-slate-500">{s.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───── 能力一览 ───── */}
      <section className="mx-auto max-w-6xl px-5 py-14 sm:px-6 sm:py-20">
        <h2 className="mb-10 text-center text-[22px] font-bold text-slate-900 sm:text-3xl">
          不止写文案
        </h2>
        <div className="grid gap-4 sm:grid-cols-3 lg:mx-auto lg:max-w-4xl">
          {[
            {
              icon: Sparkles,
              title: "AI 文案 · 方案",
              desc: "朋友圈、群公告、活动策划、赛事通知、员工话术，80+ 个球房场景",
            },
            {
              icon: ImageIcon,
              title: "AI 海报",
              desc: "说需求出图，不满意接着说「再改改」，门店 Logo 二维码自动带上",
            },
            {
              icon: CalendarCheck,
              title: "今日该干啥",
              desc: "每天打开告诉你今天该发什么、节日临近该备什么活动",
            },
          ].map((f) => (
            <div key={f.title} className="rounded-2xl border border-slate-200 p-6">
              <span className="mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white">
                <f.icon className="h-5 w-5" />
              </span>
              <h3 className="mb-1 text-[17px] font-semibold text-slate-900">{f.title}</h3>
              <p className="text-sm leading-relaxed text-slate-500">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ───── 六岗位 ───── */}
      <section className="bg-brand-950 py-14 sm:py-20">
        <div className="mx-auto max-w-6xl px-5 sm:px-6">
          <h2 className="mb-2 text-center text-[22px] font-bold text-white sm:text-3xl">
            店里每个人都用得上
          </h2>
          <p className="mb-10 text-center text-sm text-brand-200/70">
            一个店一个号，老板拉员工进来，各干各的活
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:mx-auto lg:max-w-4xl">
            {ROLES.map((r) => (
              <div key={r.role} className="rounded-2xl bg-white/5 p-4 backdrop-blur-sm">
                <h3 className="mb-1 text-[15px] font-semibold text-amber-300">{r.role}</h3>
                <p className="text-xs leading-relaxed text-brand-100/70">{r.tasks}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ───── FAQ ───── */}
      <section className="mx-auto max-w-6xl px-5 py-14 sm:px-6 sm:py-20">
        <h2 className="mb-10 text-center text-[22px] font-bold text-slate-900 sm:text-3xl">
          你可能想问
        </h2>
        <div className="mx-auto max-w-2xl space-y-3">
          {FAQS.map((f) => (
            <details key={f.q} className="group rounded-2xl border border-slate-200 bg-white">
              <summary className="flex cursor-pointer list-none items-center justify-between px-5 py-4 text-[15px] font-medium text-slate-900">
                {f.q}
                <span className="ml-3 text-slate-300 transition-transform group-open:rotate-45">＋</span>
              </summary>
              <p className="px-5 pb-4 text-sm leading-relaxed text-slate-500">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      {/* ───── 收尾 CTA ───── */}
      <section className="mx-auto max-w-6xl px-5 pb-16 sm:px-6">
        <div className="rounded-3xl bg-gradient-to-br from-brand-900 to-brand-950 px-6 py-12 text-center">
          <h2 className="mb-3 text-[22px] font-bold text-white sm:text-3xl">
            今晚的朋友圈，让 AI 来写
          </h2>
          <p className="mb-7 text-sm text-brand-200/80">免费 30 次 · 不绑卡 · 微信打开即用</p>
          <Link
            href="/register"
            className="inline-flex h-[52px] items-center justify-center rounded-xl bg-amber-400 px-10 text-[17px] font-bold text-brand-950 shadow-lg shadow-amber-400/25 active:scale-[0.98] transition-transform"
          >
            免费试用
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-slate-100 py-8 text-center text-xs text-slate-400">
        © 2026 球房 AI 运营助手
      </footer>

      {/* 手机吸底 CTA */}
      <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-slate-100 bg-white/95 p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] backdrop-blur lg:hidden">
        <Link
          href="/register"
          className="flex h-12 w-full items-center justify-center rounded-xl bg-amber-400 text-base font-bold text-brand-950 active:scale-[0.98] transition-transform"
        >
          免费试用 · 送 30 次生成
        </Link>
      </div>
    </div>
  );
}
