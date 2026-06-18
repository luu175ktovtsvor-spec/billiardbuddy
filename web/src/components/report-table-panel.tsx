"use client";

import { useEffect, useState } from "react";
import { X, Loader2, Check, AlertTriangle, Table2 } from "lucide-react";
import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";

/** 0→A 1→B … 26→AA（Excel 列字母） */
function colLetter(n: number): string {
  let s = "";
  let x = n + 1;
  while (x > 0) {
    const m = (x - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

interface Props {
  open: boolean;
  path: string;
  fileName: string;
  onClose: () => void;
}

/**
 * 报表可视化：把本机报表铺成表格看，点单元格直接改（桌面专属·改前自动备份）。
 */
export function ReportTablePanel({ open, path, fileName, onClose }: Props) {
  const [data, setData] = useState<{ sheets: { name: string; rows: string[][] }[]; truncated: boolean } | null>(null);
  const [sheetIdx, setSheetIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [editing, setEditing] = useState<{ r: number; c: number } | null>(null);
  const [editVal, setEditVal] = useState("");
  const [saving, setSaving] = useState(false);
  const [lastDiff, setLastDiff] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setErr("");
    setLastDiff("");
    api
      .readSheet(path)
      .then((d) => {
        if (!cancelled) {
          setData(d);
          setSheetIdx(0);
        }
      })
      .catch((e) => !cancelled && setErr(getErrorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, path]);

  const sheet = data?.sheets[sheetIdx];

  async function saveEdit() {
    if (!editing || !sheet || saving) return;
    const cell = colLetter(editing.c) + (editing.r + 1);
    setSaving(true);
    setErr("");
    try {
      const res = await api.excelEditCell(path, cell, editVal, sheet.name);
      setData((d) => {
        if (!d) return d;
        const sheets = d.sheets.map((s, i) =>
          i !== sheetIdx
            ? s
            : { ...s, rows: s.rows.map((row, ri) => (ri !== editing.r ? row : row.map((cv, ci) => (ci !== editing.c ? cv : res.new)))) },
        );
        return { ...d, sheets };
      });
      setLastDiff(`${res.cell}：${res.old || "（空）"} → ${res.new}　已自动备份`);
      setEditing(null);
    } catch (e) {
      setErr(getErrorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      {/* 顶栏 */}
      <div className="flex items-center gap-2 border-b border-slate-100 px-4 py-3">
        <Table2 className="h-4 w-4 text-brand-600" />
        <span className="truncate text-[15px] font-semibold text-slate-800">{fileName}</span>
        <span className="shrink-0 rounded-full bg-brand-50 px-2 py-0.5 text-[11px] font-medium text-brand-600">点格子可改</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-xl text-slate-500 active:scale-[0.97]"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* sheet 切换 */}
      {data && data.sheets.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto border-b border-slate-100 px-4 py-2">
          {data.sheets.map((s, i) => (
            <button
              key={s.name}
              type="button"
              onClick={() => setSheetIdx(i)}
              className={`shrink-0 rounded-lg px-3 py-1 text-[13px] ${i === sheetIdx ? "bg-brand-600 text-white" : "bg-slate-100 text-slate-600"}`}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      {/* 改动提示 / 错误 / 截断提示 */}
      {lastDiff && (
        <p className="flex items-center gap-1.5 bg-emerald-50 px-4 py-2 text-[12.5px] text-emerald-700">
          <Check className="h-3.5 w-3.5 shrink-0" /> {lastDiff}
        </p>
      )}
      {err && <p className="bg-rose-50 px-4 py-2 text-[12.5px] text-rose-600">{err}</p>}
      {data?.truncated && (
        <p className="flex items-center gap-1.5 bg-amber-50 px-4 py-2 text-[12px] text-amber-700">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> 报表较大，只显示前面一部分；细看请用 Excel 打开
        </p>
      )}

      {/* 表格 */}
      <div className="flex-1 overflow-auto p-3">
        {loading ? (
          <div className="flex items-center justify-center py-20 text-slate-400">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : sheet && sheet.rows.length > 0 ? (
          <table className="border-collapse text-[13px]">
            <tbody>
              {sheet.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => {
                    const isEditing = editing?.r === r && editing?.c === c;
                    return (
                      <td
                        key={c}
                        onClick={() => {
                          if (!isEditing) {
                            setEditing({ r, c });
                            setEditVal(cell);
                          }
                        }}
                        className={`min-w-[72px] max-w-[220px] cursor-pointer border border-slate-200 px-2 py-1.5 ${
                          r === 0 ? "bg-slate-50 font-medium text-slate-700" : "text-slate-700"
                        } ${isEditing ? "p-0" : "truncate"}`}
                      >
                        {isEditing ? (
                          <input
                            autoFocus
                            value={editVal}
                            onChange={(e) => setEditVal(e.target.value)}
                            onBlur={saveEdit}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                saveEdit();
                              } else if (e.key === "Escape") {
                                setEditing(null);
                              }
                            }}
                            className="w-full min-w-[72px] bg-brand-50 px-2 py-1.5 text-[13px] outline-none ring-2 ring-brand-400"
                          />
                        ) : (
                          cell
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="py-20 text-center text-sm text-slate-400">这张表是空的</p>
        )}
      </div>

      {saving && (
        <div className="flex items-center justify-center gap-1.5 border-t border-slate-100 py-2 text-[12.5px] text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> 正在保存改动…
        </div>
      )}
    </div>
  );
}
