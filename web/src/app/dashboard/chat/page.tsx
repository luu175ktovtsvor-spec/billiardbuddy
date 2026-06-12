"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Send, Loader2, Sparkles } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/auth-context";
import { PageHeader } from "@/components/layout/page-header";
import { QuotaBadge } from "@/components/quota-badge";
import { CopyButton } from "@/components/generators/copy-button";
import type { WorkbenchRole } from "@/types/generate";

/* 自由对话模式:像 DeepSeek 一样直接跟 AI 聊,但背后是同一条 free_intent 生成管道
 * ——门店画像、行业知识库、合规过滤、配额、落库全部生效。
 * 与工作台卡片互补:卡片=按场景点菜,这里=想到啥说啥。 */

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const SUGGESTIONS = [
  "帮我写一条今晚的朋友圈",
  "这周末搞个什么活动好？",
  "客人嫌台费贵，怎么回比较好？",
  "写个招聘助教的文案",
  "怎么让团购客转成会员？",
];

const VALID_ROLES = new Set(["manager", "assistant_manager", "coach", "frontdesk", "boss", "operator"]);

function toWorkbenchRole(myRole: string | null | undefined): WorkbenchRole {
  if (!myRole) return "manager";
  if (myRole === "owner") return "boss" as WorkbenchRole;
  return (VALID_ROLES.has(myRole) ? myRole : "manager") as WorkbenchRole;
}

export default function ChatPage() {
  const { isAuthenticated } = useAuth();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState(""); // 流式中的 AI 回复
  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [role, setRole] = useState<WorkbenchRole>("manager");
  const [quotaVersion, setQuotaVersion] = useState(0);
  const [quotaRemaining, setQuotaRemaining] = useState<number | null>(null);
  const quotaExhausted = quotaRemaining !== null && quotaRemaining <= 0;

  const convIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 用本人岗位视角对话(知识/规则按岗位注入)
  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    api.getMyStore()
      .then((s) => { if (!cancelled) setRole(toWorkbenchRole(s.my_role)); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, draft]);

  // 卸载时断流
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = async (text: string) => {
    const intent = text.trim();
    if (!intent || generating || quotaExhausted) return;

    setMessages((prev) => [...prev, { role: "user", content: intent }]);
    setInput("");
    setDraft("");
    setGenerating(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await api.streamWorkbench(
        {
          user_intent: intent,
          role,
          conversation_id: convIdRef.current || undefined,
        },
        (token) => setDraft((prev) => prev + token),
        (fullContent, _generationId, convId) => {
          setMessages((prev) => [...prev, { role: "assistant", content: fullContent }]);
          setDraft("");
          setQuotaVersion((v) => v + 1);
          if (convId) convIdRef.current = convId;
        },
        (msg) => {
          if (controller.signal.aborted) return;
          setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${msg}` }]);
          setDraft("");
        },
        controller.signal,
      );
    } finally {
      if (!controller.signal.aborted) setGenerating(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col pb-36 lg:min-h-[calc(100vh-8rem)] lg:pb-0">
      <PageHeader title="AI 助手" backHref="/dashboard" />

      <QuotaBadge refreshKey={quotaVersion} onQuota={(q) => setQuotaRemaining(q.remaining)} />

      {/* 消息流 */}
      <div className="flex-1 space-y-4">
        {messages.length === 0 && !draft && (
          <div className="py-10 text-center">
            <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-2xl">
              🎱
            </span>
            <p className="mb-1 text-[17px] font-semibold text-slate-900">店里的事，直接说</p>
            <p className="mb-6 text-sm text-slate-500">
              文案、活动、话术、经营问题都能聊。我了解你的门店资料和台球行业的门道。
            </p>
            <div className="flex flex-col items-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-full border border-slate-200 bg-white px-4 py-2.5 text-[14px] text-slate-700 active:bg-slate-50 active:scale-[0.98] transition-all"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m, i) =>
          m.role === "user" ? (
            <div key={i} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand-600 px-4 py-2.5 text-[15px] leading-relaxed text-white">
                {m.content}
              </div>
            </div>
          ) : (
            <div key={i} className="flex flex-col items-start">
              <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3 shadow-sm">
                <div className="prose prose-sm max-w-none prose-slate prose-p:my-1.5 prose-headings:my-2">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                </div>
              </div>
              {!m.content.startsWith("⚠️") && (
                <div className="mt-1.5 pl-1">
                  <CopyButton text={m.content} />
                </div>
              )}
            </div>
          )
        )}

        {/* 流式中的回复 */}
        {draft && (
          <div className="flex">
            <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3 shadow-sm">
              <div className="prose prose-sm max-w-none prose-slate prose-p:my-1.5">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
              </div>
            </div>
          </div>
        )}
        {generating && !draft && (
          <div className="flex items-center gap-2 pl-1 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            正在想…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区:手机吸底,桌面贴底 */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-100 bg-white px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] lg:sticky lg:bottom-4 lg:mt-6 lg:rounded-2xl lg:border lg:border-slate-200 lg:p-3 lg:shadow-sm">
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder={quotaExhausted ? "本月额度已用完，联系您的服务商提升" : "店里的事,直接说…"}
            disabled={quotaExhausted}
            className="max-h-32 flex-1 resize-none rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-slate-50"
          />
          <button
            type="button"
            onClick={() => send(input)}
            disabled={generating || !input.trim() || quotaExhausted}
            aria-label="发送"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white active:scale-95 transition-transform disabled:opacity-40"
          >
            {generating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
          </button>
        </div>
        <p className="mx-auto mt-1.5 flex max-w-3xl items-center gap-1 text-[11px] text-slate-400">
          <Sparkles className="h-3 w-3" />
          回复会基于你的门店资料生成,可直接复制使用;每次对话计入生成次数
        </p>
      </div>
    </div>
  );
}
