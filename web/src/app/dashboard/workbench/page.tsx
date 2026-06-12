"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/hooks/auth-context";
import { api } from "@/lib/api";
import type { StoreResponse } from "@/types/store";
import {
  ROLE_TASKS,
  MVP_ROLES,
  ROLE_LABELS,
  ROLE_DESCRIPTIONS,
  getOutputLabels,
} from "@/lib/role-workbench-config";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Brain, Loader2, Search, X } from "lucide-react";
import { EmptyStoreGuide } from "@/components/empty-store-guide";

function getTaskCardUsage(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem("workbench_card_usage") || "{}");
  } catch {
    return {};
  }
}

/** 成员角色 → 工作台岗位 tab。owner 看老板视角;未知角色回退店长。 */
function roleToTab(myRole: string | null | undefined): string {
  if (!myRole) return "manager";
  if (myRole === "owner") return "boss";
  return myRole in ROLE_TASKS ? myRole : "manager";
}

export default function WorkbenchPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [storeLoading, setStoreLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [activeRole, setActiveRole] = useState<string>(() => {
    if (typeof window !== "undefined") return localStorage.getItem("workbench_role") || "manager";
    return "manager";
  });

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setStoreLoading(true);
    api.getMyStore()
      .then((s) => {
        if (cancelled) return;
        setStore(s);
        // 首次进入(无手动选择记录)默认选中用户自己的岗位:
        // 助教管理打开看到的应该是助教管理的卡,不是店长的
        if (!localStorage.getItem("workbench_role") && s.my_role) {
          setActiveRole(roleToTab(s.my_role));
        }
      })
      .catch(() => { if (!cancelled) setStore(null); })
      .finally(() => { if (!cancelled) setStoreLoading(false); });
    return () => { cancelled = true; };
  }, [isAuthenticated]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      localStorage.setItem("workbench_role", activeRole);
    }
  }, [activeRole]);

  if (authLoading || storeLoading) {
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-brand-600" /></div>;
  }
  if (!isAuthenticated) return null;
  if (store === null) {
    return <EmptyStoreGuide description="请先完善门店资料，AI 工作台才能根据你的门店生成内容。" />;
  }

  const currentTasks = (ROLE_TASKS[activeRole as keyof typeof ROLE_TASKS] || []).sort((a, b) => {
    const usage = getTaskCardUsage();
    const order: Record<string, number> = { P0: 0, P1: 1, P2: 2 };
    const pa = order[a.priority] ?? 9;
    const pb = order[b.priority] ?? 9;
    if (pa === pb) return (usage[b.id] || 0) - (usage[a.id] || 0);
    return pa - pb;
  });

  // 关键词搜索:82 张卡跨岗位找功能("投诉""日报"),不用一个 tab 一个 tab 翻
  const q = query.trim().toLowerCase();
  const searchResults = q
    ? Object.values(ROLE_TASKS)
        .flat()
        .filter(
          (card) =>
            card.title.toLowerCase().includes(q) ||
            card.description.toLowerCase().includes(q) ||
            card.sceneTags.some((t) => t.toLowerCase().includes(q))
        )
    : [];

  const allRoles: Array<{ key: string; label: string; isCollab?: boolean }> = [
    ...MVP_ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r] })),
    { key: "collaborate", label: "🤝 协作", isCollab: true },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumb items={[{ label: "返回首页", href: "/dashboard" }, { label: "AI 工作台" }]} />

      <div className="flex items-center gap-2 mb-4">
        <Brain className="h-5 w-5 text-brand-600" />
        <h2 className="text-[17px] font-bold text-slate-900 lg:text-xl">AI 工作台</h2>
      </div>

      {/* 卡片搜索 */}
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="找功能，如：投诉、日报、海报、招聘…"
          className="h-11 w-full rounded-xl border border-slate-200 bg-white pl-9 pr-11 text-[15px] text-slate-900 placeholder-slate-400 shadow-sm focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
        />
        {query && (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="清空搜索"
            className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center text-slate-400 hover:text-slate-600 active:text-slate-600"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      {/* 搜索结果(跨岗位) */}
      {q ? (
        <>
          <p className="mb-4 text-sm text-slate-500">
            {searchResults.length > 0 ? `找到 ${searchResults.length} 个相关功能` : "没找到相关功能，换个关键词试试（如：朋友圈、赛事、话术）"}
          </p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {searchResults.map((card) => (
              <div
                key={card.id}
                onClick={() => router.push(`/dashboard/workbench/${card.id}`)}
                className="flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm cursor-pointer hover:border-brand-200 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 active:scale-[0.98]"
              >
                <div className="mb-1.5 flex items-start justify-between gap-2">
                  <h4 className="text-[15px] font-semibold text-slate-900">{card.title}</h4>
                  <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                    {ROLE_LABELS[card.role as keyof typeof ROLE_LABELS] || card.role}
                  </span>
                </div>
                <p className="mb-2 text-xs text-slate-500 leading-relaxed">{card.description}</p>
                <div className="mt-auto text-xs text-slate-400">{getOutputLabels(card.outputPackage)}</div>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
      {/* 角色 Tab：横向滚动 chips，手机不换行 */}
      <div className="mb-4 flex gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {allRoles.map((r) => (
          <button
            key={r.key}
            type="button"
            onClick={() => {
              if (r.isCollab) {
                router.push("/dashboard/workbench/collaborate");
              } else {
                setActiveRole(r.key);
              }
            }}
            className={`flex h-9 shrink-0 items-center rounded-full px-4 text-sm font-medium transition-all duration-150 active:scale-[0.98] ${
              activeRole === r.key && !r.isCollab
                ? "bg-brand-600 text-white shadow-sm"
                : r.isCollab
                ? "border border-brand-200 bg-white text-brand-600"
                : "border border-slate-200 bg-white text-slate-600"
            }`}
          >
            {r.label}
          </button>
        ))}
      </div>

      <p className="mb-4 text-sm text-slate-500">
        {ROLE_DESCRIPTIONS[activeRole as keyof typeof ROLE_DESCRIPTIONS]}。点击卡片进入生成。
      </p>

      {/* 任务卡片网格 */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {currentTasks.map((card) => (
          <div
            key={card.id}
            onClick={() => router.push(`/dashboard/workbench/${card.id}`)}
            className="flex flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm cursor-pointer hover:border-brand-200 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 active:scale-[0.98]"
          >
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <h4 className="text-[15px] font-semibold text-slate-900">{card.title}</h4>
              {card.priority === "P0" && (
                <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-xs text-brand-600">推荐</span>
              )}
            </div>
            <p className="mb-2 text-xs text-slate-500 leading-relaxed">{card.description}</p>
            {card.sceneTags.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1">
                {card.sceneTags.map((tag) => (
                  <span key={tag} className="inline-block rounded-full bg-slate-50 px-2 py-0.5 text-xs text-slate-500">{tag}</span>
                ))}
              </div>
            )}
            <div className="mt-auto text-xs text-slate-400">{getOutputLabels(card.outputPackage)}</div>
          </div>
        ))}
      </div>
        </>
      )}
    </div>
  );
}
