"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  Send, Loader2, Sparkles, Check, CalendarDays, Lightbulb, PenLine,
  UserPlus, Stethoscope, Dices, Wrench, Menu, LayoutDashboard, LayoutGrid,
  FileText, ImageIcon, Clock, User, BookOpen, Scissors, Paperclip, X,
  ShieldCheck, FolderOpen, AlertTriangle,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/hooks/auth-context";
import { useDesktop } from "@/hooks/use-desktop";
import { Sheet } from "@/components/ui/sheet";
import { QuotaBadge } from "@/components/quota-badge";
import { CopyButton } from "@/components/generators/copy-button";
import { getErrorMessage } from "@/lib/utils";

/* AI 运营管家:对话式 Agent。老板说人话 → 管家自己规划、调用工具(写文案/约客/诊断/查今日推荐…)
 * → 交付成果,过程可见。背后是 /agent/chat 的 ReAct 循环,门店画像/店脑/合规/配额全生效。
 * 同一次会话的多轮由前端带 history 实现。 */

interface ToolStep {
  tool: string;
  args?: Record<string, unknown>;
  result?: string;
  done: boolean;
}

interface ApprovalState {
  tool: string;
  args: Record<string, unknown>;
  token?: string; // 审批提案签名，确认执行时回传校验（防篡改）
  status: "pending" | "done" | "cancelled";
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  steps?: ToolStep[]; // 该条回复过程中管家调用过的工具
  error?: boolean;
  approval?: ApprovalState; // 该条回复附带的"待确认动作"（如生图，花钱需点头）
}

/** 待确认动作的人话说明（生图等花钱/对外动作经审批闸先确认） */
function approvalLabel(tool: string): string {
  if (tool === "make_poster") return "生成一张海报（会用 1 张生图额度，可能要等几分钟）";
  return "执行这个操作";
}

const SUGGESTIONS = [
  "这周末搞个什么活动好？",
  "帮我写一条今晚的朋友圈",
  "给一位好久没来的老顾客写个约客消息",
  "最近生意有点冷清，帮我看看",
];

// 常用场景快捷入口：点一下弹 mini 表单填关键信息 → 组成需求喂给管家（管家再用精修模板写）。
// label 与场景目录里的中文名对齐，管家 find_scenario 能匹配到对应精修模板。
const QUICK_SCENARIOS: { label: string; hint: string; Icon: typeof PenLine }[] = [
  { label: "搞个活动", hint: "周末/节日/会员日", Icon: Sparkles },
  { label: "写朋友圈", hint: "今晚发什么", Icon: PenLine },
  { label: "发群公告", hint: "群里通知一声", Icon: FileText },
  { label: "约老客回流", hint: "好久没来的", Icon: UserPlus },
  { label: "经营诊断", hint: "生意问题把脉", Icon: Stethoscope },
  { label: "助教推广", hint: "突出特长引流", Icon: Lightbulb },
  { label: "强一比赛主持", hint: "赛事主持词", Icon: Dices },
  { label: "团购转私域", hint: "团购客加微信", Icon: Wrench },
];

// 管家是主界面：移动端顶栏菜单进其他功能（桌面端有侧栏，不用这个）
const NAV_ITEMS = [
  { href: "/dashboard", label: "今日", Icon: LayoutDashboard },
  { href: "/dashboard/workbench", label: "AI 工作台", Icon: LayoutGrid },
  { href: "/dashboard/report", label: "写日报", Icon: FileText },
  { href: "/dashboard/publish", label: "一键发布", Icon: Send },
  { href: "/dashboard/edit", label: "视频剪辑", Icon: Scissors },
  { href: "/dashboard/posters", label: "AI 生图", Icon: ImageIcon },
  { href: "/dashboard/history", label: "生成历史", Icon: Clock },
  { href: "/dashboard/store-settings", label: "门店设置", Icon: User },
  { href: "/dashboard/guide", label: "使用指南", Icon: BookOpen },
];

// 工具 → 给非技术店员看的友好标签 + 图标
const TOOL_META: Record<string, { label: string; Icon: typeof Wrench }> = {
  get_current_date: { label: "看了今天日期", Icon: CalendarDays },
  get_today_recommendation: { label: "看了今日推荐", Icon: Lightbulb },
  write_operation_content: { label: "写文案", Icon: PenLine },
  assistant_outreach: { label: "拟约客话术", Icon: UserPlus },
  diagnose_operation: { label: "做经营诊断", Icon: Stethoscope },
  recommend_games: { label: "想玩法", Icon: Dices },
  make_poster: { label: "做海报", Icon: ImageIcon },
  make_platform_content: { label: "写平台内容", Icon: Sparkles },
  make_groupbuy_content: { label: "写团购套餐", Icon: FileText },
};

function toolMeta(name: string) {
  return TOOL_META[name] || { label: name, Icon: Wrench };
}

// 交付类工具：结果本身就是给老板直接拿去用的成品(走了店脑/知识/护栏全管道、已校准过)，
// 必须原样展示，绝不让编排大脑改写/精简(那会让验证过的行业真实内容失真)。
// 感知类(查日期/今日推荐)不在此列——它们的值由大脑消化后综合作答。
const DELIVERABLE_TOOLS = new Set([
  "write_operation_content", "plan_activity", "assistant_outreach",
  "diagnose_operation", "recommend_games", "make_platform_content", "make_groupbuy_content",
]);

/** 把交付类工具的产出原样渲染成可复制卡片(成品，不经大脑改写) */
function DeliverableCards({ steps }: { steps: ToolStep[] }) {
  const cards = steps.filter((s) => s.result && DELIVERABLE_TOOLS.has(s.tool));
  if (cards.length === 0) return null;
  return (
    <div className="mb-2 flex w-full max-w-[92%] flex-col gap-2">
      {cards.map((s, i) => {
        const { label, Icon } = toolMeta(s.tool);
        return (
          <div key={i} className="rounded-2xl border border-slate-100 bg-white px-4 py-3 shadow-sm">
            <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-brand-600">
              <Icon className="h-3.5 w-3.5" /> {label}
            </p>
            <div className="prose prose-sm max-w-none prose-slate prose-p:my-1.5 prose-headings:my-2">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.result || ""}</ReactMarkdown>
            </div>
            <div className="mt-1.5">
              <CopyButton text={s.result || ""} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** 一组工具步骤的展示（进行中带转圈，完成打勾） */
function StepList({ steps, active }: { steps: ToolStep[]; active: boolean }) {
  if (steps.length === 0) return null;
  return (
    <div className="mb-2 rounded-2xl bg-slate-50 px-3 py-2.5">
      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-slate-500">
        <Wrench className="h-3.5 w-3.5" /> 管家干了这些活
      </p>
      <div className="flex flex-col gap-1.5">
        {steps.map((s, i) => {
          const { label, Icon } = toolMeta(s.tool);
          const running = active && !s.done && i === steps.length - 1;
          return (
            <div key={i} className="flex items-center gap-2 text-[13px] text-slate-600">
              <Icon className="h-3.5 w-3.5 shrink-0 text-brand-500" />
              <span>{label}</span>
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin text-slate-400" />
              ) : s.done ? (
                <Check className="h-3 w-3 text-emerald-500" />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ManagerPage() {
  const { isAuthenticated } = useAuth();
  const { isDesktop, electron } = useDesktop();
  // 桌面版:老板选定、授权 Agent 读/改的本地文件绝对路径（整轮会话有效，直到清除）
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  // 桌面版权限：ask(每次问)/auto_files(自动改文件)/full(全自动)；fullDisk=全盘范围。持久化到本地。
  const [permissionMode, setPermissionMode] = useState<"ask" | "auto_files" | "full">("ask");
  const [fullDisk, setFullDisk] = useState(false);
  const [permSheetOpen, setPermSheetOpen] = useState(false);
  // 常用场景 mini 表单
  const [scenarioOpen, setScenarioOpen] = useState<(typeof QUICK_SCENARIOS)[number] | null>(null);
  const [scAudience, setScAudience] = useState("");
  const [scTiming, setScTiming] = useState("");
  const [scOffer, setScOffer] = useState("");
  const [scNote, setScNote] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null); // 多轮续接：刷新不丢、后端按它查历史
  const [draft, setDraft] = useState(""); // 流式中的最终答复
  const [liveSteps, setLiveSteps] = useState<ToolStep[]>([]); // 本轮进行中的工具步骤
  const [input, setInput] = useState("");
  const [generating, setGenerating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [executingIdx, setExecutingIdx] = useState<number | null>(null); // 正在执行确认动作的消息下标
  const [quotaVersion, setQuotaVersion] = useState(0);
  const [quotaRemaining, setQuotaRemaining] = useState<number | null>(null);
  const quotaExhausted = quotaRemaining !== null && quotaRemaining <= 0;

  const bottomRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, draft, liveSteps.length]);

  useEffect(() => () => abortRef.current?.abort(), []);

  // 会话持久化(微信刷新/切出不丢历史)：按门店隔离存 localStorage
  const sessionKey = () => `agent_chat_session_${api.getStoreId() || "default"}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(sessionKey());
      if (raw) {
        const saved = JSON.parse(raw);
        if (Array.isArray(saved.messages) && saved.messages.length) setMessages(saved.messages);
        if (saved.conversationId) setConversationId(saved.conversationId);
      }
    } catch { /* localStorage 不可用时忽略 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    try {
      if (messages.length) localStorage.setItem(sessionKey(), JSON.stringify({ conversationId, messages }));
    } catch { /* 忽略 */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, conversationId]);

  // 开新对话：清空当前会话(历史已落库,可在生成历史查)
  const startNewChat = () => {
    if (generating) return;
    setMessages([]);
    setConversationId(null);
    setDraft("");
    setLiveSteps([]);
    try { localStorage.removeItem(sessionKey()); } catch { /* 忽略 */ }
  };

  const send = async (text: string) => {
    const msg = text.trim();
    if (!msg || generating || quotaExhausted || !isAuthenticated) return;

    // 同会话多轮：把已有对话作为 history 带上（只取 role+content）
    const history = messages
      .filter((m) => !m.error)
      .map((m) => ({ role: m.role, content: m.content }));

    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setInput("");
    setDraft("");
    setLiveSteps([]);
    setGenerating(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const steps: ToolStep[] = [];
    let finalText = "";
    let approval: ApprovalState | undefined;

    try {
      await api.streamAgent(
        {
          message: msg,
          history,
          conversation_id: conversationId,
          selected_files: selectedFiles.length ? selectedFiles : undefined,
          permission_mode: isDesktop ? permissionMode : undefined,
          full_disk_access: isDesktop && fullDisk ? true : undefined,
        },
        {
          onToken: (t) => setDraft((prev) => prev + t),
          onToolCall: (tool, args) => {
            steps.push({ tool, args, done: false });
            setLiveSteps([...steps]);
          },
          onToolResult: (_tool, content) => {
            const last = steps[steps.length - 1];
            if (last) {
              last.done = true;
              last.result = content;
            }
            setLiveSteps([...steps]);
          },
          onApprovalRequest: (tool, args, _id, token) => {
            approval = { tool, args, token, status: "pending" };
          },
          onFinal: (content) => {
            finalText = content;
          },
          onDone: (info) => {
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: finalText, steps: steps.length ? [...steps] : undefined, approval },
            ]);
            if (info?.conversation_id) setConversationId(info.conversation_id); // 存会话id,刷新可续接
            setDraft("");
            setLiveSteps([]);
            setQuotaVersion((v) => v + 1);
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
  };

  // 桌面权限设置：进页面读本地存的偏好
  useEffect(() => {
    try {
      const m = localStorage.getItem("agent_permission_mode");
      if (m === "ask" || m === "auto_files" || m === "full") setPermissionMode(m);
      setFullDisk(localStorage.getItem("agent_full_disk") === "1");
    } catch { /* 忽略 */ }
  }, []);
  const updateMode = (m: "ask" | "auto_files" | "full") => {
    setPermissionMode(m);
    try { localStorage.setItem("agent_permission_mode", m); } catch { /* 忽略 */ }
  };
  const updateFullDisk = (v: boolean) => {
    setFullDisk(v);
    try { localStorage.setItem("agent_full_disk", v ? "1" : "0"); } catch { /* 忽略 */ }
  };

  // 桌面版：选本地文件/文件夹交给 AI（授权它读/改，如"把这份报表的3月营业额改成…"）
  const pickFiles = async () => {
    if (!electron) return;
    try {
      const r = await electron.files.pick({ multi: true });
      if (!r.canceled && r.paths.length) {
        setSelectedFiles((prev) => Array.from(new Set([...prev, ...r.paths])));
      }
    } catch { /* 取消/失败忽略 */ }
  };
  const pickFolder = async () => {
    if (!electron) return;
    try {
      const r = await electron.files.pick({ directory: true });
      if (!r.canceled && r.paths.length) {
        setSelectedFiles((prev) => Array.from(new Set([...prev, ...r.paths])));
      }
    } catch { /* 取消/失败忽略 */ }
  };
  const removeFile = (p: string) => setSelectedFiles((prev) => prev.filter((x) => x !== p));
  const baseName = (p: string) => p.split(/[\\/]/).pop() || p;
  const PERM_LABEL: Record<string, string> = { ask: "谨慎", auto_files: "自动改文件", full: "全自动" };

  // 主动出击：管家据今日推荐，预生成几条草稿给老板过目（只产草稿、不自动发）
  const [preparing, setPreparing] = useState(false);
  const prepareToday = async () => {
    if (preparing || generating || quotaExhausted) return;
    setPreparing(true);
    try {
      const { drafts } = await api.dailyDrafts();
      if (!drafts.length) {
        setMessages((p) => [
          ...p,
          { role: "assistant", content: "今天暂时没有需要提前备的草稿——有想做的直接跟我说就行。" },
        ]);
      } else {
        setMessages((p) => [
          ...p,
          { role: "assistant", content: `我看了下今天，先给你备了 ${drafts.length} 条草稿，你过目、要改告诉我：` },
          ...drafts.map((d) => ({ role: "assistant" as const, content: `**${d.title}**\n\n${d.content}` })),
        ]);
      }
      setQuotaVersion((v) => v + 1);
    } catch (e) {
      setMessages((p) => [...p, { role: "assistant", content: `⚠️ ${getErrorMessage(e)}`, error: true }]);
    } finally {
      setPreparing(false);
    }
  };

  // 常用场景：点开 mini 表单 / 填完组成需求发给管家
  const openScenario = (s: (typeof QUICK_SCENARIOS)[number]) => {
    setScAudience(""); setScTiming(""); setScOffer(""); setScNote("");
    setScenarioOpen(s);
  };
  const submitScenario = () => {
    if (!scenarioOpen) return;
    const parts = [`帮我写「${scenarioOpen.label}」`];
    if (scAudience.trim()) parts.push(`面向${scAudience.trim()}`);
    if (scTiming.trim()) parts.push(scTiming.trim());
    if (scOffer.trim()) parts.push(`优惠：${scOffer.trim()}`);
    let msg = parts.join("，");
    if (scNote.trim()) msg += `。${scNote.trim()}`;
    setScenarioOpen(null);
    void send(msg);
  };

  // 用户点"确认生成"→ 经 /agent/execute 真正执行该工具（生图慢，可能等几分钟）
  const confirmApproval = async (idx: number, ap: ApprovalState) => {
    setExecutingIdx(idx);
    try {
      const res = await api.executeAgentTool(
        ap.tool,
        ap.args,
        selectedFiles.length ? selectedFiles : undefined,
        isDesktop && fullDisk ? true : undefined,
        ap.token,
      );
      setMessages((prev) =>
        prev.map((m, j) => (j === idx && m.approval ? { ...m, approval: { ...m.approval, status: "done" } } : m)),
      );
      setMessages((prev) => [...prev, { role: "assistant", content: res.result }]);
      setQuotaVersion((v) => v + 1);
    } catch (e) {
      setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ ${getErrorMessage(e)}`, error: true }]);
    } finally {
      setExecutingIdx(null);
    }
  };

  const cancelApproval = (idx: number) => {
    setMessages((prev) =>
      prev.map((m, j) => (j === idx && m.approval ? { ...m, approval: { ...m.approval, status: "cancelled" } } : m)),
    );
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col pb-36 lg:min-h-[calc(100vh-8rem)] lg:pb-0">
      {/* 主页式顶栏（移动端）：管家是主界面，左侧是菜单进其他功能，不再是"返回" */}
      <div className="sticky top-0 z-30 -mx-4 mb-4 flex h-12 items-center border-b border-slate-100 bg-white/95 px-1 backdrop-blur-sm sm:-mx-6 lg:hidden">
        <button
          type="button"
          onClick={() => setMenuOpen(true)}
          aria-label="功能菜单"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-slate-600 active:bg-slate-100"
        >
          <Menu className="h-6 w-6" />
        </button>
        <p className="absolute left-1/2 max-w-[60%] -translate-x-1/2 truncate text-center text-base font-semibold text-slate-900">
          AI 运营管家
        </p>
        {messages.length > 0 && (
          <button
            type="button"
            onClick={startNewChat}
            className="ml-auto shrink-0 rounded-full px-3 py-1.5 text-[13px] font-medium text-brand-600 active:bg-brand-50"
          >
            新对话
          </button>
        )}
      </div>

      <Sheet open={menuOpen} onClose={() => setMenuOpen(false)} title="更多功能">
        <div className="grid grid-cols-3 gap-3 pb-3">
          {NAV_ITEMS.map(({ href, label, Icon }) => (
            <Link
              key={href}
              href={href}
              onClick={() => setMenuOpen(false)}
              className="flex flex-col items-center gap-2 rounded-2xl bg-slate-100 px-3 py-4 transition-transform active:scale-[0.97]"
            >
              <Icon className="h-6 w-6 text-slate-700" />
              <span className="text-center text-[13px] text-slate-700">{label}</span>
            </Link>
          ))}
        </div>
      </Sheet>

      {/* 桌面版：AI 权限与文件授权 */}
      <Sheet open={permSheetOpen} onClose={() => setPermSheetOpen(false)} title="AI 权限与文件">
        <div className="space-y-5 pb-3">
          {/* 选文件/文件夹交给 AI */}
          <div>
            <p className="mb-2 text-[13px] font-medium text-slate-700">让 AI 处理本机文件</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={pickFiles}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#F2F2F7] py-2.5 text-[14px] text-slate-700 active:scale-[0.98]"
              >
                <Paperclip className="h-4 w-4" /> 选文件
              </button>
              <button
                type="button"
                onClick={pickFolder}
                className="flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-[#F2F2F7] py-2.5 text-[14px] text-slate-700 active:scale-[0.98]"
              >
                <FolderOpen className="h-4 w-4" /> 选文件夹
              </button>
            </div>
            <p className="mt-1.5 text-[12px] text-slate-400">选中的文件/文件夹，AI 才被授权读和改它们。</p>
          </div>

          {/* 权限模式 */}
          <div>
            <p className="mb-2 text-[13px] font-medium text-slate-700">改文件时怎么确认</p>
            <div className="space-y-2">
              {([
                { v: "ask", t: "谨慎（推荐）", d: "每次改文件/做海报都先弹给你确认，最稳。" },
                { v: "auto_files", t: "自动改文件", d: "改本机文件不再每次问、直接动手（仍自动备份，可回滚）；做海报等花钱的仍会问。" },
                { v: "full", t: "全自动", d: "所有动作（含做海报等花钱/对外）都不再问、直接执行。省事但要你完全信任它。" },
              ] as const).map((o) => (
                <button
                  key={o.v}
                  type="button"
                  onClick={() => updateMode(o.v)}
                  className={`w-full rounded-xl border p-3 text-left transition ${
                    permissionMode === o.v ? "border-brand-300 bg-brand-50" : "border-slate-200 bg-white"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-[14px] font-medium text-slate-800">{o.t}</span>
                    {permissionMode === o.v && <Check className="h-4 w-4 text-brand-600" />}
                  </div>
                  <p className="mt-0.5 text-[12px] leading-relaxed text-slate-500">{o.d}</p>
                </button>
              ))}
            </div>
          </div>

          {/* 全盘范围（高级·带警告） */}
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
            <button
              type="button"
              onClick={() => updateFullDisk(!fullDisk)}
              className="flex w-full items-start gap-2 text-left"
            >
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div className="flex-1">
                <div className="flex items-center justify-between">
                  <span className="text-[14px] font-medium text-amber-900">全盘访问（高级）</span>
                  <span
                    className={`ml-2 flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 transition ${
                      fullDisk ? "justify-end bg-amber-500" : "justify-start bg-slate-300"
                    }`}
                  >
                    <span className="h-4 w-4 rounded-full bg-white" />
                  </span>
                </div>
                <p className="mt-0.5 text-[12px] leading-relaxed text-amber-700">
                  开启后 AI 不再限于你选定的文件，可碰电脑上任意文件。功能更强，但误改风险也更大——
                  确定信任再开。关着时只动你选的文件/文件夹，最安全。
                </p>
              </div>
            </button>
          </div>
        </div>
      </Sheet>

      {/* 常用场景 mini 表单：填几个空 → 组成需求发给管家（管家用精修模板写） */}
      <Sheet open={!!scenarioOpen} onClose={() => setScenarioOpen(null)} title={scenarioOpen?.label ?? ""}>
        {scenarioOpen && (
          <div className="space-y-3 pb-3">
            <p className="text-[13px] text-slate-500">填几个空（都能不填），管家用校准过的模板帮你写，省得自己想怎么开口。</p>
            <input
              value={scAudience}
              onChange={(e) => setScAudience(e.target.value)}
              placeholder="面向谁？如 上班族 / 学生 / 情侣（可不填）"
              className="w-full rounded-xl bg-[#F2F2F7] px-4 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <input
              value={scTiming}
              onChange={(e) => setScTiming(e.target.value)}
              placeholder="什么时间 / 场次？如 周五晚 / 整个 7 月（可不填）"
              className="w-full rounded-xl bg-[#F2F2F7] px-4 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <input
              value={scOffer}
              onChange={(e) => setScOffer(e.target.value)}
              placeholder="有什么优惠 / 力度？如 双人立减 30（可不填）"
              className="w-full rounded-xl bg-[#F2F2F7] px-4 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <textarea
              value={scNote}
              onChange={(e) => setScNote(e.target.value)}
              rows={2}
              placeholder="还有什么要补充的？（可不填）"
              className="w-full resize-none rounded-xl bg-[#F2F2F7] px-4 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
            />
            <button
              type="button"
              onClick={submitScenario}
              className="w-full rounded-xl bg-brand-600 py-3 text-[15px] font-medium text-white transition-transform active:scale-[0.98]"
            >
              让管家写
            </button>
          </div>
        )}
      </Sheet>

      <QuotaBadge refreshKey={quotaVersion} onQuota={(q) => setQuotaRemaining(q.remaining)} />

      {/* 消息流 */}
      <div className="flex-1 space-y-4">
        {messages.length === 0 && !draft && liveSteps.length === 0 && (
          <div className="py-10 text-center">
            <span className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-brand-50 text-2xl">
              🎱
            </span>
            <p className="mb-1 text-[17px] font-semibold text-slate-900">店里的事，交给管家</p>
            <p className="mb-5 text-sm text-slate-500">
              说一句你想干啥，我自己安排：写文案、约客、出活动主意、看经营问题。我懂你这家店。
            </p>

            {/* 主动出击：让管家先把今天该做的备成草稿 */}
            <button
              type="button"
              onClick={prepareToday}
              disabled={preparing || generating || quotaExhausted}
              className="mx-auto mb-6 flex items-center gap-2 rounded-xl bg-brand-600 px-5 py-2.5 text-[15px] font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-50"
            >
              {preparing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
              {preparing ? "正在帮你备…" : "帮我备好今天的"}
            </button>

            {/* 常用场景：点一下填几个空，管家用精修模板写（不知道怎么开口时用这个） */}
            <div className="mx-auto mb-6 grid max-w-md grid-cols-2 gap-2 sm:grid-cols-4">
              {QUICK_SCENARIOS.map((s) => (
                <button
                  key={s.label}
                  type="button"
                  onClick={() => openScenario(s)}
                  className="flex flex-col items-center gap-1.5 rounded-2xl bg-white p-3 ring-1 ring-slate-100 transition-all active:scale-[0.97]"
                >
                  <s.Icon className="h-5 w-5 text-brand-600" />
                  <span className="text-[13px] font-medium text-slate-800">{s.label}</span>
                  <span className="text-[11px] leading-tight text-slate-400">{s.hint}</span>
                </button>
              ))}
            </div>

            <p className="mb-2 text-[12px] text-slate-400">或者直接说一句：</p>
            <div className="flex flex-col items-center gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => send(s)}
                  className="rounded-full bg-slate-100 px-4 py-2.5 text-[14px] text-slate-700 transition-all active:scale-[0.98] active:bg-slate-50"
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
              {m.steps && <StepList steps={m.steps} active={false} />}
              {m.steps && <DeliverableCards steps={m.steps} />}
              {m.content.trim() && (
                <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-white px-4 py-3">
                  <div className="prose prose-sm max-w-none prose-slate prose-p:my-1.5 prose-headings:my-2">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                </div>
              )}
              {/* 纯对话(无交付卡片)时才在底部给一个复制；交付卡片各自带复制按钮 */}
              {!m.error && m.content.trim() &&
                !m.steps?.some((s) => s.result && DELIVERABLE_TOOLS.has(s.tool)) && (
                <div className="mt-1.5 flex items-center gap-3 pl-1">
                  <CopyButton text={m.content} />
                </div>
              )}
              {m.approval?.status === "pending" && (
                <div className="mt-2 w-full max-w-[92%] rounded-2xl border border-brand-200 bg-brand-50 px-4 py-3">
                  <p className="mb-2 text-[13px] text-slate-600">这一步会{approvalLabel(m.approval.tool)}，确认吗？</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => confirmApproval(i, m.approval!)}
                      disabled={executingIdx === i}
                      className="inline-flex h-9 items-center gap-1.5 rounded-xl bg-brand-600 px-4 text-sm font-medium text-white transition-transform active:scale-[0.98] disabled:opacity-50"
                    >
                      {executingIdx === i ? (
                        <>
                          <Loader2 className="h-4 w-4 animate-spin" /> 生成中…
                        </>
                      ) : (
                        "确认生成"
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => cancelApproval(i)}
                      disabled={executingIdx === i}
                      className="inline-flex h-9 items-center rounded-xl px-3 text-sm text-slate-500 transition-transform active:scale-[0.98] disabled:opacity-50"
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
              {m.approval?.status === "cancelled" && (
                <p className="mt-1.5 pl-1 text-xs text-slate-400">已取消</p>
              )}
            </div>
          ),
        )}

        {/* 流式中：先显示工具进度，再显示正在流的答复 */}
        {(liveSteps.length > 0 || draft) && (
          <div className="flex flex-col items-start">
            {liveSteps.length > 0 && <StepList steps={liveSteps} active={generating} />}
            {liveSteps.length > 0 && <DeliverableCards steps={liveSteps} />}
            {draft && (
              <div className="max-w-[92%] rounded-2xl rounded-bl-md bg-white px-4 py-3">
                <div className="prose prose-sm max-w-none prose-slate prose-p:my-1.5">
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
                </div>
              </div>
            )}
          </div>
        )}

        {generating && !draft && liveSteps.length === 0 && (
          <div className="flex items-center gap-2 pl-1 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" />
            管家正在琢磨…
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* 输入区:手机吸底,桌面贴底 */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-100 bg-white px-3 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] lg:sticky lg:bottom-4 lg:mt-6 lg:rounded-2xl lg:border lg:border-slate-200 lg:p-3 lg:shadow-sm">
        {/* 桌面版:已选定、授权 AI 读/改的本地文件（以 chip 展示，可移除） */}
        {isDesktop && selectedFiles.length > 0 && (
          <div className="mx-auto mb-2 flex max-w-3xl flex-wrap items-center gap-1.5">
            {selectedFiles.map((p) => (
              <span
                key={p}
                title={p}
                className="inline-flex items-center gap-1 rounded-lg bg-brand-50 py-1 pl-2 pr-1 text-[12px] text-brand-700"
              >
                <FileText className="h-3.5 w-3.5 shrink-0" />
                <span className="max-w-[160px] truncate">{baseName(p)}</span>
                <button
                  type="button"
                  onClick={() => removeFile(p)}
                  aria-label="移除文件"
                  className="flex h-4 w-4 items-center justify-center rounded text-brand-500 hover:bg-brand-100"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="mx-auto flex max-w-3xl items-end gap-2">
          {isDesktop && (
            <button
              type="button"
              onClick={pickFiles}
              disabled={quotaExhausted}
              aria-label="选文件给 AI 处理"
              title="选本机文件交给 AI 读/改（如报表）"
              className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-[#F2F2F7] text-slate-500 transition-transform active:scale-95 disabled:opacity-40"
            >
              <Paperclip className="h-5 w-5" />
            </button>
          )}
          {isDesktop && (
            <button
              type="button"
              onClick={() => setPermSheetOpen(true)}
              aria-label="权限设置"
              title={`AI 权限：${PERM_LABEL[permissionMode]}${fullDisk ? " · 全盘" : ""}`}
              className={`flex h-11 shrink-0 items-center gap-1 rounded-xl px-2.5 text-[12px] transition-transform active:scale-95 ${
                permissionMode === "full" || fullDisk
                  ? "bg-amber-50 text-amber-600"
                  : permissionMode === "auto_files"
                    ? "bg-brand-50 text-brand-600"
                    : "bg-[#F2F2F7] text-slate-500"
              }`}
            >
              <ShieldCheck className="h-4 w-4" />
              <span className="hidden sm:inline">{PERM_LABEL[permissionMode]}</span>
            </button>
          )}
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              const isTouch =
                typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches;
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && !isTouch) {
                e.preventDefault();
                send(input);
              }
            }}
            rows={1}
            placeholder={quotaExhausted ? "本月额度已用完，联系您的服务商提升" : "说说你想干啥…"}
            disabled={quotaExhausted}
            className="max-h-32 flex-1 resize-none rounded-xl bg-[#F2F2F7] px-4 py-2.5 text-[15px] text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/20 disabled:bg-slate-50"
          />
          <button
            type="button"
            onClick={() => send(input)}
            disabled={generating || !input.trim() || quotaExhausted}
            aria-label="发送"
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-600 text-white transition-transform active:scale-95 disabled:opacity-40"
          >
            {generating ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
          </button>
        </div>
        <p className="mx-auto mt-1.5 flex max-w-3xl items-center gap-1 text-[11px] text-slate-400">
          <Sparkles className="h-3 w-3" />
          管家会用你的门店资料办事，结果可直接复制；生成内容计入次数
        </p>
      </div>
    </div>
  );
}
