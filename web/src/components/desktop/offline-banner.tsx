"use client";

/**
 * G-b 断网全局横幅：盯 navigator.onLine + window 的 online/offline 事件，离线时露一条大白话横幅，
 * 联网恢复自动收起。跟 lib/utils.ts 的 humanizeErrorText（把一次已发生的报错文案翻成人话）是两回事——
 * 那个事后翻译错误文案，这个是实时网络状态，不用等一次请求失败才知道断网了。
 *
 * 挂在根 Providers 里（跟 ToastHost 同级，见 components/providers.tsx），每个 Electron 窗口
 * （对话/生成工作室/视频工作区/工作台）各自独立加载这一整棵 React 树，天然覆盖所有窗口，
 * 不用逐个页面接线。纯展示、不接管点击（pointer-events-none 整条透传），既不挡标题栏拖拽，
 * 也不挡顶部工具栏按钮。
 */
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";

export function OfflineBanner() {
  // 首屏（含 SSR）先当"在线"，effect 里挂载后立刻用真实 navigator.onLine 校正一次，
  // 避免服务端渲染时访问不到 navigator 报错、也不会造成 hydration 不一致（两边初值都是 false）。
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    setOffline(typeof navigator !== "undefined" && !navigator.onLine);
    const onOffline = () => setOffline(true);
    const onOnline = () => setOffline(false);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-0 z-[90] flex items-center justify-center gap-2 border-b border-[#b58a00]/25 bg-[#fff8e6]/95 px-4 py-1.5 text-[12.5px] text-[#8a6d00] shadow-sm backdrop-blur-sm dark:border-[#e0b23a]/20 dark:bg-[#3a2f0f]/95 dark:text-[#e0b23a]"
    >
      <WifiOff className="h-3.5 w-3.5 shrink-0" />
      <span>店里网络好像断了，联网后我接着干</span>
    </div>
  );
}
