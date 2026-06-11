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
import { Brain, Loader2 } from "lucide-react";
import { EmptyStoreGuide } from "@/components/empty-store-guide";

function getTaskCardUsage(): Record<string, number> {
  if (typeof window === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem("workbench_card_usage") || "{}");
  } catch {
    return {};
  }
}

export default function WorkbenchPage() {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const router = useRouter();
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [storeLoading, setStoreLoading] = useState(true);
  const [activeRole, setActiveRole] = useState<string>(() => {
    if (typeof window !== "undefined") return localStorage.getItem("workbench_role") || "manager";
    return "manager";
  });

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    setStoreLoading(true);
    api.getMyStore()
      .then((s) => { if (!cancelled) setStore(s); })
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
    return <div className="flex items-center justify-center py-20"><Loader2 className="h-6 w-6 animate-spin text-indigo-600" /></div>;
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

  const allRoles: Array<{ key: string; label: string; isCollab?: boolean }> = [
    ...MVP_ROLES.map((r) => ({ key: r, label: ROLE_LABELS[r] })),
    { key: "collaborate", label: "🤝 协作", isCollab: true },
  ];

  return (
    <div className="mx-auto max-w-5xl">
      <Breadcrumb items={[{ label: "返回首页", href: "/dashboard" }, { label: "AI 工作台" }]} />

      <div className="flex items-center gap-2 mb-4">
        <Brain className="h-5 w-5 text-indigo-600" />
        <h2 className="text-xl font-bold text-slate-900">AI 工作台</h2>
      </div>

      {/* 角色 Tab */}
      <div className="mb-4 flex gap-2 rounded-lg bg-white border border-slate-200 p-1 overflow-x-auto shadow-sm">
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
            className={`shrink-0 rounded-md px-4 py-2 text-sm font-medium transition-all duration-150 ${
              activeRole === r.key && !r.isCollab
                ? "bg-slate-50 text-slate-900 shadow-sm"
                : r.isCollab
                ? "text-indigo-600 hover:bg-indigo-50"
                : "text-slate-500 hover:text-slate-700"
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
            className="flex flex-col rounded-lg border border-slate-200 bg-white p-4 shadow-sm cursor-pointer hover:border-indigo-200 hover:-translate-y-0.5 hover:shadow-md transition-all duration-200 active:scale-[0.98]"
          >
            <div className="mb-1.5 flex items-start justify-between gap-2">
              <h4 className="text-sm font-semibold text-slate-900">{card.title}</h4>
              {card.priority === "P0" && (
                <span className="shrink-0 rounded-full bg-indigo-50 px-1.5 py-0.5 text-xs text-indigo-600">推荐</span>
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
    </div>
  );
}
