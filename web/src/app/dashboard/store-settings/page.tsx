"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import type { StoreResponse, StoreListItem } from "@/types/store";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { Sheet } from "@/components/ui/sheet";
import { useAuth } from "@/hooks/auth-context";
import { Loader2, ChevronRight, Check } from "lucide-react";

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
  const { logout } = useAuth();
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [newStoreName, setNewStoreName] = useState("");
  const [newStoreCity, setNewStoreCity] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");
  // 账号区：桌面 Header(门店切换/退出)在手机端隐藏，这里是手机唯一入口
  const [stores, setStores] = useState<StoreListItem[]>([]);
  const [storeSheetOpen, setStoreSheetOpen] = useState(false);

  const handleCreateStore = async () => {
    if (!newStoreName.trim() || creating) return;
    setCreating(true);
    setCreateError("");
    try {
      const created = await api.createStore({
        name: newStoreName.trim(),
        city: newStoreCity.trim() || undefined,
      });
      setStore(created);
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.detail : "创建失败，请重试");
    } finally {
      setCreating(false);
    }
  };

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

  // 拉门店列表：多店时账号区可切店（与桌面 Header 同一套逻辑）
  useEffect(() => {
    let cancelled = false;
    api.listStores()
      .then((list) => { if (!cancelled) setStores(list); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const handleSwitchStore = (id: string) => {
    api.setStoreId(id);
    setStoreSheetOpen(false);
    window.location.reload();
  };

  if (store === undefined) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
        <span className="ml-2 text-slate-500">加载中...</span>
      </div>
    );
  }

  if (!store) {
    // 此前这里只有"请先创建门店"的提示却没有创建入口——无邀请码注册的
    // 新用户会陷入死循环（全站唯一出口就是这个表单）
    return (
      <div className="mx-auto max-w-2xl">
        <Breadcrumb items={[
          { label: "工作台", href: "/dashboard/workbench" },
          { label: "门店设置" },
        ]} />
        <div className="rounded-2xl border border-brand-200 bg-white p-6 shadow-sm">
          <h2 className="mb-1 text-lg font-bold text-slate-900">创建你的门店</h2>
          <p className="mb-5 text-sm text-slate-500">
            填个店名就能开始，其余资料创建后可以分模块慢慢完善——资料越全，AI 生成越准。
          </p>
          <div className="space-y-4">
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">门店名称 *</label>
              <input
                type="text"
                maxLength={100}
                value={newStoreName}
                onChange={(e) => setNewStoreName(e.target.value)}
                placeholder="例：星辉台球俱乐部"
                className="h-11 w-full rounded-lg px-3 text-[15px] focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </div>
            <div>
              <label className="mb-1 block text-sm font-medium text-slate-700">所在城市（选填）</label>
              <input
                type="text"
                maxLength={50}
                value={newStoreCity}
                onChange={(e) => setNewStoreCity(e.target.value)}
                placeholder="例：成都"
                className="h-11 w-full rounded-lg px-3 text-[15px] focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20"
              />
            </div>
            {createError && <p className="text-sm text-red-600">{createError}</p>}
            <button
              type="button"
              disabled={creating || !newStoreName.trim()}
              onClick={handleCreateStore}
              className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 px-4 text-[15px] font-medium text-white hover:bg-brand-500 active:bg-brand-700 disabled:opacity-50"
            >
              {creating ? "创建中..." : "创建门店"}
            </button>
            <p className="text-xs text-slate-400">是员工？让管理员发邀请码，注册时填写即可自动加入门店。</p>
          </div>
        </div>
        {/* 手机端没有桌面 Header，无门店时也要能退出账号 */}
        <button
          type="button"
          onClick={logout}
          className="mt-4 flex h-12 w-full items-center justify-center rounded-2xl bg-white text-[15px] font-medium text-red-500 active:bg-slate-100 lg:hidden"
        >
          退出登录
        </button>
      </div>
    );
  }

  const doneCount = MODULES.filter((m) => getModuleStatus(store, store.operation_profile, m.slug)).length;

  return (
    <div className="mx-auto max-w-2xl">
      <Breadcrumb items={[
        { label: "工作台", href: "/dashboard/workbench" },
        { label: "门店设置" },
      ]} />

      {/* 桌面标题（手机端直接看门店头卡） */}
      <div className="mb-6 hidden lg:block">
        <h1 className="text-xl font-bold text-slate-900">⚙️ 门店设置</h1>
        <p className="mt-1 text-sm text-slate-500">
          分模块管理门店资料，AI 会根据这些信息生成更精准的文案
        </p>
      </div>

      {/* 门店头卡 */}
      <div className="mb-5 rounded-2xl bg-gradient-to-br from-brand-600 to-brand-700 p-5 text-white shadow-sm">
        <p className="truncate text-xl font-bold">{store.name}</p>
        <p className="mt-1 text-[13px] text-white/80">
          资料完整度 {doneCount}/{MODULES.length} · 资料越全，AI 生成越准
        </p>
      </div>

      {/* 分组一：门店资料 */}
      <p className="mb-2 px-1 text-xs font-medium text-slate-400">门店资料</p>
      <div className="mb-5 divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white">
        {MODULES.map((m) => {
          const done = getModuleStatus(store, store.operation_profile, m.slug);
          return (
            <Link
              key={m.slug}
              href={`/dashboard/store-settings/${m.slug}`}
              title={m.desc}
              className="flex h-[52px] items-center gap-3 px-4 transition-colors active:bg-slate-100 lg:hover:bg-slate-50"
            >
              <span className="text-xl">{m.icon}</span>
              <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-slate-800">{m.label}</span>
              <span className={`shrink-0 text-xs ${done ? "text-emerald-600" : "text-slate-400"}`}>
                {done ? "已填写" : "未填写"}
              </span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
            </Link>
          );
        })}
      </div>

      {/* 分组：我的内容(历史入口——手机底部不再放历史 tab,从这进) */}
      <p className="mb-2 px-1 text-xs font-medium text-slate-400">内容</p>
      <div className="mb-5 overflow-hidden rounded-2xl bg-white">
        <Link
          href="/dashboard/history"
          className="flex h-[52px] items-center gap-3 px-4 transition-colors active:bg-slate-100 lg:hover:bg-slate-50"
        >
          <span className="text-xl">🕑</span>
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-slate-800">生成历史</span>
          <span className="shrink-0 text-xs text-slate-400">收藏 · 复用</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
        </Link>
      </div>

      {/* 分组二：团队成员入口 */}
      <p className="mb-2 px-1 text-xs font-medium text-slate-400">团队</p>
      <div className="mb-5 overflow-hidden rounded-2xl bg-white">
        <Link
          href="/dashboard/store-settings/members"
          className="flex h-[52px] items-center gap-3 px-4 transition-colors active:bg-slate-100 lg:hover:bg-slate-50"
        >
          <span className="text-xl">👥</span>
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-slate-800">成员管理</span>
          <span className="shrink-0 text-xs text-slate-400">角色与权限</span>
          <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
        </Link>
      </div>

      {/* 分组三：账号（仅手机——桌面端走 Header 的门店切换/退出） */}
      <div className="lg:hidden">
        <p className="mb-2 px-1 text-xs font-medium text-slate-400">账号</p>
        <div className="divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white">
          {stores.length > 1 ? (
            <button
              type="button"
              onClick={() => setStoreSheetOpen(true)}
              className="flex h-[52px] w-full items-center gap-3 px-4 text-left transition-colors active:bg-slate-100"
            >
              <span className="text-xl">🏬</span>
              <span className="flex-1 text-[15px] font-medium text-slate-800">切换门店</span>
              <span className="max-w-[40%] truncate text-xs text-slate-400">{store.name}</span>
              <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
            </button>
          ) : (
            <div className="flex h-[52px] items-center gap-3 px-4">
              <span className="text-xl">🏬</span>
              <span className="flex-1 text-[15px] font-medium text-slate-800">当前门店</span>
              <span className="max-w-[50%] truncate text-xs text-slate-400">{store.name}</span>
            </div>
          )}
          <button
            type="button"
            onClick={logout}
            className="flex h-[52px] w-full items-center justify-center text-[15px] font-medium text-red-500 transition-colors active:bg-slate-100"
          >
            退出登录
          </button>
        </div>
      </div>

      {/* 切店抽屉（多店时从账号区唤起） */}
      <Sheet open={storeSheetOpen} onClose={() => setStoreSheetOpen(false)} title="切换门店">
        <div className="space-y-1 pb-2">
          {stores.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => handleSwitchStore(s.id)}
              className={`flex h-12 w-full items-center justify-between rounded-xl px-4 text-left text-[15px] transition-colors active:bg-slate-100 ${
                s.id === store.id ? "bg-brand-50 font-medium text-brand-700" : "text-slate-800"
              }`}
            >
              <span className="truncate">{s.name}</span>
              {s.id === store.id && <Check className="h-4 w-4 shrink-0 text-brand-600" />}
            </button>
          ))}
        </div>
      </Sheet>
    </div>
  );
}
