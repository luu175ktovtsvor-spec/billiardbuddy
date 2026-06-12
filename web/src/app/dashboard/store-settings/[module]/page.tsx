"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api } from "@/lib/api";
import { getErrorMessage } from "@/lib/utils";
import { ApiError } from "@/types/api";
import type { StoreResponse, PricingTier, MemberCard } from "@/types/store";
import { Section, Field, Toggle, TagGroup, TagCheckbox } from "@/components/forms/section-components";
import { CardSelect } from "@/components/ui/card-select";
import { Breadcrumb } from "@/components/ui/breadcrumb";
import { PageHeader } from "@/components/layout/page-header";
import { Upload, Building2, Wrench, FileText, Sparkles, ArrowLeft, Loader2 } from "lucide-react";

const VALID_MODULES = ["basic", "profile", "branding", "pricing", "slogan"] as const;
type ModuleSlug = (typeof VALID_MODULES)[number];

const MODULE_META: Record<ModuleSlug, { label: string; icon: string }> = {
  basic: { label: "基本信息", icon: "📋" },
  profile: { label: "运营画像", icon: "📊" },
  branding: { label: "品牌风格", icon: "🎨" },
  pricing: { label: "定价体系", icon: "💰" },
  slogan: { label: "广告语", icon: "📝" },
};

/* ───── helpers (extracted from original page) ───── */

type FormData = {
  name: string; city: string; district: string; address: string;
  phone: string; business_hours: string;
  table_count: string; table_types: string;
  has_private_room: boolean; has_coaching: boolean;
  has_tournament: boolean; has_parking: boolean;
  advantages: string; pricing: string; member_cards: string;
  coach_count: string; coach_price_range: string;
  beverage_price_range: string; snack_price_range: string;
  table_brands: string; daily_avg_customers: string;
  peak_hours: string; avg_spend_range: string; recharge_rules: string;
};

const EMPTY_FORM: FormData = {
  name: "", city: "", district: "", address: "",
  phone: "", business_hours: "",
  table_count: "", table_types: "",
  has_private_room: false, has_coaching: false,
  has_tournament: false, has_parking: false,
  advantages: "", pricing: "", member_cards: "",
  coach_count: "", coach_price_range: "",
  beverage_price_range: "", snack_price_range: "",
  table_brands: "", daily_avg_customers: "",
  peak_hours: "", avg_spend_range: "", recharge_rules: "",
};

type ProfileFormData = {
  positioning: string; business_district: string;
  main_selling_points: string; main_customer_types: string[];
  current_goals: string[]; monthly_focus: string;
  avoid_recommendations: string; target_conversion_types: string[];
  private_domain_groups: string[];
  has_assistant: boolean; has_assistant_manager: boolean;
  assistant_types: string[]; assistant_booking_rule: string;
  assistant_forbidden_words: string;
  allow_new_assistant_notice: boolean;
  allow_today_assistant_available: boolean;
  has_weekly_match: boolean; has_light_competition: boolean;
  has_partner_group_activity: boolean;
  has_groupbuy: boolean; has_membership: boolean;
  allow_discount_copy: boolean; allow_price_copy: boolean;
  moments_tone: string; private_chat_tone: string;
  group_notice_tone: string; allow_phone_address: boolean;
  forbidden_phrases: string;
  equipment_table_types: string[]; equipment_table_type_note: string;
  one_liner: string; staff_config: string; opening_days: string;
  competitor_info: string; groupbuy_platforms: string[];
  groupbuy_rating: string; groupbuy_conversion_goal: string;
  has_monthly_tournament: boolean; has_referral_area: boolean;
  atmosphere_features: string[]; allow_ai_write_recharge: boolean;
  reception_opening_line: string;
};

const EMPTY_PROFILE: ProfileFormData = {
  positioning: "", business_district: "", main_selling_points: "",
  main_customer_types: [], current_goals: [], monthly_focus: "",
  avoid_recommendations: "", target_conversion_types: [],
  private_domain_groups: [], has_assistant: false,
  has_assistant_manager: false, assistant_types: [],
  assistant_booking_rule: "", assistant_forbidden_words: "",
  allow_new_assistant_notice: false,
  allow_today_assistant_available: false,
  has_weekly_match: false, has_light_competition: false,
  has_partner_group_activity: false, has_groupbuy: false,
  has_membership: false, allow_discount_copy: false,
  allow_price_copy: false, moments_tone: "",
  private_chat_tone: "", group_notice_tone: "",
  allow_phone_address: false, forbidden_phrases: "",
  equipment_table_types: [], equipment_table_type_note: "",
  one_liner: "", staff_config: "", opening_days: "",
  competitor_info: "", groupbuy_platforms: [],
  groupbuy_rating: "", groupbuy_conversion_goal: "",
  has_monthly_tournament: false, has_referral_area: false,
  atmosphere_features: [], allow_ai_write_recharge: false,
  reception_opening_line: "",
};

function profileToFormData(profile: Record<string, unknown> | null | undefined): ProfileFormData {
  if (!profile || typeof profile !== "object") return { ...EMPTY_PROFILE };
  const p = profile as Record<string, unknown>;
  const basic = (p.basic as Record<string, unknown>) || {};
  const goals = (p.business_goals as Record<string, unknown>) || {};
  const customer = (p.customer_structure as Record<string, unknown>) || {};
  const groups = (p.private_domain_groups as Record<string, unknown>) || {};
  const assistant = (p.assistant_system as Record<string, unknown>) || {};
  const events = (p.events as Record<string, unknown>) || {};
  const commerce = (p.commerce_rules as Record<string, unknown>) || {};
  const style = (p.content_style as Record<string, unknown>) || {};
  const equipment = (p.equipment as Record<string, unknown>) || {};

  const enabledGroups: string[] = [];
  for (const gk of ["customer_group", "member_group", "competition_group", "partner_group", "assistant_customer_group", "event_group", "staff_group"]) {
    const g = groups[gk] as Record<string, unknown> | undefined;
    if (g?.enabled) enabledGroups.push(gk);
  }

  return {
    positioning: (basic.positioning as string) || "",
    business_district: (basic.business_district as string) || "",
    main_selling_points: Array.isArray(basic.main_selling_points) ? (basic.main_selling_points as string[]).join("、") : "",
    main_customer_types: Array.isArray(customer.main_customer_types) ? customer.main_customer_types as string[] : [],
    current_goals: Array.isArray(goals.current_goals) ? goals.current_goals as string[] : [],
    monthly_focus: (goals.monthly_focus as string) || "",
    avoid_recommendations: Array.isArray(goals.avoid_recommendations) ? (goals.avoid_recommendations as string[]).join("、") : "",
    target_conversion_types: Array.isArray(customer.target_conversion_types) ? customer.target_conversion_types as string[] : [],
    private_domain_groups: enabledGroups,
    has_assistant: !!assistant.has_assistant,
    has_assistant_manager: !!assistant.has_assistant_manager,
    assistant_types: Array.isArray(assistant.assistant_types) ? assistant.assistant_types as string[] : [],
    assistant_booking_rule: (assistant.assistant_booking_rule as string) || "",
    assistant_forbidden_words: Array.isArray(assistant.assistant_forbidden_words) ? (assistant.assistant_forbidden_words as string[]).join("、") : "",
    allow_new_assistant_notice: !!assistant.allow_new_assistant_notice,
    allow_today_assistant_available: !!assistant.allow_today_assistant_available,
    has_weekly_match: !!events.has_weekly_match,
    has_light_competition: !!events.has_light_competition,
    has_partner_group_activity: !!events.has_partner_group,
    has_groupbuy: !!commerce.has_groupbuy,
    has_membership: !!commerce.has_membership,
    allow_discount_copy: !!commerce.allow_discount_copy,
    allow_price_copy: !!commerce.allow_price_copy,
    moments_tone: (style.moments_tone as string) || "",
    private_chat_tone: (style.private_chat_tone as string) || "",
    group_notice_tone: (style.group_notice_tone as string) || "",
    allow_phone_address: !!(basic.allow_address_in_content && basic.allow_phone_in_content),
    forbidden_phrases: Array.isArray(style.forbidden_phrases) ? (style.forbidden_phrases as string[]).join("、") : "",
    equipment_table_types: Array.isArray(equipment.table_types) ? equipment.table_types as string[] : [],
    equipment_table_type_note: (equipment.table_type_note as string) || "",
    one_liner: (basic.one_liner as string) || "",
    staff_config: (basic.staff_config as string) || "",
    opening_days: (basic.opening_days as string) || "",
    competitor_info: (basic.competitor_info as string) || "",
    groupbuy_platforms: Array.isArray(commerce.groupbuy_platforms) ? commerce.groupbuy_platforms as string[] : [],
    groupbuy_rating: (commerce.groupbuy_rating as string) || "",
    groupbuy_conversion_goal: (commerce.groupbuy_conversion_goal as string) || "",
    has_monthly_tournament: !!events.has_monthly_tournament,
    has_referral_area: !!events.has_referral_area,
    atmosphere_features: Array.isArray(events.atmosphere_features) ? events.atmosphere_features as string[] : [],
    allow_ai_write_recharge: !!commerce.allow_ai_write_recharge,
    reception_opening_line: (assistant.reception_opening_line as string) || "",
  };
}

function profileFormDataToProfile(form: ProfileFormData): Record<string, unknown> {
  const groups: Record<string, unknown> = {};
  for (const gk of ["customer_group", "member_group", "competition_group", "partner_group", "assistant_customer_group", "event_group", "staff_group"]) {
    groups[gk] = { enabled: form.private_domain_groups.includes(gk) };
  }
  return {
    basic: {
      positioning: form.positioning || "",
      business_district: form.business_district || "",
      main_selling_points: form.main_selling_points ? form.main_selling_points.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : [],
      allow_address_in_content: form.allow_phone_address,
      allow_phone_in_content: form.allow_phone_address,
      one_liner: form.one_liner || "",
      staff_config: form.staff_config || "",
      opening_days: form.opening_days || "",
      competitor_info: form.competitor_info || "",
    },
    business_goals: {
      current_goals: form.current_goals,
      monthly_focus: form.monthly_focus || "",
      avoid_recommendations: form.avoid_recommendations ? form.avoid_recommendations.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : [],
    },
    customer_structure: {
      main_customer_types: form.main_customer_types,
      target_conversion_types: form.target_conversion_types,
    },
    private_domain_groups: groups,
    assistant_system: {
      has_assistant: form.has_assistant,
      has_assistant_manager: form.has_assistant_manager,
      assistant_types: form.assistant_types,
      assistant_booking_rule: form.assistant_booking_rule || "",
      assistant_forbidden_words: form.assistant_forbidden_words ? form.assistant_forbidden_words.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : [],
      allow_new_assistant_notice: form.allow_new_assistant_notice,
      allow_today_assistant_available: form.allow_today_assistant_available,
      reception_opening_line: form.reception_opening_line || "",
    },
    events: {
      has_weekly_match: form.has_weekly_match,
      has_monthly_tournament: form.has_monthly_tournament,
      has_light_competition: form.has_light_competition,
      has_partner_group: form.has_partner_group_activity,
      has_referral_area: form.has_referral_area,
      atmosphere_features: form.atmosphere_features,
    },
    commerce_rules: {
      has_groupbuy: form.has_groupbuy,
      has_membership: form.has_membership,
      allow_discount_copy: form.allow_discount_copy,
      allow_price_copy: form.allow_price_copy,
      groupbuy_platforms: form.groupbuy_platforms,
      groupbuy_rating: form.groupbuy_rating || "",
      groupbuy_conversion_goal: form.groupbuy_conversion_goal || "",
      allow_ai_write_recharge: form.allow_ai_write_recharge,
    },
    content_style: {
      moments_tone: form.moments_tone || "",
      private_chat_tone: form.private_chat_tone || "",
      group_notice_tone: form.group_notice_tone || "",
      forbidden_phrases: form.forbidden_phrases ? form.forbidden_phrases.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : [],
    },
    equipment: {
      table_types: form.equipment_table_types,
      table_type_note: form.equipment_table_type_note || "",
    },
  };
}

function parseFlexibleField(value: string): unknown {
  const v = value.trim();
  if (!v) return null;
  try { return JSON.parse(v); } catch { return v; }
}

function formatJsonForDisplay(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (Array.isArray(data)) {
    return data.map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null) {
        const parts: string[] = [];
        if ("name" in item) parts.push(String(item.name));
        if ("price" in item) parts.push(`${item.price}元`);
        if ("amount" in item && "bonus" in item) parts.push(`充${item.amount}送${item.bonus}`);
        if ("type" in item) parts.push(String(item.type));
        if ("description" in item) parts.push(String(item.description));
        return parts.length > 0 ? parts.join(" ") : JSON.stringify(item);
      }
      return String(item);
    }).join("\n");
  }
  if (typeof data === "object") {
    return Object.entries(data as Record<string, unknown>)
      .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join("\n");
  }
  return String(data);
}

function formDataToPayload(form: FormData) {
  const tableCount = form.table_count.trim() ? parseInt(form.table_count, 10) : null;
  const coachCount = form.coach_count.trim() ? parseInt(form.coach_count, 10) : null;
  const dailyAvg = form.daily_avg_customers.trim() ? parseInt(form.daily_avg_customers, 10) : null;
  return {
    name: form.name.trim(),
    city: form.city.trim() || null,
    district: form.district.trim() || null,
    address: form.address.trim() || null,
    phone: form.phone.trim() || null,
    business_hours: form.business_hours.trim() || null,
    table_count: Number.isNaN(tableCount) ? null : tableCount,
    table_types: form.table_types.trim() || null,
    has_private_room: form.has_private_room,
    has_coaching: form.has_coaching,
    has_tournament: form.has_tournament,
    has_parking: form.has_parking,
    advantages: form.advantages.trim() || null,
    pricing: parseFlexibleField(form.pricing) as PricingTier[] | string | null,
    member_cards: parseFlexibleField(form.member_cards) as MemberCard[] | string | null,
    coach_count: Number.isNaN(coachCount) ? null : coachCount,
    coach_price_range: form.coach_price_range.trim() || null,
    beverage_price_range: form.beverage_price_range.trim() || null,
    snack_price_range: form.snack_price_range.trim() || null,
    table_brands: form.table_brands.trim() || null,
    daily_avg_customers: Number.isNaN(dailyAvg) ? null : dailyAvg,
    peak_hours: form.peak_hours.trim() || null,
    avg_spend_range: form.avg_spend_range.trim() || null,
    recharge_rules: parseFlexibleField(form.recharge_rules),
  };
}

/* 手机触控规格：input 高 44px + 15px 字号；textarea 保持多行内边距 */
const INPUT_BASE = "w-full rounded-lg border border-slate-200 bg-white px-3 text-[15px] text-slate-900 placeholder-slate-400 focus:border-brand-500 focus:outline-none focus:ring-2 focus:ring-brand-500/20";
const INPUT_CLASS = `${INPUT_BASE} h-11`;
const TEXTAREA_CLASS = `${INPUT_BASE} py-2.5`;

/* ───── Sub-components for each module ───── */

function BasicModule({
  form, updateField, store, logoUploading, qrcodeUploading,
  logoInputRef, qrcodeInputRef, handleLogoUpload, handleQrcodeUpload,
}: {
  form: FormData;
  updateField: (k: keyof FormData, v: string | boolean) => void;
  store: StoreResponse;
  logoUploading: boolean;
  qrcodeUploading: boolean;
  logoInputRef: React.RefObject<HTMLInputElement>;
  qrcodeInputRef: React.RefObject<HTMLInputElement>;
  handleLogoUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleQrcodeUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <>
      <Section title="基础信息" icon={Building2}>
        <Field label="门店名称" required>
          <input type="text" maxLength={200} value={form.name}
            onChange={(e) => updateField("name", e.target.value)}
            className={INPUT_CLASS} placeholder="请输入门店名称" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="城市">
            <input type="text" maxLength={100} value={form.city}
              onChange={(e) => updateField("city", e.target.value)}
              className={INPUT_CLASS} placeholder="如：杭州" />
          </Field>
          <Field label="区">
            <input type="text" maxLength={100} value={form.district}
              onChange={(e) => updateField("district", e.target.value)}
              className={INPUT_CLASS} placeholder="如：西湖区" />
          </Field>
        </div>
        <Field label="详细地址">
          <input type="text" maxLength={500} value={form.address}
            onChange={(e) => updateField("address", e.target.value)}
            className={INPUT_CLASS} placeholder="请输入详细地址" />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="联系电话">
            <input type="text" maxLength={50} value={form.phone}
              onChange={(e) => updateField("phone", e.target.value)}
              className={INPUT_CLASS} placeholder="门店联系电话" />
          </Field>
          <Field label="营业时间">
            <input type="text" maxLength={200} value={form.business_hours}
              onChange={(e) => updateField("business_hours", e.target.value)}
              className={INPUT_CLASS} placeholder="如：10:00 - 次日02:00" />
          </Field>
        </div>
      </Section>

      <Section title="设施信息" icon={Wrench}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="球桌数量">
            <input type="number" min={0} value={form.table_count}
              onChange={(e) => updateField("table_count", e.target.value)}
              className={INPUT_CLASS} placeholder="如：12" />
          </Field>
          <Field label="桌型描述">
            <input type="text" maxLength={500} value={form.table_types}
              onChange={(e) => updateField("table_types", e.target.value)}
              className={INPUT_CLASS} placeholder="如：中式黑八 30张，斯诺克 4张" />
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Toggle label="包间" checked={form.has_private_room}
            onChange={(v) => updateField("has_private_room", v)} />
          <Toggle label="陪练" checked={form.has_coaching}
            onChange={(v) => updateField("has_coaching", v)} />
          <Toggle label="比赛" checked={form.has_tournament}
            onChange={(v) => updateField("has_tournament", v)} />
          <Toggle label="停车" checked={form.has_parking}
            onChange={(v) => updateField("has_parking", v)} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="助教总人数">
            <input type="number" min={0} value={form.coach_count}
              onChange={(e) => updateField("coach_count", e.target.value)}
              className={INPUT_CLASS} placeholder="如：5" />
          </Field>
          <Field label="助教价格范围">
            <input type="text" maxLength={100} value={form.coach_price_range}
              onChange={(e) => updateField("coach_price_range", e.target.value)}
              className={INPUT_CLASS} placeholder="如：50-80元/小时" />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="日均客流">
            <input type="number" min={0} value={form.daily_avg_customers}
              onChange={(e) => updateField("daily_avg_customers", e.target.value)}
              className={INPUT_CLASS} placeholder="如：30" />
          </Field>
          <Field label="高峰时段">
            <input type="text" maxLength={200} value={form.peak_hours}
              onChange={(e) => updateField("peak_hours", e.target.value)}
              className={INPUT_CLASS} placeholder="如：19:00-23:00" />
          </Field>
          <Field label="人均消费范围">
            <input type="text" maxLength={100} value={form.avg_spend_range}
              onChange={(e) => updateField("avg_spend_range", e.target.value)}
              className={INPUT_CLASS} placeholder="如：30-80元" />
          </Field>
        </div>
        <Field label="门店优势">
          <textarea rows={3} value={form.advantages}
            onChange={(e) => updateField("advantages", e.target.value)}
            className={TEXTAREA_CLASS} placeholder="描述门店的核心竞争优势" />
        </Field>
      </Section>

      <Section title="图片上传" icon={FileText}>
        <div className="grid gap-6 sm:grid-cols-2">
          <div>
            <label className="mb-1 block font-medium text-slate-700">Logo</label>
            {store.logo_url ? (
              <div className="mb-2 overflow-hidden rounded-lg border border-slate-200">
                <img src={api.resolveUrl(store.logo_url)} alt="门店 Logo"
                  className="h-32 w-full object-contain bg-slate-50" />
              </div>
            ) : (
              <div className="mb-2 flex h-32 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50">
                <span className="text-slate-400">暂无 Logo</span>
              </div>
            )}
            <input ref={logoInputRef} type="file" accept="image/*"
              onChange={handleLogoUpload} className="hidden" />
            <button type="button" disabled={logoUploading}
              onClick={() => logoInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              <Upload className="h-3.5 w-3.5" />
              {logoUploading ? "上传中..." : "上传 Logo"}
            </button>
          </div>
          <div>
            <label className="mb-1 block font-medium text-slate-700">微信二维码</label>
            {store.qrcode_url ? (
              <div className="mb-2 overflow-hidden rounded-lg border border-slate-200">
                <img src={api.resolveUrl(store.qrcode_url)} alt="门店二维码"
                  className="h-32 w-full object-contain bg-slate-50" />
              </div>
            ) : (
              <div className="mb-2 flex h-32 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50">
                <span className="text-slate-400">暂无二维码</span>
              </div>
            )}
            <input ref={qrcodeInputRef} type="file" accept="image/*"
              onChange={handleQrcodeUpload} className="hidden" />
            <button type="button" disabled={qrcodeUploading}
              onClick={() => qrcodeInputRef.current?.click()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              <Upload className="h-3.5 w-3.5" />
              {qrcodeUploading ? "上传二维码" : "上传二维码"}
            </button>
          </div>
        </div>
      </Section>
    </>
  );
}

function ProfileModule({
  profileForm, updateProfileField, toggleProfileArray, store,
}: {
  profileForm: ProfileFormData;
  updateProfileField: <K extends keyof ProfileFormData>(k: K, v: ProfileFormData[K]) => void;
  toggleProfileArray: (key: "main_customer_types" | "current_goals" | "private_domain_groups" | "assistant_types" | "equipment_table_types" | "target_conversion_types" | "atmosphere_features" | "groupbuy_platforms", value: string) => void;
  store: StoreResponse;
}) {
  return (
    <Section title="AI 运营画像" icon={Sparkles}>
      <p className="text-slate-500">
        让 AI 更懂你这家球房，生成内容更像本店的人写的。
      </p>

      {/* 完整度评分卡片 */}
      {store.operation_profile_completeness && (
        <div className="rounded-lg border border-brand-200 bg-brand-50 p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="font-semibold text-slate-800">AI 运营画像完整度</span>
            <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${
              store.operation_profile_completeness.overall_score >= 70
                ? "bg-emerald-50 border border-emerald-200 text-emerald-600"
                : store.operation_profile_completeness.overall_score >= 40
                ? "bg-amber-50 border border-amber-200 text-amber-600"
                : "bg-red-50 border border-red-200 text-red-600"
            }`}>
              {store.operation_profile_completeness.overall_score}%
            </span>
          </div>
          <div className="mb-3 h-1.5 w-full rounded-full bg-slate-200">
            <div
              className={`h-1.5 rounded-full transition-all ${
                store.operation_profile_completeness.overall_score >= 70 ? "bg-emerald-500"
                : store.operation_profile_completeness.overall_score >= 40 ? "bg-amber-500"
                : "bg-red-500"
              }`}
              style={{ width: `${store.operation_profile_completeness.overall_score}%` }}
            />
          </div>
        </div>
      )}

      {/* 门店定位 */}
      <Field label="门店定位/风格">
        <CardSelect
          value={profileForm.positioning}
          onChange={(v) => updateProfileField("positioning", v)}
          columns={2}
          options={[
            { value: "", label: "请选择", emoji: "—" },
            { value: "community_affordable", label: "社区球房", emoji: "🏘️", desc: "亲民、高频、社区粘性" },
            { value: "commercial_premium", label: "商业球房", emoji: "🏬", desc: "品质、体验、商圈流量" },
            { value: "competition_focused", label: "竞技球房", emoji: "🏆", desc: "赛事、培训、专业设备" },
            { value: "competition_commercial", label: "竞技商业球房", emoji: "🎯", desc: "竞技+商业混合模式" },
          ]}
        />
      </Field>
      <Field label="所在商圈/区域">
        <input type="text" maxLength={100} value={profileForm.business_district}
          onChange={(e) => updateProfileField("business_district", e.target.value)}
          className={INPUT_CLASS} placeholder="如：南山中心区" />
      </Field>
      <Field label="主要卖点（用逗号分隔）">
        <textarea rows={2} maxLength={500} value={profileForm.main_selling_points}
          onChange={(e) => updateProfileField("main_selling_points", e.target.value)}
          className={TEXTAREA_CLASS} placeholder="如：24小时营业、乔氏台球桌、免费停车" />
      </Field>
      <Field label="主要客户类型（多选）">
        <TagGroup>
          {[["casual","散客"],["competitive","竞技客户"],["assistant","助教客户"],["point_chaser","追分客户"]].map(([v,l]) => (
            <TagCheckbox key={v} label={l} checked={profileForm.main_customer_types.includes(v)}
              onChange={() => toggleProfileArray("main_customer_types", v)} />
          ))}
        </TagGroup>
      </Field>
      <Field label="重点转化客户（多选）">
        <TagGroup>
          {[["casual","散客"],["competitive","竞技客户"],["assistant","助教客户"],["point_chaser","追分客户"]].map(([v,l]) => (
            <TagCheckbox key={v} label={l} checked={profileForm.target_conversion_types.includes(v)}
              onChange={() => toggleProfileArray("target_conversion_types", v)} />
          ))}
        </TagGroup>
      </Field>
      <Field label="当前最想提升（多选）">
        <TagGroup>
          {[["customer_acquisition","拉新"],["old_customer_recall","老客户回流"],["groupbuy_conversion","团购客转私域"],
            ["assistant_booking","助教预约转化"],["tournament_growth","提升周赛人气"],["content_output","提高朋友圈发布频率"],
            ["frontdesk_conversion","提升前厅转化"],["assistant_attendance","提升助教上钟"],["matchmaking_active","搭子群活跃"]
          ].map(([v,l]) => (
            <TagCheckbox key={v} label={l} checked={profileForm.current_goals.includes(v)}
              onChange={() => toggleProfileArray("current_goals", v)} />
          ))}
        </TagGroup>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="本月经营重点">
          <input type="text" maxLength={200} value={profileForm.monthly_focus}
            onChange={(e) => updateProfileField("monthly_focus", e.target.value)}
            className={INPUT_CLASS} placeholder="如：推团购核销、提升助教上钟" />
        </Field>
        <Field label="避免推荐的内容">
          <input type="text" maxLength={300} value={profileForm.avoid_recommendations}
            onChange={(e) => updateProfileField("avoid_recommendations", e.target.value)}
            className={INPUT_CLASS} placeholder="如：充值赠送、免费体验" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="人员配置（简述）">
          <input type="text" maxLength={200} value={profileForm.staff_config}
            onChange={(e) => updateProfileField("staff_config", e.target.value)}
            className={INPUT_CLASS} placeholder="如：店长1人，助教管理2人" />
        </Field>
        <Field label="开业阶段">
          <CardSelect
            value={profileForm.opening_days}
            onChange={(v) => updateProfileField("opening_days", v)}
            columns={2}
            options={[
              { value: "", label: "请选择", emoji: "—" },
              { value: "not_opened", label: "尚未开业", emoji: "🚧", desc: "筹备中" },
              { value: "within_30", label: "开业30天内", emoji: "🆕", desc: "新店蜜月期" },
              { value: "30_90", label: "开业30-90天", emoji: "📈", desc: "爬坡期" },
              { value: "over_90", label: "开业90天以上", emoji: "🏢", desc: "稳定运营" },
            ]}
          />
        </Field>
      </div>
      <Field label="周边竞对信息（选填）">
        <textarea rows={2} maxLength={500} value={profileForm.competitor_info}
          onChange={(e) => updateProfileField("competitor_info", e.target.value)}
          className={TEXTAREA_CLASS} placeholder="如：3km内有2家竞对" />
      </Field>

      {/* 私域群矩阵 */}
      <Field label="你们门店有哪些群？（多选）">
        <TagGroup>
          {[["customer_group","客户群"],["member_group","会员群"],["competition_group","竞技群"],
            ["partner_group","搭子群"],["assistant_customer_group","助教客户群"],
            ["event_group","赛事群"],["staff_group","员工群"]
          ].map(([v,l]) => (
            <TagCheckbox key={v} label={l} checked={profileForm.private_domain_groups.includes(v)}
              onChange={() => toggleProfileArray("private_domain_groups", v)} />
          ))}
        </TagGroup>
      </Field>

      {/* 助教配置 */}
      <Toggle label="店里有助教" checked={profileForm.has_assistant}
        onChange={(v) => updateProfileField("has_assistant", v)} />
      {profileForm.has_assistant && (
        <>
          <Field label="助教类型（多选）">
            <TagGroup>
              {[["service_experience","服务体验型"],["technical_coaching","技术陪练型/高级助教"]].map(([v,l]) => (
                <TagCheckbox key={v} label={l} checked={profileForm.assistant_types.includes(v)}
                  onChange={() => toggleProfileArray("assistant_types", v)} />
              ))}
            </TagGroup>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Toggle label="有专门的助教管理" checked={profileForm.has_assistant_manager}
              onChange={(v) => updateProfileField("has_assistant_manager", v)} />
            <div />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="助教预约方式">
              <input type="text" maxLength={200} value={profileForm.assistant_booking_rule}
                onChange={(e) => updateProfileField("assistant_booking_rule", e.target.value)}
                className={INPUT_CLASS} placeholder="如：微信预约、到店前台预约" />
            </Field>
            <Field label="助教内容禁用词">
              <input type="text" maxLength={300} value={profileForm.assistant_forbidden_words}
                onChange={(e) => updateProfileField("assistant_forbidden_words", e.target.value)}
                className={INPUT_CLASS} placeholder="如：美女助教、陪玩" />
            </Field>
          </div>
          <Field label="管理层接待开场白（选填）">
            <input type="text" maxLength={200} value={profileForm.reception_opening_line}
              onChange={(e) => updateProfileField("reception_opening_line", e.target.value)}
              className={INPUT_CLASS} placeholder="如：欢迎来我们球房" />
          </Field>
          <Toggle label="允许写「新助教到店」" checked={profileForm.allow_new_assistant_notice}
            onChange={(v) => updateProfileField("allow_new_assistant_notice", v)} />
          <Toggle label="允许写「今日助教可约」" checked={profileForm.allow_today_assistant_available}
            onChange={(v) => updateProfileField("allow_today_assistant_available", v)} />
        </>
      )}

      {/* 赛事/活动 */}
      <Field label="赛事/活动（多选）">
        <TagGroup>
          {[["has_weekly_match","固定做周赛"],["has_monthly_tournament","有月赛"],
            ["has_light_competition","有轻竞技/台费局"],["has_partner_group_activity","有搭子群活动"],
            ["has_referral_area","有引流台/引流区"]
          ].map(([k, l]) => (
            <TagCheckbox key={k} label={l}
              checked={!!(profileForm as any)[k]}
              onChange={() => updateProfileField(k as keyof ProfileFormData, !(profileForm as any)[k] as any)} />
          ))}
        </TagGroup>
      </Field>

      <Field label="氛围特色（多选）">
        <TagGroup>
          {[["professional_lighting","专业灯光"],["sound_system","音响系统"],
            ["fragrance","香氛"],["referral_area","引流台"],["assistant_rest_area","助教休息区"]
          ].map(([v,l]) => (
            <TagCheckbox key={v} label={l} checked={profileForm.atmosphere_features.includes(v)}
              onChange={() => toggleProfileArray("atmosphere_features", v)} />
          ))}
        </TagGroup>
      </Field>

      {/* 团购与会员 */}
      <Toggle label="做团购（美团/抖音）" checked={profileForm.has_groupbuy}
        onChange={(v) => updateProfileField("has_groupbuy", v)} />
      {profileForm.has_groupbuy && (
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="团购平台（多选）">
            <TagGroup>
              {[["meituan","美团"],["douyin","抖音"]].map(([v,l]) => (
                <TagCheckbox key={v} label={l} checked={profileForm.groupbuy_platforms.includes(v)}
                  onChange={() => toggleProfileArray("groupbuy_platforms", v)} />
              ))}
            </TagGroup>
          </Field>
          <Field label="当前团购评分">
            <CardSelect value={profileForm.groupbuy_rating}
              onChange={(v) => updateProfileField("groupbuy_rating", v)} columns={2}
              options={[
                { value: "", label: "请选择", emoji: "—" },
                { value: "below_4.6", label: "4.6以下", emoji: "😐", desc: "需要提升" },
                { value: "4.6_4.8", label: "4.6-4.8", emoji: "🙂", desc: "中等偏上" },
                { value: "4.8_4.9", label: "4.8-4.9", emoji: "😊", desc: "优秀" },
                { value: "above_4.9", label: "4.9以上", emoji: "🤩", desc: "顶级口碑" },
              ]} />
          </Field>
          <Field label="团购客到店目标">
            <CardSelect value={profileForm.groupbuy_conversion_goal}
              onChange={(v) => updateProfileField("groupbuy_conversion_goal", v)} columns={2}
              options={[
                { value: "", label: "请选择", emoji: "—" },
                { value: "add_wechat", label: "加微信进群", emoji: "💬", desc: "私域沉淀" },
                { value: "recommend_assistant", label: "推荐助教", emoji: "🎱", desc: "提升上钟" },
                { value: "push_recharge", label: "推充值卡", emoji: "💳", desc: "锁客复购" },
                { value: "experience_guide", label: "体验引导", emoji: "✨", desc: "首次体验转化" },
              ]} />
          </Field>
        </div>
      )}
      <Toggle label="有会员体系" checked={profileForm.has_membership}
        onChange={(v) => updateProfileField("has_membership", v)} />
      <Toggle label="允许写优惠/折扣" checked={profileForm.allow_discount_copy}
        onChange={(v) => updateProfileField("allow_discount_copy", v)} />
      <Toggle label="允许写价格" checked={profileForm.allow_price_copy}
        onChange={(v) => updateProfileField("allow_price_copy", v)} />
      <Toggle label="允许AI写充值方案" checked={profileForm.allow_ai_write_recharge}
        onChange={(v) => updateProfileField("allow_ai_write_recharge", v)} />
    </Section>
  );
}

function BrandingModule({
  store, onBrandStyleChange,
}: {
  store: StoreResponse;
  onBrandStyleChange: (style: string) => void;
}) {
  return (
    <Section title="品牌风格" icon={Sparkles}>
      <p className="text-slate-500">
        选择品牌风格后，AI 生成的文案会自动匹配对应语气。
      </p>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {[
          { value: "", label: "不指定", emoji: "—", desc: "默认语气" },
          { value: "lively", label: "活泼", emoji: "🎉", desc: "轻松、emoji、亲切" },
          { value: "professional", label: "专业", emoji: "💼", desc: "正式、数据、商务" },
          { value: "youthful", label: "年轻", emoji: "⚡", desc: "潮流、互动、Z世代" },
          { value: "premium", label: "高端", emoji: "✨", desc: "优雅、品质、尊贵" },
        ].map((style) => (
          <button
            key={style.value}
            type="button"
            onClick={() => onBrandStyleChange(style.value)}
            className={`flex flex-col items-center gap-1 rounded-xl border-2 p-4 text-center transition-all ${
              (store as any).brand_style === style.value || (!style.value && !(store as any).brand_style)
                ? "border-brand-500 bg-brand-50 shadow-sm"
                : "border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm"
            }`}
          >
            <span className="text-2xl">{style.emoji}</span>
            <span className={`text-sm font-medium ${
              (store as any).brand_style === style.value || (!style.value && !(store as any).brand_style)
                ? "text-brand-700" : "text-slate-700"
            }`}>{style.label}</span>
            <span className="text-xs text-slate-400">{style.desc}</span>
          </button>
        ))}
      </div>

      {/* Logo + 二维码 */}
      <div className="grid gap-6 sm:grid-cols-2 mt-4">
        <div>
          <label className="mb-1 block font-medium text-slate-700">Logo</label>
          {store.logo_url ? (
            <div className="mb-2 overflow-hidden rounded-lg border border-slate-200">
              <img src={api.resolveUrl(store.logo_url)} alt="门店 Logo"
                className="h-32 w-full object-contain bg-slate-50" />
            </div>
          ) : (
            <div className="mb-2 flex h-32 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50">
              <span className="text-slate-400">暂无 Logo</span>
            </div>
          )}
        </div>
        <div>
          <label className="mb-1 block font-medium text-slate-700">微信二维码</label>
          {store.qrcode_url ? (
            <div className="mb-2 overflow-hidden rounded-lg border border-slate-200">
              <img src={api.resolveUrl(store.qrcode_url)} alt="门店二维码"
                className="h-32 w-full object-contain bg-slate-50" />
            </div>
          ) : (
            <div className="mb-2 flex h-32 items-center justify-center rounded-lg border border-dashed border-slate-200 bg-slate-50">
              <span className="text-slate-400">暂无二维码</span>
            </div>
          )}
        </div>
      </div>
      <p className="text-xs text-slate-400">
        Logo 和二维码在「基本信息」模块中上传管理。
      </p>
    </Section>
  );
}

function PricingModule({
  form, updateField,
}: {
  form: FormData;
  updateField: (k: keyof FormData, v: string | boolean) => void;
}) {
  return (
    <>
      <Section title="价格体系" icon={FileText}>
        <Field label="价格体系">
          <textarea rows={8} value={form.pricing}
            onChange={(e) => updateField("pricing", e.target.value)}
            className={TEXTAREA_CLASS}
            placeholder={"1. 中式黑八\n   (a) 普台：30元/1小时\n   (b) 金腿：XX元/1小时\n   (c) 银腿：XX元/1小时\n   (d) 毒牙：XX元/1小时\n2. 包厢：XX元/1小时"} />
        </Field>
        <Field label="会员卡套餐">
          <textarea rows={5} value={form.member_cards}
            onChange={(e) => updateField("member_cards", e.target.value)}
            className={TEXTAREA_CLASS}
            placeholder={"1. 畅打月卡：888元/月\n2. 周卡：388元/周\n3. 次卡：50次 1500元"} />
        </Field>
        <Field label="充值规则（选填）">
          <textarea rows={3} value={form.recharge_rules}
            onChange={(e) => updateField("recharge_rules", e.target.value)}
            className={TEXTAREA_CLASS}
            placeholder="如：充1000送99，充3000送399" />
        </Field>
      </Section>

      <Section title="辅助定价信息" icon={Wrench}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="饮料价格范围">
            <input type="text" maxLength={100} value={form.beverage_price_range}
              onChange={(e) => updateField("beverage_price_range", e.target.value)}
              className={INPUT_CLASS} placeholder="如：8-30元" />
          </Field>
          <Field label="小食价格范围">
            <input type="text" maxLength={100} value={form.snack_price_range}
              onChange={(e) => updateField("snack_price_range", e.target.value)}
              className={INPUT_CLASS} placeholder="如：15-50元" />
          </Field>
        </div>
      </Section>
    </>
  );
}

function SloganModule({
  profileForm, updateProfileField,
}: {
  profileForm: ProfileFormData;
  updateProfileField: <K extends keyof ProfileFormData>(k: K, v: ProfileFormData[K]) => void;
}) {
  return (
    <Section title="广告语与文案风格" icon={FileText}>
      <Field label="广告语（用于海报、团购页、朋友圈）">
        <input type="text" maxLength={50} value={profileForm.one_liner}
          onChange={(e) => updateProfileField("one_liner", e.target.value)}
          className={INPUT_CLASS}
          placeholder="如：来一杆，解千愁 | 找搭子，来打球" />
      </Field>

      <div className="grid gap-4 sm:grid-cols-3">
        <Field label="朋友圈语气">
          <CardSelect value={profileForm.moments_tone}
            onChange={(v) => updateProfileField("moments_tone", v)} columns={2}
            options={[
              { value: "", label: "请选择", emoji: "—" },
              { value: "casual_friendly", label: "熟人自然", emoji: "🤝", desc: "像朋友聊天" },
              { value: "light_humorous", label: "轻松幽默", emoji: "😄", desc: "有梗有趣" },
              { value: "premium_business", label: "高端商务", emoji: "💼", desc: "专业品质感" },
              { value: "young_trendy", label: "年轻潮流", emoji: "⚡", desc: "网感强" },
              { value: "short_direct", label: "简短直接", emoji: "✂️", desc: "不废话" },
            ]} />
        </Field>
        <Field label="私聊语气">
          <CardSelect value={profileForm.private_chat_tone}
            onChange={(v) => updateProfileField("private_chat_tone", v)} columns={2}
            options={[
              { value: "", label: "请选择", emoji: "—" },
              { value: "casual_friendly", label: "熟人自然", emoji: "🤝", desc: "像朋友聊天" },
              { value: "light_humorous", label: "轻松幽默", emoji: "😄", desc: "有梗有趣" },
              { value: "premium_business", label: "高端商务", emoji: "💼", desc: "专业品质感" },
              { value: "young_trendy", label: "年轻潮流", emoji: "⚡", desc: "网感强" },
              { value: "short_direct", label: "简短直接", emoji: "✂️", desc: "不废话" },
            ]} />
        </Field>
        <Field label="群公告语气">
          <CardSelect value={profileForm.group_notice_tone}
            onChange={(v) => updateProfileField("group_notice_tone", v)} columns={2}
            options={[
              { value: "", label: "请选择", emoji: "—" },
              { value: "casual_friendly", label: "熟人自然", emoji: "🤝", desc: "像朋友聊天" },
              { value: "light_humorous", label: "轻松幽默", emoji: "😄", desc: "有梗有趣" },
              { value: "premium_business", label: "高端商务", emoji: "💼", desc: "专业品质感" },
              { value: "young_trendy", label: "年轻潮流", emoji: "⚡", desc: "网感强" },
              { value: "short_direct", label: "简短直接", emoji: "✂️", desc: "不废话" },
            ]} />
        </Field>
      </div>

      <Field label="禁用表达（用逗号分隔）">
        <input type="text" maxLength={300} value={profileForm.forbidden_phrases}
          onChange={(e) => updateProfileField("forbidden_phrases", e.target.value)}
          className={INPUT_CLASS}
          placeholder="如：包教包会、全城最低" />
      </Field>
      <Toggle label="允许内容里带电话/地址" checked={profileForm.allow_phone_address}
        onChange={(v) => updateProfileField("allow_phone_address", v)} />
    </Section>
  );
}

/* ───── Main Page ───── */

export default function StoreSettingsModulePage() {
  const { module } = useParams<{ module: string }>();
  const router = useRouter();

  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [profileForm, setProfileForm] = useState<ProfileFormData>(EMPTY_PROFILE);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [logoUploading, setLogoUploading] = useState(false);
  const [qrcodeUploading, setQrcodeUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);
  const qrcodeInputRef = useRef<HTMLInputElement>(null);

  const isValid = VALID_MODULES.includes(module as ModuleSlug);

  useEffect(() => {
    let cancelled = false;
    api.getMyStore()
      .then((s) => {
        if (cancelled) return;
        setStore(s);
        setForm({
          name: s.name || "", city: s.city || "", district: s.district || "",
          address: s.address || "", phone: s.phone || "",
          business_hours: s.business_hours || "",
          table_count: s.table_count != null ? String(s.table_count) : "",
          table_types: s.table_types || "",
          has_private_room: s.has_private_room || false,
          has_coaching: s.has_coaching || false,
          has_tournament: s.has_tournament || false,
          has_parking: s.has_parking || false,
          advantages: s.advantages || "",
          pricing: formatJsonForDisplay(s.pricing),
          member_cards: formatJsonForDisplay(s.member_cards),
          coach_count: s.coach_count != null ? String(s.coach_count) : "",
          coach_price_range: s.coach_price_range || "",
          beverage_price_range: s.beverage_price_range || "",
          snack_price_range: s.snack_price_range || "",
          table_brands: s.table_brands || "",
          daily_avg_customers: s.daily_avg_customers != null ? String(s.daily_avg_customers) : "",
          peak_hours: s.peak_hours || "",
          avg_spend_range: s.avg_spend_range || "",
          recharge_rules: formatJsonForDisplay(s.recharge_rules),
        });
        setProfileForm(profileToFormData(s.operation_profile));
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          router.replace("/dashboard/store-settings");
        } else {
          setError("加载门店信息失败");
        }
      });
    return () => { cancelled = true; };
  }, [router]);

  const updateField = (key: keyof FormData, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const updateProfileField = <K extends keyof ProfileFormData>(key: K, value: ProfileFormData[K]) => {
    setProfileForm((prev) => ({ ...prev, [key]: value }));
  };

  const toggleProfileArray = (key: "main_customer_types" | "current_goals" | "private_domain_groups" | "assistant_types" | "equipment_table_types" | "target_conversion_types" | "atmosphere_features" | "groupbuy_platforms", value: string) => {
    setProfileForm((prev) => {
      const arr = prev[key];
      return { ...prev, [key]: arr.includes(value) ? arr.filter(v => v !== value) : [...arr, value] };
    });
  };

  const handleSave = async () => {
    setError(""); setSuccess("");
    if (!form.name.trim()) { setError("门店名称不能为空"); return; }
    setSaving(true);
    try {
      const payload = formDataToPayload(form);
      const profileData = profileFormDataToProfile(profileForm);
      const updated = await api.updateStore({ ...payload, operation_profile: profileData });
      setStore(updated);
      setSuccess("保存成功");
    } catch (err) {
      setError(err instanceof ApiError ? getErrorMessage(err) : "保存失败，请重试");
    } finally {
      setSaving(false);
    }
  };

  const handleBrandStyleChange = async (style: string) => {
    try {
      await api.updateStore({ brand_style: style || undefined } as any);
      const updated = await api.getMyStore();
      setStore(updated);
    } catch { /* silent */ }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoUploading(true); setError("");
    try {
      await api.uploadLogo(file);
      const updated = await api.getMyStore();
      setStore(updated);
    } catch (err) {
      setError(err instanceof ApiError ? getErrorMessage(err) : "Logo 上传失败");
    } finally {
      setLogoUploading(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  };

  const handleQrcodeUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setQrcodeUploading(true); setError("");
    try {
      await api.uploadQrcode(file);
      const updated = await api.getMyStore();
      setStore(updated);
    } catch (err) {
      setError(err instanceof ApiError ? getErrorMessage(err) : "二维码上传失败");
    } finally {
      setQrcodeUploading(false);
      if (qrcodeInputRef.current) qrcodeInputRef.current.value = "";
    }
  };

  /* Invalid module */
  if (!isValid) {
    return (
      <>
        <PageHeader title="门店设置" backHref="/dashboard/store-settings" />
        <div className="mx-auto max-w-2xl py-20 text-center">
          <p className="text-slate-500">模块不存在</p>
          <Link href="/dashboard/store-settings" className="mt-4 inline-block text-sm text-brand-600 hover:underline">
            返回门店设置
          </Link>
        </div>
      </>
    );
  }

  const meta = MODULE_META[module as ModuleSlug];

  /* Loading */
  if (store === undefined) {
    return (
      <>
        <PageHeader title={meta.label} backHref="/dashboard/store-settings" />
        <div className="flex items-center justify-center py-20">
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
          <span className="ml-2 text-slate-500">加载中...</span>
        </div>
      </>
    );
  }

  return (
    <div className="mx-auto max-w-2xl pb-24 lg:pb-0">
      <PageHeader title={meta.label} backHref="/dashboard/store-settings" />
      <Breadcrumb items={[
        { label: "工作台", href: "/dashboard/workbench" },
        { label: "门店设置", href: "/dashboard/store-settings" },
        { label: `${meta.icon} ${meta.label}` },
      ]} />

      {/* 桌面标题行（手机端由 PageHeader 承担） */}
      <div className="mb-6 hidden items-center justify-between lg:flex">
        <h1 className="text-xl font-bold text-slate-900">{meta.icon} {meta.label}</h1>
        <Link
          href="/dashboard/store-settings"
          className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-brand-600 transition-colors"
        >
          <ArrowLeft className="h-4 w-4" />
          返回
        </Link>
      </div>

      {error && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 p-3 text-red-700">{error}</div>
      )}
      {success && (
        <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-600">{success}</div>
      )}

      <div className="space-y-6">
        {module === "basic" && store && (
          <BasicModule
            form={form} updateField={updateField} store={store}
            logoUploading={logoUploading} qrcodeUploading={qrcodeUploading}
            logoInputRef={logoInputRef} qrcodeInputRef={qrcodeInputRef}
            handleLogoUpload={handleLogoUpload} handleQrcodeUpload={handleQrcodeUpload}
          />
        )}
        {module === "profile" && store && (
          <ProfileModule
            profileForm={profileForm} updateProfileField={updateProfileField}
            toggleProfileArray={toggleProfileArray} store={store}
          />
        )}
        {module === "branding" && store && (
          <BrandingModule store={store} onBrandStyleChange={handleBrandStyleChange} />
        )}
        {module === "pricing" && (
          <PricingModule form={form} updateField={updateField} />
        )}
        {module === "slogan" && (
          <SloganModule profileForm={profileForm} updateProfileField={updateProfileField} />
        )}
      </div>

      {/* Save bar：手机端吸底（避开安全区），桌面端保持原右对齐 */}
      <div className="fixed bottom-0 left-0 right-0 z-20 border-t border-slate-200 bg-white p-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] lg:static lg:mt-6 lg:flex lg:justify-end lg:border-0 lg:bg-transparent lg:p-0 lg:pb-6">
        <button type="button" disabled={saving}
          onClick={handleSave}
          className="flex h-12 w-full items-center justify-center rounded-xl bg-brand-600 text-[15px] font-medium text-white hover:bg-brand-500 active:bg-brand-700 disabled:opacity-50 lg:h-auto lg:w-auto lg:rounded-md lg:px-6 lg:py-2.5 lg:text-sm">
          {saving ? "保存中..." : "保存"}
        </button>
      </div>
    </div>
  );
}
