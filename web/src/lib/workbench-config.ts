import type { WorkbenchRole, TargetCustomerType, OutputPackageItem } from "@/types/generate";

/* ─── Role options ─── */

export interface RoleOption {
  value: WorkbenchRole;
  label: string;
  shortLabel: string;
  description: string;
}

export const ROLE_OPTIONS: RoleOption[] = [
  { value: "boss", label: "老板 / 经营负责人", shortLabel: "老板", description: "关注全店经营状况和趋势" },
  { value: "manager", label: "店长", shortLabel: "店长", description: "负责全店日常运营管理" },
  { value: "assistant_manager", label: "助教管理", shortLabel: "助教管理", description: "负责助教团队管理和推广" },
  { value: "coach", label: "教练", shortLabel: "教练", description: "负责教学和竞技客户维护" },
  { value: "frontdesk", label: "前厅主管", shortLabel: "前厅", description: "负责客户接待和前台管理" },
  { value: "operator", label: "运营负责人", shortLabel: "运营", description: "负责内容和数据分析" },
];

/* ─── Customer type options ─── */

export interface CustomerTypeOption {
  value: TargetCustomerType;
  label: string;
  description: string;
}

export const CUSTOMER_TYPE_OPTIONS: CustomerTypeOption[] = [
  { value: "all", label: "全部客户", description: "不确定时选这个" },
  { value: "groupbuy", label: "团购客", description: "美团/抖音团购第一次来的客户" },
  { value: "new", label: "新客户", description: "第1-2次到店，还在观望" },
  { value: "old", label: "老客户", description: "3次以上到店" },
  { value: "competition", label: "竞技客户", description: "喜欢约局、打比赛" },
  { value: "assistant", label: "助教客户", description: "预约过或想约助教的客户" },
  { value: "light_competition", label: "轻竞技客户", description: "熟人之间娱乐性打局" },
  { value: "vip", label: "大客户", description: "高频到店、大额充值" },
];

/* ─── Output package groups ─── */

export interface OutputPackageGroup {
  key: string;
  label: string;
  items: { value: OutputPackageItem; label: string; description: string }[];
}

export const OUTPUT_PACKAGE_GROUPS: OutputPackageGroup[] = [
  {
    key: "content",
    label: "常用内容",
    items: [
      { value: "moments", label: "朋友圈", description: "2-3条可直接发的朋友圈文案" },
      { value: "private_chat", label: "私聊话术", description: "分场景的微信/当面对话语术" },
      { value: "group_notice", label: "群公告", description: "可直接发到微信群的公告" },
    ],
  },
  {
    key: "promo",
    label: "活动 / 推广",
    items: [
      { value: "activity_plan", label: "活动方案", description: "含目标、规则、执行清单" },
      { value: "poster_copy", label: "海报文案", description: "标题+副标题+正文" },
      { value: "short_video", label: "短视频配文", description: "标题+配文+话题标签" },
    ],
  },
  {
    key: "mgmt",
    label: "管理 / 执行",
    items: [
      { value: "execution_tips", label: "执行建议", description: "谁发、什么时候发、怎么发" },
      { value: "sop_checklist", label: "SOP / 检查表", description: "逐条可勾选的检查清单" },
      { value: "daily_report", label: "日报 / 汇报", description: "数据摘要+总结+明日计划" },
      { value: "pk_plan", label: "PK 方案", description: "指标定义+目标表+追踪表" },
    ],
  },
];

/* ─── Default output package ─── */

export const DEFAULT_OUTPUT_PACKAGE: OutputPackageItem[] = ["moments", "execution_tips"];

/* ─── Recommended output combos ─── */

export interface OutputCombo {
  key: string;
  label: string;
  description: string;
  packages: OutputPackageItem[];
}

export const RECOMMENDED_OUTPUT_COMBOS: OutputCombo[] = [
  {
    key: "standard",
    label: "标准内容包",
    description: "朋友圈 + 私聊 + 群公告 + 执行建议",
    packages: ["moments", "private_chat", "group_notice", "execution_tips"],
  },
  {
    key: "activity",
    label: "活动全案包",
    description: "活动方案 + 朋友圈 + 群公告 + 海报 + 执行建议",
    packages: ["activity_plan", "moments", "group_notice", "poster_copy", "execution_tips"],
  },
  {
    key: "mgmt",
    label: "管理工具包",
    description: "PK方案 + SOP + 日报 + 执行建议",
    packages: ["pk_plan", "sop_checklist", "daily_report", "execution_tips"],
  },
];

/* ─── Label lookup helpers ─── */

const OUTPUT_LABEL_MAP: Record<OutputPackageItem, string> = {
  moments: "朋友圈", group_notice: "群公告", private_chat: "私聊话术",
  poster_copy: "海报文案", short_video: "短视频配文", execution_tips: "执行建议",
  daily_report: "日报/汇报", activity_plan: "活动方案", sop_checklist: "SOP/检查表", pk_plan: "PK方案",
};

export function getOutputPackageLabel(item: OutputPackageItem): string {
  return OUTPUT_LABEL_MAP[item] || item;
}