"use client";

import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { PageHeader } from "@/components/layout/page-header";
import {
  Trophy,
  Store,
  BookOpen,
  BarChart3,
  Flag,
  BadgePercent,
  Crown,
  Wand2,
  ChevronRight,
  type LucideIcon,
} from "lucide-react";

/* 协作场景馆:只负责"选场景",执行在独立的 run 页(对话感)。
 * 前 4 个是后端原生 task_type;后 4 个是预设模板——走 custom 通道+预填描述,
 * 不需要后端新增类型,场景可以随时在这里加。 */

interface Scenario {
  type: string;
  icon: LucideIcon;
  name: string;
  desc: string;
  roles: string[];
  /** custom 预设:预填到执行页的任务描述模板 */
  preset?: string;
}

const SCENARIOS: Scenario[] = [
  {
    type: "activity_planning",
    icon: Trophy,
    name: "策划活动",
    desc: "周赛、月赛、节日活动,从玩法到宣传一条龙",
    roles: ["店长", "教练", "运营", "前厅"],
  },
  {
    type: "store_opening",
    icon: Store,
    name: "新店开业",
    desc: "开业筹备全流程:节奏、物料、引爆动作",
    roles: ["老板", "店长", "前厅", "运营"],
  },
  {
    type: "staff_training",
    icon: BookOpen,
    name: "员工培训",
    desc: "新人入职、技能提升、考核标准一次出齐",
    roles: ["店长", "助教管理", "前厅"],
  },
  {
    type: "business_review",
    icon: BarChart3,
    name: "经营复盘",
    desc: "月度/季度经营分析,问题与下一步打法",
    roles: ["老板", "店长", "运营"],
  },
  {
    type: "custom",
    icon: Flag,
    name: "周年庆方案",
    desc: "店庆主题、玩法、宣传节奏、预算分配思路",
    roles: ["自动分派"],
    preset: "帮我策划门店周年庆活动:确定主题和玩法,设计宣传节奏(提前几天发什么),给出预算分配思路和当天人员分工。",
  },
  {
    type: "custom",
    icon: BadgePercent,
    name: "淡季促活作战",
    desc: "工作日下午没人?引流、社群、助教联动打法",
    roles: ["自动分派"],
    preset: "制定淡季(工作日下午时段)促活作战方案:怎么引流到店、社群里怎么带节奏、助教怎么联动,给出一周的执行清单。",
  },
  {
    type: "custom",
    icon: Crown,
    name: "会员体系搭建",
    desc: "权益设计、推销话术、上线节奏整套方案",
    roles: ["自动分派"],
    preset: "帮我设计门店会员/储值体系搭建方案:权益怎么设计、前台推销话术、上线推广节奏,注意要符合小比例赠送的稳妥原则。",
  },
  {
    type: "custom",
    icon: Wand2,
    name: "自定义协作",
    desc: "自己描述任务,指挥官自动分派岗位",
    roles: ["自动分派"],
  },
];

export default function CollaborateGalleryPage() {
  const { isAuthenticated } = useAuth();
  const router = useRouter();

  if (!isAuthenticated) return null;

  const goRun = (s: Scenario) => {
    const params = new URLSearchParams({ type: s.type, name: s.name });
    if (s.preset) params.set("preset", s.preset);
    router.push(`/dashboard/workbench/collaborate/run?${params.toString()}`);
  };

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="多人协作" backHref="/dashboard/workbench" />
      <Breadcrumb
        items={[
          { label: "工作台", href: "/dashboard/workbench" },
          { label: "协作任务" },
        ]}
      />

      <h2 className="hidden text-xl font-bold text-slate-900 mb-2 lg:block">协作任务</h2>
      <p className="mb-6 text-[15px] leading-relaxed text-slate-500 lg:text-sm">
        选一个场景,运营智能体先制定方案框架,再让各岗位分头执行,最后整合成一份能直接落地的完整方案。
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {SCENARIOS.map((s) => (
          <button
            key={s.name}
            type="button"
            onClick={() => goRun(s)}
            className="flex items-start gap-3.5 rounded-2xl bg-white p-4 text-left transition-all duration-200 hover:border-brand-200 hover:shadow-md active:scale-[0.98]"
          >
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-brand-50 text-brand-600">
              <s.icon className="h-6 w-6" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className="text-[15px] font-semibold text-slate-900">{s.name}</span>
                <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
              </span>
              <span className="mt-0.5 block text-[13px] leading-relaxed text-slate-500">{s.desc}</span>
              <span className="mt-2 flex flex-wrap gap-1">
                {s.roles.map((r) => (
                  <span key={r} className="rounded-full bg-slate-50 px-2 py-0.5 text-[11px] text-slate-500">
                    {r}
                  </span>
                ))}
              </span>
            </span>
          </button>
        ))}
      </div>

      <p className="mt-5 text-center text-xs text-slate-400">
        每次协作生成一份完整方案,计入生成次数;结果自动存入生成历史
      </p>
    </div>
  );
}
