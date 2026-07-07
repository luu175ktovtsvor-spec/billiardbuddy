"use client";

/**
 * Word(.docx) / PPT(.pptx) 文字级编辑：把文档拆成一块块文字，点哪块改哪块——
 * 既能手动改，也能「让 AI 改」(出 diff 接受/放弃)；保存时只把改过的块原地写回原文件，
 * 文档其余结构/格式不动（对齐"只改我改的"）。
 */
import { useEffect, useRef, useState } from "react";
import { Loader2, Save, Wand2, Check, X, Pencil, FileText, Presentation } from "lucide-react";

import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { DiffBlock } from "./diff-block";
import { useVersionHistory } from "./use-version-history";
import { VersionBar } from "./version-bar";

type Edits = Record<string, string>;
const editsEq = (a: Edits, b: Edits) => {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
};
const snippet = (t: string) => { const s = (t || "").trim().replace(/\s+/g, " "); return s.length > 10 ? s.slice(0, 10) + "…" : s; };

type Block = { id: string; kind: string; text: string; slide?: number };

const BLOCK_CLS: Record<string, string> = {
  h1: "text-[17px] font-bold text-[#1d1d1f] dark:text-[#e6e7e9]",
  h2: "text-[15px] font-semibold text-[#1d1d1f] dark:text-[#e6e7e9]",
  h3: "text-[14px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]",
  title: "text-[15px] font-semibold text-[#1d1d1f] dark:text-[#e6e7e9]",
  p: "text-[13px] text-[#3a3a3c] dark:text-[#c8cace]",
  body: "text-[13px] text-[#3a3a3c] dark:text-[#c8cace]",
  li: "text-[13px] text-[#3a3a3c] dark:text-[#c8cace]",
  cell: "text-[12.5px] font-mono text-[#3a3a3c] dark:text-[#c8cace]",
};

export function DocEditView({ path, title }: { path: string; title: string }) {
  const [data, setData] = useState<{ kind: "docx" | "pptx"; blocks: Block[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const vh = useVersionHistory<Edits>({}, "原始", editsEq); // 版本检查点：每次改存一版改动快照
  const edits = vh.current;
  const resetHistory = vh.reset; // 稳定引用，供换文档时清时间线
  const [picked, setPicked] = useState<string | null>(null);
  const [draft, setDraft] = useState("");           // 手动编辑的文字
  const [aiText, setAiText] = useState("");          // 让 AI 改的指令
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ id: string; before: string; after: string } | null>(null);
  const aiReqIdRef = useRef(0);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    resetHistory({});
    setPicked(null);
    setPending(null);
    api
      .docBlocks(path)
      .then((r) => { if (!cancelled) setData({ kind: r.kind, blocks: r.blocks }); })
      .catch((e) => { if (!cancelled) setErr(getErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, resetHistory]);

  const textOf = (b: Block) => edits[b.id] ?? b.text;
  const dirtyCount = Object.keys(edits).length;

  const openBlock = (b: Block) => {
    if (pending) return;
    setPicked(b.id);
    setDraft(textOf(b));
    setAiText("");
    setTimeout(() => taRef.current?.focus(), 0);
  };
  const applyManual = (b: Block) => {
    const next = { ...edits };
    if (draft === b.text) delete next[b.id]; // 改回原样 = 不算改动
    else next[b.id] = draft;
    vh.commit(next, `改《${snippet(b.text)}》`);
    setPicked(null);
  };
  const runAi = async (b: Block) => {
    const ins = aiText.trim();
    if (!ins || busy) return;
    const rid = ++aiReqIdRef.current;
    setBusy(true);
    setErr(null);
    try {
      const cur = textOf(b);
      const res = await api.canvasEdit(cur, ins, cur, "文档");
      if (rid !== aiReqIdRef.current) return;
      if (res.content === cur) setErr("这段没改出不一样的内容，换个说法再试");
      else setPending({ id: b.id, before: cur, after: res.content });
    } catch (e) {
      if (rid !== aiReqIdRef.current) return;
      setErr(getErrorMessage(e));
    } finally {
      if (rid === aiReqIdRef.current) setBusy(false);
    }
  };
  const acceptPending = () => {
    if (!pending) return;
    const orig = data?.blocks.find((x) => x.id === pending.id)?.text;
    const next = { ...edits };
    if (pending.after === orig) delete next[pending.id];
    else next[pending.id] = pending.after;
    vh.commit(next, `改《${snippet(pending.before)}》`);
    setPending(null);
    setPicked(null);
  };

  const flash = (text: string, bad?: boolean) => { setSaveMsg({ text, bad }); setTimeout(() => setSaveMsg(null), 3500); };
  const save = async () => {
    if (saving || dirtyCount === 0) return;
    setSaving(true);
    try {
      const r = await api.docSave(path, edits);
      // 写回成功：把改动并进基线、版本时间线重置为新基线
      setData((d) => d && { ...d, blocks: d.blocks.map((b) => (b.id in edits ? { ...b, text: edits[b.id] } : b)) });
      vh.reset({});
      flash(`已写回原文件（改了 ${r.saved} 处）`);
    } catch (e) {
      flash(getErrorMessage(e), true);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-[#86868b] dark:text-[#6e7077]"><Loader2 className="h-4 w-4 animate-spin" /> 正在打开文档…</div>;
  }
  if (err && !data) {
    return <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-[#ff3b30] dark:text-[#ff8585]">{err}</div>;
  }
  if (!data) return null;
  const Icon = data.kind === "pptx" ? Presentation : FileText;

  // 渲染一个块（选中时给手动/AI 编辑器）
  const renderBlock = (b: Block) => {
    const changed = b.id in edits;
    if (picked === b.id) {
      return (
        <div key={b.id} className="rounded-lg border border-[#10a37f]/40 bg-[#10a37f]/[0.04] p-2.5 dark:bg-[#10a37f]/[0.08]">
          {pending && pending.id === b.id ? (
            <>
              <div className="mb-1.5 text-[12px] text-[#86868b] dark:text-[#9a9ca3]">看一下改动，满意就接受</div>
              <DiffBlock before={pending.before} after={pending.after} />
              <div className="mt-2 flex items-center gap-2">
                <button onClick={acceptPending} className="app-primary-action flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-[12.5px] font-medium transition active:scale-[0.98]"><Check className="h-3.5 w-3.5" /> 接受改动</button>
                <button onClick={() => setPending(null)} className="flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md border border-black/[0.1] bg-white text-[12.5px] text-[#1d1d1f] transition hover:bg-black/[0.03] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace]"><X className="h-3.5 w-3.5" /> 放弃</button>
              </div>
            </>
          ) : (
            <>
              <textarea
                ref={taRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") setPicked(null); }}
                rows={Math.min(6, Math.max(2, Math.ceil(draft.length / 28)))}
                className="w-full resize-none rounded-md border border-black/[0.08] bg-white px-2.5 py-1.5 text-[13px] text-[#1d1d1f] outline-none focus:border-[#10a37f]/50 dark:border-white/[0.1] dark:bg-[#0e0f11] dark:text-[#e6e7e9]"
              />
              <div className="mt-1.5 flex items-center gap-1.5">
                <button onClick={() => applyManual(b)} className="app-primary-action rounded-md px-2.5 py-1 text-[12px] font-medium transition active:scale-[0.98]">保存这段</button>
                <button onClick={() => setPicked(null)} className="rounded-md px-2 py-1 text-[12px] text-[#86868b] transition hover:text-[#1d1d1f] dark:text-[#9a9ca3] dark:hover:text-[#e6e7e9]">取消</button>
                <div className="flex-1" />
              </div>
              <div className="mt-2 flex items-end gap-1.5 border-t border-black/[0.06] pt-2 dark:border-white/[0.08]">
                <div className="flex-1">
                  <div className="mb-1 flex items-center gap-1 text-[11.5px] text-[#86868b] dark:text-[#9a9ca3]"><Wand2 className="h-3 w-3 text-[#10a37f]" /> 或让 AI 改</div>
                  <input
                    value={aiText}
                    onChange={(e) => setAiText(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); runAi(b); } }}
                    placeholder="如：更热情、更短、换个说法"
                    className="w-full rounded-md border border-black/[0.08] bg-white px-2.5 py-1.5 text-[12.5px] text-[#1d1d1f] outline-none placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.1] dark:bg-[#0e0f11] dark:text-[#e6e7e9]"
                  />
                </div>
                <button onClick={() => runAi(b)} disabled={!aiText.trim() || busy} className="h-8 shrink-0 rounded-md border border-[#10a37f]/40 px-2.5 text-[12px] font-medium text-[#10a37f] transition hover:bg-[#10a37f]/10 disabled:opacity-40">
                  {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "改写"}
                </button>
              </div>
              {err && <div className="mt-1.5 text-[12px] text-[#ff3b30] dark:text-[#ff8585]">{err}</div>}
            </>
          )}
        </div>
      );
    }
    return (
      <button
        key={b.id}
        type="button"
        onClick={() => openBlock(b)}
        className={`group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition hover:bg-[#10a37f]/[0.06] ${changed ? "bg-[#10a37f]/[0.05]" : ""}`}
      >
        {b.kind === "li" && <span className="mt-[3px] shrink-0 text-[#10a37f]">•</span>}
        <span className={`min-w-0 flex-1 whitespace-pre-wrap break-words ${BLOCK_CLS[b.kind] || BLOCK_CLS.p}`}>{textOf(b)}</span>
        {changed && <span className="mt-1 shrink-0 rounded bg-[#10a37f]/15 px-1 text-[10px] text-[#10a37f]">已改</span>}
        <Pencil className="mt-0.5 h-3 w-3 shrink-0 text-transparent transition group-hover:text-[#b0b0b5]" />
      </button>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条 */}
      <div className="flex shrink-0 items-center gap-2 border-b border-black/[0.06] px-3 py-1.5 dark:border-white/[0.06]">
        <Icon className="h-3.5 w-3.5 text-[#10a37f]" />
        <span className="text-[12px] text-[#86868b] dark:text-[#9a9ca3]">点任意一段文字即可修改{dirtyCount > 0 ? ` · 待写回 ${dirtyCount} 处` : ""}</span>
        <div className="flex-1" />
        <VersionBar versions={vh.versions} index={vh.index} onGoto={vh.goto} />
        <button
          onClick={save}
          disabled={saving || dirtyCount === 0}
          className="app-primary-action inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium transition active:scale-[0.98] disabled:opacity-40"
        >
          {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          {saving ? "写回中…" : "写回原文件"}
        </button>
      </div>
      {saveMsg && <div className={`shrink-0 truncate px-3 py-1.5 text-[12px] ${saveMsg.bad ? "text-[#ff3b30] dark:text-[#ff8585]" : "text-[#10a37f]"}`} title={saveMsg.text}>{saveMsg.text}</div>}

      {/* 文档主体 */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {data.kind === "pptx" ? (
          // 按页分组
          groupBySlide(data.blocks).map(([slideNo, items]) => (
            <div key={slideNo} className="mb-3 rounded-lg border border-black/[0.08] bg-white p-3 shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
              <div className="mb-1.5 font-mono text-[11px] text-[#86868b] dark:text-[#6e7077]">第 {slideNo} 页</div>
              <div className="flex flex-col gap-0.5">{items.map(renderBlock)}</div>
            </div>
          ))
        ) : (
          <div className="mx-auto max-w-[640px] rounded-lg border border-black/[0.08] bg-white p-4 shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
            <div className="flex flex-col gap-0.5">{data.blocks.map(renderBlock)}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function groupBySlide(blocks: Block[]): [number, Block[]][] {
  const map = new Map<number, Block[]>();
  for (const b of blocks) {
    const s = b.slide || 1;
    if (!map.has(s)) map.set(s, []);
    map.get(s)!.push(b);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]);
}
