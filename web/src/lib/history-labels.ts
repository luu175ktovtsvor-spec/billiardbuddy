import type { GenerationHistoryItem } from "@/types/generation-history";
import { ROLE_TASKS } from "@/lib/role-workbench-config";

const TYPE_LABELS: Record<string, string> = {
  copywriting: "文案",
  activity: "活动",
  operation: "经营",
  workbench: "工作台",
  poster: "海报",
  batch: "批量生成",
  diagnosis: "经营诊断",
  games: "玩法推荐",
  outreach: "约客话术",
  performance: "绩效考核",
  repurpose: "内容变体",
  sop: "服务话术",
};

// 协作任务类型 → 中文(sub_type 形如 collab_activity_planning)
const COLLAB_TASK_LABELS: Record<string, string> = {
  activity_planning: "策划活动",
  store_opening: "新店开业",
  staff_training: "员工培训",
  business_review: "经营复盘",
  custom: "自定义协作",
};

// 变体平台
const PLATFORM_LABELS: Record<string, string> = {
  douyin: "抖音版", xiaohongshu: "小红书版", wechat_moments: "朋友圈版", group_notice: "群公告版",
};

// 诊断问题域
const PROBLEM_LABELS: Record<string, string> = {
  traffic: "客流", revenue: "营收", customer_loss: "服务", staff: "团队",
  competition: "竞争", activity_effect: "综合",
};

const SUB_TYPE_LABELS: Record<string, string> = {
  // 文案
  moments: "朋友圈",
  group_notice: "群公告",
  // 活动
  planning: "活动策划",
  daily_invite: "每日约客",
  activity_promo: "活动推广",
  tournament_notice: "赛事通知",
  recharge_promo: "充值促销",
  afternoon_special: "下午场特惠",
  // 经营场景
  groupbuy_to_private: "团购转私域",
  assistant_promo: "助教推广",
  partner_match: "球友匹配",
  tournament: "赛事活动",
  old_customer_recall: "老客户回访",
  assistant_outreach: "助教约客",
  assistant_booking: "助教预约",
  member_assistant_notice: "助教可约通知",
  game_recommend: "玩法推荐",
  opening_event: "开业活动",
  performance_template: "绩效模板",
  complaint_handling: "投诉处理",
  daily_task_list: "每日任务",
  vip_maintenance: "VIP维护",
  daily_report: "日报",
  monthly_report: "月报",
  training_exam: "培训考核",
  review_meeting: "复盘会议",
  short_video: "短视频",
  frontdesk_sop: "前厅SOP",
  ip_cooperation: "IP合作",
  diagnosis_tool: "诊断工具",
  group_content: "群内容",
  workbench_tasks: "工作台任务",
  qiangyi_battle: "抢一大战",
  tournament_signup: "赛事报名",
  tournament_report: "赛事战报",
  tournament_rules: "赛制说明",
  champion_poster: "冠军海报",
  coaching_promo: "教学推广",
  competition_customer: "竞技客户维护",
  empty_table_promo: "空台促活",
  departure_followup: "离店跟进",
  customer_group_guide: "进群引导",
  opening_closing_sop: "开店闭店SOP",
  equipment_management: "电器管理",
  store_atmosphere: "门店氛围",
  poster_copy: "海报文案",
  sports_event_watching: "看球活动",
  staff_birthday: "员工生日",
  hygiene_check: "卫生检查",
  review_guidance: "好评引导",
  activity_direction: "活动方向",
  business_strategy: "经营策略",
  table_content_plan: "内容规划",
  cart_promotion: "推车促销",
  recruitment: "招聘",
  // 岗位
  boss: "老板",
  manager: "店长",
  assistant_manager: "助教管理",
  coach: "教练",
  frontdesk: "前厅",
  operator: "运营",
};

/** 类型/子类型标签解析:覆盖后端所有产出值,绝不向用户露出英文原值 */
export function typeLabel(type: string): string {
  return TYPE_LABELS[type] || "内容";
}

export function subTypeLabel(item: { type: string; sub_type: string | null }): string {
  const sub = item.sub_type || "";
  if (!sub) return typeLabel(item.type);
  if (sub.startsWith("collab_")) return "协作·" + (COLLAB_TASK_LABELS[sub.slice(7)] || "方案");
  if (item.type === "repurpose") return PLATFORM_LABELS[sub] || "内容变体";
  if (item.type === "diagnosis") return PROBLEM_LABELS[sub] || "经营诊断";
  if (item.type === "poster") return sub; // 比例(3:4 等)直接显示
  const stripped = sub.includes(".") ? sub.split(".").pop()! : sub;
  return SUB_TYPE_LABELS[sub] || SUB_TYPE_LABELS[stripped] || typeLabel(item.type);
}

/** "继续对话"跳转：按 prompt_key 找回原任务卡片并带上原始意图；找不到（自由输入等）则返回 null */
export function continueHref(item: GenerationHistoryItem): string | null {
  if (item.type !== "workbench") return null;
  const params = (item.input_params || {}) as Record<string, unknown>;
  const intent = params.user_intent;
  const promptKey = params.prompt_key;
  if (typeof intent !== "string" || !intent) return null;
  if (typeof promptKey !== "string" || !promptKey) return null;
  for (const tasks of Object.values(ROLE_TASKS)) {
    const card = tasks.find((t) => t.promptKey === promptKey);
    if (card) {
      return `/dashboard/workbench/${card.id}?intent=${encodeURIComponent(intent)}`;
    }
  }
  return null;
}
