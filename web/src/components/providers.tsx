"use client";

import { useEffect } from "react";
import { AuthProvider } from "@/hooks/auth-context";
import { ToastProvider } from "@/components/desktop/toast";
import { OfflineBanner } from "@/components/desktop/offline-banner";
import { watchSystemTheme } from "@/lib/theme";

export function Providers({ children }: { children: React.ReactNode }) {
  // P1-10 跟随系统时,系统深浅色实时变化要跟上(首屏由 layout 内联脚本定调,这里管运行时)。
  useEffect(() => watchSystemTheme(), []);
  // ToastProvider 挂在根：系统状态通知(已保存/已删除等)走 toast，不再伪装成 AI 气泡塞进对话历史。
  // OfflineBanner 同样挂在根（跟 ToastHost 同级）：每个 Electron 窗口（对话/生成工作室/视频工作区/
  // 工作台）各自独立加载这棵树，一处接线天然覆盖全部窗口，断网横幅不用逐页面接。
  return (
    <AuthProvider>
      <ToastProvider>
        <OfflineBanner />
        {children}
      </ToastProvider>
    </AuthProvider>
  );
}
