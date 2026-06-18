"use client";

import { useEffect, useState } from "react";
import type { ElectronBridge } from "@/types/electron";

/** 是否运行在桌面端(Electron)。web 浏览器版返回 false → 发布/剪辑入口自动隐藏。 */
export function useDesktop(): { isDesktop: boolean; electron: ElectronBridge | null } {
  const [isDesktop, setIsDesktop] = useState(false);

  useEffect(() => {
    // window.electron 由 desktop 的 preload 注入;浏览器没有
    setIsDesktop(typeof window !== "undefined" && !!window.electron);
  }, []);

  return {
    isDesktop,
    electron: typeof window !== "undefined" ? window.electron ?? null : null,
  };
}
