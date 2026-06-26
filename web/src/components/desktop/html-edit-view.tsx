"use client";

/**
 * 网页「可圈可点」编辑（对齐 Onlook / Cursor Design Mode）：
 * 打开网页 → 开「圈点修改」→ 鼠标点页面上任意元素 → 说一句怎么改 →
 * AI 只改那个元素 → 出 diff → 接受/放弃 → 可撤销 → 定稿保存到电脑/素材库。
 * iframe 用 sandbox="allow-same-origin"（父窗口能读 DOM 挂点选，但页面自身脚本不执行，安全）。
 */
import { useEffect, useRef, useState } from "react";
import { Wand2, Save, Download, FolderHeart, Check, X, Loader2, MousePointerClick, ChevronDown } from "lucide-react";

import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { useDesktop } from "@/hooks/use-desktop";
import { DiffBlock } from "./diff-block";
import { useVersionHistory } from "./use-version-history";
import { VersionBar } from "./version-bar";

export function HtmlEditView({ initialHtml, title }: { initialHtml: string; title: string }) {
  const { electron } = useDesktop();
  const vh = useVersionHistory(initialHtml);
  const html = vh.current;
  const resetHistory = vh.reset; // 稳定引用
  const [annotate, setAnnotate] = useState(false);
  const [picked, setPicked] = useState<{ outerHTML: string; label: string } | null>(null);
  const [promptText, setPromptText] = useState("");
  const [busy, setBusy] = useState(false);
  const editReqIdRef = useRef(0);
  const [err, setErr] = useState<string | null>(null);
  const [pending, setPending] = useState<{ before: string; after: string; label: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  // 换一个网页打开时重置时间线
  useEffect(() => {
    resetHistory(initialHtml);
    setPending(null);
    setPicked(null);
    setAnnotate(false);
  }, [initialHtml, resetHistory]);

  // 圈点模式：往 iframe DOM 挂 hover 高亮 + 点选（同源可读 DOM；无 allow-scripts，页面脚本不跑）
  useEffect(() => {
    const ifr = iframeRef.current;
    if (!ifr || pending) return;
    let last: HTMLElement | null = null;
    const onOver = (e: Event) => {
      const t = e.target as HTMLElement;
      if (!t || !t.style) return;
      if (last) last.style.outline = "";
      last = t;
      t.style.outline = "2px solid #10a37f";
      t.style.outlineOffset = "-1px";
    };
    const onOut = () => { if (last) { last.style.outline = ""; last = null; } };
    const onClick = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      const t = e.target as HTMLElement;
      if (!t || !t.outerHTML) return;
      const txt = (t.textContent || "").trim().replace(/\s+/g, " ").slice(0, 20);
      setPicked({ outerHTML: t.outerHTML, label: `<${t.tagName.toLowerCase()}>${txt ? ` “${txt}…”` : ""}` });
      setPromptText("");
    };
    let doc: Document | null = null;
    const attach = () => {
      doc = ifr.contentDocument;
      if (!doc || !annotate) return;
      doc.addEventListener("mouseover", onOver, true);
      doc.addEventListener("mouseout", onOut, true);
      doc.addEventListener("click", onClick, true);
      if (doc.body) doc.body.style.cursor = "crosshair";
    };
    ifr.addEventListener("load", attach);
    attach(); // 已加载的情况
    return () => {
      ifr.removeEventListener("load", attach);
      if (doc) {
        doc.removeEventListener("mouseover", onOver, true);
        doc.removeEventListener("mouseout", onOut, true);
        doc.removeEventListener("click", onClick, true);
        if (last) last.style.outline = "";
        if (doc.body) doc.body.style.cursor = "";
      }
    };
  }, [annotate, html, pending]);

  const submitEdit = async () => {
    const ins = promptText.trim();
    if (!ins || !picked || busy) return;
    const rid = ++editReqIdRef.current;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.canvasEdit(html, ins, picked.outerHTML, "网页");
      if (rid !== editReqIdRef.current) return;
      if (res.content === html) setErr("这处没改出不一样的内容，换个说法再试");
      else setPending({ before: html, after: res.content, label: ins.slice(0, 16) });
    } catch (e) {
      if (rid !== editReqIdRef.current) return;
      setErr(getErrorMessage(e));
    } finally {
      if (rid === editReqIdRef.current) {
        setBusy(false);
        setPicked(null);
        setPromptText("");
      }
    }
  };
  const accept = () => {
    if (!pending) return;
    vh.commit(pending.after, pending.label || "圈点改");
    setPending(null);
  };

  const flash = (text: string, bad?: boolean) => {
    setSaveMsg({ text, bad });
    setTimeout(() => setSaveMsg(null), 3500);
  };
  const safeTitle = (title || "网页").replace(/[\\/:*?"<>|]/g, "").trim() || "网页";
  const saveAs = async () => {
    setSaveOpen(false);
    if (!electron?.files?.save) { flash("当前环境不支持另存为，请用「放进素材库」", true); return; }
    setSaving(true);
    try {
      const base64 = btoa(unescape(encodeURIComponent(html)));
      const r = await electron.files.save({ defaultName: `${safeTitle}.html`, base64, filters: [{ name: "网页", extensions: ["html"] }] });
      if (r.canceled) flash("已取消");
      else if (r.error) flash(r.error, true);
      else flash(`已存到电脑：${r.path}`);
    } catch (e) {
      flash(getErrorMessage(e), true);
    } finally {
      setSaving(false);
    }
  };
  const saveLib = async () => {
    setSaveOpen(false);
    setSaving(true);
    try {
      const r = await api.saveToLibrary(html, "html", safeTitle);
      flash(`已放进素材库：${r.path}`);
    } catch (e) {
      flash(getErrorMessage(e), true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 工具条 */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-black/[0.06] px-3 py-1.5 dark:border-white/[0.06]">
        <button
          type="button"
          onClick={() => { setAnnotate((v) => !v); setPicked(null); }}
          disabled={!!pending}
          className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12.5px] font-medium transition disabled:opacity-40 ${
            annotate ? "bg-[#10a37f] text-white" : "border border-black/[0.1] text-[#1d1d1f] hover:bg-black/[0.03] dark:border-white/[0.12] dark:text-[#c8cace] dark:hover:bg-white/[0.05]"
          }`}
        >
          <MousePointerClick className="h-3.5 w-3.5" /> {annotate ? "圈点中…点页面元素" : "圈点修改"}
        </button>
        <VersionBar versions={vh.versions} index={vh.index} onGoto={vh.goto} />
        <div className="flex-1" />
        <div className="relative">
          <button
            type="button"
            onClick={() => setSaveOpen((v) => !v)}
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#10a37f] px-2.5 py-1 text-[12.5px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.98] disabled:opacity-60"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "保存中…" : "保存到电脑"}
            {!saving && <ChevronDown className={`h-3 w-3 transition ${saveOpen ? "rotate-180" : ""}`} />}
          </button>
          {saveOpen && (
            <>
              <button type="button" aria-hidden tabIndex={-1} onClick={() => setSaveOpen(false)} className="fixed inset-0 z-40 cursor-default" />
              <div className="absolute right-0 top-[calc(100%+6px)] z-50 w-[240px] rounded-xl border border-black/[0.1] bg-white p-1.5 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.25)] dark:border-white/[0.1] dark:bg-[#1c1e24]">
                <button type="button" onClick={saveAs} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]">
                  <Download className="h-4 w-4 shrink-0 text-[#10a37f]" />
                  <span><span className="block text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">另存为网页…</span><span className="block text-[11.5px] text-[#86868b] dark:text-[#8a8c93]">选个文件夹存成 .html</span></span>
                </button>
                <button type="button" onClick={saveLib} className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]">
                  <FolderHeart className="h-4 w-4 shrink-0 text-[#10a37f]" />
                  <span><span className="block text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">放进素材库</span><span className="block text-[11.5px] text-[#86868b] dark:text-[#8a8c93]">存到软件里，随时回来找</span></span>
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {saveMsg && (
        <div className={`shrink-0 truncate px-3 py-1.5 text-[12px] ${saveMsg.bad ? "text-[#ff3b30] dark:text-[#ff8585]" : "text-[#10a37f]"}`} title={saveMsg.text}>{saveMsg.text}</div>
      )}

      {/* 主体：待确认时看 diff，否则看网页 */}
      <div className="relative min-h-0 flex-1">
        {pending ? (
          <div className="flex h-full flex-col">
            <div className="shrink-0 px-4 pt-3 text-[12px] text-[#86868b] dark:text-[#6e7077]">
              <span className="rounded bg-[#10a37f]/12 px-1.5 py-0.5 font-medium text-[#10a37f]">改这个元素</span>
              <span className="ml-2">看一下改动，满意就接受</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4"><DiffBlock before={pending.before} after={pending.after} /></div>
            <div className="flex shrink-0 items-center gap-2 border-t border-black/[0.06] p-3 dark:border-white/[0.06]">
              <button onClick={accept} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md bg-[#10a37f] text-[13px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.98]"><Check className="h-3.5 w-3.5" /> 接受改动</button>
              <button onClick={() => setPending(null)} className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-black/[0.1] bg-white text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"><X className="h-3.5 w-3.5" /> 放弃</button>
            </div>
          </div>
        ) : (
          <>
            <iframe ref={iframeRef} sandbox="allow-same-origin" srcDoc={html} title="网页预览" className="h-full w-full border-0 bg-white dark:bg-[#16181d]" />
            {annotate && !picked && (
              <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-black/70 px-3 py-1 text-[12px] text-white">点页面上任意地方，圈出要改的部分</div>
            )}
            {busy && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/55 backdrop-blur-[1px] dark:bg-black/45">
                <span className="flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-[12.5px] text-[#10a37f] shadow dark:bg-[#1c1e24]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在改这块…</span>
              </div>
            )}
          </>
        )}
      </div>

      {/* 选中元素后的改写输入条 */}
      {annotate && picked && !pending && (
        <div className="shrink-0 border-t border-black/[0.08] bg-[#f5f5f7] p-2.5 dark:border-white/[0.06] dark:bg-[#0b0c0e]">
          <div className="mb-1.5 flex items-center gap-2 text-[12px] text-[#86868b] dark:text-[#9a9ca3]">
            <Wand2 className="h-3.5 w-3.5 text-[#10a37f]" /> 改这个：<span className="truncate font-mono text-[#3a3a3c] dark:text-[#c8cace]">{picked.label}</span>
          </div>
          <div className="flex items-end gap-2">
            <textarea
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitEdit(); } if (e.key === "Escape") setPicked(null); }}
              autoFocus
              rows={2}
              placeholder="这块改成…（如：标题换成更醒目的、把这段缩短、按钮文字改成立即报名）"
              className="flex-1 resize-none rounded-md border border-black/[0.08] bg-white px-2.5 py-1.5 text-[12.5px] text-[#1d1d1f] outline-none placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.1] dark:bg-[#0e0f11] dark:text-[#e6e7e9] dark:placeholder:text-[#56585f]"
            />
            <button onClick={submitEdit} disabled={!promptText.trim() || busy} className="h-9 shrink-0 rounded-md bg-[#10a37f] px-3 text-[12.5px] font-medium text-white transition hover:bg-[#0e906f] active:scale-[0.98] disabled:opacity-40">改写</button>
          </div>
          {err && <div className="mt-1.5 text-[12px] text-[#ff3b30] dark:text-[#ff8585]">{err}</div>}
        </div>
      )}
      {!picked && err && <div className="shrink-0 px-3 pb-2 text-[12px] text-[#ff3b30] dark:text-[#ff8585]">{err}</div>}
    </div>
  );
}
