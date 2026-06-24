/**
 * Agent 工具的前端展示元数据（桌面壳与手机页共享的"工具→友好标签/图标/是否成品"）。
 * 注意：手机页 chat/page.tsx 目前有一份同样的内联常量（历史原因），桌面壳改用这份共享模块；
 * 后续可把手机页也切到这里以彻底单一来源。**新增/改成品工具时两处都要同步**（与后端 deliverable 标记对齐）。
 */
import {
  CalendarDays, Lightbulb, PenLine, UserPlus, Stethoscope, Dices, ImageIcon, Sparkles,
  FileText, PartyPopper, Search, History, FolderOpen, Save, FilePen, FileSpreadsheet, Layers, Wrench,
  FileSearch, Terminal, Globe, ListChecks, Users, Monitor, MousePointerClick, Plug, Bell, Clock,
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
  generate_image: { label: "生成图片", Icon: ImageIcon },
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
  find_files: { label: "找文件", Icon: Search },
  search_in_files: { label: "搜文件内容", Icon: FileSearch },
  run_command: { label: "跑命令", Icon: Terminal },
  web_fetch: { label: "抓网页", Icon: Globe },
  web_search: { label: "网上搜", Icon: Search },
  todo_write: { label: "列任务清单", Icon: ListChecks },
  run_subagent: { label: "派子代理", Icon: Users },
  skill: { label: "用技能", Icon: Sparkles },
  computer_view: { label: "看屏幕", Icon: Monitor },
  computer_control: { label: "操作电脑", Icon: MousePointerClick },
  notify: { label: "发通知", Icon: Bell },
  run_background: { label: "后台跑命令", Icon: Terminal },
  schedule_reminder: { label: "设提醒", Icon: Clock },
  list_reminders: { label: "看提醒", Icon: Clock },
  cancel_reminder: { label: "取消提醒", Icon: Clock },
  install_plugin: { label: "装插件", Icon: Plug },
};

export function toolMeta(name: string) {
  if (TOOL_META[name]) return TOOL_META[name];
  if (name.startsWith("mcp__")) {
    const parts = name.split("__");
    return { label: `MCP·${parts[1] || ""}·${parts.slice(2).join("·")}`, Icon: Plug };
  }
  return { label: name, Icon: Wrench };
}

// 交付类工具：结果是给老板直接拿去用的成品，原样渲染、绝不让大脑改写。需与后端 deliverable 标记一致。
// make_poster 直接出图、就是成品（海报图原样渲染），不再走审批卡。
export const DELIVERABLE_TOOLS = new Set([
  "write_operation_content", "write_batch", "plan_activity", "assistant_outreach",
  "diagnose_operation", "recommend_games", "make_platform_content", "make_groupbuy_content",
  "make_poster", "generate_image",
]);

// 内部/指令注入类工具（P1-8 + 专题B.1）：结果是【给 AI 看的操作手册/检索原文】，对老板零价值还吓人
// （满屏 ## 守则 / prompt_key=… 的内部指令稿）。这些工具只显示"做了一步"的标签，绝不把原文 dump 给用户、也不进右侧预览。
export const INTERNAL_TOOLS = new Set([
  "skill", "find_scenario", "recall_my_content", "look_up_knowledge", "read_knowledge",
]);

/** 待确认动作的标题（对外发出 / 在本机执行的动作，经审批闸先确认）。前置「需要确认」徽标已表态，标题只点动作。 */
export function approvalLabel(tool: string, args?: Record<string, unknown>): string {
  if (tool === "edit_excel") return "修改这份报表";
  if (tool === "write_file" || tool === "edit_file") return "修改这个文件";
  if (tool === "run_command") {
    // 中性表述：只说要在本机执行命令 + 原文，不提钱、不评判。
    const cmd = typeof args?.command === "string" ? args.command : "";
    return cmd ? `在本机执行命令：${cmd}` : "在本机执行一条命令";
  }
  if (tool === "computer_control") {
    const a = typeof args?.action === "string" ? args.action : "";
    return a ? `操作电脑：${a}` : "操作电脑";
  }
  if (tool === "run_background") {
    const cmd = typeof args?.command === "string" ? args.command : "";
    return cmd ? `在后台执行命令：${cmd}` : "在后台执行一条命令";
  }
  if (tool === "install_plugin") {
    const repo = typeof args?.repo === "string" ? args.repo : "";
    return repo ? `从 GitHub 安装插件：${repo}` : "安装一个插件";
  }
  return `执行「${toolMeta(tool).label}」`;
}

/** 确认按钮文案。 */
export function approvalConfirmText(tool: string): string {
  if (tool === "edit_excel" || tool === "write_file" || tool === "edit_file") return "确认修改";
  if (tool === "run_command") return "确认执行命令";
  return "确认执行";
}
