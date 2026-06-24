"use client";

/**
 * Codex 风对话流（浅色默认 · 跟随系统深浅色）：用户输入(› 前导) / 工具步骤块 / 成品卡 / 内联审批 / 提问卡。
 * 纯展示组件，状态与逻辑由 useAgentChat 提供。
 */
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Check, Wrench, AlertTriangle, Send, Maximize2, BookOpen, Flag, Target, ShieldQuestion, FileEdit, Terminal, ChevronRight, Brain } from "lucide-react";

import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { CopyButton } from "@/components/generators/copy-button";
import { toolMeta, DELIVERABLE_TOOLS, INTERNAL_TOOLS, approvalLabel, approvalConfirmText } from "@/lib/agent-tools";
import type { ChatMessage, ToolStep, ApprovalState, QuestionData } from "@/hooks/use-agent-chat";
import type { PreviewItem } from "./preview-panel";
import { AgentSpinner } from "./agent-spinner";

const PROSE = "prose prose-sm prose-slate dark:prose-invert max-w-none leading-relaxed prose-p:my-1.5";

function posterUrl(content: string): string | null {
  const m = content.match(/!\[[^\]]*\]\(([^)\s]+)/);
  return m ? m[1] : null;
}

// G.3：从生图工具结果里稳健抓出图片地址——markdown 图片语法 ∪ 裸 URL ∪ 本机 /uploads 路径 ∪ 图片扩展名。
// 不再只认 markdown `![]()`，否则结果是纯路径/URL 时"说生成了图却看不到图"。
function extractImageUrl(text: string): string | null {
  if (!text) return null;
  const md = text.match(/!\[[^\]]*\]\(([^)\s]+)\)/);
  if (md) return md[1];
  const url = text.match(/(https?:\/\/[^\s)"']+\.(?:png|jpg|jpeg|webp|gif)|\/uploads\/[^\s)"']+\.(?:png|jpg|jpeg|webp|gif)|[^\s)"']+\.(?:png|jpg|jpeg|webp|gif))/i);
  return url ? url[1] : null;
}

const IMAGE_TOOLS = new Set(["make_poster", "generate_image"]);

/** 解析 run_command 的结果文本（后端固定格式：命令／返回码／【标准输出】／【错误输出】）。 */
function parseCommandResult(
  text: string,
): { command: string; exitCode: number | null; stdout: string; stderr: string } | null {
  if (!text.startsWith("命令：")) return null;
  const nl = text.indexOf("\n");
  const command = (nl === -1 ? text.slice(3) : text.slice(3, nl)).trim();
  const rc = text.match(/返回码：(-?\d+)/);
  const exitCode = rc ? parseInt(rc[1], 10) : null;
  const SO = "【标准输出】";
  const SE = "【错误输出】";
  const soIdx = text.indexOf(SO);
  const seIdx = text.indexOf(SE);
  let stdout = "";
  let stderr = "";
  if (soIdx !== -1) stdout = text.slice(soIdx + SO.length, seIdx !== -1 ? seIdx : undefined).trim();
  if (seIdx !== -1) stderr = text.slice(seIdx + SE.length).trim();
  return { command, exitCode, stdout, stderr };
}

/** 终端式命令块：完整命令 + stdout/stderr + 退出码（对标 Claude Code 的 Bash 展示）。 */
function TerminalBlock({ text }: { text: string }) {
  const p = parseCommandResult(text);
  if (!p) {
    // 非标准格式（拒绝执行／需开启完全访问等提示）：当等宽提示展示
    return (
      <pre className="overflow-x-auto whitespace-pre-wrap rounded-md bg-[#1e1e1e] px-3 py-2 font-mono text-[12px] leading-relaxed text-[#d4d4d4]">
        {text}
      </pre>
    );
  }
  const ok = p.exitCode === 0 || p.exitCode === null;
  return (
    <div className="overflow-hidden rounded-md border border-black/10 bg-[#1e1e1e] dark:border-white/10">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-[#d4d4d4]">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
          <span className="truncate">{p.command}</span>
        </span>
        {p.exitCode !== null && (
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${ok ? "bg-[#10a37f]/20 text-[#3ddc97]" : "bg-[#ff3b30]/25 text-[#ff8585]"}`}
          >
            exit {p.exitCode}
          </span>
        )}
      </div>
      <div className="max-h-[320px] overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed">
        {p.stdout && <pre className="whitespace-pre-wrap text-[#d4d4d4]">{p.stdout}</pre>}
        {p.stderr && <pre className="whitespace-pre-wrap text-[#ff8585]">{p.stderr}</pre>}
        {!p.stdout && !p.stderr && <span className="text-[#888]">（无输出）</span>}
      </div>
    </div>
  );
}

/** 命令执行中的实时终端块（边跑边显示）：命令头 + 滚动累进的输出 + 运行中指示。 */
function LiveTerminalBlock({ command, output }: { command: string; output: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-black/10 bg-[#1e1e1e] dark:border-white/10">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-[12px] text-[#d4d4d4]">
          <Terminal className="h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
          <span className="truncate">{command || "运行命令"}</span>
        </span>
        <span className="flex shrink-0 items-center gap-1 font-mono text-[10px] text-[#3ddc97]">
          <Loader2 className="h-3 w-3 animate-spin" /> 运行中
        </span>
      </div>
      <div className="max-h-[320px] overflow-auto px-3 py-2 font-mono text-[12px] leading-relaxed">
        {output ? <pre className="whitespace-pre-wrap text-[#d4d4d4]">{output}</pre> : <span className="text-[#888]">…</span>}
      </div>
    </div>
  );
}

/** 普通工具结果的可折叠披露（抓网页／搜文件／读文件等）：默认折叠显示一行预览，点开看全文。 */
function ResultDisclosure({ text, onOpen }: { text: string; onOpen?: () => void }) {
  const [open, setOpen] = useState(false);
  const oneLine = text.replace(/\s+/g, " ").trim();
  const preview = oneLine.length > 64 ? oneLine.slice(0, 64) + "…" : oneLine;
  return (
    <div className="ml-5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 items-center gap-1 font-mono text-[11.5px] text-[#86868b] transition hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:text-[#c8cace]"
        >
          <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
          <span className="truncate">{open ? "收起结果" : `结果：${preview}`}</span>
        </button>
        {onOpen && (
          <button
            type="button"
            onClick={onOpen}
            className="shrink-0 font-mono text-[11px] text-[#10a37f] transition hover:underline"
          >
            ⤢ 右侧打开
          </button>
        )}
      </div>
      {open && (
        <pre className="mt-1 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md border border-black/[0.06] bg-black/[0.02] px-2.5 py-2 font-mono text-[12px] leading-relaxed text-[#3a3a3c] dark:border-white/[0.06] dark:bg-white/[0.02] dark:text-[#9a9ca3]">
          {text}
        </pre>
      )}
    </div>
  );
}

/** F.1 思考块（抄 cc-haha ThinkingBlock）：灰斜体可折叠的"思考过程"。流式时默认展开看它想、答案落定后默认收起。 */
function ThinkingBlock({ text, active, defaultOpen }: { text: string; active?: boolean; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  if (!text && !active) return null;
  return (
    <div className="ml-0">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 font-mono text-[11.5px] text-[#a1a1a6] transition hover:text-[#6e6e73] dark:text-[#6e7077] dark:hover:text-[#9a9ca3]"
      >
        <ChevronRight className={`h-3 w-3 shrink-0 transition-transform ${open ? "rotate-90" : ""}`} />
        <Brain className="h-3 w-3 shrink-0" />
        <span>{active ? "思考中…" : "已思考"}</span>
        {active && <span className="animate-pulse">▍</span>}
      </button>
      {open && text && (
        <div className="mt-1 whitespace-pre-wrap border-l-2 border-black/[0.06] pl-2.5 text-[12.5px] italic leading-relaxed text-[#86868b] dark:border-white/[0.08] dark:text-[#6e7077]">
          {text}
        </div>
      )}
    </div>
  );
}

/** todo_write 的结果（☐待办 / ◐进行中 / ☑已完成）渲染成常驻可见的清单卡（不折叠）。 */
function TodoCard({ text }: { text: string }) {
  return (
    <div className="ml-5 rounded-md border border-black/[0.06] bg-black/[0.02] px-3 py-2 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]">{text}</pre>
    </div>
  );
}

function MacStepList({ steps, active, onPreview }: { steps: ToolStep[]; active: boolean; onPreview?: (item: PreviewItem) => void }) {
  if (steps.length === 0) return null;
  return (
    <div className="rounded-lg border border-black/[0.06] bg-black/[0.02] px-3 py-2.5 dark:border-white/[0.06] dark:bg-white/[0.02]">
      <p className="mb-1.5 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-[#86868b] dark:text-[#6e7077]">
        <Wrench className="h-3 w-3" /> 执行过程
      </p>
      <div className="flex flex-col gap-1.5">
        {steps.map((s, i) => {
          const { label, Icon } = toolMeta(s.tool);
          const running = active && !s.done && i === steps.length - 1;
          // P1-8 + B.1：内部/指令类工具（用技能/检索）结果是给 AI 看的原文，对老板零价值还吓人 → 绝不 dump、不进右侧。
          const isInternal = INTERNAL_TOOLS.has(s.tool);
          // 非成品、非内部工具（跑命令/抓网页/搜文件/读文件…）才把结果摊开展示；成品走成品卡，内部只留一行标签。
          const showResult = s.done && !!s.result && !DELIVERABLE_TOOLS.has(s.tool) && !isInternal;
          // 命令边跑边显示：未结束 + 已有实时输出 → 渲染滚动中的终端块
          const showLiveCmd = !s.done && s.tool === "run_command" && !!s.progress;
          const cmdText = typeof s.args?.command === "string" ? s.args.command : "";
          // 内部工具补一句人话副标题（用了哪个技能/查了什么）——从 args 取，绝不从结果原文截（截出来是乱码/指令稿）。
          const internalNote = isInternal
            ? (typeof s.args?.skill === "string" ? s.args.skill
              : typeof s.args?.name === "string" ? s.args.name
              : typeof s.args?.topic === "string" ? s.args.topic
              : typeof s.args?.query === "string" ? s.args.query : "")
            : "";
          // B.1：右侧只接"真有本机文件路径"的结果；任意工具文本不再借 file 兜底污染右侧成品台。
          const filePath = typeof s.args?.path === "string" ? s.args.path
            : typeof s.args?.file_path === "string" ? s.args.file_path : undefined;
          return (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-center gap-2 text-[13px] text-[#3a3a3c] dark:text-[#9a9ca3]">
                <span className={`shrink-0 text-[9px] leading-none ${running ? "animate-pulse text-[#d4901f]" : s.done ? "text-[#10a37f]" : "text-[#b0b0b5] dark:text-[#56585f]"}`}>⏺</span>
                <Icon className="h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#6e7077]" />
                <span>{label}{internalNote ? <span className="text-[#86868b] dark:text-[#6e7077]"> · {internalNote}</span> : null}</span>
                {running && <Loader2 className="h-3 w-3 animate-spin text-[#b0b0b5] dark:text-[#56585f]" />}
              </div>
              {showLiveCmd && <LiveTerminalBlock command={cmdText} output={s.progress as string} />}
              {showResult &&
                (s.tool === "run_command" ? (
                  <TerminalBlock text={s.result as string} />
                ) : s.tool === "todo_write" ? (
                  <TodoCard text={s.result as string} />
                ) : (
                  <ResultDisclosure
                    text={s.result as string}
                    onOpen={(onPreview && filePath) ? () => {
                      const p = filePath as string;
                      // 报表→表格(可点格改)；PDF/Word/PPT/网页→文档原样预览；其它本机文件→纯文本预览
                      if (/\.(xlsx|xlsm)$/i.test(p)) onPreview({ kind: "sheet", title: label, path: p });
                      else if (/\.(pdf|docx|pptx|html|htm)$/i.test(p)) onPreview({ kind: "doc", title: label, path: p });
                      else onPreview({ kind: "file", title: label, path: p, text: s.result as string });
                    } : undefined}
                  />
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CorrectionAction() {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit() {
    const rule = text.trim();
    if (!rule || saving) return;
    setSaving(true);
    setErr(null);
    try {
      await api.addStoreMemory(rule, "rule");
      setSaved(true);
      setOpen(false);
      setText("");
      setTimeout(() => setSaved(false), 3000);
    } catch (e) {
      setErr(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (saved) {
    return (
      <div className="flex items-center gap-1.5 px-4 pb-3 text-[12.5px] text-[#10a37f]">
        <Check className="h-3.5 w-3.5" /> 已记住，以后照此办。
      </div>
    );
  }

  if (!open) {
    return (
      <div className="px-4 pb-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] text-[#86868b] transition hover:text-[#1d1d1f] active:scale-[0.97] dark:text-[#6e7077] dark:hover:text-[#c8cace]"
        >
          <Flag className="h-3.5 w-3.5" /> 这条不太合适
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 pb-3">
      <div className="rounded-lg border border-black/[0.08] bg-black/[0.02] p-2.5 dark:border-white/[0.08] dark:bg-white/[0.02]">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit(); }}
          autoFocus
          rows={2}
          placeholder="告诉我一条规矩，下次照办，比如：不要写绝对化广告词"
          className="w-full resize-none rounded-md border border-black/[0.08] bg-white px-2.5 py-2 text-[13px] text-[#1d1d1f] outline-none placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.08] dark:bg-[#0e0f11] dark:text-[#e6e7e9] dark:placeholder:text-[#56585f]"
        />
        {err && <div className="mt-1.5 text-[12px] text-[#ff3b30] dark:text-[#ff8585]">{err}</div>}
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => { setOpen(false); setText(""); setErr(null); }}
            disabled={saving}
            className="rounded-md px-3 py-1 text-[12.5px] text-[#86868b] transition hover:text-[#1d1d1f] active:scale-[0.97] disabled:opacity-40 dark:text-[#9a9ca3] dark:hover:text-[#e6e7e9]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !text.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#10a37f] px-3 py-1 text-[12.5px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.98] disabled:opacity-40"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            记住
          </button>
        </div>
      </div>
    </div>
  );
}

function DeliverableCard({
  step,
  onPublish,
  onPreview,
}: {
  step: ToolStep;
  onPublish?: (platform: unknown, content: string) => void;
  onPreview?: (item: PreviewItem) => void;
}) {
  const { label, Icon } = toolMeta(step.tool);
  // G.3：生图工具 → 直接抓出图片地址渲染成真 <img>（不靠结果恰好是 markdown 图片语法），点开看大图。
  const imgUrl = IMAGE_TOOLS.has(step.tool) ? extractImageUrl(step.result || "") : null;
  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-white shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
      <div className="flex items-center justify-between border-b border-black/[0.06] bg-black/[0.015] px-4 py-2 dark:border-white/[0.06] dark:bg-white/[0.02]">
        <span className="flex items-center gap-1.5 font-mono text-[12px] text-[#1d1d1f] dark:text-[#c8cace]">
          <Icon className="h-3.5 w-3.5 text-[#10a37f]" /> {label}
        </span>
        <CopyButton text={step.result || ""} />
      </div>
      {imgUrl ? (
        <div className="px-4 py-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={imgUrl}
            alt={label}
            onClick={onPreview ? () => onPreview({ kind: "poster", imageUrl: imgUrl }) : undefined}
            className={`max-h-[420px] w-auto rounded-md border border-black/[0.06] dark:border-white/[0.06] ${onPreview ? "cursor-zoom-in" : ""}`}
          />
        </div>
      ) : (
        <div className={`${PROSE} px-4 py-3`}>
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.result || ""}</ReactMarkdown>
        </div>
      )}
      {step.knowledgeUsed && step.knowledgeUsed.length > 0 && (
        <div className="flex items-start gap-1.5 px-4 pb-2.5 text-[12px] leading-relaxed text-[#86868b] dark:text-[#6e7077]">
          <BookOpen className="mt-[1px] h-3.5 w-3.5 shrink-0" />
          <span><span>依据：</span>{step.knowledgeUsed.join(" · ")}</span>
        </div>
      )}
      {(onPreview || (onPublish && step.tool === "make_platform_content")) && (
        <div className="flex items-center gap-2 px-4 pb-1">
          {onPreview && !imgUrl && (
            <button
              type="button"
              onClick={() => onPreview({ kind: "content", title: label, text: step.result || "" })}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-[#10a37f] transition hover:bg-[#10a37f]/10 active:scale-[0.97]"
            >
              <Maximize2 className="h-3.5 w-3.5" /> 展开预览
            </button>
          )}
          {onPreview && imgUrl && (
            <button
              type="button"
              onClick={() => onPreview({ kind: "poster", imageUrl: imgUrl })}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-[#10a37f] transition hover:bg-[#10a37f]/10 active:scale-[0.97]"
            >
              <Maximize2 className="h-3.5 w-3.5" /> 在右侧看大图
            </button>
          )}
          {onPublish && step.tool === "make_platform_content" && (
            <button
              type="button"
              onClick={() => onPublish(step.args?.platform, step.result || "")}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-[#10a37f] transition hover:bg-[#10a37f]/10 active:scale-[0.97]"
            >
              <Send className="h-3.5 w-3.5" /> 去发布
            </button>
          )}
        </div>
      )}
      <CorrectionAction />
    </div>
  );
}

function MacDeliverables({
  steps,
  onPublish,
  onPreview,
}: {
  steps: ToolStep[];
  onPublish?: (platform: unknown, content: string) => void;
  onPreview?: (item: PreviewItem) => void;
}) {
  const cards = steps.map((s, idx) => ({ s, idx })).filter(({ s }) => s.result && DELIVERABLE_TOOLS.has(s.tool));
  if (cards.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {cards.map(({ s, idx }) => (
        <DeliverableCard key={idx} step={s} onPublish={onPublish} onPreview={onPreview} />
      ))}
    </div>
  );
}

function MacApprovalCard({
  ap,
  idx,
  executing,
  onConfirm,
  onCancel,
}: {
  ap: ApprovalState;
  idx: number;
  executing: boolean;
  onConfirm: (idx: number, ap: ApprovalState) => void;
  onCancel: (idx: number, ap?: ApprovalState) => void;
}) {
  if (ap.status === "cancelled") {
    return <div className="text-[13px] text-[#86868b] dark:text-[#6e7077]">已取消。</div>;
  }
  if (ap.status === "done") {
    return <div className="flex items-center gap-1.5 text-[13px] text-[#10a37f]"><Check className="h-3.5 w-3.5" /> 已确认执行。</div>;
  }
  const r = ap.reason;
  const previewBox = "rounded-md border border-black/[0.08] bg-black/[0.03] px-3 py-2 font-mono text-[12.5px] text-[#3a3a3c] whitespace-pre-line dark:border-white/[0.08] dark:bg-black/30 dark:text-[#c8cace]";
  return (
    <div className="overflow-hidden rounded-lg border border-[#e0b84a]/40 bg-[#fffaf0] dark:border-[#d4a72c]/25 dark:bg-[#211c0d]">
      <div className="px-4 py-3">
        <div className="mb-2.5 flex items-center gap-2 text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">
          <span className="rounded bg-[#d4a72c]/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-[#b9770f] dark:text-[#e0b84a]">需要确认</span>
          {approvalLabel(ap.tool, ap.args)}
        </div>
        {r ? (
          <div className="space-y-2.5">
            {r.what && (
              <div className="flex items-start gap-2">
                <Target className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[#10a37f]" />
                <div className="text-[13px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]"><span className="font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">要做什么：</span>{r.what}</div>
              </div>
            )}
            {r.why && (
              <div className="flex items-start gap-2">
                <ShieldQuestion className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[#d4901f] dark:text-[#e0b84a]" />
                <div className="text-[13px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]"><span className="font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">为什么要你确认：</span>{r.why}</div>
              </div>
            )}
            {r.impact && (
              <div className="flex items-start gap-2">
                <FileEdit className="mt-[2px] h-3.5 w-3.5 shrink-0 text-[#86868b] dark:text-[#9a9ca3]" />
                <div className="text-[13px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]"><span className="font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">影响：</span>{r.impact}</div>
              </div>
            )}
            {ap.preview && <div className={previewBox}>{ap.preview}</div>}
          </div>
        ) : (
          ap.preview && <div className={previewBox}>{ap.preview}</div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-4 pb-3">
        <button
          onClick={() => onCancel(idx, ap)}
          disabled={executing}
          className="rounded-md border border-black/[0.1] bg-white px-4 py-1.5 text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] disabled:opacity-40 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
        >
          取消
        </button>
        <button
          onClick={() => onConfirm(idx, ap)}
          disabled={executing}
          className="flex items-center gap-1.5 rounded-md bg-[#10a37f] px-4 py-1.5 text-[13px] text-white transition hover:bg-[#0e906f] active:scale-[0.98] disabled:opacity-60"
        >
          {executing && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
          {approvalConfirmText(ap.tool)}
        </button>
      </div>
    </div>
  );
}

function MacQuestionCard({ q, onAnswer }: { q: QuestionData; onAnswer: (label: string) => void }) {
  return (
    <div className="overflow-hidden rounded-lg border border-black/[0.08] bg-white shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
      <div className="border-b border-black/[0.06] px-4 py-2.5 text-[13px] font-medium text-[#1d1d1f] dark:border-white/[0.06] dark:text-[#e6e7e9]">🤔 {q.question}</div>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
        {q.options.map((o, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onAnswer(o.label)}
            className="rounded-md border border-black/[0.08] bg-black/[0.01] p-3 text-left transition hover:border-[#10a37f]/40 hover:bg-[#10a37f]/[0.06] active:scale-[0.99] dark:border-white/[0.08] dark:bg-white/[0.02]"
          >
            <div className="text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{o.label}</div>
            {o.description && <div className="mt-0.5 text-[12px] text-[#6e6e73] dark:text-[#8a8c93]">{o.description}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DesktopChatThread({
  messages,
  draft,
  reasoningDraft = "",
  liveSteps,
  generating,
  executingIdx,
  onConfirm,
  onCancel,
  onPublish,
  onPreview,
  onAnswer,
  onStop,
}: {
  messages: ChatMessage[];
  draft: string;
  reasoningDraft?: string;
  liveSteps: ToolStep[];
  generating: boolean;
  executingIdx: number | null;
  onConfirm: (idx: number, ap: ApprovalState) => void;
  onCancel: (idx: number, ap?: ApprovalState) => void;
  onPublish?: (platform: unknown, content: string) => void;
  onPreview?: (item: PreviewItem) => void;
  onAnswer?: (label: string) => void;
  onStop?: () => void;
}) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[820px] space-y-5 px-5 py-6">
        {messages.map((m, idx) =>
          m.role === "user" ? (
            <div key={idx} className="flex gap-2.5">
              <span className="mt-0.5 select-none font-mono text-[14px] leading-relaxed text-[#10a37f]">›</span>
              <div className="min-w-0 flex-1 whitespace-pre-wrap text-[14px] leading-relaxed text-[#1d1d1f] dark:text-[#e6e7e9]">{m.content}</div>
            </div>
          ) : (
            <div key={idx} className="space-y-2.5">
              {m.error ? (
                <div className="flex items-center gap-1.5 text-[14px] text-[#ff3b30] dark:text-[#ff8585]">
                  <AlertTriangle className="h-4 w-4 shrink-0" /> {m.content.replace(/^⚠️\s*/, "")}
                </div>
              ) : (
                <>
                  {m.reasoning && <ThinkingBlock text={m.reasoning} />}
                  {m.steps && <MacStepList steps={m.steps} active={false} onPreview={onPreview} />}
                  {m.steps && <MacDeliverables steps={m.steps} onPublish={onPublish} onPreview={onPreview} />}
                  {m.content &&
                    (m.kind === "command" ? (
                      <TerminalBlock text={m.content} />
                    ) : (
                      <div className={PROSE}>
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                      </div>
                    ))}
                  {onPreview && posterUrl(m.content) && (
                    <button
                      type="button"
                      onClick={() => onPreview({ kind: "poster", imageUrl: posterUrl(m.content) as string })}
                      className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-[#10a37f] transition hover:bg-[#10a37f]/10 active:scale-[0.97]"
                    >
                      <Maximize2 className="h-3.5 w-3.5" /> 在右侧看大图
                    </button>
                  )}
                  {m.approval && (
                    <MacApprovalCard ap={m.approval} idx={idx} executing={executingIdx === idx} onConfirm={onConfirm} onCancel={onCancel} />
                  )}
                  {m.question && onAnswer && <MacQuestionCard q={m.question} onAnswer={onAnswer} />}
                </>
              )}
            </div>
          )
        )}

        {generating && (
          <div className="space-y-2.5">
            {reasoningDraft && <ThinkingBlock text={reasoningDraft} active defaultOpen />}
            {liveSteps.length > 0 && <MacStepList steps={liveSteps} active onPreview={onPreview} />}
            {draft ? (
              <div className={PROSE}>
                <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
              </div>
            ) : (
              <AgentSpinner onStop={onStop} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
