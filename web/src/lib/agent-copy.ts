/**
 * 集中文案 + 状态动词库 —— 对标 Claude Code / cc-haha 的呈现，中文落地、单一来源。
 * 覆盖：权限模式三档 / 空状态欢迎 / 输入框 placeholder / spinner 进行时动词库。
 * 改文案改这里，别散落进组件。配色不在这里（保留现有 #10a37f 等）。
 */

import type { PermissionMode } from "@/hooks/use-agent-chat";

/**
 * 权限模式三档 —— 照搬 Claude Code（default / acceptEdits / bypassPermissions），不自创一套。
 * 后端值仍是 ask / auto_files / full（不改），只统一显示文案与描述。
 */
export const PERMISSION_MODES: { value: PermissionMode; label: string; desc: string; effects: string[] }[] = [
  { value: "ask", label: "逐项确认", desc: "改文件、跑命令前先问你", effects: ["改文件：先问", "跑命令：先问", "对外发布：必须确认"] },
  { value: "auto_files", label: "自动接受修改", desc: "改文件直接做，跑命令和对外动作仍先问", effects: ["改文件：直接做", "跑命令：先问", "对外发布：必须确认"] },
  { value: "plan", label: "计划模式", desc: "只看只想、不动手", effects: ["改文件：不做", "跑命令：不跑", "对外发布：不发布"] },
  { value: "full", label: "跳过确认", desc: "普通读写改查直接做，发布、删除、高成本动作仍确认", effects: ["改文件：直接做", "跑命令：直接跑", "对外发布：必须确认"] },
];

/** 空状态 / 欢迎 —— 去客服腔，专业 agent 基调（对标 cc-haha empty state）。 */
export const WELCOME = {
  title: "帮你把电脑上的事办完",
  subtitle: "直接说要办什么——看报表、整理文件、写文案、做海报都行，做好的东西会自动存好。",
  placeholder: "说说要办什么，比如：整理这个文件夹 / 看这份报表 / 写条朋友圈",
};

/**
 * Spinner 进行时动词库 —— 对标 cc-haha 的 spinnerVerbs（随机轮换），中文落地。
 * 文案统改(A-Task-4a)：从 28 个随手写的口语动词精简为 6 个中性词，收敛"随便感"；
 * 有活跃工具时前端已优先显示工具标签(见 agent-spinner.tsx)，不受此列表影响。
 */
export const SPINNER_VERBS = [
  "思考中", "整理中", "查资料中", "分析中", "撰写中", "核对中",
];

/** `/help` —— 先讲"我能帮你做什么"(大白话)，命令和高级靠后，不甩技术名词给普通用户。 */
export const HELP_TEXT = `**我能帮你做什么**

直接用大白话说就行，比如：
- 整理这个文件夹、把这些文件改个名、找出所有 Excel
- 看这张经营报表，挑 3 个老板能听懂的问题
- 写条周末活动朋友圈 / 给老客写句催回话术
- 做一张 9:16 的周赛海报、再把它做成抖音视频
- 上网帮我查查竞品 / 天气 / 附近有什么活动

**几个顺手的小命令**（输入 \`/\` 就会浮出来）：
\`/new\` 开新对话 · \`/clear\` 清空 · \`/settings\` 设置 · \`/export\` 导出对话

底部还能切**运行权限**（要不要每一步都先问你）和**行业模式**（要不要按台球房来答）。`;
