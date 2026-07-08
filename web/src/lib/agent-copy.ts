/**
 * 集中文案 + 状态动词库 —— 对标 Claude Code / cc 的呈现，中文落地、单一来源。
 * 覆盖：权限模式四档 / 空状态欢迎 / 输入框 placeholder / spinner 进行时动词库。
 * 改文案改这里，别散落进组件。配色不在这里（保留现有 #10a37f 等）。
 */

import type { PermissionMode, PermissionModeInput } from "@/hooks/use-agent-chat";

/**
 * 权限模式四档 —— 对齐 Claude Code 的 default / acceptEdits / plan / bypassPermissions。
 */
export const PERMISSION_MODES: { value: PermissionMode; label: string; desc: string; effects: string[] }[] = [
  { value: "default", label: "默认", desc: "本机读写直接做，对外和不可逆动作先问", effects: ["改文件：直接做", "本机命令：直接跑", "对外/删除：必须确认"] },
  { value: "acceptEdits", label: "接受修改", desc: "本机读写直接做，对外和不可逆动作先问", effects: ["改文件：直接做", "本机命令：直接跑", "对外/删除：必须确认"] },
  { value: "plan", label: "计划模式", desc: "只看只想、不动手", effects: ["改文件：不做", "跑命令：不跑", "高风险动作：不做"] },
  { value: "bypassPermissions", label: "跳过确认", desc: "普通读写改查直接做，登录、支付、灾难级动作仍拦", effects: ["改文件：直接做", "跑命令：直接跑", "强确认：仍会拦"] },
];

export function normalizePermissionMode(value: unknown): PermissionMode | null {
  if (value === "default" || value === "acceptEdits" || value === "plan" || value === "bypassPermissions") return value;
  if (value === "ask") return "default";
  if (value === "auto_files") return "acceptEdits";
  if (value === "full") return "bypassPermissions";
  return null;
}

export function permissionModeStorageValue(value: PermissionModeInput): PermissionMode {
  return normalizePermissionMode(value) || "default";
}

/** 空状态 / 欢迎 —— 去客服腔，专业 agent 基调（对标 cc empty state）。 */
export const WELCOME = {
  title: "今天要处理什么？",
  subtitle: "可以改代码、查资料、整理文件、分析报表，也可以继续做图和视频。对外触达、不可逆或高风险动作会先确认。",
  placeholder: "描述任务，或输入 / 调命令，比如：修改这个文件 / 跑测试 / 看这份报表",
};

/**
 * Spinner 进行时动词库 —— 对标 cc 的 spinnerVerbs（随机轮换），中文落地。
 * 文案统改(A-Task-4a)：从 28 个随手写的口语动词精简为 6 个中性词，收敛"随便感"；
 * 有活跃工具时前端已优先显示工具标签(见 agent-spinner.tsx)，不受此列表影响。
 */
export const SPINNER_VERBS = [
  "思考中", "整理中", "查资料中", "分析中", "撰写中", "核对中",
];

/** `/help` —— 先讲"我能帮你做什么"(大白话)，命令和高级靠后，不甩技术名词给普通用户。 */
export const HELP_TEXT = `**我能帮你做什么**

直接用大白话说就行，比如：
- 改这段代码，顺手跑相关测试
- 查这个报错从哪里来，给出修改方案
- 整理这个文件夹、把这些文件改个名、找出所有 Excel
- 看这张经营报表，挑 3 个能直接处理的问题
- 写条周末活动朋友圈 / 给老客写句催回话术
- 做一张 9:16 的周赛海报、再把它做成抖音视频
- 上网帮我查查竞品 / 天气 / 附近有什么活动

**几个顺手的小命令**（输入 \`/\` 就会浮出来）：
\`/new\` 开新对话 · \`/clear\` 清空 · \`/settings\` 设置 · \`/export\` 导出对话

底部还能切**运行权限**（对外/不可逆动作是否需要确认）和**专家**（是否挂载台球运营专家）。`;
