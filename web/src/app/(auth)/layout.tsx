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
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-gradient-to-b from-brand-950 via-brand-900 to-brand-950 px-4 py-12">
      {/* 夜场氛围:台呢光晕 + 彩球点缀,与落地页同语言 */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute -left-20 top-16 h-56 w-56 rounded-full bg-brand-600/25 blur-3xl" />
        <div className="absolute -right-10 bottom-24 h-48 w-48 rounded-full bg-amber-500/10 blur-3xl" />
        <div className="absolute left-[15%] top-[20%] h-2.5 w-2.5 rounded-full bg-red-500/60" />
        <div className="absolute right-[18%] top-[30%] h-2 w-2 rounded-full bg-amber-400/70" />
      </div>
      <div className="relative w-full max-w-sm">
        <div className="mb-8 text-center">
          <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-white/10 text-2xl backdrop-blur-sm">
            🎱
          </div>
          <h1 className="text-xl font-bold text-white">球房 AI 运营助手</h1>
          <p className="mt-1 text-sm text-brand-200/70">台球房的运营活，AI 替你干</p>
        </div>
        {children}
      </div>
    </div>
  );
}
