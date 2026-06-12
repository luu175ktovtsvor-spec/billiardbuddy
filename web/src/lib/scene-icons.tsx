import type { LucideIcon } from "lucide-react";
import {
  MessageCircle,
  Megaphone,
  Trophy,
  Flag,
  Store,
  BarChart3,
  UserPlus,
  BookOpen,
  Users,
  Target,
  HeartHandshake,
  Image as ImageIcon,
  BadgePercent,
  Crown,
  Video,
  ShieldCheck,
  ClipboardCheck,
  ListChecks,
  MessagesSquare,
  Sparkles,
} from "lucide-react";

/** 场景图标体系:按语义关键词映射统一的 lucide 线性图标。
 * 替代此前散落各处的随机 emoji(🔥💪🎓…)——emoji 风格不一、含义牵强,
 * 是界面"AI 生成感"的主要来源。新增场景不用配图标,命中关键词即可。 */
const KEYWORD_ICONS: Array<[RegExp, LucideIcon]> = [
  [/朋友圈|发圈|种草/, MessageCircle],
  [/群公告|进群|接龙|社群|群内容|群运营/, Megaphone],
  [/赛事|比赛|周赛|月赛|战报|冠军|报名|赛制|对阵/, Trophy],
  [/开业|新店/, Store],
  [/活动|策划|节日|周年|促活|引流/, Flag],
  [/日报|周报|月报|简报|复盘|报表|分析|诊断|数据|经营|营收/, BarChart3],
  [/招聘|招人|入职/, UserPlus],
  [/培训|考核|教学|SOP|流程|手册/, BookOpen],
  [/助教/, Users],
  [/教练|球技|练球|教学计划/, Target],
  [/回访|老客|维护|邀约|约球|搭子|客户/, HeartHandshake],
  [/海报|生图|图片|设计|配图/, ImageIcon],
  [/团购|促销|特惠|折扣|核销/, BadgePercent],
  [/会员|充值|VIP|储值/, Crown],
  [/抖音|短视频|小红书|视频号|平台/, Video],
  [/投诉|安抚|纠纷|差评/, ShieldCheck],
  [/卫生|检查|巡店|闭店|开店/, ClipboardCheck],
  [/任务|清单|排班|待办/, ListChecks],
  [/话术|沟通|回复|应对/, MessagesSquare],
];

export function sceneIconFor(hint: string): LucideIcon {
  for (const [re, icon] of KEYWORD_ICONS) {
    if (re.test(hint)) return icon;
  }
  return Sparkles;
}

/** 统一图标砖:浅绿底 + 品牌绿线性图标,全站同一视觉语言。 */
export function SceneIconTile({
  hint,
  size = "md",
  className = "",
}: {
  hint: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const Icon = sceneIconFor(hint);
  const box = size === "sm" ? "h-9 w-9 rounded-lg" : size === "lg" ? "h-12 w-12 rounded-xl" : "h-10 w-10 rounded-xl";
  const glyph = size === "sm" ? "h-4 w-4" : size === "lg" ? "h-6 w-6" : "h-5 w-5";
  return (
    <span className={`flex shrink-0 items-center justify-center bg-brand-50 text-brand-600 ${box} ${className}`}>
      <Icon className={glyph} />
    </span>
  );
}
