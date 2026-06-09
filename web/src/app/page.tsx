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
            <Link href="/register" className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-md">免费试用</Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto max-w-6xl px-6 py-20 text-center">
        <h2 className="text-4xl font-bold mb-4">AI 帮你写球房运营文案，每天省 2 小时</h2>
        <p className="text-lg text-slate-600 mb-8">专为台球房管理层设计，朋友圈/活动策划/海报一键生成</p>
        <Link href="/register" className="px-8 py-3 bg-indigo-600 text-white rounded-lg text-lg">免费试用</Link>
      </section>

      {/* 功能展示 */}
      <section className="mx-auto max-w-6xl px-6 py-16">
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

      {/* 定价 */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <h2 className="text-2xl font-bold text-center mb-8">定价</h2>
        <div className="grid md:grid-cols-3 gap-8">
          {[
            { name: "免费版", price: "0", features: ["每月 20 次生成", "基础模板", "有水印"] },
            { name: "专业版", price: "99", features: ["每月 300 次生成", "全部模板", "无水印海报"], popular: true },
            { name: "团队版", price: "299", features: ["不限次数", "多成员协作", "专属客服"] },
          ].map((p, i) => (
            <div key={i} className={`rounded-lg border p-6 ${p.popular ? "border-indigo-600 ring-2 ring-indigo-600" : ""}`}>
              {p.popular && <span className="text-xs bg-indigo-600 text-white px-2 py-1 rounded">最受欢迎</span>}
              <h3 className="font-bold text-lg mt-2">{p.name}</h3>
              <p className="text-3xl font-bold my-4">¥{p.price}<span className="text-sm font-normal">/月</span></p>
              <ul className="space-y-2">
                {p.features.map((f, j) => <li key={j} className="text-sm text-slate-600">✓ {f}</li>)}
              </ul>
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
