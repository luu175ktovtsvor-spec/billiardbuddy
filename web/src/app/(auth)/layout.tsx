"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    // 单窗口产品：已登录就进唯一窗口（/dashboard/chat），不再去已删除的 /dashboard
    if (!isLoading && isAuthenticated) {
      router.replace("/dashboard/chat");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#F2F2F7] dark:bg-[#0e0f11]">
        <p className="text-[13px] text-[#86868b] dark:text-[#6e7077]">加载中…</p>
      </div>
    );
  }

  return (
    // 浅色默认 · 跟随系统深浅色
    <div className="flex min-h-screen items-center justify-center bg-[#F2F2F7] px-4 py-12 dark:bg-[#0e0f11]">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 h-14 w-14 overflow-hidden rounded-2xl shadow-sm">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/agent-icon.png" alt="台球运营管家" className="h-full w-full object-cover" />
          </div>
          <h1 className="text-[22px] font-bold text-[#1d1d1f] dark:text-[#e6e7e9]">台球运营管家</h1>
          <p className="mt-1 text-sm text-[#86868b] dark:text-[#6e7077]">台球房的运营活，AI 替你干</p>
        </div>
        {children}
      </div>
    </div>
  );
}
