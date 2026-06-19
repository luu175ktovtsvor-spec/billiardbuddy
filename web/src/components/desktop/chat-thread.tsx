"use client";

/**
 * 桌面端对话流（macOS 风）：用户气泡 / 工具步骤 / 成品卡(可复制·去发布) / 审批卡。
 * 纯展示组件，状态与逻辑由 useAgentChat 提供。忠实复刻手机页的渲染语义、换 macOS 皮。
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader2, Check, Wrench, AlertTriangle, Send, Maximize2 } from "lucide-react";

import { CopyButton } from "@/components/generators/copy-button";
import { toolMeta, DELIVERABLE_TOOLS, approvalLabel, approvalConfirmText } from "@/lib/agent-tools";
import type { ChatMessage, ToolStep, ApprovalState } from "@/hooks/use-agent-chat";
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
      {cards.map(({ s, idx }) => {
        const { label, Icon } = toolMeta(s.tool);
        return (
          <div key={idx} className="overflow-hidden rounded-xl border border-black/[0.07] bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-black/[0.07] bg-black/[0.015] px-4 py-2.5">
              <span className="flex items-center gap-1.5 text-[13px] font-medium text-[#1d1d1f]">
                <Icon className="h-3.5 w-3.5 text-brand-600" /> {label}
              </span>
              <CopyButton text={s.result || ""} />
            </div>
            <div className="prose prose-sm max-w-none px-4 py-3 prose-slate prose-p:my-1.5 prose-headings:my-2">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{s.result || ""}</ReactMarkdown>
            </div>
            {(onPreview || (onPublish && s.tool === "make_platform_content")) && (
              <div className="flex items-center gap-2 px-4 pb-3">
                {onPreview && (
                  <button
                    type="button"
                    onClick={() => onPreview({ kind: "content", title: label, text: s.result || "" })}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-brand-600 active:scale-[0.97]"
                  >
                    <Maximize2 className="h-3.5 w-3.5" /> 展开预览
                  </button>
                )}
                {onPublish && s.tool === "make_platform_content" && (
                  <button
                    type="button"
                    onClick={() => onPublish(s.args?.platform, s.result || "")}
                    className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[12.5px] font-medium text-brand-600 active:scale-[0.97]"
                  >
                    <Send className="h-3.5 w-3.5" /> 去发布
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
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
