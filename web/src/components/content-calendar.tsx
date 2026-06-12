"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Calendar, CheckCircle2, ChevronRight, Clock, Sparkles, PartyPopper } from "lucide-react";
import { api } from "@/lib/api";
import { getTaskById } from "@/lib/role-workbench-config";

interface CalendarItem {
  time: string;
  title: string;
  desc: string;
  href: string;
}

const WEEKDAY_ITEMS: Record<number, CalendarItem[]> = {
  0: [ // 周日
    { time: "10:00", title: "周末到店提醒", desc: "发朋友圈提醒客户周末来打球", href: "/dashboard/workbench/mgr-daily-moments?intent=周末到店提醒朋友圈" },
    { time: "14:00", title: "周赛战报", desc: "如果周末有比赛，发赛后战报", href: "/dashboard/workbench/coach-tournament-report?intent=发周赛战报" },
    { time: "20:00", title: "下周预告", desc: "预告下周的活动或赛事", href: "/dashboard/workbench/mgr-weekly-tournament-notice?intent=下周活动预告" },
  ],
  1: [ // 周一
    { time: "10:00", title: "新的一周开始", desc: "发朋友圈激励老客户本周来打球", href: "/dashboard/workbench/mgr-daily-moments?intent=新的一周激励老客户的朋友圈" },
    { time: "15:00", title: "空台促活", desc: "下午空台多，发促活内容", href: "/dashboard/workbench/fd-empty-table-promo?intent=下午空台促活" },
  ],
  2: [ // 周二
    { time: "10:00", title: "助教推广", desc: "发助教服务推广内容", href: "/dashboard/workbench/mgr-assistant-promo?intent=助教到店推广" },
    { time: "15:00", title: "搭子局通知", desc: "撮合散客组局", href: "/dashboard/workbench/mgr-competition-group-match?intent=搭子局组局通知" },
  ],
  3: [ // 周三
    { time: "10:00", title: "会员群维护", desc: "会员群发内容保持活跃", href: "/dashboard/workbench/op-member-group-content?intent=今天会员群发什么" },
    { time: "15:00", title: "竞技群维护", desc: "竞技群发约球通知", href: "/dashboard/workbench/op-competition-group-content?intent=竞技群约球通知" },
  ],
  4: [ // 周四
    { time: "10:00", title: "老客户回访", desc: "联系半个月没来的老客户", href: "/dashboard/workbench/mgr-old-customer-recall?intent=联系半个月没来的老客户" },
    { time: "15:00", title: "周赛预热", desc: "提前预热周末周赛", href: "/dashboard/workbench/coach-tournament-signup?intent=周末周赛预热" },
  ],
  5: [ // 周五
    { time: "10:00", title: "周末预热", desc: "发朋友圈预热周末活动", href: "/dashboard/workbench/mgr-daily-moments?intent=周末预热朋友圈" },
    { time: "15:00", title: "周赛报名", desc: "推周赛报名", href: "/dashboard/workbench/coach-tournament-signup?intent=周赛报名通知" },
    { time: "20:00", title: "今晚约球", desc: "发今晚约球通知", href: "/dashboard/workbench/mgr-competition-group-match?intent=今晚约球通知" },
  ],
  6: [ // 周六
    { time: "10:00", title: "周末到店提醒", desc: "提醒客户周末来打球", href: "/dashboard/workbench/mgr-daily-moments?intent=周末到店提醒朋友圈" },
    { time: "14:00", title: "周赛执行", desc: "周赛相关内容", href: "/dashboard/workbench/coach-pre-match-reminder?intent=周赛赛前提醒" },
    { time: "20:00", title: "赛后战报", desc: "发周赛战报", href: "/dashboard/workbench/coach-tournament-report?intent=赛后战报" },
  ],
};

const WEEKDAY_NAMES = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

// 节日表与后端 dashboard_service 的 FESTIVALS 保持一致(月,日,名称),前端提前 10 天内提醒
const FESTIVALS: Array<[number, number, string]> = [
  [1, 1, "元旦"], [2, 14, "情人节"], [3, 8, "妇女节"], [5, 1, "劳动节"],
  [6, 1, "儿童节"], [10, 1, "国庆节"], [11, 11, "双十一"], [12, 25, "圣诞节"],
];

/** 从今天起 10 天内最近的节日(跨年安全),没有则 null */
function upcomingFestival(now: Date): { name: string; days: number } | null {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let best: { name: string; days: number } | null = null;
  for (const [mo, d, name] of FESTIVALS) {
    for (const yr of [now.getFullYear(), now.getFullYear() + 1]) {
      const fd = new Date(yr, mo - 1, d);
      const days = Math.round((fd.getTime() - start.getTime()) / 86400000);
      if (days >= 0 && days <= 10 && (!best || days < best.days)) {
        best = { name, days };
      }
    }
  }
  return best;
}

function timeToMin(t: string): number {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** 从事项 href 解析出任务卡的 promptKey（用于和今日生成记录比对打勾） */
function itemPromptKey(item: CalendarItem): string | null {
  const m = item.href.match(/\/dashboard\/workbench\/([^?]+)/);
  if (!m) return null;
  return getTaskById(m[1])?.promptKey || null;
}

export function ContentCalendar() {
  const today = new Date();
  const todayWeekday = today.getDay();
  const nowMin = today.getHours() * 60 + today.getMinutes();
  const [selectedDay, setSelectedDay] = useState(todayWeekday);
  const [doneSubTypes, setDoneSubTypes] = useState<Set<string>>(new Set());

  const festival = upcomingFestival(today);

  /* 拉今日生成记录：做过的事项自动打勾，静态日历变每日打卡清单 */
  useEffect(() => {
    let cancelled = false;
    api
      .listGenerations({ page: 1, page_size: 50 })
      .then((res) => {
        if (cancelled) return;
        const todayStr = new Date().toDateString();
        const subTypes = new Set<string>();
        for (const item of res.items) {
          if (new Date(item.created_at).toDateString() === todayStr && item.sub_type) {
            subTypes.add(item.sub_type);
          }
        }
        setDoneSubTypes(subTypes);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const items = WEEKDAY_ITEMS[selectedDay] || [];
  const isToday = selectedDay === todayWeekday;
  const itemDone = (it: CalendarItem) => {
    const pk = itemPromptKey(it);
    return isToday && !!pk && doneSubTypes.has(pk);
  };
  const doneCount = isToday ? items.filter(itemDone).length : 0;

  // 今天列里:第一个"还没到点且没做"的事项 = 接下来要做的(高亮)
  const nextIdx = isToday
    ? items.findIndex((it) => !itemDone(it) && timeToMin(it.time) >= nowMin)
    : -1;

  return (
    <div className="rounded-2xl bg-white">
      <div className="border-b border-slate-100 px-4 py-3">
        <div className="flex items-center gap-2">
          <Calendar className="h-5 w-5 text-brand-600" />
          <h3 className="text-[17px] font-semibold text-slate-900 lg:text-base">内容日历</h3>
          <span className="ml-auto text-[13px] text-slate-400 lg:text-xs">
            {isToday && items.length > 0
              ? doneCount >= items.length
                ? "今天全部完成 🎉"
                : `今天完成 ${doneCount}/${items.length}`
              : "一周内容节奏"}
          </span>
        </div>
      </div>

      {/* 节日雷达:临近节日提醒(实时,复用后端同款节日表) */}
      {festival && (
        <Link
          href={`/dashboard/workbench/mgr-daily-moments?intent=${encodeURIComponent(festival.name + "活动预热朋友圈")}`}
          className="flex items-center gap-2 border-b border-slate-100 bg-brand-50/60 px-4 py-2.5 active:bg-brand-100/60 transition-colors"
        >
          <PartyPopper className="h-4 w-4 shrink-0 text-brand-600" />
          <span className="flex-1 text-[13px] text-slate-700">
            {festival.days === 0 ? (
              <>今天就是<b className="font-semibold">{festival.name}</b>，趁热做内容</>
            ) : (
              <>还有 <b className="font-semibold">{festival.days}</b> 天就是<b className="font-semibold">{festival.name}</b>，建议提前备活动</>
            )}
          </span>
          <ChevronRight className="h-4 w-4 shrink-0 text-brand-400" />
        </Link>
      )}

      {/* 星期选择 */}
      <div className="flex border-b border-slate-100">
        {WEEKDAY_NAMES.map((name, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setSelectedDay(i)}
            className={`flex-1 min-h-[44px] py-2 text-[13px] font-medium text-center transition-colors active:bg-slate-100 lg:min-h-0 lg:text-xs ${
              i === selectedDay
                ? "border-b-2 border-brand-600 text-brand-600"
                : i === todayWeekday
                ? "text-brand-400"
                : "text-slate-400 hover:text-slate-600"
            }`}
          >
            {name}
            {i === todayWeekday && <span className="block text-[10px] text-brand-400">今天</span>}
          </button>
        ))}
      </div>

      {/* 内容列表 */}
      <div className="divide-y divide-slate-50">
        {items.map((item, i) => {
          const done = itemDone(item);
          const past = isToday && !done && timeToMin(item.time) < nowMin;
          const isNext = i === nextIdx;
          return (
            <div
              key={i}
              className={`flex min-h-[56px] items-center gap-3 px-4 py-3 transition-colors ${
                isNext ? "bg-brand-50/40" : "hover:bg-slate-50"
              }`}
            >
              <div className="flex items-center gap-1.5 shrink-0 w-20">
                {done ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Clock className={`h-3.5 w-3.5 ${past ? "text-slate-300" : "text-slate-400"}`} />
                )}
                <span className={`text-xs ${past ? "text-slate-300" : "text-slate-500"}`}>{item.time}</span>
                {isNext && (
                  <span className="rounded-full bg-brand-600 px-1.5 py-0.5 text-[10px] font-medium text-white">接下来</span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className={`text-[15px] font-medium lg:text-sm ${done ? "text-slate-400 line-through" : past ? "text-slate-400" : "text-slate-900"}`}>
                  {item.title}
                  {past && <span className="ml-1.5 text-[11px] font-normal text-slate-300">已过</span>}
                </p>
                <p className="text-[13px] text-slate-500 truncate lg:text-xs">{item.desc}</p>
              </div>
              <Link
                href={item.href}
                className={`shrink-0 inline-flex items-center gap-1 rounded-lg px-3 py-2.5 text-[13px] font-medium transition-all active:scale-[0.98] lg:text-xs ${
                  done
                    ? "bg-slate-50 text-slate-400 hover:bg-slate-100"
                    : "bg-brand-50 text-brand-600 hover:bg-brand-100"
                }`}
              >
                <Sparkles className="h-3.5 w-3.5" />
                {done ? "再来一条" : "生成"}
                <ChevronRight className="h-3.5 w-3.5" />
              </Link>
            </div>
          );
        })}
      </div>
    </div>
  );
}
