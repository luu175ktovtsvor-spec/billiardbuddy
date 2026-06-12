"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && isAuthenticated) {
      router.replace("/dashboard");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <p className="text-slate-400">加载中...</p>
      </div>
    );
  }

  return (
    // 苹果浅色登录:iOS 灰底 + 白卡聚焦,克制无装饰
    <div className="flex min-h-screen items-center justify-center bg-[#F2F2F7] px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white text-2xl shadow-sm">
            🎱
          </div>
          <h1 className="text-[22px] font-bold text-slate-900">球房 AI 运营助手</h1>
          <p className="mt-1 text-sm text-slate-500">台球房的运营活，AI 替你干</p>
        </div>
        {children}
      </div>
    </div>
  );
}
