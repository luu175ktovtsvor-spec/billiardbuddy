"use client";

/**
 * 桌面 macOS UI 预览页（开发期可视化校验用，公开路由、不连后端）。
 * 用 mock 数据预览：欢迎态 + 对话流（用户气泡/工具步骤/成品卡/审批卡）。真机走 chat 页 isDesktop 早返回的 DesktopChatShell。
 */
import { useState } from "react";

import { DesktopShell, DesktopSidebar } from "@/components/desktop/macos-shell";
import { WelcomeScreen } from "@/components/desktop/welcome-screen";
import { DesktopComposer, type PermissionMode } from "@/components/desktop/desktop-composer";
import { DesktopChatThread } from "@/components/desktop/chat-thread";
import { DesktopPreviewPanel, type PreviewItem } from "@/components/desktop/preview-panel";
import type { ChatMessage } from "@/hooks/use-agent-chat";

const MOCK_CONVERSATIONS = [
  { id: "1", title: "周末双人优惠海报", subtitle: "帮我做张周末双人优惠的海报…", group: "今天" },
  { id: "2", title: "这个月经营诊断", group: "今天" },
  { id: "3", title: "中秋活动策划", group: "前 7 天" },
];

const MOCK_MESSAGES: ChatMessage[] = [
  { role: "user", content: "帮我写条周末双人优惠的朋友圈，再做张海报" },
  {
    role: "assistant",
    content: "好嘞，先给你写好朋友圈文案 👇 海报我也准备了，确认下就开做。",
    steps: [
      { tool: "find_scenario", id: "s1", done: true, result: "已挑选模板：周末双人局" },
      {
        tool: "write_operation_content",
        id: "s2",
        done: true,
        result:
          "🎱 周末来一局！双人同行更划算～\n本周六日，两人开台享 8 折，再送一小时畅打体验。\n约上搭子，台呢一铺，烦恼全消。\n📍 万象城店 · 营业到凌晨两点，随时来。",
      },
    ],
    approval: {
      tool: "make_poster",
      args: {},
      preview: "竖版 9:16 · 暖色温馨风 · 突出「周末双人 8 折」· 含门店名与营业时间",
      status: "pending",
    },
  },
  {
    role: "assistant",
    content: "对了，海报想走哪种风格？挑一个我来出图 👇",
    question: {
      question: "海报想走哪种风格？",
      options: [
        { label: "温馨有爱", description: "情侣、朋友来打球，暖暖的有氛围" },
        { label: "年轻潮酷", description: "年轻人、夜场，酷炫抓眼球" },
        { label: "简约干净", description: "清爽不花哨，显得有档次" },
      ],
    },
  },
];

export default function DesktopPreviewPage() {
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<PermissionMode>("ask");
  const [showThread, setShowThread] = useState(true);
  const [previewItem, setPreviewItem] = useState<PreviewItem | null>({
    kind: "content",
    title: "朋友圈文案",
    text: MOCK_MESSAGES[1].steps?.[1]?.result || "",
  });

  return (
    <DesktopShell
      sidebar={
        <DesktopSidebar
          storeName="楠米台球·万象城店"
          monthlySpend="¥3.2"
          conversations={MOCK_CONVERSATIONS}
          activeId="1"
          onNewChat={() => setShowThread(false)}
          onSelect={() => setShowThread(true)}
        />
      }
      preview={previewItem ? <DesktopPreviewPanel item={previewItem} onClose={() => setPreviewItem(null)} onRefine={() => {}} /> : undefined}
    >
      <div className="flex h-[52px] items-center border-b border-black/[0.07] px-5 text-[14px] font-medium text-[#1d1d1f]">
        {showThread ? "周末双人优惠海报" : "新对话"}
      </div>

      {showThread ? (
        <DesktopChatThread
          messages={MOCK_MESSAGES}
          draft=""
          liveSteps={[]}
          generating={false}
          executingIdx={null}
          onConfirm={() => {}}
          onCancel={() => {}}
          onPreview={setPreviewItem}
          onAnswer={() => {}}
        />
      ) : (
        <WelcomeScreen
          greeting="晚上好，老板"
          todaySuggestion="周五了，周末客流高峰前，要不要发条周末活动预告？"
          onPick={(p) => setInput(p)}
        />
      )}

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
