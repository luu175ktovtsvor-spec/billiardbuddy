"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import type { StoreResponse } from "@/types/store";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Users, Loader2 } from "lucide-react";
import { EmptyStoreGuide } from "@/components/empty-store-guide";

const MODULES = [
  { slug: "basic", label: "基本信息", icon: "📋", desc: "门店名称、地址、电话、营业时间" },
  { slug: "profile", label: "运营画像", icon: "📊", desc: "门店类型、客群、定价、特色服务" },
  { slug: "branding", label: "品牌风格", icon: "🎨", desc: "品牌调性、Logo、二维码" },
  { slug: "pricing", label: "定价体系", icon: "💰", desc: "台费标准、套餐设计、会员卡" },
  { slug: "slogan", label: "广告语", icon: "📝", desc: "门店宣传语、文案风格" },
];

function isNonEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (typeof v === "object" && !Array.isArray(v)) return Object.keys(v as object).length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function getModuleStatus(store: StoreResponse | null, profile: Record<string, unknown> | null | undefined, slug: string): boolean {
  if (!store) return false;
  switch (slug) {
    case "basic":
      return !!(store.name && store.address && store.phone && store.business_hours);
    case "profile":
      return !!profile && typeof profile === "object" && Object.keys(profile).length > 0;
    case "branding":
      return !!(store as any).brand_style || !!store.logo_url;
    case "pricing":
      return isNonEmpty(store.pricing) || isNonEmpty(store.member_cards) || isNonEmpty(store.recharge_rules);
    case "slogan": {
      if (!profile || typeof profile !== "object") return false;
      const basic = (profile as any).basic;
      return !!(basic?.one_liner || basic?.main_selling_points?.length);
    }
    default:
      return false;
  }
}

export default function StoreSettingsPage() {
  const router = useRouter();
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    api.getMyStore()
      .then((s) => { if (!cancelled) setStore(s); })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          setStore(null);
        }
      });
    return () => { cancelled = true; };
  }, []);

  if (store === undefined) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
        <span className="ml-2 text-slate-500">加载中...</span>
      </div>
    );
  }

  if (!store) {
    return (
      <div className="mx-auto max-w-2xl">
        <Breadcrumb items={[
          { label: "工作台", href: "/dashboard/workbench" },
          { label: "门店设置" },
        ]} />
        <EmptyStoreGuide description="你还没有门店资料，请先创建门店" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <Breadcrumb items={[
        { label: "工作台", href: "/dashboard/workbench" },
        { label: "门店设置" },
      ]} />

      <div className="mb-6">
        <h1 className="text-xl font-bold text-slate-900">⚙️ 门店设置</h1>
        <p className="mt-1 text-sm text-slate-500">
          分模块管理门店资料，AI 会根据这些信息生成更精准的文案
        </p>
      </div>

      <div className="grid gap-3">
        {MODULES.map((m) => {
          const done = getModuleStatus(store, store.operation_profile, m.slug);
          return (
            <Link
              key={m.slug}
              href={`/dashboard/store-settings/${m.slug}`}
              className="group flex items-center gap-4 rounded-xl border border-slate-200 bg-white px-4 py-4 shadow-sm transition-all hover:border-indigo-300 hover:shadow-md"
            >
              <span className="text-2xl">{m.icon}</span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-800">{m.label}</span>
                  {done && (
                    <span className="inline-flex items-center rounded-full bg-emerald-50 border border-emerald-200 px-2 py-0.5 text-xs font-medium text-emerald-600">
                      已填写
                    </span>
                  )}
                </div>
                <p className="text-xs text-slate-400 mt-0.5">{m.desc}</p>
              </div>
              <span className="text-slate-300 group-hover:text-indigo-500 transition-colors">→</span>
            </Link>
          );
        })}
      </div>

      {/* 团队成员入口 */}
      <div className="mt-6 pt-4 border-t border-slate-200">
        <Link
          href="/dashboard/store-settings/members"
          className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-sm transition-all hover:border-indigo-300 hover:shadow-md"
        >
          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-100">
            <Users className="h-5 w-5 text-slate-600" />
          </div>
          <div className="flex-1">
            <span className="text-sm font-semibold text-slate-800">👥 团队成员</span>
            <p className="text-xs text-slate-400">管理门店成员、角色和权限</p>
          </div>
          <span className="text-slate-300">→</span>
        </Link>
      </div>
    </div>
  );
}
