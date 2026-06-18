"use client";

/**
 * 桌面 macOS UI 预览页（开发期可视化校验用，不在 dashboard 鉴权下，公开可看）。
 * 真机里这套外壳由 chat 页在 isDesktop 时早返回渲染；这里用 mock 数据预览组件长相。
 */
import { useState } from "react";

import { DesktopShell, DesktopSidebar } from "@/components/desktop/macos-shell";
import { WelcomeScreen } from "@/components/desktop/welcome-screen";
import { DesktopComposer, type PermissionMode } from "@/components/desktop/desktop-composer";

const MOCK_CONVERSATIONS = [
  { id: "1", title: "周末双人优惠海报", subtitle: "帮我做张周末双人优惠的海报…", group: "今天" },
  { id: "2", title: "这个月经营诊断", group: "今天" },
  { id: "3", title: "中秋活动策划", group: "前 7 天" },
  { id: "4", title: "助教约客话术一批", group: "前 7 天" },
];

export default function DesktopPreviewPage() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<PermissionMode>("ask");

  return (
    <DesktopShell
      sidebar={
        <DesktopSidebar
          storeName="楠米台球·万象城店"
          monthlySpend="¥3.2"
          conversations={MOCK_CONVERSATIONS}
          activeId="1"
        />
      }
    >
      <div className="flex h-[52px] items-center border-b border-black/[0.07] px-5 text-[14px] font-medium text-[#1d1d1f]">
        新对话
      </div>
      <WelcomeScreen
        greeting="晚上好，老板"
        todaySuggestion="周五了，周末客流高峰前，要不要发条周末活动预告？"
        onPick={(p) => setInput(p)}
      />
      <DesktopComposer
        value={input}
        onChange={setInput}
        onSend={() => setInput("")}
        permissionMode={mode}
        onPermissionChange={setMode}
      />
    </DesktopShell>
  );
}
