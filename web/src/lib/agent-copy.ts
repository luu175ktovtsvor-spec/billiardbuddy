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
export const PERMISSION_MODES: { value: PermissionMode; label: string; desc: string }[] = [
  { value: "ask", label: "询问权限", desc: "改文件、跑命令前先问你" },
  { value: "auto_files", label: "自动接受编辑", desc: "改文件直接做，其它操作仍先问" },
  { value: "plan", label: "计划模式", desc: "只看只想、不动手" },
  { value: "full", label: "完全访问", desc: "所有操作直接做，不再逐个确认" },
];

/** 空状态 / 欢迎 —— 去客服腔，专业 agent 基调（对标 cc-haha empty state）。 */
export const WELCOME = {
  title: "新会话",
  subtitle: "运营的活，一句话交给我——写文案、做海报、读报表、改本地文件、上网查料，一站办妥。",
  placeholder: "说一件要办的事——写文案、做海报、读报表，或交代一件要在电脑上完成的活…",
};

/**
 * Spinner 进行时动词库 —— 对标 cc-haha 的 spinnerVerbs（随机轮换、俏皮但克制），中文落地。
 */
export const SPINNER_VERBS = [
  "思考中", "盘算中", "琢磨中", "推敲中", "酝酿中", "捣鼓中", "编排中", "盘点中",
  "构思中", "梳理中", "斟酌中", "运筹中", "拆解中", "鼓捣中", "打磨中", "合计中",
  "演算中", "勾画中", "捋思路", "码字中", "校对中", "整合中", "钻研中", "拼装中",
  "调度中", "归整中", "推演中", "落子中",
];

/** `/help` 展示的命令与能力速览。 */
export const HELP_TEXT = `**命令与能力**

输入 \`/\` 浮出命令与技能：
- \`/new\` 开新会话 · \`/clear\` 清空当前会话
- \`/model\`、\`/settings\` 打开设置（配 AI 模型 / Key）
- \`/help\` 看这份说明
- 已安装的**技能**也在这里（如 \`/commit\` 写提交、\`/review\` 审代码）

**我能做**：读/写/改本地文件、跑命令、上网查、看屏幕 / 操作电脑、做海报与文案、连 MCP 外部工具、派子代理（探索 / 规划）。

顶部工具条可切**运行权限**（询问 / 自动接受编辑 / 计划 / 完全访问）和**输出风格**。`;
