"use client";

/**
 * 桌面端右侧预览/画布面板（学 Claude Artifacts / ChatGPT Canvas）：
 * 把成品（海报大图 / 文案 / 文件）摆到右侧看清楚，并支持两档"基于此调整"：
 *  ① 整条改：底部"基于此调整"按钮，预填输入框让管家重做。
 *  ② 选区改（对齐 Canvas/Codex）：在文案/文件预览里【划选一段】→ 就地浮出"基于此调整"→
 *     说一句要改啥 → 把【选中的原文 + 怎么改】一起发给 AI，AI 只改这一段（海报是图、不支持选区）。
 * 由 DesktopShell 的 preview 槽渲染；presentational，开关与数据由 chat-shell 管。
 */
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X, Download, Wand2, Copy, Check } from "lucide-react";
import { useRef, useState } from "react";

import { useHorizontalResize } from "./use-resize";

export type PreviewItem =
  | { kind: "poster"; title?: string; imageUrl: string; ratio?: string }
  | { kind: "content"; title?: string; text: string }
  | { kind: "file"; title?: string; path?: string; text: string };

export function DesktopPreviewPanel({
  item,
  onClose,
  onRefine,
  onRefineSelection,
}: {
  item: PreviewItem;
  onClose: () => void;
  onRefine?: (kind: PreviewItem["kind"]) => void;
  /** 选区改：把选中的原文 + 要改成啥发给管家，只改这一段（对齐 ChatGPT Canvas/Codex）。 */
  onRefineSelection?: (selectedText: string, instruction: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const { width, onHandleMouseDown } = useHorizontalResize({
    storageKey: "desktop.previewWidth", defaultWidth: 440, min: 320, max: 720, edge: "left",
  });
  // 选区浮窗：划中一段文字 → 在选区上方冒出"基于此调整"小窗
  const bodyRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ text: string; top: number; left: number } | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineText, setRefineText] = useState("");
  const selectable = item.kind !== "poster" && !!onRefineSelection; // 海报是图、不支持选区改

  const copy = async () => {
    if (item.kind === "poster") return;
    try {
      await navigator.clipboard.writeText(item.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 忽略 */ }
  };

  // 划选结束：抓选中文字 + 选区位置，冒出浮窗；划空了就收起（除非正在填改写指令）
  const onBodyMouseUp = () => {
    if (!selectable) return;
    const s = window.getSelection();
    const text = s?.toString().trim() || "";
    if (text && s && bodyRef.current && bodyRef.current.contains(s.anchorNode)) {
      const rect = s.getRangeAt(0).getBoundingClientRect();
      setSel({ text, top: rect.top, left: rect.left + rect.width / 2 });
      setRefineOpen(false);
      setRefineText("");
    } else if (!refineOpen) {
      setSel(null);
    }
  };
  const submitRefine = () => {
    const ins = refineText.trim();
    if (!ins || !sel || !onRefineSelection) return;
    onRefineSelection(sel.text, ins);
    setSel(null);
    setRefineOpen(false);
    setRefineText("");
  };

  return (
    <section style={{ width }} className="relative flex shrink-0 flex-col border-l border-black/[0.08] bg-[#f5f5f7] dark:border-white/[0.06] dark:bg-[#0b0c0e]">
      {/* 面板头 */}
      <div className="app-drag flex h-[44px] items-center justify-between border-b border-black/[0.08] px-4 dark:border-white/[0.06]">
        <div className="min-w-0 truncate font-mono text-[12.5px] text-[#6e6e73] dark:text-[#9a9ca3]">
          {item.title || (item.kind === "poster" ? "海报预览" : item.kind === "file" ? (item.path?.split(/[\\/]/).pop() || "文件") : "成品预览")}
          {selectable && <span className="ml-2 text-[#b0b0b5] dark:text-[#56585f]">· 划选一段可就地改</span>}
        </div>
        <button
          onClick={onClose}
          className="app-no-drag flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] transition hover:bg-black/[0.06] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
          aria-label="收起预览"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 预览体（文案/文件可划选；ref+onMouseUp 捕获选区） */}
      <div ref={bodyRef} onMouseUp={onBodyMouseUp} className="flex min-h-0 flex-1 flex-col">
        {item.kind === "poster" ? (
          <div className="flex flex-1 items-center justify-center overflow-hidden bg-black/[0.04] p-4 dark:bg-black/40">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={item.imageUrl}
              alt="海报预览"
              className="max-h-full max-w-full rounded-xl object-contain shadow-[0_10px_34px_rgba(0,0,0,0.2)] dark:shadow-[0_10px_34px_rgba(0,0,0,0.5)]"
            />
          </div>
        ) : item.kind === "file" ? (
          <div className="flex-1 overflow-auto p-4">
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-black/[0.08] bg-white p-3.5 font-mono text-[12px] leading-relaxed text-[#1d1d1f] shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:text-[#c8cace] dark:shadow-none">{item.text}</pre>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-5">
            <div className="prose prose-sm prose-slate dark:prose-invert max-w-none rounded-lg border border-black/[0.08] bg-white p-4 shadow-sm prose-p:my-1.5 dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{item.text}</ReactMarkdown>
            </div>
          </div>
        )}
      </div>

      {/* 选区浮窗：固定定位贴在选区上方 */}
      {selectable && sel && (
        <div
          style={{ position: "fixed", top: Math.max(8, sel.top - (refineOpen ? 118 : 42)), left: sel.left, transform: "translateX(-50%)" }}
          className="z-50"
        >
          {!refineOpen ? (
            <button
              type="button"
              onClick={() => setRefineOpen(true)}
              className="flex items-center gap-1.5 rounded-full bg-[#10a37f] px-3 py-1.5 text-[12.5px] font-medium text-white shadow-lg transition hover:bg-[#0e906f] active:scale-[0.97]"
            >
              <Wand2 className="h-3.5 w-3.5" /> 基于此调整
            </button>
          ) : (
            <div className="w-[260px] rounded-lg border border-black/[0.1] bg-white p-2 shadow-xl dark:border-white/[0.12] dark:bg-[#1c1e24]">
              <div className="mb-1.5 line-clamp-2 rounded bg-black/[0.04] px-2 py-1 text-[11px] text-[#86868b] dark:bg-white/[0.05] dark:text-[#9a9ca3]">改这段：「{sel.text.length > 40 ? sel.text.slice(0, 40) + "…" : sel.text}」</div>
              <textarea
                value={refineText}
                onChange={(e) => setRefineText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitRefine(); } if (e.key === "Escape") { setSel(null); setRefineOpen(false); } }}
                autoFocus
                rows={2}
                placeholder="这段改成…（如：更热情、缩短一半、换个说法）"
                className="w-full resize-none rounded-md border border-black/[0.08] bg-white px-2 py-1.5 text-[12.5px] text-[#1d1d1f] outline-none placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.1] dark:bg-[#0e0f11] dark:text-[#e6e7e9] dark:placeholder:text-[#56585f]"
              />
              <div className="mt-1.5 flex items-center justify-end gap-1.5">
                <button
                  type="button"
                  onClick={() => { setSel(null); setRefineOpen(false); setRefineText(""); }}
                  className="rounded-md px-2 py-1 text-[12px] text-[#86868b] transition hover:text-[#1d1d1f] dark:text-[#9a9ca3] dark:hover:text-[#e6e7e9]"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={submitRefine}
                  disabled={!refineText.trim()}
                  className="rounded-md bg-[#10a37f] px-2.5 py-1 text-[12px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.98] disabled:opacity-40"
                >
                  发送给管家
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 工具条 */}
      <div className="border-t border-black/[0.08] p-3 dark:border-white/[0.06]">
        {item.kind === "poster" && item.ratio && (
          <div className="mb-2 text-center font-mono text-[11px] text-[#86868b] dark:text-[#6e7077]">{item.ratio}</div>
        )}
        <div className="flex items-center gap-2">
          {item.kind === "poster" ? (
            <a
              href={item.imageUrl}
              download
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-[#10a37f] text-[13px] text-white transition hover:bg-[#0e906f] active:scale-[0.98]"
            >
              <Download className="h-3.5 w-3.5" /> 保存到本机
            </a>
          ) : (
            <button
              onClick={copy}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-[#10a37f] text-[13px] text-white transition hover:bg-[#0e906f] active:scale-[0.98]"
            >
              {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
              {copied ? "已复制" : "复制"}
            </button>
          )}
          {onRefine && item.kind !== "file" && (
            <button
              onClick={() => onRefine(item.kind)}
              className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-black/[0.1] bg-white text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
            >
              <Wand2 className="h-3.5 w-3.5" /> {item.kind === "poster" ? "整张重做" : "整条改"}
            </button>
          )}
        </div>
      </div>
      <div
        onMouseDown={onHandleMouseDown}
        className="app-no-drag absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-[#10a37f]/40"
        title="拖拽调整预览栏宽度"
      />
    </section>
  );
}
