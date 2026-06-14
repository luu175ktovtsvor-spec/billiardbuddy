// 报表/日报类型。与后端 server/report_forms/*.yaml schema 对齐。

export type FieldSource = "pos_glance" | "manual" | "profile";
export type ReportShape = "flat" | "personal" | "roster";

export interface ReportField {
  key: string;
  label: string;
  type?: string;
  unit?: string;
  source?: FieldSource;
}

export interface ReportGroup {
  name: string;
  fields: ReportField[];
}

export interface ReportColumn {
  key: string;
  label: string;
  type?: string;
  unit?: string;
  source?: FieldSource;
}

export interface ReportSchema {
  key: string;
  shape: ReportShape;
  role?: string;
  variant?: string;
  title?: string;
  prefill?: string[];
  groups?: ReportGroup[];      // flat / personal
  columns?: ReportColumn[];    // roster
  row_label?: string;          // roster
  rank_by?: string;            // roster
  cumulative_fields?: string[];// personal
  narrative?: { prompt_key: string; outputs?: string[] };
}

export interface ReportListItem {
  id: string;
  report_type: string | null;
  title: string | null;
  created_at: string;
}

export interface ReportDelta {
  pct: number;
  dir: "up" | "down";
  prev: number;
}

export interface ReportSubmitResponse {
  report_id: string;
  narrative: string;
  deltas: Record<string, ReportDelta>;
}

/** 报表数据：flat/personal 是字段键值；roster 多一个 rows 数组 */
export type ReportData = Record<string, unknown> & {
  rows?: Array<Record<string, unknown>>;
};
