"use client";

/**
 * 桌面端右侧预览/画布面板（学 Claude Artifacts / ChatGPT Canvas）：
 * 把成品（海报大图 / 文案）摆到右侧看清楚、还能"基于此调整"让管家在原件上接着改。
 * 由 DesktopShell 的 preview 槽渲染；presentational，开关与数据由 chat-shell 管。
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X, Download, Wand2, Copy, Check } from "lucide-react";
import { useState } from "react";

export type PreviewItem =
  | { kind: "poster"; title?: string; imageUrl: string; ratio?: string }
  | { kind: "content"; title?: string; text: string };

export function DesktopPreviewPanel({
  item,
  onClose,
  onRefine,
}: {
  item: PreviewItem;
  onClose: () => void;
  onRefine?: (kind: PreviewItem["kind"]) => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (item.kind !== "content") return;
    try {
      await navigator.clipboard.writeText(item.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 忽略 */ }
  };

  return (
    <section className="flex w-[440px] shrink-0 flex-col bg-[#fafafa]">
      {/* 面板头 */}
      <div className="flex h-[52px] items-center justify-between border-b border-black/[0.07] px-4">
        <div className="text-[13px] font-medium text-[#1d1d1f]">
          {item.title || (item.kind === "poster" ? "海报预览" : "成品预览")}
        </div>
        <button
          onClick={onClose}
          className="flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] hover:bg-black/[0.06]"
          aria-label="收起预览"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 预览体 */}
      {item.kind === "poster" ? (
        <div className="flex flex-1 items-center justify-center overflow-hidden p-4" style={{ background: "#ececf0" }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={item.imageUrl}
            alt="海报预览"
            className="max-h-full max-w-full rounded-2xl object-contain shadow-[0_10px_34px_rgba(0,0,0,0.2)]"
          />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-5">
          <div className="prose prose-sm max-w-none rounded-xl border border-black/[0.07] bg-white p-4 shadow-sm prose-slate prose-p:my-1.5">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
          </div>
        </div>
      )}

      {/* 工具条 */}
      <div className="border-t border-black/[0.07] p-3">
        {item.kind === "poster" && item.ratio && (
          <div className="mb-2 text-center text-[11px] text-[#86868b]">{item.ratio}</div>
        )}
        <div className="flex items-center gap-2">
          {item.kind === "poster" ? (
            <a
              href={item.imageUrl}
              download
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-600 text-[13px] text-white transition active:scale-[0.98]"
            >
              <Download className="h-3.5 w-3.5" /> 保存到本机
            </a>
          ) : (
            <button
              onClick={copy}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg bg-brand-600 text-[13px] text-white transition active:scale-[0.98]"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "已复制" : "复制"}
            </button>
          )}
          {onRefine && (
            <button
              onClick={() => onRefine(item.kind)}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-lg border border-black/[0.07] bg-white text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.02] active:scale-[0.98]"
            >
              <Wand2 className="h-3.5 w-3.5" /> 基于此调整
            </button>
          )}
        </div>
      </div>
    </section>
  );
}
