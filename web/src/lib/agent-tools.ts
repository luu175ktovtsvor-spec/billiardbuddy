/**
 * Agent 工具的前端展示元数据（桌面壳与手机页共享的"工具→友好标签/图标/是否成品"）。
 * 注意：手机页 chat/page.tsx 目前有一份同样的内联常量（历史原因），桌面壳改用这份共享模块；
 * 后续可把手机页也切到这里以彻底单一来源。**新增/改成品工具时两处都要同步**（与后端 deliverable 标记对齐）。
 */
import {
  CalendarDays, Lightbulb, PenLine, UserPlus, Stethoscope, Dices, ImageIcon, Sparkles,
  FileText, PartyPopper, Search, History, FolderOpen, Save, FilePen, FileSpreadsheet, Layers, Wrench,
} from "lucide-react";

export const TOOL_META: Record<string, { label: string; Icon: typeof Wrench }> = {
  get_current_date: { label: "看了今天日期", Icon: CalendarDays },
  get_today_recommendation: { label: "看了今日推荐", Icon: Lightbulb },
  write_operation_content: { label: "写文案", Icon: PenLine },
  write_batch: { label: "批量写一批", Icon: Layers },
  assistant_outreach: { label: "拟约客话术", Icon: UserPlus },
  diagnose_operation: { label: "做经营诊断", Icon: Stethoscope },
  recommend_games: { label: "想玩法", Icon: Dices },
  make_poster: { label: "做海报", Icon: ImageIcon },
  make_platform_content: { label: "写平台内容", Icon: Sparkles },
  make_groupbuy_content: { label: "写团购套餐", Icon: FileText },
  plan_activity: { label: "策划活动", Icon: PartyPopper },
  find_scenario: { label: "找合适的方案", Icon: Search },
  recall_my_content: { label: "翻你以前写的", Icon: History },
  list_files: { label: "翻看你的文件", Icon: FolderOpen },
  read_file: { label: "读文件", Icon: FileText },
  write_file: { label: "存文件", Icon: Save },
  edit_file: { label: "改文件", Icon: FilePen },
  edit_excel: { label: "改报表", Icon: FileSpreadsheet },
};

export function toolMeta(name: string) {
  return TOOL_META[name] || { label: name, Icon: Wrench };
}

// 交付类工具：结果是给老板直接拿去用的成品，原样渲染、绝不让大脑改写。需与后端 deliverable 标记一致。
export const DELIVERABLE_TOOLS = new Set([
  "write_operation_content", "write_batch", "plan_activity", "assistant_outreach",
  "diagnose_operation", "recommend_games", "make_platform_content", "make_groupbuy_content",
]);

/** 待确认动作的人话标题（花钱/对外动作经审批闸先确认）。 */
export function approvalLabel(tool: string): string {
  if (tool === "make_poster") return "做这张海报需要你确认";
  if (tool === "edit_excel") return "改这份报表需要你确认";
  if (tool === "write_file" || tool === "edit_file") return "改这个文件需要你确认";
  return `执行「${toolMeta(tool).label}」需要你确认`;
}

/** 确认按钮文案。 */
export function approvalConfirmText(tool: string): string {
  if (tool === "make_poster") return "确认生成";
  if (tool === "edit_excel" || tool === "write_file" || tool === "edit_file") return "确认修改";
  return "确认执行";
}
