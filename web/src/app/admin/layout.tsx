"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/hooks/auth-context";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (!isLoading && !user?.is_admin) {
      router.replace("/dashboard");
    }
  }, [user, isLoading, router]);

  if (isLoading) return <div className="flex items-center justify-center py-20">加载中...</div>;
  if (!user?.is_admin) return null;

  return (
    <div className="flex min-h-screen">
      <aside className="w-60 border-r bg-slate-50 p-4">
        <h2 className="font-bold mb-4 text-slate-900">管理后台</h2>
        <nav className="space-y-2">
          <Link href="/admin" className="block px-3 py-2 rounded hover:bg-slate-100 text-slate-700">总览</Link>
          <Link href="/admin/users" className="block px-3 py-2 rounded hover:bg-slate-100 text-slate-700">用户管理</Link>
          <Link href="/admin/plans" className="block px-3 py-2 rounded hover:bg-slate-100 text-slate-700">套餐管理</Link>
        </nav>
      </aside>
      <main className="flex-1 p-6">{children}</main>
    </div>
  );
}
