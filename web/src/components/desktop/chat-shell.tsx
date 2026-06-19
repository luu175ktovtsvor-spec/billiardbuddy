"use client";

/**
 * 桌面端 Agent 对话整壳：侧栏 + （空态欢迎页 | 对话流）+ 输入区，接 useAgentChat 真后端管道。
 * 由 chat/page.tsx 在 isDesktop 时早返回渲染；手机网页版走原有页面，二者物理隔离。
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { api } from "@/lib/api";
import { useAgentChat, type PermissionMode, type ChatMessage } from "@/hooks/use-agent-chat";
import { DesktopShell, DesktopSidebar, type DesktopConversation } from "./macos-shell";
import { WelcomeScreen } from "./welcome-screen";
import { DesktopComposer } from "./desktop-composer";
import { DesktopChatThread } from "./chat-thread";
import { DesktopPreviewPanel, type PreviewItem } from "./preview-panel";

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

function groupByDate(iso: string | null): string {
  if (!iso) return "更早";
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "今天";
  const days = Math.floor((now.getTime() - d.getTime()) / 86400000);
  return days < 7 ? "前 7 天" : "更早";
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
  const [preview, setPreview] = useState<PreviewItem | null>(null);

  // 侧栏真数据：门店名 + 本月 AI 花费（拿不到就用传入的默认/占位，不阻断）
  const [liveStoreName, setLiveStoreName] = useState<string | undefined>();
  const [liveSpend, setLiveSpend] = useState<string | undefined>();
  const [liveToday, setLiveToday] = useState<string | undefined>();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // allSettled：任一接口挂了不拖垮其它，拿不到的就保持默认/占位
      const [s, c, t] = await Promise.allSettled([api.getMyStore(), api.getCost(), api.getTodayDashboard()]);
      if (cancelled) return;
      if (s.status === "fulfilled" && s.value?.name) setLiveStoreName(s.value.name);
      if (c.status === "fulfilled" && typeof c.value?.est_cost_yuan === "number") {
        setLiveSpend(`¥${c.value.est_cost_yuan.toFixed(2)}`);
      }
      if (t.status === "fulfilled") {
        const rec = t.value?.recommendations?.[0];
        if (rec) setLiveToday(rec.description || rec.title);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // 会话历史列表（侧栏）：进页面拉一次 + 每拿到新会话 id 后刷新（新会话冒头）
  const [conversations, setConversations] = useState<DesktopConversation[]>([]);
  const refreshConversations = useCallback(async () => {
    try {
      const r = await api.listAgentConversations();
      setConversations((r.conversations || []).map((c) => ({
        id: c.conversation_id,
        title: c.title || "新对话",
        group: groupByDate(c.last_at),
      })));
    } catch { /* 拿不到就空 */ }
  }, []);
  useEffect(() => { void refreshConversations(); }, [refreshConversations]);
  useEffect(() => { if (chat.conversationId) void refreshConversations(); }, [chat.conversationId, refreshConversations]);

  // 点开一条历史会话 → 拉它的消息加载进来（可继续聊）
  const loadConv = useCallback(async (id: string) => {
    try {
      const r = await api.getAgentConversation(id);
      chat.loadConversation(id, (r.messages || []) as ChatMessage[]);
    } catch { /* 忽略 */ }
  }, [chat]);

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

  // 右侧"基于此调整"：把输入框预填好引子，老板补上要改什么、发出去，管家在原件上接着改
  const onRefine = (kind: PreviewItem["kind"]) => {
    setInput(kind === "poster" ? "把刚才那张海报改成：" : "把刚才这条改成：");
  };

  const empty = chat.messages.length === 0 && !chat.generating;

  return (
    <DesktopShell
      sidebar={
        <DesktopSidebar
          storeName={liveStoreName || storeName}
          monthlySpend={liveSpend ?? monthlySpend}
          conversations={conversations}
          activeId={chat.conversationId ?? undefined}
          onNewChat={chat.startNewChat}
          onSelect={loadConv}
          onOpenSettings={() => router.push("/dashboard/store-settings")}
        />
      }
      preview={preview ? <DesktopPreviewPanel item={preview} onClose={() => setPreview(null)} onRefine={onRefine} /> : undefined}
    >
      <div className="flex h-[52px] items-center border-b border-black/[0.07] px-5 text-[14px] font-medium text-[#1d1d1f]">
        {empty ? "新对话" : "对话"}
      </div>

      {empty ? (
        <WelcomeScreen greeting={timeGreeting()} todaySuggestion={liveToday || todaySuggestion} onPick={pick} />
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
          onPreview={setPreview}
          onAnswer={(label) => { void chat.send(label); }}
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
