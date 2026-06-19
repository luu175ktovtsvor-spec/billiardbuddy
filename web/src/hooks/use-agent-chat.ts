"use client";

/**
 * Agent 对话的共享逻辑 hook（桌面壳用；手机页暂保留自己的内联逻辑，零风险隔离）。
 * 一比一复刻 chat/page.tsx 的 send / confirmApproval / cancelApproval：
 * - 同会话多轮带 history（最近 12 条、每条截 2000 字，后端再封顶一次）
 * - onToolResult **按 id 回填**对应步骤（防审批占位结果覆盖成品卡）
 * - 审批走 /agent/execute，确认后回灌结果 + 可能的续接审批卡
 * 调用同一个平台无关管道 api.streamAgent / api.executeAgentTool。
 */
import { useCallback, useRef, useState } from "react";

import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";

export interface ToolStep {
  tool: string;
  args?: Record<string, unknown>;
  result?: string;
  id?: string; // tool_call_id：按它回填 tool_result 到对应步骤
  done: boolean;
}

export interface ApprovalState {
  tool: string;
  args: Record<string, unknown>;
  token?: string;
  preview?: string;
  status: "pending" | "done" | "cancelled";
}

export interface QuestionData {
  question: string;
  options: { label: string; description?: string }[];
  multi?: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  steps?: ToolStep[];
  approval?: ApprovalState;
  question?: QuestionData; // AskUserQuestion：管家给老板的选项，老板点选后作为下一句消息发回
  error?: boolean;
}

export type PermissionMode = "ask" | "auto_files" | "full";

export interface AgentChatOptions {
  permissionMode: PermissionMode;
  selectedFiles?: string[];
  fullDisk?: boolean;
}

export function useAgentChat(opts: AgentChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [liveSteps, setLiveSteps] = useState<ToolStep[]>([]);
  const [generating, setGenerating] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [executingIdx, setExecutingIdx] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 让异步回调里始终读到最新的 opts（权限/选定文件），而不是闭包里的旧值
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const send = useCallback(async (text: string) => {
    const msg = text.trim();
    if (!msg || generating) return;
    const o = optsRef.current;

    setMessages((prev) => {
      const history = prev
        .filter((m) => !m.error)
        .slice(-12)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
      // 真正发送放在下面（用 prev 拿 history）——这里只追加 user 消息
      void runSend(msg, history);
      return [...prev, { role: "user", content: msg }];
    });

    async function runSend(message: string, history: { role: string; content: string }[]) {
      setDraft("");
      setLiveSteps([]);
      setGenerating(true);
      const controller = new AbortController();
      abortRef.current = controller;

      const steps: ToolStep[] = [];
      let finalText = "";
      let approval: ApprovalState | undefined;
      let question: QuestionData | undefined;

      try {
        await api.streamAgent(
          {
            message,
            history,
            conversation_id: conversationId,
            selected_files: o.selectedFiles?.length ? o.selectedFiles : undefined,
            permission_mode: o.permissionMode,
            full_disk_access: o.fullDisk ? true : undefined,
          },
          {
            onToken: (t) => setDraft((prev) => prev + t),
            onToolCall: (tool, args, id) => {
              steps.push({ tool, args, id, done: false });
              setLiveSteps([...steps]);
            },
            onToolResult: (_tool, content, id) => {
              // 按 id 定位回填——不能盲取末尾：审批工具先发占位结果，盲取会覆盖成品卡
              const st = id ? steps.find((s) => s.id === id) : steps[steps.length - 1];
              if (st) {
                st.done = true;
                st.result = content;
                setLiveSteps([...steps]);
              }
            },
            onApprovalRequest: (tool, args, _id, token, preview) => {
              approval = { tool, args, token, preview, status: "pending" };
            },
            onAskQuestion: (q) => {
              question = { question: q.question, options: q.options, multi: q.multi };
            },
            onFinal: (content) => {
              finalText = content;
            },
            onDone: (info) => {
              setMessages((prev) => [
                ...prev,
                { role: "assistant", content: finalText, steps: steps.length ? [...steps] : undefined, approval, question },
              ]);
              if (info?.conversation_id) setConversationId(info.conversation_id);
              setDraft("");
              setLiveSteps([]);
            },
            onError: (m) => {
              if (controller.signal.aborted) return;
              setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${m}`, error: true }]);
              setDraft("");
              setLiveSteps([]);
            },
          },
          controller.signal,
        );
      } finally {
        if (!controller.signal.aborted) setGenerating(false);
      }
    }
  }, [generating, conversationId]);

  const confirmApproval = useCallback(async (idx: number, ap: ApprovalState) => {
    const o = optsRef.current;
    setExecutingIdx(idx);
    try {
      const res = await api.executeAgentTool(
        ap.tool,
        ap.args,
        o.selectedFiles?.length ? o.selectedFiles : undefined,
        o.fullDisk ? true : undefined,
        ap.token,
        conversationId,
      );
      setMessages((prev) =>
        prev.map((m, j) => (j === idx && m.approval ? { ...m, approval: { ...m.approval, status: "done" } } : m)),
      );
      setMessages((prev) => {
        const next: ChatMessage[] = [...prev, { role: "assistant", content: res.result }];
        if (res.continuation && res.continuation.trim()) {
          next.push({
            role: "assistant",
            content: res.continuation,
            approval: res.approval
              ? { tool: res.approval.tool, args: res.approval.args, token: res.approval.token, preview: res.approval.preview, status: "pending" }
              : undefined,
          });
        }
        return next;
      });
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${getErrorMessage(e)}`, error: true }]);
    } finally {
      setExecutingIdx(null);
    }
  }, [conversationId]);

  const cancelApproval = useCallback((idx: number) => {
    setMessages((prev) =>
      prev.map((m, j) => (j === idx && m.approval ? { ...m, approval: { ...m.approval, status: "cancelled" } } : m)),
    );
  }, []);

  const startNewChat = useCallback(() => {
    if (generating) return;
    setMessages([]);
    setConversationId(null);
    setDraft("");
    setLiveSteps([]);
  }, [generating]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    setGenerating(false);
  }, []);

  return {
    messages, draft, liveSteps, generating, conversationId, executingIdx,
    send, confirmApproval, cancelApproval, startNewChat, stop,
  };
}
