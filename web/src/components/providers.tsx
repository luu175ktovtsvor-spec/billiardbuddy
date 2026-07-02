"use client";

import { useEffect } from "react";
import { AuthProvider } from "@/hooks/auth-context";
import { ToastProvider } from "@/components/desktop/toast";
import { watchSystemTheme } from "@/lib/theme";

export function Providers({ children }: { children: React.ReactNode }) {
  // P1-10 跟随系统时,系统深浅色实时变化要跟上(首屏由 layout 内联脚本定调,这里管运行时)。
  useEffect(() => watchSystemTheme(), []);
  // ToastProvider 挂在根：系统状态通知(已保存/已删除等)走 toast，不再伪装成 AI 气泡塞进对话历史。
  return (
    <AuthProvider>
      <ToastProvider>{children}</ToastProvider>
    </AuthProvider>
  );
}
