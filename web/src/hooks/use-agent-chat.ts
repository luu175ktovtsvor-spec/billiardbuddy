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

import { api, type ApprovalReason } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";

export type { ApprovalReason };

export interface ToolStep {
  tool: string;
  args?: Record<string, unknown>;
  result?: string;
  id?: string; // tool_call_id：按它回填 tool_result 到对应步骤
  knowledgeUsed?: string[]; // B-2「依据可见」：本次注入的知识【大白话name】，成品卡显示"依据：…"
  done: boolean;
}

export interface ApprovalState {
  tool: string;
  args: Record<string, unknown>;
  token?: string;
  preview?: string;
  reason?: ApprovalReason; // SH-8：结构化理由 {what/why/impact}，审批卡据此列清"要做什么/为什么要你确认/影响"
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

    // 在 updater 外算好 history（读当前 messages），updater 只追加 user 气泡。
    // 副作用 runSend 绝不放进 setMessages 更新函数里——否则 React StrictMode 开发态会把 updater 跑两次→同一条消息双发请求。
    const history = messages
      .filter((m) => !m.error)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    void runSend(msg, history);

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
            onToolResult: (_tool, content, id, knowledgeUsed) => {
              // 按 id 定位回填——不能盲取末尾：审批工具先发占位结果，盲取会覆盖成品卡
              const st = id ? steps.find((s) => s.id === id) : steps[steps.length - 1];
              if (st) {
                st.done = true;
                st.result = content;
                if (knowledgeUsed && knowledgeUsed.length) st.knowledgeUsed = knowledgeUsed;
                setLiveSteps([...steps]);
              }
            },
            onApprovalRequest: (tool, args, _id, token, preview, reason) => {
              approval = { tool, args, token, preview, reason, status: "pending" };
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
              // 流在 done 前断开时，已攒到的 steps/审批/提问/正文不能直接丢——
              // 先把这些已生成内容落成一条正常 assistant 消息（成品卡/审批卡照常可用），再追加一条错误提示。
              const salvaged = steps.length > 0 || !!approval || !!question || !!finalText.trim();
              setMessages((prev) => {
                const next: ChatMessage[] = [...prev];
                if (salvaged) {
                  next.push({
                    role: "assistant",
                    content: finalText,
                    steps: steps.length ? [...steps] : undefined,
                    approval,
                    question,
                  });
                }
                next.push({ role: "assistant", content: `⚠️ ${m}`, error: true });
                return next;
              });
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
  }, [generating, conversationId, messages]);

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
              ? { tool: res.approval.tool, args: res.approval.args, token: res.approval.token, preview: res.approval.preview, reason: res.approval.reason, status: "pending" }
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

  const cancelApproval = useCallback((idx: number, ap?: ApprovalState) => {
    // SH-8：把"老板拒绝了这个动作"上报后端记一次 → 同一动作连拒到阈值，管家就不再反复提请、改走文本/换方案。
    // 故障安全（.catch 吞掉）、不阻断取消本身。
    if (ap?.tool) api.rejectAgentTool(ap.tool, ap.args, conversationId).catch(() => {});
    setMessages((prev) =>
      prev.map((m, j) => (j === idx && m.approval ? { ...m, approval: { ...m.approval, status: "cancelled" } } : m)),
    );
  }, [conversationId]);

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

  // 点开历史会话：加载其消息 + 设 conversationId（后续可在此基础上续接）
  const loadConversation = useCallback((id: string, msgs: ChatMessage[]) => {
    abortRef.current?.abort();
    setMessages(msgs);
    setConversationId(id);
    setDraft("");
    setLiveSteps([]);
    setGenerating(false);
  }, []);

  return {
    messages, draft, liveSteps, generating, conversationId, executingIdx,
    send, confirmApproval, cancelApproval, startNewChat, stop, loadConversation,
  };
}
