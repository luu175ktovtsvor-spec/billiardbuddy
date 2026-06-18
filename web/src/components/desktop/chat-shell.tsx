"use client";

/**
 * 桌面端 Agent 对话整壳：侧栏 + （空态欢迎页 | 对话流）+ 输入区，接 useAgentChat 真后端管道。
 * 由 chat/page.tsx 在 isDesktop 时早返回渲染；手机网页版走原有页面，二者物理隔离。
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { useAgentChat, type PermissionMode } from "@/hooks/use-agent-chat";
import { DesktopShell, DesktopSidebar } from "./macos-shell";
import { WelcomeScreen } from "./welcome-screen";
import { DesktopComposer } from "./desktop-composer";
import { DesktopChatThread } from "./chat-thread";

const PLATFORM_PUBLISH_ID: Record<string, string> = {
  douyin: "douyin", 抖音: "douyin",
  kuaishou: "kuaishou", 快手: "kuaishou",
  shipinhao: "shipinhao", 视频号: "shipinhao", channels: "shipinhao",
  xiaohongshu: "xiaohongshu", 小红书: "xiaohongshu", xhs: "xiaohongshu", red: "xiaohongshu",
};

function timeGreeting(): string {
  const h = new Date().getHours();
  const t = h < 5 ? "凌晨好" : h < 11 ? "早上好" : h < 13 ? "中午好" : h < 18 ? "下午好" : "晚上好";
  return `${t}，老板`;
}

export function DesktopChatShell({
  storeName = "我的台球房",
  monthlySpend,
  todaySuggestion,
}: {
  storeName?: string;
  monthlySpend?: string;
  todaySuggestion?: string;
}) {
  const router = useRouter();
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<PermissionMode>("ask");
  const chat = useAgentChat({ permissionMode: mode });

  // 权限偏好持久化（与手机页同一个 localStorage key，体验一致）
  useEffect(() => {
    try {
      const m = localStorage.getItem("agent_permission_mode");
      if (m === "ask" || m === "auto_files" || m === "full") setMode(m);
    } catch { /* 忽略 */ }
  }, []);
  const updateMode = (m: PermissionMode) => {
    setMode(m);
    try { localStorage.setItem("agent_permission_mode", m); } catch { /* 忽略 */ }
  };

  const onSend = () => {
    const t = input.trim();
    if (!t || chat.generating) return;
    setInput("");
    void chat.send(t);
  };
  const pick = (prompt: string) => {
    if (chat.generating) return;
    setInput("");
    void chat.send(prompt);
  };
  const publishHandoff = (rawPlatform: unknown, content: string) => {
    const raw = String(rawPlatform ?? "").trim();
    const pid = PLATFORM_PUBLISH_ID[raw.toLowerCase()] || PLATFORM_PUBLISH_ID[raw] || "douyin";
    const tags = (content.match(/#[^\s#]+/g) || []).map((t) => t.slice(1)).slice(0, 8);
    const caption = content.replace(/#[^\s#]+/g, "").replace(/\n{3,}/g, "\n\n").trim().slice(0, 800);
    const qs = new URLSearchParams({ platform: pid, title: caption, tags: tags.join(",") });
    router.push(`/dashboard/publish?${qs.toString()}`);
  };

  const empty = chat.messages.length === 0 && !chat.generating;

  return (
    <DesktopShell
      sidebar={
        <DesktopSidebar
          storeName={storeName}
          monthlySpend={monthlySpend}
          conversations={[]}
          onNewChat={chat.startNewChat}
          onOpenSettings={() => router.push("/dashboard/store-settings")}
        />
      }
    >
      <div className="flex h-[52px] items-center border-b border-black/[0.07] px-5 text-[14px] font-medium text-[#1d1d1f]">
        {empty ? "新对话" : "对话"}
      </div>

      {empty ? (
        <WelcomeScreen greeting={timeGreeting()} todaySuggestion={todaySuggestion} onPick={pick} />
      ) : (
        <DesktopChatThread
          messages={chat.messages}
          draft={chat.draft}
          liveSteps={chat.liveSteps}
          generating={chat.generating}
          executingIdx={chat.executingIdx}
          onConfirm={chat.confirmApproval}
          onCancel={chat.cancelApproval}
          onPublish={publishHandoff}
        />
      )}

      <DesktopComposer
        value={input}
        onChange={setInput}
        onSend={onSend}
        permissionMode={mode}
        onPermissionChange={updateMode}
        disabled={chat.generating}
      />
    </DesktopShell>
  );
}
