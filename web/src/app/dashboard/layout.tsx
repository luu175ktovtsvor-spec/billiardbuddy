"use client";

// 单窗口化：桌面版只剩 AI agent 一个窗口（Codex 风）。
// 这里只保留「鉴权守卫」——不再渲染网页版侧栏/头部/底栏。整窗外观由 DesktopChatShell 自己掌控。
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { ErrorBoundary } from "@/components/error-boundary";
import { ToastProvider } from "@/components/ui/toast";
import { ClientErrorReporter } from "@/components/client-error-reporter";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.replace("/login");
    }
  }, [isLoading, isAuthenticated, router]);

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-[#0e0f11]">
        <p className="text-[13px] text-[#86868b] dark:text-[#6e7077]">加载中…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null;
  }

  return (
    <ErrorBoundary>
      <ToastProvider>
        <ClientErrorReporter />
        {children}
      </ToastProvider>
    </ErrorBoundary>
  );
}
