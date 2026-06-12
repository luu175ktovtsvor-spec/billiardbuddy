import Link from "next/link";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-slate-200">404</h1>
        <p className="mt-4 text-lg text-slate-600">页面不存在</p>
        <p className="mt-2 text-sm text-slate-400">
          你访问的页面可能已被移动或删除
        </p>
        <Link
          href="/dashboard"
          className="mt-6 inline-flex items-center gap-2 rounded-md bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-500"
        >
          返回首页
        </Link>
      </div>
    </div>
  );
}
