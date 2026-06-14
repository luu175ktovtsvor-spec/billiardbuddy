"use client";

import { Plus, X } from "lucide-react";
import type { ReportColumn, ReportData, ReportField, ReportSchema } from "@/types/report";

/** 一个数字输入行：左标签(POS 字段带"收银系统看"提示)，右数字+单位 */
function NumberField({
  field,
  value,
  onChange,
}: {
  field: ReportField | ReportColumn;
  value: unknown;
  onChange: (v: number | undefined) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 border-b border-slate-50 py-2.5 last:border-0">
      <span className="text-[15px] text-slate-700">
        {field.label}
        {field.source === "pos_glance" && (
          <span className="ml-1.5 text-xs text-slate-400">收银系统看</span>
        )}
      </span>
      <span className="flex items-center gap-1.5">
        <input
          type="number"
          inputMode="decimal"
          value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))}
          className="w-24 rounded-xl border border-slate-200 px-3 py-2 text-right text-[15px] tabular-nums focus:border-brand-600 focus:outline-none"
          placeholder="0"
        />
        {field.unit && <span className="w-5 text-sm text-slate-400">{field.unit}</span>}
      </span>
    </label>
  );
}

/** 文本输入行（roster 的姓名等） */
function TextField({
  value,
  placeholder,
  onChange,
}: {
  value: unknown;
  placeholder: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      value={typeof value === "string" ? value : ""}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="flex-1 rounded-xl border border-slate-200 px-3 py-2 text-[15px] focus:border-brand-600 focus:outline-none"
    />
  );
}

/** 报表表单：按 schema.shape 渲染 flat / personal / roster 三种形态。 */
export function ReportForm({
  schema,
  value,
  onChange,
}: {
  schema: ReportSchema;
  value: ReportData;
  onChange: (next: ReportData) => void;
}) {
  const setField = (key: string, v: number | undefined) => onChange({ ...value, [key]: v });

  // ─── roster：一行一个成员，可增删 ───
  if (schema.shape === "roster") {
    const cols = schema.columns ?? [];
    const idKey = cols[0]?.key ?? "name";
    const metricCols = cols.filter((c) => c.key !== idKey);
    const rows = value.rows ?? [];

    const setRow = (i: number, patch: Record<string, unknown>) => {
      const next = rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r));
      onChange({ ...value, rows: next });
    };
    const addRow = () => onChange({ ...value, rows: [...rows, {}] });
    const removeRow = (i: number) =>
      onChange({ ...value, rows: rows.filter((_, idx) => idx !== i) });

    return (
      <div className="space-y-3">
        {rows.map((row, i) => (
          <div key={i} className="rounded-2xl bg-white p-4">
            <div className="mb-2 flex items-center gap-2">
              <TextField
                value={row[idKey]}
                placeholder={`${schema.row_label ?? "成员"}姓名`}
                onChange={(v) => setRow(i, { [idKey]: v })}
              />
              <button
                type="button"
                onClick={() => removeRow(i)}
                aria-label="删除"
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400 active:bg-slate-100"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
            {metricCols.map((c) => (
              <NumberField
                key={c.key}
                field={c}
                value={row[c.key]}
                onChange={(v) => setRow(i, { [c.key]: v })}
              />
            ))}
          </div>
        ))}
        <button
          type="button"
          onClick={addRow}
          className="flex w-full items-center justify-center gap-1.5 rounded-2xl border border-dashed border-slate-300 py-3.5 text-[15px] text-slate-500 active:scale-[0.98] active:bg-slate-50 transition-transform"
        >
          <Plus className="h-5 w-5" />加一个{schema.row_label ?? "成员"}
        </button>
      </div>
    );
  }

  // ─── flat / personal：分节填空 ───
  return (
    <div className="space-y-3">
      {(schema.groups ?? []).map((group) => (
        <div key={group.name} className="rounded-2xl bg-white p-4">
          <h3 className="mb-1 text-[13px] font-medium text-slate-500">{group.name}</h3>
          {group.fields.map((f) => (
            <NumberField key={f.key} field={f} value={value[f.key]} onChange={(v) => setField(f.key, v)} />
          ))}
        </div>
      ))}
    </div>
  );
}
