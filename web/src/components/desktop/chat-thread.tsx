"use client";

/**
 * 桌面端对话流（macOS 风）：用户气泡 / 工具步骤 / 成品卡(可复制·去发布) / 审批卡。
 * 纯展示组件，状态与逻辑由 useAgentChat 提供。忠实复刻手机页的渲染语义、换 macOS 皮。
 */
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Check, Wrench, AlertTriangle, Send, Maximize2, BookOpen, Flag } from "lucide-react";

import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { CopyButton } from "@/components/generators/copy-button";
import { toolMeta, DELIVERABLE_TOOLS, approvalLabel, approvalConfirmText } from "@/lib/agent-tools";
import type { ChatMessage, ToolStep, ApprovalState, QuestionData } from "@/hooks/use-agent-chat";
import type { PreviewItem } from "./preview-panel";

/** 从一段 markdown 里抽第一张图片的 url（海报结果是 ![门店海报](url)）。 */
function posterUrl(content: string): string | null {
  const m = content.match(/!\[[^\]]*\]\(([^)\s]+)/);
  return m ? m[1] : null;
}

function MacStepList({ steps, active }: { steps: ToolStep[]; active: boolean }) {
  if (steps.length === 0) return null;
  return (
    <div className="rounded-xl bg-black/[0.03] px-3 py-2.5">
      <p className="mb-1.5 flex items-center gap-1.5 text-[12px] font-medium text-[#86868b]">
        <Wrench className="h-3.5 w-3.5" /> 管家干了这些活
      </p>
      <div className="flex flex-col gap-1.5">
        {steps.map((s, i) => {
          const { label, Icon } = toolMeta(s.tool);
          const running = active && !s.done && i === steps.length - 1;
          return (
            <div key={i} className="flex items-center gap-2 text-[13px] text-[#3a3a3c]">
              <Icon className="h-3.5 w-3.5 shrink-0 text-brand-500" />
              <span>{label}</span>
              {running ? (
                <Loader2 className="h-3 w-3 animate-spin text-[#b0b0b5]" />
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

/**
 * B-3 纠错按钮：成品卡上一个轻量动作"这条不适用/我们店不这样"。
 * 点开 → 内联输入老板的店规矩 → 调 api.addStoreMemory 写成 manual 店规矩（后端 POST 强制 source="manual"，
 * AI 注入最高优先、绝不覆盖）。成功后给"已记进你的店规矩"轻提示。
 */
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
      // type 仅做分类，后端 POST 一律落 source="manual"（老板亲定的店规矩）
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
      <div className="flex items-center gap-1.5 px-4 pb-3 text-[12.5px] text-emerald-600">
        <Check className="h-3.5 w-3.5" /> 已记进你的店规矩，以后管家会照办。
      </div>
    );
  }

  if (!open) {
    return (
      <div className="px-4 pb-3">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-[#86868b] transition hover:text-[#1d1d1f] active:scale-[0.97]"
        >
          <Flag className="h-3.5 w-3.5" /> 这条不适用 / 我们店不这样
        </button>
      </div>
    );
  }

  return (
    <div className="px-4 pb-3">
      <div className="rounded-lg border border-black/[0.08] bg-black/[0.015] p-2.5">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          }}
          autoFocus
          rows={2}
          placeholder="说一句我们店的规矩，如：我们店不做大额充值赠送"
          className="w-full resize-none rounded-md border border-black/[0.07] bg-white px-2.5 py-2 text-[13px] text-[#1d1d1f] outline-none placeholder:text-[#b0b0b5] focus:border-brand-500"
        />
        {err && <div className="mt-1.5 text-[12px] text-[#ff3b30]">{err}</div>}
        <div className="mt-2 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => { setOpen(false); setText(""); setErr(null); }}
            disabled={saving}
            className="rounded-md px-3 py-1 text-[12.5px] text-[#86868b] transition hover:text-[#1d1d1f] active:scale-[0.97] disabled:opacity-40"
          >
            取消
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={saving || !text.trim()}
            className="inline-flex items-center gap-1.5 rounded-md bg-brand-600 px-3 py-1 text-[12.5px] font-medium text-white transition active:scale-[0.98] disabled:opacity-40"
          >
            {saving && <Loader2 className="h-3 w-3 animate-spin" />}
            记进店规矩
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
  return (
    <div className="overflow-hidden rounded-xl border border-black/[0.07] bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-black/[0.07] bg-black/[0.015] px-4 py-2.5">
        <span className="flex items-center gap-1.5 text-[13px] font-medium text-[#1d1d1f]">
          <Icon className="h-3.5 w-3.5 text-brand-600" /> {label}
        </span>
        <CopyButton text={step.result || ""} />
      </div>
      <div className="prose prose-sm max-w-none px-4 py-3 prose-slate prose-p:my-1.5 prose-headings:my-2">
        <ReactMarkdown remarkPlugins={[remarkGfm]}>{step.result || ""}</ReactMarkdown>
      </div>
      {step.knowledgeUsed && step.knowledgeUsed.length > 0 && (
        <div className="flex items-start gap-1.5 px-4 pb-2.5 text-[12px] leading-relaxed text-[#86868b]">
          <BookOpen className="mt-[1px] h-3.5 w-3.5 shrink-0 text-[#a1a1a6]" />
          <span>
            <span className="text-[#86868b]">依据：</span>
            {step.knowledgeUsed.join(" · ")}
          </span>
        </div>
      )}
      {(onPreview || (onPublish && step.tool === "make_platform_content")) && (
        <div className="flex items-center gap-2 px-4 pb-1">
          {onPreview && (
            <button
              type="button"
              onClick={() => onPreview({ kind: "content", title: label, text: step.result || "" })}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-brand-600 active:scale-[0.97]"
            >
              <Maximize2 className="h-3.5 w-3.5" /> 展开预览
            </button>
          )}
          {onPublish && step.tool === "make_platform_content" && (
            <button
              type="button"
              onClick={() => onPublish(step.args?.platform, step.result || "")}
              className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-brand-600 active:scale-[0.97]"
            >
              <Send className="h-3.5 w-3.5" /> 去发布
            </button>
          )}
        </div>
      )}
      {/* 纠错入口：放在「依据」附近，让老板看到 AI 的依据后能立刻纠正「我们店不这样」 */}
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
  onCancel: (idx: number) => void;
}) {
  if (ap.status === "cancelled") {
    return <div className="text-[13px] text-[#86868b]">已取消。</div>;
  }
  if (ap.status === "done") {
    return <div className="flex items-center gap-1.5 text-[13px] text-emerald-600"><Check className="h-3.5 w-3.5" /> 已确认执行。</div>;
  }
  return (
    <div className="overflow-hidden rounded-xl border bg-[#fffaf0] shadow-sm" style={{ borderColor: "#f0c98a66" }}>
      <div className="px-4 py-3">
        <div className="mb-1.5 flex items-center gap-1.5 text-[13px] font-medium text-[#1d1d1f]">
          ⚠️ {approvalLabel(ap.tool)}
          <span className="text-[11px] font-normal text-[#86868b]">（花钱/对外动作，先点头才执行）</span>
        </div>
        {ap.preview && (
          <div className="rounded-lg border border-black/[0.07] bg-white/70 px-3 py-2 text-[13px] text-[#3a3a3c] whitespace-pre-line">
            {ap.preview}
          </div>
        )}
      </div>
      <div className="flex items-center justify-end gap-2 px-4 pb-3">
        <button
          onClick={() => onCancel(idx)}
          disabled={executing}
          className="rounded-lg border border-black/[0.07] bg-white px-4 py-1.5 text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] disabled:opacity-40"
        >
          取消
        </button>
        <button
          onClick={() => onConfirm(idx, ap)}
          disabled={executing}
          className="flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-1.5 text-[13px] text-white transition active:scale-[0.98] disabled:opacity-60"
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
    <div className="overflow-hidden rounded-xl border border-black/[0.07] bg-white shadow-sm">
      <div className="border-b border-black/[0.07] px-4 py-2.5 text-[13px] font-medium text-[#1d1d1f]">
        🤔 {q.question}
      </div>
      <div className="grid grid-cols-1 gap-2 p-3 sm:grid-cols-2">
        {q.options.map((o, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onAnswer(o.label)}
            className="rounded-lg border border-black/[0.07] bg-white p-3 text-left transition hover:border-brand-600 hover:bg-brand-50 active:scale-[0.99]"
          >
            <div className="text-[13.5px] font-medium text-[#1d1d1f]">{o.label}</div>
            {o.description && <div className="mt-0.5 text-[12px] text-[#86868b]">{o.description}</div>}
          </button>
        ))}
      </div>
    </div>
  );
}

export function DesktopChatThread({
  messages,
  draft,
  liveSteps,
  generating,
  executingIdx,
  onConfirm,
  onCancel,
  onPublish,
  onPreview,
  onAnswer,
}: {
  messages: ChatMessage[];
  draft: string;
  liveSteps: ToolStep[];
  generating: boolean;
  executingIdx: number | null;
  onConfirm: (idx: number, ap: ApprovalState) => void;
  onCancel: (idx: number) => void;
  onPublish?: (platform: unknown, content: string) => void;
  onPreview?: (item: PreviewItem) => void;
  onAnswer?: (label: string) => void;
}) {
  return (
    <div className="flex-1 space-y-4 overflow-y-auto px-6 py-5">
      {messages.map((m, idx) =>
        m.role === "user" ? (
          <div key={idx} className="flex justify-end">
            <div
              className="max-w-[78%] rounded-2xl rounded-tr-md px-4 py-2.5 text-[14px] text-[#1d1d1f]"
              style={{ background: "#007AFF14" }}
            >
              {m.content}
            </div>
          </div>
        ) : (
          <div key={idx} className="max-w-[88%] space-y-2.5">
            {m.error ? (
              <div className="flex items-center gap-1.5 text-[14px] text-[#ff3b30]">
                <AlertTriangle className="h-4 w-4 shrink-0" /> {m.content.replace(/^⚠️\s*/, "")}
              </div>
            ) : (
              <>
                {m.steps && <MacStepList steps={m.steps} active={false} />}
                {m.steps && <MacDeliverables steps={m.steps} onPublish={onPublish} onPreview={onPreview} />}
                {m.content && (
                  <div className="prose prose-sm max-w-none leading-relaxed prose-slate prose-p:my-1.5">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  </div>
                )}
                {onPreview && posterUrl(m.content) && (
                  <button
                    type="button"
                    onClick={() => onPreview({ kind: "poster", imageUrl: posterUrl(m.content) as string })}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-brand-600 active:scale-[0.97]"
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

      {/* 进行中（流式） */}
      {generating && (
        <div className="max-w-[88%] space-y-2.5">
          {liveSteps.length > 0 && <MacStepList steps={liveSteps} active />}
          {draft ? (
            <div className="prose prose-sm max-w-none leading-relaxed prose-slate prose-p:my-1.5">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{draft}</ReactMarkdown>
            </div>
          ) : liveSteps.length === 0 ? (
            <div className="flex items-center gap-2 text-[13px] text-[#86868b]">
              <Loader2 className="h-4 w-4 animate-spin" /> 管家在想…
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}
