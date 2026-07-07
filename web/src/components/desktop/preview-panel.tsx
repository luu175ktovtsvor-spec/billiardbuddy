"use client";

/**
 * 桌面端右侧预览/画布面板（学 Claude Artifacts / ChatGPT Canvas）：
 * 把成品摆到右侧看清楚，并真正能在右侧就地改：
 *  ① 文案/文件：底部「整条改」+ 划选一段「基于此调整」。
 *     - 文案(content)：直接走 /canvas/edit 定向改写，只改选中那段、就地刷新（不绕一整轮对话）。
 *     - 文件(file)：走管家(agent) 路由，由它在原件上改并写回（带审批/备份）。
 *  ② 报表(sheet)：把本机 .xlsx 渲染成表格，点单元格就地改（/canvas/excel-edit，后端自动备份）。
 *  ③ 海报(poster)：图片预览 + 保存 + 整张重做（图不支持选区/文字改）。
 * 由 DesktopShell 的 preview 槽渲染；数据由 chat-shell 管，表格/定向改的接口调用在本面板内自洽。
 */
import { X, Download, Wand2, Copy, Check, Loader2, RotateCcw, Table2, FileText, CheckCircle2, RefreshCw, Save, ChevronDown, FolderHeart, Clapperboard, AlertTriangle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { useDesktop } from "@/hooks/use-desktop";
import { useHorizontalResize } from "./use-resize";
import { DiffBlock } from "./diff-block";
import { HtmlEditView } from "./html-edit-view";
import { DocEditView } from "./doc-edit-view";
import { useVersionHistory } from "./use-version-history";
import { VersionBar } from "./version-bar";
import { SafeMarkdown } from "./safe-markdown";

export type PreviewItem =
  // E1-C2・generationId：做成视频走 openWorkbench({fromGen}) handoff 要用它按 id 取图；只有等这轮
  // 对话/成品卡真正落库后才拿得到，图刚流式出来那一刻(仍在生成中)可能还没有——没有就不露"做成视频"按钮。
  | { kind: "poster"; title?: string; imageUrl: string; ratio?: string; width?: number; height?: number; generationId?: string }
  | { kind: "video"; title?: string; videoUrl: string; ratio?: string; duration?: number }
  | { kind: "content"; title?: string; text: string }
  | { kind: "file"; title?: string; path?: string; text: string }
  | { kind: "sheet"; title?: string; path: string }
  // 文档原样预览：PDF / Word(.docx) / PPT(.pptx) / 网页(.html)，由后端 /canvas/doc 读成可渲染数据
  | { kind: "doc"; title?: string; path: string }
  // 文件修改正在执行：模型已发起写入/编辑，完成后会自动切成 diff
  | { kind: "file_pending"; title?: string; path: string; tool: string }
  | { kind: "file_pending_list"; title?: string; paths: string[]; tool: string }
  | { kind: "file_error"; title?: string; path: string; tool: string; message: string }
  | { kind: "file_error_list"; title?: string; paths: string[]; tool: string; message: string }
  // B.2：AI 改了本机已有文件 → 拉"改前/改后"对比让老板确认（复用 DiffBlock）
  | { kind: "diff"; title?: string; path: string; backupPath?: string }
  | { kind: "diff_list"; title?: string; changes: { path: string; backupPath?: string }[] };

/** 0 基列序号 → Excel 列字母（0→A, 25→Z, 26→AA…）。 */
function colLetter(idx: number): string {
  let s = "";
  let n = idx;
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function fileName(path?: string): string {
  return path?.split(/[\\/]/).pop() || "文件";
}

type SheetData = { name: string; sheets: { name: string; rows: string[][] }[]; truncated: boolean };

/** 报表表格视图：读 .xlsx → 表格；点单元格内联编辑 → 就地改写（后端自动备份）。 */
function SheetView({ path }: { path: string }) {
  const [data, setData] = useState<SheetData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [editVal, setEditVal] = useState("");
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<{ msg: string; bad?: boolean } | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    setEditing(null);
    api
      .readSheet(path)
      .then((r) => { if (!cancelled) { setData(r); setActive(0); } })
      .catch((e) => { if (!cancelled) setErr(getErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path]);

  const sheet = data?.sheets[active];
  const colCount = sheet ? sheet.rows.reduce((m, row) => Math.max(m, row.length), 0) : 0;

  const startEdit = (r: number, c: number, cur: string) => {
    if (saving) return;
    setEditing({ r, c });
    setEditVal(cur);
  };

  const commit = async () => {
    if (!editing || !sheet || saving) return;
    const cell = colLetter(editing.c) + (editing.r + 1);
    const { r, c } = editing;
    setSaving(true);
    try {
      const res = await api.excelEditCell(path, cell, editVal, sheet.name);
      // 就地刷新这一格（不整表重拉）
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          sheets: prev.sheets.map((s, si) =>
            si !== active
              ? s
              : { ...s, rows: s.rows.map((row, ri) => (ri !== r ? row : row.map((cv, ci) => (ci === c ? res.new : cv)))) },
          ),
        };
      });
      setToast({ msg: `${cell}：${res.old || "（空）"} → ${res.new || "（空）"}` });
      setEditing(null);
    } catch (e) {
      setToast({ msg: getErrorMessage(e), bad: true });
    } finally {
      setSaving(false);
      setTimeout(() => setToast(null), 3000);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-[#86868b] dark:text-[#6e7077]">
        <Loader2 className="h-4 w-4 animate-spin" /> 正在读取报表…
      </div>
    );
  }
  if (err) {
    return (
      <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-[#ff3b30] dark:text-[#ff8585]">{err}</div>
    );
  }
  if (!sheet || sheet.rows.length === 0) {
    return <div className="flex flex-1 items-center justify-center text-[13px] text-[#86868b] dark:text-[#6e7077]">（空表）</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 多 sheet 切换 */}
      {data && data.sheets.length > 1 && (
        <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-black/[0.06] px-3 py-1.5 dark:border-white/[0.06]">
          {data.sheets.map((s, i) => (
            <button
              key={s.name + i}
              type="button"
              onClick={() => { setActive(i); setEditing(null); }}
              className={`shrink-0 rounded-md px-2.5 py-1 text-[12px] transition ${
                i === active
                  ? "bg-[#10a37f]/12 font-medium text-[#10a37f]"
                  : "text-[#6e6e73] hover:bg-black/[0.04] dark:text-[#9a9ca3] dark:hover:bg-white/[0.05]"
              }`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* 表格本体 */}
      <div className="min-h-0 flex-1 overflow-auto p-3">
        <table className="border-collapse font-mono text-[12px]">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 border border-black/[0.08] bg-[#ececf0] px-2 py-1 text-[#86868b] dark:border-white/[0.08] dark:bg-[#23252b] dark:text-[#6e7077]"></th>
              {Array.from({ length: colCount }, (_, c) => (
                <th
                  key={c}
                  className="sticky top-0 z-10 min-w-[70px] border border-black/[0.08] bg-[#ececf0] px-2 py-1 font-medium text-[#86868b] dark:border-white/[0.08] dark:bg-[#23252b] dark:text-[#9a9ca3]"
                >
                  {colLetter(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows.map((row, r) => (
              <tr key={r}>
                <td className="sticky left-0 z-10 border border-black/[0.08] bg-[#ececf0] px-2 py-1 text-center text-[#86868b] dark:border-white/[0.08] dark:bg-[#23252b] dark:text-[#6e7077]">
                  {r + 1}
                </td>
                {Array.from({ length: colCount }, (_, c) => {
                  const val = row[c] ?? "";
                  const isEditing = editing?.r === r && editing?.c === c;
                  return (
                    <td key={c} className="border border-black/[0.08] p-0 dark:border-white/[0.08]">
                      {isEditing ? (
                        <input
                          value={editVal}
                          autoFocus
                          disabled={saving}
                          onChange={(e) => setEditVal(e.target.value)}
                          onBlur={commit}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") { e.preventDefault(); commit(); }
                            if (e.key === "Escape") { e.preventDefault(); setEditing(null); }
                          }}
                          className="block w-full min-w-[70px] bg-white px-2 py-1 text-[12px] text-[#1d1d1f] outline outline-2 outline-[#10a37f] dark:bg-[#0e0f11] dark:text-[#e6e7e9]"
                        />
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEdit(r, c, val)}
                          title="点击修改这个格子"
                          className="block w-full max-w-[260px] truncate px-2 py-1 text-left text-[#1d1d1f] transition hover:bg-[#10a37f]/[0.08] dark:text-[#c8cace]"
                        >
                          {val || " "}
                        </button>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 底部状态：保存中 / diff 提示 / 截断说明 */}
      <div className="shrink-0 border-t border-black/[0.06] px-3 py-2 text-[11.5px] dark:border-white/[0.06]">
        {saving ? (
          <span className="flex items-center gap-1.5 text-[#86868b] dark:text-[#6e7077]"><Loader2 className="h-3 w-3 animate-spin" /> 正在保存到报表…</span>
        ) : toast ? (
          <span className={toast.bad ? "text-[#ff3b30] dark:text-[#ff8585]" : "text-[#10a37f]"}>
            {toast.bad ? "修改失败：" : "已改 · "}{toast.msg}
          </span>
        ) : (
          <span className="text-[#86868b] dark:text-[#6e7077]">
            点任意格子即可修改，改前自动备份 · 共 {sheet.rows.length} 行
            {data?.truncated && " · 表太大已截断显示"}
          </span>
        )}
      </div>
    </div>
  );
}

type DocData = {
  name: string;
  render: "pdf" | "page" | "richtext" | "slides" | "toobig";
  pdf_base64?: string;
  html?: string;
  slides?: { title: string; bullets: string[] }[];
  message?: string;
  truncated?: boolean;
};

// Word 转出来的是 HTML 片段，套个带样式的壳塞进 iframe（跟随系统深浅色）；网页(.html)本身是整页、不再包壳。
function wrapRichText(fragment: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:-apple-system,system-ui,"PingFang SC",sans-serif;font-size:14px;line-height:1.75;color:#1d1d1f;margin:0;padding:20px;}
    h1{font-size:20px;margin:.6em 0 .3em;} h2{font-size:17px;margin:.6em 0 .3em;} h3{font-size:15px;margin:.5em 0 .3em;}
    p{margin:.4em 0;} li{margin:.2em 0;}
    table{border-collapse:collapse;margin:10px 0;width:100%;} td{border:1px solid #d0d0d5;padding:5px 9px;}
    @media (prefers-color-scheme: dark){ body{color:#e6e7e9;background:#16181d;} td{border-color:#3a3c42;} }
  </style></head><body>${fragment}</body></html>`;
}

/** 文档原样预览：PDF(Chromium原生) / 网页(.html) / Word(转HTML) / PPT(逐页大纲)。 */
function DocView({ path }: { path: string }) {
  const [data, setData] = useState<DocData | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const blobRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setErr(null);
    if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null; }
    setPdfUrl(null);
    api
      .readDoc(path)
      .then((r) => {
        if (cancelled) return;
        setData(r);
        if (r.render === "pdf" && r.pdf_base64) {
          // base64 → blob → objectURL：用 Chromium 自带 PDF 查看器原样翻页，无需 pdf.js
          const bytes = Uint8Array.from(atob(r.pdf_base64), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
          blobRef.current = url;
          setPdfUrl(url);
        }
      })
      .catch((e) => { if (!cancelled) setErr(getErrorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => {
      cancelled = true;
      if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null; }
    };
  }, [path]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-2 text-[13px] text-[#86868b] dark:text-[#6e7077]">
        <Loader2 className="h-4 w-4 animate-spin" /> 正在打开文档…
      </div>
    );
  }
  if (err) {
    return <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-[#ff3b30] dark:text-[#ff8585]">{err}</div>;
  }
  if (!data) return null;

  if (data.render === "toobig") {
    return <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-[#86868b] dark:text-[#6e7077]">{data.message || "文件太大，无法预览"}</div>;
  }
  if (data.render === "pdf") {
    return pdfUrl ? (
      <iframe src={pdfUrl} title="PDF 预览" className="min-h-0 flex-1 border-0 bg-white dark:bg-[#0b0c0e]" />
    ) : null;
  }
  if (data.render === "page") {
    // 网页：可圈可点编辑（点元素→说怎么改→AI 改→diff→保存）
    return <HtmlEditView initialHtml={data.html || ""} title={data.name || "网页"} />;
  }
  if (data.render === "richtext") {
    // Word 转出来的富文本：只读预览（sandbox 不含 allow-scripts，安全）
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <iframe sandbox="" srcDoc={wrapRichText(data.html || "")} title="文档预览" className="min-h-0 flex-1 border-0 bg-white dark:bg-[#16181d]" />
        {data.truncated && <div className="shrink-0 border-t border-black/[0.06] px-3 py-1.5 text-[11.5px] text-[#86868b] dark:border-white/[0.06] dark:text-[#6e7077]">内容较长，已截断预览</div>}
      </div>
    );
  }
  // slides：逐页大纲卡
  const slides = data.slides || [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-4">
      {slides.length === 0 ? (
        <div className="py-10 text-center text-[13px] text-[#86868b] dark:text-[#6e7077]">（这份 PPT 没有文字内容）</div>
      ) : (
        <div className="flex flex-col gap-3">
          {slides.map((s, i) => (
            <div key={i} className="rounded-lg border border-black/[0.08] bg-white p-3.5 shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
              <div className="mb-1.5 flex items-center gap-2">
                <span className="rounded bg-[#10a37f]/12 px-1.5 py-0.5 font-mono text-[10px] text-[#10a37f]">第 {i + 1} 页</span>
                {s.title && <span className="truncate text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">{s.title}</span>}
              </div>
              {s.bullets.length > 0 && (
                <ul className="ml-4 list-disc space-y-0.5 text-[13px] leading-relaxed text-[#3a3a3c] dark:text-[#c8cace]">
                  {s.bullets.map((b, j) => <li key={j}>{b}</li>)}
                </ul>
              )}
            </div>
          ))}
          {data.truncated && <div className="py-2 text-center text-[11.5px] text-[#86868b] dark:text-[#6e7077]">页数较多，已截断预览</div>}
        </div>
      )}
    </div>
  );
}

// 选区改的快捷动作（对齐 ChatGPT Canvas 的预设：非技术老板一键改文案，比裸输入好用）
const QUICK_ACTIONS: { label: string; instruction: string }[] = [
  { label: "更短", instruction: "在不丢关键信息的前提下精简这段，更短更利落" },
  { label: "更口语", instruction: "把这段改得更口语、像跟顾客聊天那样自然" },
  { label: "更热情", instruction: "把这段改得更热情、更有感染力，让人想参与" },
  { label: "更正式", instruction: "把这段改得更正式、更稳重得体" },
  { label: "换个说法", instruction: "保持意思不变，换一种说法重写这段" },
  { label: "挑错别字", instruction: "只修这段里的错别字和标点、语病，别改写风格和意思" },
];

// DiffBlock 已抽到 ./diff-block（文案、网页 HTML 等改写共用）。

/** B.2：AI 改了本机已有文件 → 拉"改前/改后"对比（old=最近备份、new=当前），复用 DiffBlock 渲染。 */
function DiffPreview({ path, backupPath }: { path: string; backupPath?: string }) {
  const [data, setData] = useState<{ old: string; neu: string; backupPath?: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setData(null); setErr(null); setMsg(null);
    api.fileDiff(path, backupPath)
      .then((r) => { if (cancelled) return; if (r.ok) setData({ old: r.old || "", neu: r.new || "", backupPath: r.backup_path || backupPath }); else setErr(r.error || "暂时打不开改动对比"); })
      .catch(() => { if (!cancelled) setErr("暂时打不开改动对比"); });
    return () => { cancelled = true; };
  }, [path, backupPath]);
  const restore = async () => {
    if (busy || !data) return;
    setBusy(true); setMsg(null); setErr(null);
    try {
      const r = await api.fileRestore(path, data.backupPath || backupPath);
      if (!r.ok) {
        setErr(r.error || "恢复失败");
        return;
      }
      const diff = await api.fileDiff(path, r.current_backup_path || undefined);
      setData({ old: diff.old || "", neu: diff.new || "", backupPath: diff.backup_path || r.current_backup_path || data.backupPath });
      setMsg("已恢复到备份。当前版本也已另存一份备份，可再回退。");
    } catch (e) {
      setErr(getErrorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  if (err) return <div className="flex-1 p-4 text-[12.5px] text-[#86868b] dark:text-[#6e7077]">{err}</div>;
  if (!data) return <div className="flex-1 p-4 text-[12.5px] text-[#a1a1a6]">读取改动中…</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 px-4 pt-3 text-[12px] text-[#86868b] dark:text-[#6e7077]">
        <span className="min-w-0 flex-1">这份文件改了哪几处（红删绿增）：</span>
        <button
          type="button"
          onClick={restore}
          disabled={busy || !data.backupPath}
          className="flex h-7 items-center gap-1 rounded-md border border-black/[0.08] bg-white px-2 text-[11.5px] text-[#3a3a3c] transition hover:bg-black/[0.03] disabled:opacity-50 dark:border-white/[0.08] dark:bg-[#16181d] dark:text-[#c8cace] dark:hover:bg-white/[0.05]"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
          恢复到备份
        </button>
      </div>
      {msg && <div className="mx-4 mt-2 rounded-md bg-[#10a37f]/10 px-2.5 py-1.5 text-[12px] text-[#10a37f]">{msg}</div>}
      <div className="min-h-0 flex-1 overflow-auto p-4"><DiffBlock before={data.old} after={data.neu} /></div>
    </div>
  );
}

function DiffListPreview({ changes }: { changes: { path: string; backupPath?: string }[] }) {
  const [active, setActive] = useState(0);
  const signature = changes.map(change => `${change.path}\u0000${change.backupPath || ""}`).join("\u0001");
  useEffect(() => {
    setActive(0);
  }, [signature]);
  const activeChange = changes[Math.min(active, Math.max(0, changes.length - 1))];
  if (!activeChange) return <div className="flex-1 p-4 text-[12.5px] text-[#86868b] dark:text-[#6e7077]">没有可展示的文件改动。</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 overflow-x-auto border-b border-black/[0.06] px-3 py-2 dark:border-white/[0.06]">
        <span className="shrink-0 text-[12px] text-[#86868b] dark:text-[#6e7077]">{changes.length} 个文件</span>
        {changes.map((change, index) => (
          <button
            key={`${change.path}:${index}`}
            type="button"
            onClick={() => setActive(index)}
            className={`min-w-[96px] max-w-[180px] truncate rounded-md border px-2.5 py-1.5 text-left font-mono text-[11.5px] transition ${
              index === active
                ? "border-black/[0.14] bg-white text-[#1d1d1f] shadow-sm dark:border-white/[0.12] dark:bg-[#16181d] dark:text-[#e6e7e9]"
                : "border-transparent text-[#86868b] hover:bg-black/[0.04] hover:text-[#3a3a3c] dark:text-[#8a8c93] dark:hover:bg-white/[0.05] dark:hover:text-[#c8cace]"
            }`}
            title={change.path}
          >
            {fileName(change.path)}
          </button>
        ))}
      </div>
      <DiffPreview path={activeChange.path} backupPath={activeChange.backupPath} />
    </div>
  );
}

function PendingFileChangeView({ path, tool }: { path: string; tool: string }) {
  const action = tool === "write_file"
    ? "正在写入"
    : tool === "patch_file"
      ? "正在应用补丁"
      : tool === "patch_files"
        ? "正在应用多文件补丁"
        : tool === "multi_edit_file"
          ? "正在批量修改"
          : "正在修改";
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-black/[0.06] bg-white text-[#10a37f] shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
        <Loader2 className="h-4 w-4 animate-spin" />
      </div>
      <div className="max-w-full truncate text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">
        {action} {fileName(path)}
      </div>
      <div className="mt-1 max-w-full truncate font-mono text-[11.5px] text-[#86868b] dark:text-[#6e7077]" title={path}>
        {path}
      </div>
      <div className="mt-3 text-[12px] text-[#a1a1a6] dark:text-[#56585f]">完成后显示改动对比</div>
    </div>
  );
}

function PendingFileChangeListView({ paths, tool }: { paths: string[]; tool: string }) {
  const action = tool === "patch_files" ? "正在应用多文件补丁" : "正在修改多个文件";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-black/[0.06] px-4 py-3 text-[12px] text-[#86868b] dark:border-white/[0.06] dark:text-[#6e7077]">
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-[#10a37f]" />
        <span className="min-w-0 flex-1 truncate">{action}</span>
        <span className="shrink-0 font-mono text-[11px] text-[#a1a1a6] dark:text-[#6e7077]">{paths.length} files</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="overflow-hidden rounded-md border border-black/[0.06] bg-white shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
          {paths.map((path, index) => (
            <div key={`${path}:${index}`} className="flex min-w-0 items-center gap-2 border-t border-black/[0.05] px-3 py-2 first:border-t-0 dark:border-white/[0.06]">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[#10a37f]/10 font-mono text-[10px] text-[#0b8064] dark:text-[#70d7bd]">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#3a3a3c] dark:text-[#c8cace]" title={path}>
                {path}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 text-center text-[12px] text-[#a1a1a6] dark:text-[#56585f]">完成后显示每个文件的改动对比</div>
      </div>
    </div>
  );
}

function FileChangeErrorView({ path, message }: { path: string; message: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-6 text-center">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md border border-[#ff3b30]/15 bg-[#ff3b30]/[0.05] text-[#c4352b] dark:border-[#ff8585]/20 dark:bg-[#ff8585]/[0.08] dark:text-[#ff8585]">
        <AlertTriangle className="h-4 w-4" />
      </div>
      <div className="max-w-full truncate text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">
        没有写入 {fileName(path)}
      </div>
      <div className="mt-1 max-w-full truncate font-mono text-[11.5px] text-[#86868b] dark:text-[#6e7077]" title={path}>
        {path}
      </div>
      <div className="mt-3 max-w-[360px] rounded-md border border-black/[0.06] bg-white px-3 py-2 text-left text-[12px] leading-relaxed text-[#6e6e73] dark:border-white/[0.08] dark:bg-[#16181d] dark:text-[#9a9ca3]">
        {message}
      </div>
    </div>
  );
}

function FileChangeErrorListView({ paths, message }: { paths: string[]; message: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-black/[0.06] px-4 py-3 text-[12px] text-[#86868b] dark:border-white/[0.06] dark:text-[#6e7077]">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[#c4352b] dark:text-[#ff8585]" />
        <span className="min-w-0 flex-1 truncate">这些文件没有写入</span>
        <span className="shrink-0 font-mono text-[11px] text-[#a1a1a6] dark:text-[#6e7077]">{paths.length} files</span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="overflow-hidden rounded-md border border-black/[0.06] bg-white shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
          {paths.map((path, index) => (
            <div key={`${path}:${index}`} className="flex min-w-0 items-center gap-2 border-t border-black/[0.05] px-3 py-2 first:border-t-0 dark:border-white/[0.06]">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded bg-[#ff3b30]/10 font-mono text-[10px] text-[#c4352b] dark:text-[#ff8585]">
                {index + 1}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-[#3a3a3c] dark:text-[#c8cace]" title={path}>
                {path}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-3 rounded-md border border-black/[0.06] bg-white px-3 py-2 text-[12px] leading-relaxed text-[#6e6e73] dark:border-white/[0.08] dark:bg-[#16181d] dark:text-[#9a9ca3]">
          {message}
        </div>
      </div>
    </div>
  );
}

export function DesktopPreviewPanel({
  item,
  onClose,
  onRefine,
  onRefineSelection,
  onFinalize,
  onMakeVideo,
}: {
  item: PreviewItem;
  onClose: () => void;
  onRefine?: (kind: PreviewItem["kind"]) => void;
  /** 选区改（仅 file 用，走管家路由）：把选中的原文 + 要改成啥发给管家，由它改原件并写回。 */
  onRefineSelection?: (selectedText: string, instruction: string) => void;
  /** 定稿闸：老板看完拍板。accept=确认采用这一版(content/file 带最终文字)；redo=重做一版。 */
  onFinalize?: (action: "accept" | "redo", finalText?: string) => void;
  onMakeVideo?: (item: Extract<PreviewItem, { kind: "poster" }>) => void;
}) {
  const { electron } = useDesktop();
  const [copied, setCopied] = useState(false);
  // 「保存到电脑」面板：选存成什么(Word/网页/纯文字/Markdown) + 存哪儿(另存为/素材库)
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveFmt, setSaveFmt] = useState("docx");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const { width, onHandleMouseDown } = useHorizontalResize({
    storageKey: "desktop.previewWidth", defaultWidth: 440, min: 320, max: 720, edge: "left",
  });

  // 文案/文件的就地工作副本：content 走 canvasEdit 在此基础上就地改写；file 仅作展示（改由管家写回原件）。
  const isText = item.kind === "content" || item.kind === "file";
  // 版本检查点：每次接受改写存一版，可回看/跳任意一版（取代旧的撤销栈）
  const vh = useVersionHistory(isText ? (item as { text: string }).text : "");
  const workText = vh.current;
  const edited = vh.index > 0;
  const resetHistory = vh.reset; // 稳定引用，供换预览对象时清时间线
  const [busy, setBusy] = useState(false);
  const [editErr, setEditErr] = useState<string | null>(null);
  const reqIdRef = useRef(0);
  // 待确认的改写（对齐 cc：改完不直接落，先出 diff 给老板 接受/放弃）
  const [pending, setPending] = useState<{ before: string; after: string; label: string } | null>(null);
  // 切换预览对象时重置时间线/待确认
  useEffect(() => {
    resetHistory(isText ? (item as { text: string }).text : "");
    setEditErr(null);
    setPending(null);
  }, [item, isText, resetHistory]);

  // 选区浮窗：划中一段 → 冒出"基于此调整"
  const bodyRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState<{ text: string; top: number; left: number } | null>(null);
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineText, setRefineText] = useState("");
  // 整条改输入条（content 内联，走 canvasEdit）
  const [wholeOpen, setWholeOpen] = useState(false);
  const [wholeText, setWholeText] = useState("");

  const selectable = (item.kind === "content" || (item.kind === "file" && !!onRefineSelection)) && !busy && !pending;
  const directEdit = item.kind === "content"; // content 直连 canvasEdit；file 走管家

  const copy = async () => {
    if (item.kind === "poster" || item.kind === "video" || item.kind === "sheet") return;
    try {
      await navigator.clipboard.writeText(workText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* 忽略 */ }
  };

  // 调定向改接口：selection 传则只改那段，否则整篇修订。改完不直接落 → 进 pending 等老板看 diff 后拍板。
  const runCanvasEdit = async (instruction: string, selection: string | undefined, label: string) => {
    if (busy) return;
    const rid = ++reqIdRef.current;
    setBusy(true);
    setEditErr(null);
    try {
      const res = await api.canvasEdit(workText, instruction, selection, item.title);
      if (rid !== reqIdRef.current) return;
      if (res.content === workText) {
        setEditErr("这次没改出不一样的内容，换个说法再试试");
      } else {
        setPending({ before: workText, after: res.content, label });
      }
    } catch (e) {
      if (rid !== reqIdRef.current) return;
      setEditErr(getErrorMessage(e));
    } finally {
      if (rid === reqIdRef.current) setBusy(false);
    }
  };
  // 接受 diff：存为新一版（进版本时间线）
  const acceptPending = () => {
    if (!pending) return;
    vh.commit(pending.after, pending.label || "改写");
    setPending(null);
  };
  const rejectPending = () => setPending(null);

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
  // 选区改：自定义指令或预设快捷动作。content 走 canvasEdit 出 diff；file 走管家。
  const runSelEdit = async (instruction: string) => {
    if (!instruction.trim() || !sel) return;
    const selectedText = sel.text;
    setSel(null);
    setRefineOpen(false);
    setRefineText("");
    if (directEdit) {
      await runCanvasEdit(instruction, selectedText, "改这段");
    } else if (onRefineSelection) {
      onRefineSelection(selectedText, instruction);
    }
  };
  const submitRefine = () => runSelEdit(refineText.trim());
  const submitWhole = async () => {
    const ins = wholeText.trim();
    if (!ins) return;
    setWholeText("");
    setWholeOpen(false);
    await runCanvasEdit(ins, undefined, "整条改");
  };
  const reset = () => {
    vh.goto(0);          // 复原 = 回到最初那一版（时间线仍在，可再跳回去）
    setEditErr(null);
    setPending(null);
  };

  // 「保存到电脑」：存成什么格式（大白话名 + 文件后缀）
  const SAVE_FORMATS: { fmt: string; label: string; ext: string }[] = [
    { fmt: "docx", label: "Word 文档", ext: "docx" },
    { fmt: "html", label: "网页", ext: "html" },
    { fmt: "txt", label: "纯文字", ext: "txt" },
    { fmt: "md", label: "Markdown", ext: "md" },
  ];
  const saveTitle = (item.title || "成品").replace(/[\\/:*?"<>|]/g, "").trim() || "成品";
  const flashSave = (text: string, bad?: boolean) => {
    setSaveMsg({ text, bad });
    setTimeout(() => setSaveMsg(null), 3500);
  };
  const showSavedLocation = async () => {
    if (!savedPath || !electron?.files?.showInFolder) return;
    const r = await electron.files.showInFolder(savedPath);
    if (!r.ok && r.error) flashSave(r.error, true);
  };
  const saveMediaAsFile = async () => {
    if (saving || (item.kind !== "poster" && item.kind !== "video")) return;
    if (!electron?.files?.save) { flashSave("当前环境不支持保存到电脑", true); return; }
    const url = item.kind === "poster" ? item.imageUrl : item.videoUrl;
    const isVideo = item.kind === "video";
    const defaultExt = isVideo ? "mp4" : "png";
    const fromUrl = url.split("?")[0].split("#")[0].split("/").pop() || `${saveTitle}.${defaultExt}`;
    const cleanName = fromUrl.includes(".") ? fromUrl : `${saveTitle}.${defaultExt}`;
    setSaving(true);
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error("下载成品失败，请稍后再试");
      const blob = await res.blob();
      const buffer = await blob.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const r = await electron.files.save({
        defaultName: cleanName.replace(/[\\/:*?"<>|]/g, "") || `${saveTitle}.${defaultExt}`,
        base64: btoa(binary),
        title: isVideo ? "保存视频到本机" : "保存图片到本机",
        filters: isVideo
          ? [{ name: "视频", extensions: ["mp4", "mov", "webm"] }]
          : [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp"] }],
      });
      if (r.canceled) flashSave("已取消");
      else if (r.error) flashSave(r.error, true);
      else {
        setSavedPath(r.path || null);
        flashSave(`已存到电脑：${r.path}`);
      }
    } catch (e) {
      flashSave(getErrorMessage(e), true);
    } finally {
      setSaving(false);
    }
  };
  // 另存为：渲染成所选格式 → 走系统「保存」对话框写到老板选的位置
  const saveAsFile = async (f: { fmt: string; label: string; ext: string }) => {
    if (saving) return;
    setSaveOpen(false);
    if (!electron?.files?.save) { flashSave("当前环境不支持另存为，请用「放进素材库」", true); return; }
    setSaving(true);
    try {
      const { base64 } = await api.renderDeliverable(workText, f.fmt);
      const r = await electron.files.save({
        defaultName: `${saveTitle}.${f.ext}`,
        base64,
        filters: [{ name: f.label, extensions: [f.ext] }],
      });
      if (r.canceled) flashSave("已取消");
      else if (r.error) flashSave(r.error, true);
      else {
        setSavedPath(r.path || null);
        flashSave(`已存到电脑：${r.path}`);
      }
    } catch (e) {
      flashSave(getErrorMessage(e), true);
    } finally {
      setSaving(false);
    }
  };
  // 放进素材库：存到软件「内容库/成品」
  const saveToLib = async (f: { fmt: string; label: string; ext: string }) => {
    if (saving) return;
    setSaveOpen(false);
    setSaving(true);
    try {
      const r = await api.saveToLibrary(workText, f.fmt, saveTitle);
      setSavedPath(r.path || null);
      flashSave(`已放进素材库：${r.path}`);
    } catch (e) {
      flashSave(getErrorMessage(e), true);
    } finally {
      setSaving(false);
    }
  };

  const headerName =
    item.title ||
    (item.kind === "poster" ? "海报预览"
      : item.kind === "video" ? "视频预览"
      : item.kind === "sheet" ? fileName(item.path)
      : item.kind === "doc" ? fileName(item.path)
      : item.kind === "file_pending" ? `${fileName(item.path)} · 正在修改`
      : item.kind === "file_pending_list" ? `${item.paths.length} 个文件 · 正在修改`
      : item.kind === "file_error" ? `${fileName(item.path)} · 未修改`
      : item.kind === "file_error_list" ? `${item.paths.length} 个文件 · 未修改`
      : item.kind === "diff" ? `${fileName(item.path)} · 改动对比`
      : item.kind === "diff_list" ? `${item.changes.length} 个文件 · 改动对比`
      : item.kind === "file" ? fileName(item.path)
      : "成品预览");

  return (
    <section style={{ width }} className="relative flex shrink-0 flex-col border-l border-black/[0.08] bg-[#f5f5f7] dark:border-white/[0.06] dark:bg-[#0b0c0e]">
      {/* 面板头 */}
      <div className="app-drag app-titlebar-safe-right flex h-[44px] items-center justify-between border-b border-black/[0.08] px-4 dark:border-white/[0.06]">
        <div className="min-w-0 truncate font-mono text-[12.5px] text-[#6e6e73] dark:text-[#9a9ca3]">
          {item.kind === "sheet" && <Table2 className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-[#10a37f]" />}
          {item.kind === "doc" && <FileText className="mr-1.5 inline h-3.5 w-3.5 align-[-2px] text-[#10a37f]" />}
          {headerName}
          {selectable && directEdit && <span className="ml-2 text-[#b0b0b5] dark:text-[#56585f]">· 划选一段可就地改</span>}
          {edited && <span className="ml-2 text-[#10a37f]">· 已就地改写</span>}
        </div>
        <button
          onClick={onClose}
          className="app-no-drag flex h-7 w-7 items-center justify-center rounded-md text-[#86868b] transition hover:bg-black/[0.06] hover:text-[#1d1d1f] dark:text-[#6e7077] dark:hover:bg-white/[0.06] dark:hover:text-[#c8cace]"
          aria-label="收起预览"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* 预览体 */}
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
        ) : item.kind === "video" ? (
          <div className="flex flex-1 items-center justify-center overflow-hidden bg-black/[0.04] p-4 dark:bg-black/40">
            <video
              src={item.videoUrl}
              controls
              className="max-h-full max-w-full rounded-xl bg-black shadow-[0_10px_34px_rgba(0,0,0,0.2)] dark:shadow-[0_10px_34px_rgba(0,0,0,0.5)]"
            />
          </div>
        ) : item.kind === "sheet" ? (
          <SheetView path={item.path} />
        ) : item.kind === "doc" ? (
          // Word/PPT → 文字级编辑(写回原文件)；PDF/网页 → DocView(网页可圈可点 / PDF 原样)
          /\.(docx|pptx)$/i.test(item.path) ? <DocEditView path={item.path} title={item.title || fileName(item.path)} /> : <DocView path={item.path} />
        ) : item.kind === "file_pending" ? (
          <PendingFileChangeView path={item.path} tool={item.tool} />
        ) : item.kind === "file_pending_list" ? (
          <PendingFileChangeListView paths={item.paths} tool={item.tool} />
        ) : item.kind === "file_error" ? (
          <FileChangeErrorView path={item.path} message={item.message} />
        ) : item.kind === "file_error_list" ? (
          <FileChangeErrorListView paths={item.paths} message={item.message} />
        ) : item.kind === "diff" ? (
          <DiffPreview path={item.path} backupPath={item.backupPath} />
        ) : item.kind === "diff_list" ? (
          <DiffListPreview changes={item.changes} />
        ) : item.kind === "file" ? (
          <div className="flex-1 overflow-auto p-4">
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-black/[0.08] bg-white p-3.5 font-mono text-[12px] leading-relaxed text-[#1d1d1f] shadow-sm dark:border-white/[0.08] dark:bg-[#16181d] dark:text-[#c8cace] dark:shadow-none">{workText}</pre>
          </div>
        ) : pending ? (
          // 待确认改写：对齐 cc——先看 diff(旧红/新绿带上下文)，再 接受/放弃
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 px-4 pt-3 text-[12px] text-[#86868b] dark:text-[#6e7077]">
              <span className="rounded bg-[#10a37f]/12 px-1.5 py-0.5 font-medium text-[#10a37f]">{pending.label}</span>
              <span className="ml-2">看一下改动，满意就接受</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-4">
              <DiffBlock before={pending.before} after={pending.after} />
            </div>
          </div>
        ) : (
          <div className="relative flex-1 overflow-y-auto p-5">
            <div className="prose prose-sm prose-slate dark:prose-invert max-w-none rounded-lg border border-black/[0.08] bg-white p-4 shadow-sm prose-p:my-1.5 dark:border-white/[0.08] dark:bg-[#16181d] dark:shadow-none">
              <SafeMarkdown>{workText}</SafeMarkdown>
            </div>
            {busy && (
              <div className="absolute inset-0 flex items-center justify-center bg-white/55 backdrop-blur-[1px] dark:bg-black/45">
                <span className="flex items-center gap-2 rounded-full bg-white px-3 py-1.5 text-[12.5px] text-[#10a37f] shadow dark:bg-[#1c1e24]"><Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在改写…</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 选区浮窗 */}
      {selectable && sel && (
        <div
          style={{ position: "fixed", top: Math.max(8, sel.top - (refineOpen ? 118 : 42)), left: sel.left, transform: "translateX(-50%)" }}
          className="z-50"
        >
          {!refineOpen ? (
            <button
              type="button"
              onClick={() => setRefineOpen(true)}
              className="app-primary-action flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[12.5px] font-medium shadow-lg transition active:scale-[0.97]"
            >
              <Wand2 className="h-3.5 w-3.5" /> 基于此调整
            </button>
          ) : (
            <div className="w-[268px] rounded-lg border border-black/[0.1] bg-white p-2 shadow-xl dark:border-white/[0.12] dark:bg-[#1c1e24]">
              <div className="mb-1.5 line-clamp-2 rounded bg-black/[0.04] px-2 py-1 text-[11px] text-[#86868b] dark:bg-white/[0.05] dark:text-[#9a9ca3]">改这段：「{sel.text.length > 40 ? sel.text.slice(0, 40) + "…" : sel.text}」</div>
              {/* 预设快捷动作（对齐 ChatGPT Canvas）：一键改，无需打字 */}
              {directEdit && (
                <div className="mb-1.5 flex flex-wrap gap-1">
                  {QUICK_ACTIONS.map((q) => (
                    <button
                      key={q.label}
                      type="button"
                      onClick={() => void runSelEdit(q.instruction)}
                      className="rounded-full border border-black/[0.08] bg-black/[0.02] px-2 py-0.5 text-[11.5px] text-[#3a3a3c] transition hover:border-[#10a37f]/40 hover:bg-[#10a37f]/[0.08] hover:text-[#10a37f] active:scale-[0.97] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace]"
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              )}
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
                  className="app-primary-action rounded-md px-2.5 py-1 text-[12px] font-medium transition active:scale-[0.98] disabled:opacity-40"
                >
                  {directEdit ? "改写这段" : "发送给管家"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 工具条（海报/文案/文件 + 定稿闸；报表不需要——点格即改；doc 仅在有定稿闸时显示底栏） */}
      {item.kind !== "sheet" && item.kind !== "doc" && item.kind !== "file_pending" && item.kind !== "file_pending_list" && item.kind !== "file_error" && item.kind !== "file_error_list" && item.kind !== "diff" && item.kind !== "diff_list" && (
        <div className="border-t border-black/[0.08] p-3 dark:border-white/[0.06]">
          {item.kind === "poster" && (item.ratio || item.width || item.height) && (
            <div className="mb-2 text-center font-mono text-[11px] text-[#86868b] dark:text-[#6e7077]">
              {[item.ratio, item.width && item.height ? `${item.width}x${item.height}` : ""].filter(Boolean).join(" · ")}
            </div>
          )}
          {item.kind === "poster" && onMakeVideo && item.generationId && (
            <div className="mb-2 rounded-md bg-[#ff9500]/10 px-2 py-1.5 text-center text-[11.5px] leading-relaxed text-[#9a5b00] dark:text-[#ffcc80]">
              做成视频会带这张图跳到视频工作台，在那边配置运镜/时长再生成。
            </div>
          )}
          {item.kind === "video" && (item.ratio || item.duration) && (
            <div className="mb-2 text-center font-mono text-[11px] text-[#86868b] dark:text-[#6e7077]">
              {[item.ratio, item.duration ? `${item.duration}秒` : ""].filter(Boolean).join(" · ")}
            </div>
          )}
          {editErr && <div className="mb-2 text-[12px] text-[#ff3b30] dark:text-[#ff8585]">{editErr}</div>}
          {/* 待确认改写：接受/放弃这处 diff（对齐 cc 的逐处采纳纪律） */}
          {pending && (
            <div className="flex items-center gap-2">
              <button
                onClick={acceptPending}
                className="app-primary-action flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition active:scale-[0.98]"
              >
                <Check className="h-3.5 w-3.5" /> 接受改动
              </button>
              <button
                onClick={rejectPending}
                className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-black/[0.1] bg-white text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
              >
                <X className="h-3.5 w-3.5" /> 放弃
              </button>
            </div>
          )}
          {/* content 的「整条改」内联输入条 */}
          {!pending && wholeOpen && directEdit && (
            <div className="mb-2 rounded-lg border border-black/[0.08] bg-white p-2 dark:border-white/[0.1] dark:bg-[#16181d]">
              <textarea
                value={wholeText}
                onChange={(e) => setWholeText(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submitWhole(); } if (e.key === "Escape") { setWholeOpen(false); setWholeText(""); } }}
                autoFocus
                rows={2}
                placeholder="整条改成…（如：更口语、加个促销点、压到三句话）"
                className="w-full resize-none rounded-md border border-black/[0.08] bg-white px-2 py-1.5 text-[12.5px] text-[#1d1d1f] outline-none placeholder:text-[#b0b0b5] focus:border-[#10a37f]/50 dark:border-white/[0.1] dark:bg-[#0e0f11] dark:text-[#e6e7e9] dark:placeholder:text-[#56585f]"
              />
              <div className="mt-1.5 flex items-center justify-end gap-1.5">
                <button type="button" onClick={() => { setWholeOpen(false); setWholeText(""); }} className="rounded-md px-2 py-1 text-[12px] text-[#86868b] transition hover:text-[#1d1d1f] dark:text-[#9a9ca3] dark:hover:text-[#e6e7e9]">取消</button>
                <button type="button" onClick={submitWhole} disabled={!wholeText.trim() || busy} className="app-primary-action rounded-md px-2.5 py-1 text-[12px] font-medium transition active:scale-[0.98] disabled:opacity-40">改写</button>
              </div>
            </div>
          )}
          {/* 成品(文案/海报/文件)：复制 + 整条改/整张重做 + 撤销/复原 */}
          {!pending && (
            <div className="flex items-center gap-2">
              {item.kind === "poster" ? (
                <button
                  type="button"
                  onClick={() => void saveMediaAsFile()}
                  disabled={saving}
                  className="app-primary-action flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] transition active:scale-[0.98]"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  {saving ? "正在保存…" : "保存到本机"}
                </button>
              ) : item.kind === "video" ? (
                <button
                  type="button"
                  onClick={() => void saveMediaAsFile()}
                  disabled={saving}
                  className="app-primary-action flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] transition active:scale-[0.98]"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
                  {saving ? "正在保存…" : "保存到本机"}
                </button>
              ) : (
                <button
                  onClick={copy}
                  className="app-primary-action flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] transition active:scale-[0.98]"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  {copied ? "已复制" : "复制"}
                </button>
              )}
              {/* content：整条改走内联 canvasEdit；poster：整张重做走 onRefine 预填 */}
              {directEdit ? (
                <button
                  onClick={() => setWholeOpen((v) => !v)}
                  disabled={busy}
                  className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-black/[0.1] bg-white text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] disabled:opacity-50 dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
                >
                  <Wand2 className="h-3.5 w-3.5" /> 整条改
                </button>
              ) : onRefine && item.kind === "poster" ? (
                <button
                  onClick={() => onRefine(item.kind)}
                  className="flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md border border-black/[0.1] bg-white text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
                >
                  <Wand2 className="h-3.5 w-3.5" /> 整张重做
                </button>
              ) : null}
              {item.kind === "poster" && onMakeVideo && item.generationId && (
                <button
                  onClick={() => onMakeVideo(item)}
                  className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-black/[0.1] bg-white px-3 text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
                  title="带这张图跳到视频工作台，在那边配运镜/时长再生成"
                >
                  <Clapperboard className="h-3.5 w-3.5" /> 做成视频
                </button>
              )}
              {edited && (
                <button
                  onClick={reset}
                  title="回到最初那一版"
                  className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-black/[0.1] bg-white px-3 text-[13px] text-[#86868b] transition hover:bg-black/[0.03] active:scale-[0.98] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#9a9ca3] dark:hover:bg-white/[0.06]"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> 复原
                </button>
              )}
            </div>
          )}
          {/* 版本时间线：回看/跳到任意一版 */}
          {!pending && vh.versions.length > 1 && (
            <div className="mt-1.5 flex items-center">
              <VersionBar versions={vh.versions} index={vh.index} onGoto={vh.goto} />
            </div>
          )}
          {/* 定稿保存提示 */}
          {saveMsg && (
            <div className="mt-2 flex min-w-0 items-center gap-2">
              <div className={`min-w-0 flex-1 truncate text-[12px] ${saveMsg.bad ? "text-[#ff3b30] dark:text-[#ff8585]" : "text-[#10a37f]"}`} title={saveMsg.text}>
                {saving ? "" : saveMsg.text}
              </div>
              {!saveMsg.bad && savedPath && electron?.files?.showInFolder && (
                <button
                  type="button"
                  onClick={() => void showSavedLocation()}
                  className="shrink-0 rounded-md px-2 py-1 text-[12px] text-[#10a37f] transition hover:bg-[#10a37f]/10"
                >
                  打开位置
                </button>
              )}
            </div>
          )}
          {/* 文案：定稿 = 保存到电脑（存成 Word/网页/纯文字/Markdown，另存为或放进素材库）+ 重做一版 */}
          {!pending && directEdit && (
            <div className="relative mt-2 flex items-center gap-2">
              <button
                onClick={() => setSaveOpen((v) => !v)}
                disabled={saving}
                className="app-primary-action flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition active:scale-[0.98] disabled:opacity-60"
              >
                {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                {saving ? "正在保存…" : "保存到电脑"}
                {!saving && <ChevronDown className={`h-3 w-3 transition ${saveOpen ? "rotate-180" : ""}`} />}
              </button>
              <button
                onClick={() => onFinalize?.("redo")}
                className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-black/[0.1] bg-white px-3 text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
              >
                <RefreshCw className="h-3.5 w-3.5" /> 重做一版
              </button>

              {saveOpen && (
                <>
                  <button type="button" aria-hidden tabIndex={-1} onClick={() => setSaveOpen(false)} className="fixed inset-0 z-40 cursor-default" />
                  <div className="absolute bottom-[calc(100%+8px)] left-0 z-50 w-[260px] rounded-xl border border-black/[0.1] bg-white p-2.5 shadow-[0_12px_40px_-10px_rgba(0,0,0,0.25)] dark:border-white/[0.1] dark:bg-[#1c1e24]">
                    <div className="mb-1.5 px-1 text-[11px] font-medium uppercase tracking-wider text-[#a1a1a6] dark:text-[#6e7077]">存成什么</div>
                    <div className="mb-2.5 flex flex-wrap gap-1">
                      {SAVE_FORMATS.map((f) => (
                        <button
                          key={f.fmt}
                          type="button"
                          onClick={() => setSaveFmt(f.fmt)}
                          className={`rounded-full border px-2.5 py-1 text-[12px] transition ${
                            saveFmt === f.fmt
                              ? "border-[#10a37f] bg-[#10a37f]/10 font-medium text-[#10a37f]"
                              : "border-black/[0.1] text-[#3a3a3c] hover:bg-black/[0.03] dark:border-white/[0.12] dark:text-[#c8cace] dark:hover:bg-white/[0.05]"
                          }`}
                        >
                          {f.label}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      onClick={() => saveAsFile(SAVE_FORMATS.find((x) => x.fmt === saveFmt)!)}
                      className="mb-1 flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                    >
                      <Download className="h-4 w-4 shrink-0 text-[#10a37f]" />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">另存到电脑…</span>
                        <span className="block text-[11.5px] text-[#86868b] dark:text-[#8a8c93]">选个文件夹存，跟保存 Word 一样</span>
                      </span>
                    </button>
                    <button
                      type="button"
                      onClick={() => saveToLib(SAVE_FORMATS.find((x) => x.fmt === saveFmt)!)}
                      className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-black/[0.04] dark:hover:bg-white/[0.05]"
                    >
                      <FolderHeart className="h-4 w-4 shrink-0 text-[#10a37f]" />
                      <span className="min-w-0">
                        <span className="block text-[13px] font-medium text-[#1d1d1f] dark:text-[#e6e7e9]">放进素材库</span>
                        <span className="block text-[11.5px] text-[#86868b] dark:text-[#8a8c93]">存到软件里，随时回来找</span>
                      </span>
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {/* 海报/文件：看完拍板。确认采用 / 重做一版 */}
          {!pending && !directEdit && onFinalize && (
            <div className="mt-2 flex items-center gap-2">
              <button
                onClick={() => onFinalize("accept", isText ? workText : undefined)}
                className="app-primary-action flex h-9 flex-1 items-center justify-center gap-1.5 rounded-md text-[13px] font-medium transition active:scale-[0.98]"
              >
                <CheckCircle2 className="h-3.5 w-3.5" /> 确认采用
              </button>
              <button
                onClick={() => onFinalize("redo")}
                className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-black/[0.1] bg-white px-3 text-[13px] text-[#1d1d1f] transition hover:bg-black/[0.03] active:scale-[0.98] dark:border-white/[0.1] dark:bg-white/[0.03] dark:text-[#c8cace] dark:hover:bg-white/[0.06]"
              >
                <RefreshCw className="h-3.5 w-3.5" /> 重做一版
              </button>
            </div>
          )}
        </div>
      )}
      <div
        onMouseDown={onHandleMouseDown}
        className="app-no-drag absolute left-0 top-0 z-20 h-full w-1 cursor-col-resize transition-colors hover:bg-[#10a37f]/40"
        title="拖拽调整预览栏宽度"
      />
    </section>
  );
}
