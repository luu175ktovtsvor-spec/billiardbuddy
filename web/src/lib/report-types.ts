// 前端报表类型清单（与后端 server/report_forms/*.yaml 的 key 对齐）。

export const REPORT_TYPES = [
  { type: "manager_daily", label: "店长日报" },
  { type: "assistant_manager_daily", label: "助教管理日报" },
  { type: "coach_main_daily", label: "主教练日报" },
  { type: "coach_assistant_daily", label: "副教练日报" },
  { type: "frontdesk_daily", label: "前厅日报" },
] as const;

export function reportTypeLabel(type: string | null | undefined): string {
  return REPORT_TYPES.find((r) => r.type === type)?.label ?? type ?? "日报";
}
