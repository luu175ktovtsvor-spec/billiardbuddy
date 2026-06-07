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

/* ─── Workbench examples by role (24 total) ─── */

export interface WorkbenchExample {
  id: string;
  title: string;
  userIntent: string;
  role: WorkbenchRole;
  targetCustomerType: TargetCustomerType;
  outputPackage: OutputPackageItem[];
  group: string;
}

export const WORKBENCH_EXAMPLES_BY_ROLE: Record<WorkbenchRole, WorkbenchExample[]> = {
  boss: [
    { id: "ex-boss-1", title: "月度汇报框架", userIntent: "这个月店里运营情况，帮我整理个汇报框架", role: "boss", targetCustomerType: "all", outputPackage: ["daily_report", "execution_tips"], group: "老板场景" },
    { id: "ex-boss-2", title: "大客户单独约访", userIntent: "有个大客户好久没来了，想单独约一下，别太刻意", role: "boss", targetCustomerType: "vip", outputPackage: ["private_chat", "execution_tips"], group: "老板场景" },
    { id: "ex-boss-3", title: "门店冷清想想办法", userIntent: "最近店里有点冷清，帮我想想发点什么", role: "boss", targetCustomerType: "old", outputPackage: ["moments", "group_notice", "execution_tips"], group: "老板场景" },
    { id: "ex-boss-4", title: "看助教整体状态", userIntent: "看看助教这个月整体怎么样，帮我弄个汇总", role: "boss", targetCustomerType: "assistant", outputPackage: ["daily_report", "execution_tips"], group: "老板场景" },
  ],
  manager: [
    { id: "ex-mgr-1", title: "老客户回访约球", userIntent: "好久没联系老客户了，帮我发几句话约他们来打球", role: "manager", targetCustomerType: "old", outputPackage: ["private_chat", "moments", "execution_tips"], group: "店长场景" },
    { id: "ex-mgr-2", title: "下午空台拉人", userIntent: "今天下午空台多，帮我发条朋友圈拉人", role: "manager", targetCustomerType: "all", outputPackage: ["moments", "execution_tips"], group: "店长场景" },
    { id: "ex-mgr-3", title: "员工生日祝福", userIntent: "今天有个员工生日，帮我在员工群里发个祝福", role: "manager", targetCustomerType: "assistant", outputPackage: ["group_notice", "execution_tips"], group: "店长场景" },
    { id: "ex-mgr-4", title: "下雨天邀约", userIntent: "今天下雨，店里估计人少，帮我发个朋友圈拉人", role: "manager", targetCustomerType: "old", outputPackage: ["moments", "execution_tips"], group: "店长场景" },
    { id: "ex-mgr-5", title: "会员群空台提醒", userIntent: "会员群里发个空台提醒，让大家知道现在可以来打球", role: "manager", targetCustomerType: "old", outputPackage: ["group_notice", "execution_tips"], group: "店长场景" },
    { id: "ex-mgr-6", title: "竞技群约局通知", userIntent: "竞技群发个今晚约局通知，看看有没有人想打球", role: "manager", targetCustomerType: "competition", outputPackage: ["group_notice", "private_chat", "execution_tips"], group: "店长场景" },
  ],
  assistant_manager: [
    { id: "ex-am-1", title: "助教在店发圈", userIntent: "今天助教都在，帮我发个朋友圈让客户知道", role: "assistant_manager", targetCustomerType: "assistant", outputPackage: ["moments", "execution_tips"], group: "助教管理场景" },
    { id: "ex-am-2", title: "助教PK设计", userIntent: "这个月想搞个助教PK，帮我设计一下规则", role: "assistant_manager", targetCustomerType: "assistant", outputPackage: ["pk_plan", "execution_tips"], group: "助教管理场景" },
    { id: "ex-am-3", title: "提醒助教发朋友圈", userIntent: "助教最近朋友圈发得少，帮我在群里提醒一下", role: "assistant_manager", targetCustomerType: "assistant", outputPackage: ["group_notice", "execution_tips"], group: "助教管理场景" },
    { id: "ex-am-4", title: "短视频配文", userIntent: "助教拍了条短视频，帮我配个文案", role: "assistant_manager", targetCustomerType: "assistant", outputPackage: ["short_video", "moments"], group: "助教管理场景" },
    { id: "ex-am-5", title: "助教客户群通知", userIntent: "助教客户群发个今日助教可约通知", role: "assistant_manager", targetCustomerType: "assistant", outputPackage: ["group_notice", "private_chat"], group: "助教管理场景" },
  ],
  coach: [
    { id: "ex-coach-1", title: "32人周赛全套", userIntent: "这周想搞个32人周赛，帮我弄一下", role: "coach", targetCustomerType: "competition", outputPackage: ["group_notice", "moments", "activity_plan", "execution_tips"], group: "教练场景" },
    { id: "ex-coach-2", title: "赛后战报", userIntent: "昨晚周赛打完了，帮我写个赛后战报", role: "coach", targetCustomerType: "competition", outputPackage: ["moments", "group_notice", "poster_copy"], group: "教练场景" },
    { id: "ex-coach-3", title: "拉新客进周赛群", userIntent: "今天有几个新客打得还可以，想拉他们进周赛群", role: "coach", targetCustomerType: "groupbuy", outputPackage: ["private_chat", "group_notice", "execution_tips"], group: "教练场景" },
    { id: "ex-coach-4", title: "客户问有没有人约球", userIntent: "有个客户问今晚有没有人一起打，怎么回", role: "coach", targetCustomerType: "competition", outputPackage: ["private_chat", "group_notice", "execution_tips"], group: "教练场景" },
    { id: "ex-coach-5", title: "竞技群赛后战报", userIntent: "竞技群赛后战报写一下，上周比赛结果出来了", role: "coach", targetCustomerType: "competition", outputPackage: ["moments", "group_notice", "execution_tips"], group: "教练场景" },
    { id: "ex-coach-6", title: "乔氏球桌约局", userIntent: "店里有乔氏台球桌，发给竞技客户的朋友圈约局", role: "coach", targetCustomerType: "competition", outputPackage: ["moments", "group_notice"], group: "教练场景" },
  ],
  frontdesk: [
    { id: "ex-fd-1", title: "团购客加微信", userIntent: "今天来了几个团购客，想加微信后面方便喊他们来打球", role: "frontdesk", targetCustomerType: "groupbuy", outputPackage: ["private_chat", "sop_checklist", "execution_tips"], group: "前厅场景" },
    { id: "ex-fd-2", title: "新客接待话术", userIntent: "第一次来的客户，前台怎么跟他说比较自然", role: "frontdesk", targetCustomerType: "new", outputPackage: ["private_chat", "sop_checklist", "execution_tips"], group: "前厅场景" },
    { id: "ex-fd-3", title: "开店检查表", userIntent: "前厅早班开店总是漏东西，帮我弄个检查表", role: "frontdesk", targetCustomerType: "new", outputPackage: ["sop_checklist", "execution_tips"], group: "前厅场景" },
    { id: "ex-fd-4", title: "客人问会员", userIntent: "有个客人问会员怎么弄，我怎么跟他说比较自然", role: "frontdesk", targetCustomerType: "groupbuy", outputPackage: ["private_chat", "execution_tips"], group: "前厅场景" },
  ],
  operator: [
    { id: "ex-op-1", title: "月度运营汇报", userIntent: "这个月运营数据帮我搭个汇报框架", role: "operator", targetCustomerType: "all", outputPackage: ["daily_report", "execution_tips"], group: "运营场景" },
    { id: "ex-op-2", title: "周末小活动", userIntent: "老板让我想一个周末小活动，别太复杂", role: "operator", targetCustomerType: "old", outputPackage: ["activity_plan", "moments", "group_notice", "execution_tips"], group: "运营场景" },
    { id: "ex-op-3", title: "本周内容规划", userIntent: "最近朋友圈发得太少了，帮我规划这周发什么", role: "operator", targetCustomerType: "all", outputPackage: ["moments", "execution_tips"], group: "运营场景" },
    { id: "ex-op-4", title: "短视频更新", userIntent: "店里短视频太久没更新了，帮我写几条配文", role: "operator", targetCustomerType: "all", outputPackage: ["short_video", "moments", "execution_tips"], group: "运营场景" },
  ],
};

/* ─── Quick scene cards by role (30 total) ─── */

export interface QuickSceneCard {
  id: string;
  title: string;
  description: string;
  userIntent: string;
  role: WorkbenchRole;
  targetCustomerType: TargetCustomerType;
  outputPackage: OutputPackageItem[];
}

export const QUICK_SCENE_CARDS_BY_ROLE: Record<WorkbenchRole, QuickSceneCard[]> = {
  boss: [
    { id: "sc-boss-1", title: "月度运营汇报", description: "整理本月运营框架", userIntent: "帮我整理这个月运营汇报框架", role: "boss", targetCustomerType: "all", outputPackage: ["daily_report", "execution_tips"] },
    { id: "sc-boss-2", title: "大客户关系维护", description: "单独约大客户来打球", userIntent: "有个大客户好久没来了，单独约一下", role: "boss", targetCustomerType: "vip", outputPackage: ["private_chat", "execution_tips"] },
    { id: "sc-boss-3", title: "门店冷清拉人", description: "发朋友圈和群公告热场", userIntent: "最近店里有点冷清，帮我想想发什么", role: "boss", targetCustomerType: "old", outputPackage: ["moments", "group_notice", "execution_tips"] },
    { id: "sc-boss-4", title: "看助教团队状态", description: "汇总助教本月表现", userIntent: "看看助教这个月整体状态怎么样", role: "boss", targetCustomerType: "assistant", outputPackage: ["daily_report", "execution_tips"] },
    { id: "sc-boss-5", title: "经营方向思考", description: "想想怎么改善经营", userIntent: "最近生意一般，帮我想想怎么弄", role: "boss", targetCustomerType: "all", outputPackage: ["execution_tips", "activity_plan"] },
  ],
  manager: [
    { id: "sc-mgr-1", title: "老客户回访", description: "熟人口吻私聊约球", userIntent: "好久没联系老客户了，帮我发几句话约球", role: "manager", targetCustomerType: "old", outputPackage: ["private_chat", "moments", "execution_tips"] },
    { id: "sc-mgr-2", title: "空台拉人", description: "发朋友圈吸引打球", userIntent: "今天下午空台多，帮我发朋友圈", role: "manager", targetCustomerType: "all", outputPackage: ["moments", "execution_tips"] },
    { id: "sc-mgr-3", title: "员工生日", description: "群里发自然祝福", userIntent: "今天有个员工生日，群里发个祝福", role: "manager", targetCustomerType: "assistant", outputPackage: ["group_notice", "execution_tips"] },
    { id: "sc-mgr-4", title: "雨天邀约", description: "下雨天人少发朋友圈", userIntent: "今天下雨人少，发朋友圈拉人", role: "manager", targetCustomerType: "old", outputPackage: ["moments", "execution_tips"] },
    { id: "sc-mgr-5", title: "卫生检查表", description: "做前厅卫生检查清单", userIntent: "最近卫生有点乱，做个检查表", role: "manager", targetCustomerType: "all", outputPackage: ["sop_checklist", "execution_tips"] },
    { id: "sc-mgr-6", title: "会员群空台提醒", description: "会员群发空台促活", userIntent: "会员群发个空台提醒，让大家来打球", role: "manager", targetCustomerType: "old", outputPackage: ["group_notice", "private_chat", "execution_tips"] },
    { id: "sc-mgr-7", title: "竞技群约局通知", description: "竞技群组织约球", userIntent: "竞技群发今晚约局通知", role: "manager", targetCustomerType: "competition", outputPackage: ["group_notice", "private_chat", "execution_tips"] },
  ],
  assistant_manager: [
    { id: "sc-am-1", title: "助教在店发圈", description: "让客户知道助教可约", userIntent: "今天助教都在，发朋友圈", role: "assistant_manager", targetCustomerType: "assistant", outputPackage: ["moments", "execution_tips"] },
    { id: "sc-am-2", title: "助教PK方案", description: "设计PK规则和追踪", userIntent: "这个月搞个助教PK，帮我设计", role: "assistant_manager", targetCustomerType: "assistant", outputPackage: ["pk_plan", "execution_tips"] },
    { id: "sc-am-3", title: "提醒发朋友圈", description: "群里温和提醒", userIntent: "助教朋友圈发太少，群里说下", role: "assistant_manager", targetCustomerType: "assistant", outputPackage: ["group_notice", "execution_tips"] },
    { id: "sc-am-4", title: "短视频配文", description: "给助教视频配文案", userIntent: "助教拍了短视频，帮我配文", role: "assistant_manager", targetCustomerType: "assistant", outputPackage: ["short_video", "moments"] },
    { id: "sc-am-5", title: "招助教内容", description: "写专业招聘文案", userIntent: "想招几个助教，帮我写招聘内容", role: "assistant_manager", targetCustomerType: "assistant", outputPackage: ["moments", "execution_tips"] },
    { id: "sc-am-6", title: "助教客户群通知", description: "群通知今日助教可约", userIntent: "助教客户群发今日助教可约", role: "assistant_manager", targetCustomerType: "assistant", outputPackage: ["group_notice", "private_chat", "execution_tips"] },
  ],
  coach: [
    { id: "sc-coach-1", title: "32人周赛全套", description: "公告+朋友圈+活动方案", userIntent: "这周搞32人周赛，帮我弄", role: "coach", targetCustomerType: "competition", outputPackage: ["group_notice", "moments", "activity_plan", "execution_tips"] },
    { id: "sc-coach-2", title: "赛后战报", description: "发战报+预热线", userIntent: "昨晚周赛打完，帮我写战报", role: "coach", targetCustomerType: "competition", outputPackage: ["moments", "group_notice", "poster_copy"] },
    { id: "sc-coach-3", title: "拉人进周赛群", description: "教练视角轻引导", userIntent: "新客打得不错，拉他进周赛群", role: "coach", targetCustomerType: "groupbuy", outputPackage: ["private_chat", "group_notice", "execution_tips"] },
    { id: "sc-coach-4", title: "撮合约球搭子", description: "帮客户组局约球", userIntent: "有客户问有没有人一起打", role: "coach", targetCustomerType: "competition", outputPackage: ["private_chat", "group_notice", "execution_tips"] },
    { id: "sc-coach-5", title: "课程推广", description: "推基础教学不发价格", userIntent: "想推基础教学课，发朋友圈", role: "coach", targetCustomerType: "new", outputPackage: ["moments", "execution_tips"] },
    { id: "sc-coach-6", title: "竞技群赛后战报", description: "写战报+预告下次", userIntent: "竞技群发个赛后战报，附下次预告", role: "coach", targetCustomerType: "competition", outputPackage: ["moments", "group_notice", "execution_tips"] },
    { id: "sc-coach-7", title: "乔氏球桌约局", description: "围绕乔氏台组局", userIntent: "乔氏台球桌约局发朋友圈和群里", role: "coach", targetCustomerType: "competition", outputPackage: ["moments", "group_notice"] },
    { id: "sc-coach-8", title: "斯诺克邀约", description: "斯诺克球友约球", userIntent: "想发个斯诺克邀约内容", role: "coach", targetCustomerType: "competition", outputPackage: ["moments", "group_notice", "execution_tips"] },
  ],
  frontdesk: [
    { id: "sc-fd-1", title: "团购客加微信", description: "自然不推销的话术", userIntent: "团购客来了，加微信方便后面喊球", role: "frontdesk", targetCustomerType: "groupbuy", outputPackage: ["private_chat", "sop_checklist", "execution_tips"] },
    { id: "sc-fd-2", title: "新客接待", description: "第一次到店怎么说", userIntent: "第一次来的客户，前台怎么说", role: "frontdesk", targetCustomerType: "new", outputPackage: ["private_chat", "sop_checklist", "execution_tips"] },
    { id: "sc-fd-3", title: "开店检查表", description: "早班不漏东西", userIntent: "早班开店老漏东西，做个检查表", role: "frontdesk", targetCustomerType: "new", outputPackage: ["sop_checklist", "execution_tips"] },
    { id: "sc-fd-4", title: "客人问会员", description: "不输出储值方案", userIntent: "客人问会员怎么弄，怎么回", role: "frontdesk", targetCustomerType: "groupbuy", outputPackage: ["private_chat", "execution_tips"] },
    { id: "sc-fd-5", title: "投诉安抚", description: "不擅自经济承诺", userIntent: "客人排队太久不高兴，安抚一下", role: "frontdesk", targetCustomerType: "new", outputPackage: ["private_chat", "execution_tips"] },
  ],
  operator: [
    { id: "sc-op-1", title: "月度汇报框架", description: "搭汇报结构", userIntent: "运营汇报框架帮我搭一个", role: "operator", targetCustomerType: "all", outputPackage: ["daily_report", "execution_tips"] },
    { id: "sc-op-2", title: "周末小活动", description: "简单不复杂", userIntent: "做个周末活动，别太复杂", role: "operator", targetCustomerType: "old", outputPackage: ["activity_plan", "moments", "group_notice", "execution_tips"] },
    { id: "sc-op-3", title: "本周内容规划", description: "规划朋友圈内容", userIntent: "朋友圈太久没发，规划发什么", role: "operator", targetCustomerType: "all", outputPackage: ["moments", "execution_tips"] },
    { id: "sc-op-4", title: "短视频配文", description: "抖音/朋友圈多版本", userIntent: "短视频太久没更新，写配文", role: "operator", targetCustomerType: "all", outputPackage: ["short_video", "moments", "execution_tips"] },
    { id: "sc-op-5", title: "客流分析", description: "理理最近数据", userIntent: "最近客流什么情况，帮我理理", role: "operator", targetCustomerType: "all", outputPackage: ["daily_report", "execution_tips"] },
  ],
};

/* ─── Label lookup helpers ─── */

const ROLE_LABEL_MAP: Record<WorkbenchRole, string> = {
  boss: "老板", manager: "店长", assistant_manager: "助教管理",
  coach: "教练", frontdesk: "前厅", operator: "运营",
};

const CUSTOMER_LABEL_MAP: Record<TargetCustomerType, string> = {
  all: "全部客户", groupbuy: "团购客", new: "新客户", old: "老客户",
  competition: "竞技客户", assistant: "助教客户", light_competition: "轻竞技", vip: "大客户",
};

const OUTPUT_LABEL_MAP: Record<OutputPackageItem, string> = {
  moments: "朋友圈", group_notice: "群公告", private_chat: "私聊话术",
  poster_copy: "海报文案", short_video: "短视频配文", execution_tips: "执行建议",
  daily_report: "日报/汇报", activity_plan: "活动方案", sop_checklist: "SOP/检查表", pk_plan: "PK方案",
};

export function getRoleLabel(role: WorkbenchRole): string {
  return ROLE_LABEL_MAP[role] || role;
}

export function getCustomerTypeLabel(type: TargetCustomerType): string {
  return CUSTOMER_LABEL_MAP[type] || type;
}

export function getOutputPackageLabel(item: OutputPackageItem): string {
  return OUTPUT_LABEL_MAP[item] || item;
}