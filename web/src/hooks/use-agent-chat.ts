"use client";

/**
 * Agent 对话的共享逻辑 hook（桌面壳用；手机页暂保留自己的内联逻辑，零风险隔离）。
 * 一比一复刻 chat/page.tsx 的 send / confirmApproval / cancelApproval：
 * - 同会话多轮带 history（最近 12 条、每条截 2000 字，后端再封顶一次）
 * - onToolResult **按 id 回填**对应步骤（防审批占位结果覆盖成品卡）
 * - 审批走 /agent/execute，确认后回灌结果 + 可能的续接审批卡
 * 调用同一个平台无关管道 api.streamAgent / api.executeAgentTool。
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { api, type ApprovalReason } from "@/lib/api";
import { getErrorMessage, humanizeErrorText } from "@/lib/utils";

export type { ApprovalReason };

export interface ToolStep {
  tool: string;
  args?: Record<string, unknown>;
  result?: string;
  id?: string; // tool_call_id：按它回填 tool_result 到对应步骤
  knowledgeUsed?: string[]; // B-2「依据可见」：本次注入的知识【大白话name】，成品卡显示"依据：…"
  progress?: string; // 命令边跑边显示：工具执行中实时累进的输出（run_command 终端块据此实时渲染）
  done: boolean;
}

export interface GeneratedImageArtifact {
  imageUrl: string;
  title?: string;
  ratio?: string;
  width?: number;
  height?: number;
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
  reasoning?: string; // F.1：本轮模型的思考过程（reasoning_content），灰斜体可折叠展示，默认收起
  memoryRefs?: string[]; // 本轮回答引用的门店资料摘要，给用户可见可改
  steps?: ToolStep[];
  approval?: ApprovalState;
  question?: QuestionData; // AskUserQuestion：管家给老板的选项，老板点选后作为下一句消息发回
  kind?: "command" | "video"; // 审批通过后执行的结果渲染方式：run_command→终端块；generate_video→<video> 播放器
  error?: boolean;
  generationId?: string; // P1-4 效果反馈：本轮成品对应的 generation id，成品卡 👍 据此写 effect_rating="good"
}

export type PermissionMode = "ask" | "auto_files" | "full" | "plan";

export interface AgentChatOptions {
  permissionMode: PermissionMode;
  selectedFiles?: string[];
  fullDisk?: boolean;
  knowledgePacks?: string[]; // @ 挂载的知识库（如 ["billiards"]）：挂上=领域专家，不挂=通用 Agent
  outputStyle?: string; // 输出风格名（explanatory/concise…），空=默认
  goal?: string; // /goal 目标驱动：本次会话目标条件
  deepThinking?: boolean; // F.2 深度思考开关：true=开/false=关/undefined=跟随模型默认
  workingDir?: string | null; // 本会话工作目录(选/新建的文件夹)
  onGeneratedImage?: (item: GeneratedImageArtifact) => void;
}

const IMAGE_TOOLS = new Set(["make_poster", "generate_image"]);
const ACTIVE_TASK_STORAGE_KEY = "agent_active_task";

function imageArtifactFromToolResult(tool: string, content: string): GeneratedImageArtifact | null {
  if (!IMAGE_TOOLS.has(tool) || !content) return null;
  const md = content.match(/!\[([^\]]*)\]\(([^)\s]+)\)/);
  const imageUrl = md?.[2] || content.match(/(https?:\/\/[^\s)"']+\.(?:png|jpg|jpeg|webp|gif)|\/uploads\/[^\s)"']+\.(?:png|jpg|jpeg|webp|gif)|[^\s)"']+\.(?:png|jpg|jpeg|webp|gif))/i)?.[1];
  if (!imageUrl) return null;
  const ratio = content.match(/(?:尺寸|比例)：\s*([0-9]+:[0-9]+)/)?.[1];
  const dims = content.match(/([0-9]{2,5})x([0-9]{2,5})/i);
  return {
    imageUrl,
    title: md?.[1] || (tool === "make_poster" ? "海报预览" : "图片预览"),
    ratio,
    width: dims ? Number(dims[1]) : undefined,
    height: dims ? Number(dims[2]) : undefined,
  };
}

export function useAgentChat(opts: AgentChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [reasoningDraft, setReasoningDraft] = useState(""); // F.1：当前轮的实时思考流（答案落定后并进消息）
  const [liveSteps, setLiveSteps] = useState<ToolStep[]>([]);
  const [generating, setGenerating] = useState(false);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [executingIdx, setExecutingIdx] = useState<number | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activeTaskRef = useRef<string | null>(null);
  // 方向盘：活跃任务 id 的**响应式**镜像（ref 变了不触发渲染，输入框"运行中可插话"的启停要靠 state）。
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // 本窗口刚发出的插话（乐观上屏了）：steering 事件回流时据此去重——匹配到就跳过（屏上已有那条），
  // 匹配不到（页面刷新后重放）才把插话补回对话流。
  const pendingSteerEchoRef = useRef<string[]>([]);
  const lastOffsetRef = useRef(-1);
  const lastUserMsgRef = useRef<string | null>(null);
  const stopNoticeTaskRef = useRef<string | null>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const conversationIdRef = useRef(conversationId);
  conversationIdRef.current = conversationId;

  // 让异步回调里始终读到最新的 opts（权限/选定文件），而不是闭包里的旧值
  const optsRef = useRef(opts);
  optsRef.current = opts;

  // ref + state 同步更新（ref 给异步回调读最新值，state 给 UI 响应）。
  const setActiveTask = useCallback((id: string | null) => {
    activeTaskRef.current = id;
    setActiveTaskId(id);
  }, []);

  const pushStopNotice = useCallback((taskId: string | null) => {
    if (taskId && stopNoticeTaskRef.current === taskId) return;
    stopNoticeTaskRef.current = taskId || "__manual__";
    setMessages((prev) => [...prev, { role: "assistant", content: "已停止这次任务。需要继续的话，可以直接重新说要做什么。" }]);
  }, []);

  const clearActiveTaskSnapshot = useCallback(() => {
    try { sessionStorage.removeItem(ACTIVE_TASK_STORAGE_KEY); } catch { /* 忽略 */ }
  }, []);

  const saveActiveTaskSnapshot = useCallback((data: { taskId: string; userMessage: string; offset?: number; conversationId?: string | null }) => {
    try {
      sessionStorage.setItem(ACTIVE_TASK_STORAGE_KEY, JSON.stringify({
        task_id: data.taskId,
        user_message: data.userMessage,
        offset: typeof data.offset === "number" ? data.offset : -1,
        conversation_id: data.conversationId || conversationIdRef.current || null,
      }));
    } catch { /* 忽略 */ }
  }, []);

  const subscribeToTask = useCallback(async (taskId: string, userMessage: string, after = -1, controller?: AbortController, recovered = false) => {
    const ctrl = controller || new AbortController();
    abortRef.current = ctrl;
    setActiveTask(taskId);
    lastOffsetRef.current = after;
    setGenerating(true);

    const steps: ToolStep[] = [];
    let finalText = "";
    let reasoningText = "";
    let approval: ApprovalState | undefined;
    let question: QuestionData | undefined;

    try {
      if (recovered) {
        setDraft("正在接回刚才没完成的任务…");
      }
      await api.subscribeAgentTask(
        taskId,
        {
          onEvent: (ev) => {
            const off = typeof ev.offset === "number" ? ev.offset : undefined;
            if (off !== undefined) {
              lastOffsetRef.current = Math.max(lastOffsetRef.current, off);
              saveActiveTaskSnapshot({ taskId, userMessage, offset: lastOffsetRef.current });
            }
          },
          onToken: (t) => setDraft((prev) => (recovered && prev === "正在接回刚才没完成的任务…" ? "" : prev) + t),
          onReasoning: (c) => { reasoningText += c; setReasoningDraft((prev) => prev + c); },
          onToolCall: (tool, args, id) => {
            steps.push({ tool, args, id, done: false });
            setLiveSteps([...steps]);
          },
          onToolProgress: (_tool, id, chunk) => {
            const st = id ? steps.find((s) => s.id === id) : steps[steps.length - 1];
            if (st) {
              st.progress = (st.progress || "") + chunk;
              setLiveSteps([...steps]);
            }
          },
          onToolResult: (_tool, content, id, knowledgeUsed) => {
            const st = id ? steps.find((s) => s.id === id) : steps[steps.length - 1];
            if (st) {
              st.done = true;
              st.result = content;
              if (knowledgeUsed && knowledgeUsed.length) st.knowledgeUsed = knowledgeUsed;
              setLiveSteps([...steps]);
            }
            const image = imageArtifactFromToolResult(_tool, content);
            if (image) optsRef.current.onGeneratedImage?.(image);
          },
          onApprovalRequest: (tool, args, _id, token, preview, reason) => {
            approval = { tool, args, token, preview, reason, status: "pending" };
          },
          onAskQuestion: (q) => {
            question = { question: q.question, options: q.options, multi: q.multi };
          },
          // 方向盘：后端确认插话已注入。本窗口刚发的（乐观上屏过）→ 去重跳过；
          // 刷新恢复重放时本地没这条 → 补回对话流，插话不因刷新而消失。
          onSteering: (content) => {
            const pend = pendingSteerEchoRef.current;
            const i = pend.indexOf(content);
            if (i >= 0) { pend.splice(i, 1); return; }
            setMessages((prev) => [...prev, { role: "user", content }]);
          },
          onFinal: (content) => {
            finalText = content;
          },
          onDone: (info) => {
            if (info.stopped_reason === "cancelled") {
              pushStopNotice(info.task_id || taskId);
            } else if (info.stopped_reason !== "error") {
              setMessages((prev) => [
                ...prev,
                { role: "assistant", content: finalText, reasoning: reasoningText || undefined,
                  steps: steps.length ? [...steps] : undefined, approval, question, memoryRefs: info.memory_refs,
                  generationId: info.generation_id },
              ]);
            }
            if (info?.conversation_id) setConversationId(info.conversation_id);
            setActiveTask(null);
            clearActiveTaskSnapshot();
            setDraft("");
            setReasoningDraft("");
            setLiveSteps([]);
          },
          onError: (m) => {
            if (ctrl.signal.aborted) return;
            const salvaged = steps.length > 0 || !!approval || !!question || !!finalText.trim();
            setMessages((prev) => {
              const next: ChatMessage[] = [...prev];
              if (salvaged) {
                next.push({
                  role: "assistant",
                  content: finalText,
                  reasoning: reasoningText || undefined,
                  steps: steps.length ? [...steps] : undefined,
                  approval,
                  question,
                });
              }
              next.push({ role: "assistant", content: `⚠️ ${humanizeErrorText(m)}`, error: true });
              return next;
            });
            setActiveTask(null);
            clearActiveTaskSnapshot();
            setDraft("");
            setReasoningDraft("");
            setLiveSteps([]);
          },
        },
        ctrl.signal,
        after,
      );
    } catch (e) {
      if (!ctrl.signal.aborted) {
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${getErrorMessage(e)}`, error: true }]);
        setActiveTask(null);
        clearActiveTaskSnapshot();
        setDraft("");
        setReasoningDraft("");
        setLiveSteps([]);
      }
    } finally {
      if (!ctrl.signal.aborted) setGenerating(false);
    }
  }, [clearActiveTaskSnapshot, pushStopNotice, saveActiveTaskSnapshot, setActiveTask]);

  useEffect(() => {
    let raw: string | null = null;
    try { raw = sessionStorage.getItem(ACTIVE_TASK_STORAGE_KEY); } catch { raw = null; }
    if (!raw) return;
    try {
      const data = JSON.parse(raw) as { task_id?: string; user_message?: string; offset?: number; conversation_id?: string | null };
      if (!data.task_id || !data.user_message) {
        clearActiveTaskSnapshot();
        return;
      }
      setMessages((prev) => prev.length ? prev : [{ role: "user", content: data.user_message || "继续刚才的任务" }]);
      if (data.conversation_id) setConversationId(data.conversation_id);
      setDraft("");
      setReasoningDraft("");
      setLiveSteps([]);
      const controller = new AbortController();
      // 页面刷新后本地 draft/steps 已经丢了，必须从头重放后端缓存事件来重建完整回答。
      // offset 只用于当前页面记录进度，不用于刷新恢复，否则可能只收到 done，落成空消息。
      void subscribeToTask(data.task_id, data.user_message, -1, controller, true);
      return () => controller.abort();
    } catch {
      clearActiveTaskSnapshot();
    }
  }, [clearActiveTaskSnapshot, subscribeToTask]);

  // 真正发起请求的内部路径：history 由调用方显式算好传入，不在这里再去读 messagesRef——
  // 这样 retry() 可以传自己裁剪过的 history，不会因为 messagesRef 还没跟上刚发出的 setMessages 而带出脏数据。
  const sendWithHistory = useCallback(async (
    message: string,
    history: { role: string; content: string }[],
    sourceRecId?: string,
    overrides?: { selectedFiles?: string[] },
  ) => {
    const o = optsRef.current;
    // 采纳信号只在推荐触发的首轮、且是新会话时带上（同会话续接不重复计采纳）。
    const recId = sourceRecId && !conversationId ? sourceRecId : undefined;
    setDraft("");
    setReasoningDraft("");
    setLiveSteps([]);
    setGenerating(true);
    const controller = new AbortController();
    abortRef.current = controller;
    setActiveTask(null);
    stopNoticeTaskRef.current = null;
    lastOffsetRef.current = -1;

    try {
      const payload = {
        message,
        history,
        conversation_id: conversationId,
        selected_files: overrides?.selectedFiles?.length
          ? overrides.selectedFiles
          : o.selectedFiles?.length ? o.selectedFiles : undefined,
        permission_mode: o.permissionMode,
        full_disk_access: o.fullDisk ? true : undefined,
        knowledge_packs: o.knowledgePacks?.length ? o.knowledgePacks : undefined,
        output_style: o.outputStyle || undefined,
        goal: o.goal || undefined,
        deep_thinking: o.deepThinking,
        source_rec_id: recId,
        working_dir: o.workingDir || undefined,
      };
      const task = await api.startAgentTask(payload);
      saveActiveTaskSnapshot({ taskId: task.task_id, userMessage: message, offset: -1, conversationId });
      await subscribeToTask(task.task_id, message, lastOffsetRef.current, controller);
    } catch (e) {
      if (!controller.signal.aborted) {
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${getErrorMessage(e)}`, error: true }]);
        setActiveTask(null);
        clearActiveTaskSnapshot();
        setDraft("");
        setReasoningDraft("");
        setLiveSteps([]);
      }
    } finally {
      if (!controller.signal.aborted) setGenerating(false);
    }
  }, [conversationId, clearActiveTaskSnapshot, saveActiveTaskSnapshot, subscribeToTask, setActiveTask]);

  const send = useCallback(async (text: string, sourceRecId?: string, overrides?: { selectedFiles?: string[] }) => {
    const msg = text.trim();
    if (!msg) return;
    // 方向盘：任务跑动中再打字 = 插话纠偏（不是新任务）。乐观上屏 + 排进该任务的插话队列，
    // AI 下一轮注入、当场改道；任务没在跑时行为不变（走下面的新任务路径）。
    if (generating) {
      const taskId = activeTaskRef.current;
      if (!taskId) return; // 在跑但没有可捎话的任务（如正在执行审批工具）→ 维持原来的"运行中不发"
      setMessages((prev) => [...prev, { role: "user", content: msg }]);
      pendingSteerEchoRef.current.push(msg);
      api.sendTaskMessage(taskId, msg).catch((e) => {
        // 没送进去（任务刚结束/队列满）：撤掉去重记录并提示；话还留在屏上，等任务停了直接重发即可。
        const i = pendingSteerEchoRef.current.indexOf(msg);
        if (i >= 0) pendingSteerEchoRef.current.splice(i, 1);
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${getErrorMessage(e)}`, error: true }]);
      });
      return;
    }
    // 用 messagesRef 读最新状态（这里读没问题：本次调用还没触发任何 setMessages，ref 与当前渲染的 messages 一致）。
    lastUserMsgRef.current = msg;
    const history = messagesRef.current
      .filter((m) => !m.error)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    // 副作用 sendWithHistory 绝不放进 setMessages 更新函数里——否则 React StrictMode 开发态会把 updater 跑两次→同一条消息双发请求。
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    void sendWithHistory(msg, history, sourceRecId, overrides);
  }, [generating, sendWithHistory]);

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
        o.knowledgePacks?.length ? o.knowledgePacks : undefined,
        o.workingDir || undefined,
      );
      setMessages((prev) =>
        prev.map((m, j) => (j === idx && m.approval ? { ...m, approval: { ...m.approval, status: "done" } } : m)),
      );
      setMessages((prev) => {
        // 跑命令的结果渲染成终端式块（命令+输出+退出码）；生视频结果渲染成 <video> 播放器；其它工具结果走普通文本。
        const first: ChatMessage =
          ap.tool === "run_command"
            ? { role: "assistant", content: res.result, kind: "command" }
            : ap.tool === "generate_video"
              ? { role: "assistant", content: res.result, kind: "video" }
              : { role: "assistant", content: res.result };
        const next: ChatMessage[] = [...prev, first];
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
    setReasoningDraft("");
    setLiveSteps([]);
    pendingSteerEchoRef.current = [];
  }, [generating]);

  const stop = useCallback(() => {
    const taskId = activeTaskRef.current;
    if (taskId) api.cancelAgentTask(taskId).catch(() => {});
    setActiveTask(null);
    clearActiveTaskSnapshot();
    abortRef.current?.abort();
    setGenerating(false);
    setDraft("");
    setReasoningDraft("");
    setLiveSteps([]);
    // 任务被掐掉后 steering 回声事件永远不会来了，清掉待回声队列防滞留
    pendingSteerEchoRef.current = [];
    pushStopNotice(taskId);
  }, [clearActiveTaskSnapshot, pushStopNotice, setActiveTask]);

  // 点开历史会话：加载其消息 + 设 conversationId（后续可在此基础上续接）
  const loadConversation = useCallback((id: string, msgs: ChatMessage[]) => {
    if (generating || activeTaskRef.current) {
      setMessages((prev) => [...prev, { role: "assistant", content: "当前任务还在跑，先别切换会话。等它完成后再打开历史记录；要停掉就点「中断」。" }]);
      return false;
    }
    abortRef.current?.abort();
    setActiveTask(null);
    clearActiveTaskSnapshot();
    setMessages(msgs);
    setConversationId(id);
    setDraft("");
    setReasoningDraft("");
    setLiveSteps([]);
    setGenerating(false);
    pendingSteerEchoRef.current = [];
    return true;
  }, [clearActiveTaskSnapshot, generating, setActiveTask]);

  // 往会话里塞一条本地 assistant 消息（如 /help 的说明），不走后端。
  const pushAssistantMessage = useCallback((content: string) => {
    setMessages((prev) => [...prev, { role: "assistant", content }]);
  }, []);

  const retry = useCallback(() => {
    const msg = lastUserMsgRef.current;
    if (!msg || generating) return;
    // 在这里同步读 messagesRef.current（还没调用任何 setMessages，值是新鲜的），自己算好裁剪后的 history 显式传下去——
    // 不能指望 sendWithHistory 内部再读 messagesRef：state 更新是异步的，此刻发出 setMessages 后 ref 要等下一次渲染才会跟上，
    // 届时读到的还是裁剪前的旧数组，history 末尾会带着刚裁掉的那条 user 消息，和重发的这条重复。
    const trimmed = [...messagesRef.current];
    while (trimmed.length && trimmed[trimmed.length - 1].role === "assistant") trimmed.pop();
    if (trimmed.length && trimmed[trimmed.length - 1].role === "user") trimmed.pop();
    const history = trimmed
      .filter((m) => !m.error)
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
    setMessages([...trimmed, { role: "user", content: msg }]);
    void sendWithHistory(msg, history);
  }, [generating, sendWithHistory]);

  // 方向盘：任务跑动中可插话（有活跃后台任务才行；审批执行等非任务态的 generating 不算）。
  // 输入框据此"运行中不再禁用"，send 自动走插话路径。
  const canSteer = generating && !!activeTaskId;

  return {
    messages, draft, reasoningDraft, liveSteps, generating, conversationId, executingIdx, canSteer,
    send, confirmApproval, cancelApproval, startNewChat, stop, loadConversation,
    pushAssistantMessage, retry,
  };
}
