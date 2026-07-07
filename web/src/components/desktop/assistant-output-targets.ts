export type AssistantOutputTargetKind = "copy" | "plan" | "report" | "checklist" | "script" | "prompt";

export interface AssistantOutputTarget {
  kind: AssistantOutputTargetKind;
  title: string;
  spec: string;
}

const TARGET_KEYWORDS: Array<{ kind: AssistantOutputTargetKind; label: string; pattern: RegExp }> = [
  { kind: "copy", label: "朋友圈文案", pattern: /朋友圈文案|客户群话术|社群话术|招聘文案|平台回复|差评回复|海报文案/ },
  { kind: "plan", label: "活动方案", pattern: /活动方案|营销方案|引流方案|执行方案|整改方案|运营方案/ },
  { kind: "report", label: "老板汇报", pattern: /老板汇报|经营分析|营业日报|日报|周报|月报|复盘报告|数据报告/ },
  { kind: "checklist", label: "执行清单", pattern: /执行清单|任务清单|检查清单|SOP|排班表|巡店清单/ },
  { kind: "script", label: "短视频脚本", pattern: /短视频脚本|剪辑脚本|分镜脚本|口播脚本|直播脚本/ },
  { kind: "prompt", label: "生图提示词", pattern: /生图提示词|视频提示词|海报提示词|镜头提示词|prompt/i },
];

const STRUCTURED_LABELS = [
  "标题",
  "正文",
  "目标",
  "玩法",
  "时间",
  "预算",
  "步骤",
  "话术",
  "分工",
  "结论",
  "问题",
  "改法",
  "镜头",
  "画面",
  "字幕",
];

export function extractAssistantOutputTarget(text: string | undefined | null): AssistantOutputTarget | null {
  const content = (text || "").trim();
  if (!content || content.length < 80) return null;
  if (looksLikeConversationalExplanation(content)) return null;

  const head = content.slice(0, 260);
  const matched = TARGET_KEYWORDS.find((item) => item.pattern.test(head));
  const structureScore = structuredLabelCount(head);
  if (content.length < 120 && !matched) return null;
  if (!matched && structureScore < 2) return null;

  const title = cleanTitle(titleFromHeading(content) || matched?.label || "文字成品");
  const kind = matched?.kind || inferKindFromTitle(title);
  return {
    kind,
    title,
    spec: `${nounForKind(kind)} · ${charCount(content)}字`,
  };
}

function looksLikeConversationalExplanation(text: string): boolean {
  const first = firstNonEmptyLine(text);
  return /^(我会|我先|这里|这个问题|原因是|可以这样|建议你|目前看|先说结论)[，,:：]/.test(first) &&
    !TARGET_KEYWORDS.some((item) => item.pattern.test(text.slice(0, 180)));
}

function titleFromHeading(text: string): string {
  const line = firstNonEmptyLine(text);
  const md = line.match(/^#{1,3}\s+(.{2,40})$/);
  if (md?.[1]) return md[1];
  const bracket = line.match(/^【([^】]{2,40})】/);
  if (bracket?.[1]) return bracket[1];
  const colon = line.match(/^([^：:]{2,24})[：:]\s*$/);
  if (colon?.[1]) return colon[1];
  return "";
}

function inferKindFromTitle(title: string): AssistantOutputTargetKind {
  return TARGET_KEYWORDS.find((item) => item.pattern.test(title))?.kind || "copy";
}

function nounForKind(kind: AssistantOutputTargetKind): string {
  switch (kind) {
    case "plan":
      return "方案";
    case "report":
      return "报告";
    case "checklist":
      return "清单";
    case "script":
      return "脚本";
    case "prompt":
      return "提示词";
    default:
      return "文案";
  }
}

function structuredLabelCount(text: string): number {
  let count = 0;
  for (const label of STRUCTURED_LABELS) {
    if (new RegExp(`(^|[\\n\\s*\\-•])${label}[：:]`).test(text)) count++;
  }
  return count;
}

function firstNonEmptyLine(text: string): string {
  return text.split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function cleanTitle(value: string): string {
  const title = value.replace(/^#+\s*/, "").replace(/[*_`>]/g, "").trim();
  if (!title) return "文字成品";
  return title.length > 24 ? `${title.slice(0, 24)}…` : title;
}

function charCount(text: string): number {
  return text.replace(/\s+/g, "").length;
}
