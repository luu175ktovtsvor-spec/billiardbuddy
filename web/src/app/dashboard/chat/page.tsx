"use client";

// 单窗口产品：聊天路由只渲染唯一的 Codex 风 AI agent 外壳。
// （旧的手机网页版分支已随单窗口化删除——桌面壳在浏览器里也能渲染，electron 专属能力自带守卫。）
import { DesktopChatShell } from "@/components/desktop/chat-shell";

export default function ChatPage() {
  return <DesktopChatShell />;
}
