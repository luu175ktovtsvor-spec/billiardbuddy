"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { X, Undo2, Loader2, Wand2, Copy, Check, MousePointerClick } from "lucide-react";
import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";

interface CanvasPanelProps {
  open: boolean;
  title: string; // 成品类型名（如"朋友圈文案"）
  deliverableType: string; // 传给后端只影响语气
  content: string; // 打开时的成品全文
  onClose: () => void;
  onContentChange?: (next: string) => void; // 把最新版同步回聊天卡片
}

/**
 * 画布：成品在右侧展开后，老板"指着某处说改这里"。
 * - 选中一段文字 → 说"这段怎么改" → 只改那段、不动别处（后端 span 改写）。
 * - 不选直接说 → 整篇按要求修订。
 * - 每改存一版，可一键撤销。
 */
export function CanvasPanel({ open, title, deliverableType, content, onClose, onContentChange }: CanvasPanelProps) {
  const [versions, setVersions] = useState<string[]>([content]);
  const cur = versions[versions.length - 1] ?? "";
  const [selection, setSelection] = useState("");
  const [instruction, setInstruction] = useState("");
  const [editing, setEditing] = useState(false);
  const [err, setErr] = useState("");
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  // 打开了新成品 → 重置版本栈与选区
  useEffect(() => {
    setVersions([content]);
    setSelection("");
    setInstruction("");
    setErr("");
  }, [content]);

  function captureSelection() {
    const s = (typeof window !== "undefined" && window.getSelection?.()?.toString().trim()) || "";
    // 只认落在画布正文内的选区
    if (s && s.length >= 1) setSelection(s);
  }

  async function runEdit() {
    const ins = instruction.trim();
    if (!ins || editing) return;
    setEditing(true);
    setErr("");
    try {
      const res = await api.canvasEdit(cur, ins, selection || undefined, deliverableType);
      const next = (res.content || cur).trim();
      setVersions((v) => [...v, next]);
      onContentChange?.(next);
      setInstruction("");
      setSelection("");
    } catch (e) {
      setErr(getErrorMessage(e));
    } finally {
      setEditing(false);
    }
  }

  function undo() {
    if (versions.length <= 1) return;
    setVersions((v) => {
      const nv = v.slice(0, -1);
      onContentChange?.(nv[nv.length - 1]);
      return nv;
    });
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(cur);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 微信等环境复制失败，忽略 */
    }
  }

  if (!open) return null;

  return (
    <>
      {/* 手机：全屏遮罩点击关闭；桌面无遮罩（分栏并排） */}
      <div className="fixed inset-0 z-40 bg-black/30 lg:hidden" onClick={onClose} />
      <aside
        className="fixed inset-0 z-50 flex flex-col bg-white lg:inset-y-0 lg:right-0 lg:left-auto lg:w-[460px] lg:border-l lg:border-slate-200 lg:shadow-xl"
      >
        {/* 顶栏 */}
        <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
          <span className="text-[15px] font-semibold text-slate-800">{title}</span>
          <span className="rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-600">画布·可改</span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={undo}
              disabled={versions.length <= 1}
              title="撤销上一步"
              className="inline-flex h-9 items-center gap-1 rounded-xl px-2.5 text-[13px] text-slate-500 disabled:opacity-40 active:scale-[0.97]"
            >
              <Undo2 className="h-4 w-4" /> 撤销
            </button>
            <button
              type="button"
              onClick={copy}
              title="复制全文"
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 active:scale-[0.97]"
            >
              {copied ? <Check className="h-4 w-4 text-emerald-500" /> : <Copy className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 active:scale-[0.97]"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* 成品正文（选中其中一段即可定向改） */}
        <div
          ref={bodyRef}
          onMouseUp={captureSelection}
          onTouchEnd={captureSelection}
          className="flex-1 overflow-auto px-4 py-4"
        >
          <div className="prose prose-sm max-w-none prose-slate prose-p:my-2 prose-headings:my-2.5 selection:bg-brand-100">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{cur}</ReactMarkdown>
          </div>
        </div>

        {/* 底部：选区提示 + 改写指令输入 */}
        <div className="border-t border-slate-100 px-4 py-3">
          {selection ? (
            <div className="mb-2 flex items-start gap-1.5 rounded-xl bg-brand-50 px-3 py-2 text-[12.5px] text-brand-700">
              <MousePointerClick className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="flex-1">
                只改这段：「{selection.length > 40 ? selection.slice(0, 40) + "…" : selection}」
              </span>
              <button type="button" onClick={() => setSelection("")} className="shrink-0 text-brand-400">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            <p className="mb-2 flex items-center gap-1.5 text-[12px] text-slate-400">
              <MousePointerClick className="h-3.5 w-3.5" /> 选中正文里的一段，就只改那段；不选则整体改
            </p>
          )}
          {err && <p className="mb-2 text-[12.5px] text-rose-500">{err}</p>}
          <div className="flex items-end gap-2">
            <textarea
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  runEdit();
                }
              }}
              rows={1}
              placeholder={selection ? "这段怎么改？比如：改成5折、说得再热闹点" : "整体怎么改？比如：再活泼点、加个结尾钩子"}
              className="max-h-28 flex-1 resize-none rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-[14px] text-slate-800 outline-none focus:border-brand-300"
            />
            <button
              type="button"
              onClick={runEdit}
              disabled={!instruction.trim() || editing}
              className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-xl bg-brand-600 px-4 text-sm font-medium text-white disabled:opacity-50 active:scale-[0.98]"
            >
              {editing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
              {editing ? "改中…" : "改"}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
