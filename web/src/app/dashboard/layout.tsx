"use client";

// 单窗口化：桌面版只剩 AI agent 一个窗口（Codex 风），整窗外观由 DesktopChatShell 自己掌控。
// 免登录：本地 owner 由 getMe 自动加载，不再有登录守卫/跳转。
import { useAuth } from "@/hooks/auth-context";
import { ErrorBoundary } from "@/components/error-boundary";
import { ClientErrorReporter } from "@/components/client-error-reporter";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-[#0e0f11]">
        <p className="text-[13px] text-[#86868b] dark:text-[#6e7077]">加载中…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-white dark:bg-[#0e0f11]">
        <p className="text-[13px] text-[#86868b] dark:text-[#6e7077]">本地身份加载失败，请重启 App</p>
      </div>
    );
  }

  return (
    <ErrorBoundary>
      <ClientErrorReporter />
      {children}
    </ErrorBoundary>
  );
}
