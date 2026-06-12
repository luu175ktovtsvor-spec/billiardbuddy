import Link from "next/link";

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white">
      {/* Header */}
      <header className="border-b">
        <div className="mx-auto max-w-6xl flex items-center justify-between px-6 py-4">
          <h1 className="text-xl font-bold">球房 AI 运营助手</h1>
          <div className="flex gap-3">
            <Link href="/login" className="px-4 py-2 text-sm">登录</Link>
            <Link href="/register" className="px-4 py-2 text-sm bg-brand-600 text-white rounded-md">免费试用</Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 py-20 text-center">
        <h2 className="text-4xl font-bold mb-4">AI 帮你写球房运营文案，每天省 2 小时</h2>
        <p className="text-lg text-slate-600 mb-8">专为台球房管理层设计，朋友圈/活动策划/海报一键生成</p>
        <Link href="/register" className="px-8 py-3 bg-brand-600 text-white rounded-lg text-lg">免费试用</Link>
      </section>

      {/* 功能展示 */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-bold text-center mb-8">核心功能</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {[
            { title: "AI 文案生成", desc: "朋友圈、群公告、活动方案，30 秒生成" },
            { title: "AI 海报制作", desc: "上传参考图，一键生成专业级海报" },
            { title: "智能推荐", desc: "每天告诉你该做什么，不用自己想" },
          ].map((f, i) => (
            <div key={i} className="rounded-lg border p-6">
              <h3 className="font-bold text-lg mb-2">{f.title}</h3>
              <p className="text-slate-600">{f.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 适用岗位 */}
      <section className="mx-auto max-w-6xl px-6 py-16 bg-slate-50">
        <h2 className="text-2xl font-bold text-center mb-8">适用岗位</h2>
        <div className="grid md:grid-cols-3 gap-6">
          {[
            { role: "店长", tasks: "日报/周报/活动策划/老客维护" },
            { role: "助教管理", tasks: "助教推广/招聘文案/PK方案/培训计划" },
            { role: "教练", tasks: "赛事通知/赛后战报/搭子局/好评引导" },
            { role: "前厅", tasks: "团购核销话术/投诉安抚/开店闭店SOP" },
            { role: "老板", tasks: "经营简报/月度汇报/投资回报分析" },
            { role: "运营", tasks: "朋友圈计划/短视频文案/抖音矩阵" },
          ].map((r, i) => (
            <div key={i} className="rounded-lg border bg-white p-4">
              <h3 className="font-bold text-sm text-brand-600 mb-1">{r.role}</h3>
              <p className="text-sm text-slate-600">{r.tasks}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t py-8 text-center text-sm text-slate-500">
        © 2026 球房 AI 运营助手
      </footer>
    </div>
  );
}
