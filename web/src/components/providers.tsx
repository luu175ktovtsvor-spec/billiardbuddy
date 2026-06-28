"use client";

import { useEffect } from "react";
import { AuthProvider } from "@/hooks/auth-context";
import { watchSystemTheme } from "@/lib/theme";

export function Providers({ children }: { children: React.ReactNode }) {
  // P1-10 跟随系统时,系统深浅色实时变化要跟上(首屏由 layout 内联脚本定调,这里管运行时)。
  useEffect(() => watchSystemTheme(), []);
  return <AuthProvider>{children}</AuthProvider>;
}
