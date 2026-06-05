"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { ApiError } from "@/types/api";
import type { StoreResponse, PricingTier, MemberCard } from "@/types/store";
import { Section, Field, Toggle, TagGroup, TagCheckbox } from "@/components/forms/section-components";
import { Upload, Building2, Wrench, FileText, ImageIcon, Sparkles, Brain } from "lucide-react";
import { ProfileGuide } from "@/components/store/profile-guide";
import { MODULE_LABELS } from "@/lib/role-workbench-config";

type FormData = {
  name: string;
  city: string;
  district: string;
  address: string;
  phone: string;
  business_hours: string;
  table_count: string;
  table_types: string;
  has_private_room: boolean;
  has_coaching: boolean;
  has_tournament: boolean;
  has_parking: boolean;
  target_customers: string;
  style: string;
  advantages: string;
  common_activities: string;
  pricing: string;
  member_cards: string;
  coach_count: string;
  coach_service_types: string;
  coach_price_range: string;
  beverage_price_range: string;
  snack_price_range: string;
  cue_price_range: string;
  table_brands: string;
  cue_brands: string;
  other_equipment: string;
  daily_avg_customers: string;
  peak_hours: string;
  avg_spend_range: string;
  membership_types: string;
  recharge_rules: string;
  membership_benefits: string;
};

const EMPTY_FORM: FormData = {
  name: "",
  city: "",
  district: "",
  address: "",
  phone: "",
  business_hours: "",
  table_count: "",
  table_types: "",
  has_private_room: false,
  has_coaching: false,
  has_tournament: false,
  has_parking: false,
  target_customers: "",
  style: "",
  advantages: "",
  common_activities: "",
  pricing: "",
  member_cards: "",
  coach_count: "",
  coach_service_types: "",
  coach_price_range: "",
  beverage_price_range: "",
  snack_price_range: "",
  cue_price_range: "",
  table_brands: "",
  cue_brands: "",
  other_equipment: "",
  daily_avg_customers: "",
  peak_hours: "",
  avg_spend_range: "",
  membership_types: "",
  recharge_rules: "",
  membership_benefits: "",
};

type ProfileFormData = {
  positioning: string;
  business_district: string;
  main_selling_points: string;
  main_customer_types: string[];
  current_goals: string[];
  monthly_focus: string;
  avoid_recommendations: string;
  target_conversion_types: string[];
  private_domain_groups: string[];
  has_assistant: boolean;
  has_assistant_manager: boolean;
  assistant_types: string[];
  assistant_booking_rule: string;
  assistant_forbidden_words: string;
  allow_new_assistant_notice: boolean;
  allow_today_assistant_available: boolean;
  has_weekly_match: boolean;
  has_light_competition: boolean;
  has_partner_group_activity: boolean;
  has_groupbuy: boolean;
  has_membership: boolean;
  allow_discount_copy: boolean;
  allow_price_copy: boolean;
  moments_tone: string;
  private_chat_tone: string;
  group_notice_tone: string;
  allow_phone_address: boolean;
  forbidden_phrases: string;
  equipment_table_types: string[];
  equipment_table_type_note: string;
};

const EMPTY_PROFILE_FORM: ProfileFormData = {
  positioning: "",
  business_district: "",
  main_selling_points: "",
  main_customer_types: [],
  current_goals: [],
  monthly_focus: "",
  avoid_recommendations: "",
  target_conversion_types: [],
  private_domain_groups: [],
  has_assistant: false,
  has_assistant_manager: false,
  assistant_types: [],
  assistant_booking_rule: "",
  assistant_forbidden_words: "",
  allow_new_assistant_notice: false,
  allow_today_assistant_available: false,
  has_weekly_match: false,
  has_light_competition: false,
  has_partner_group_activity: false,
  has_groupbuy: false,
  has_membership: false,
  allow_discount_copy: false,
  allow_price_copy: false,
  moments_tone: "",
  private_chat_tone: "",
  group_notice_tone: "",
  allow_phone_address: false,
  forbidden_phrases: "",
  equipment_table_types: [],
  equipment_table_type_note: "",
};

function profileToFormData(profile: Record<string, unknown> | null | undefined): ProfileFormData {
  if (!profile || typeof profile !== "object") return { ...EMPTY_PROFILE_FORM };
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
  const groupKeys = ["customer_group", "member_group", "competition_group", "partner_group", "assistant_customer_group", "event_group", "staff_group"];
  for (const gk of groupKeys) {
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
  };
}

function profileFormDataToProfile(form: ProfileFormData): Record<string, unknown> {
  const groups: Record<string, unknown> = {};
  const allGroupKeys = ["customer_group", "member_group", "competition_group", "partner_group", "assistant_customer_group", "event_group", "staff_group"];
  for (const gk of allGroupKeys) {
    groups[gk] = { enabled: form.private_domain_groups.includes(gk) };
  }

  return {
    basic: {
      positioning: form.positioning || "",
      business_district: form.business_district || "",
      main_selling_points: form.main_selling_points ? form.main_selling_points.split(/[,，、]/).map(s => s.trim()).filter(Boolean) : [],
      allow_address_in_content: form.allow_phone_address,
      allow_phone_in_content: form.allow_phone_address,
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
    },
    events: {
      has_weekly_match: form.has_weekly_match,
      has_light_competition: form.has_light_competition,
      has_partner_group: form.has_partner_group_activity,
    },
    commerce_rules: {
      has_groupbuy: form.has_groupbuy,
      has_membership: form.has_membership,
      allow_discount_copy: form.allow_discount_copy,
      allow_price_copy: form.allow_price_copy,
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
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

/** 把 JSON 数据转成用户能看懂的文字 */
function formatJsonForDisplay(data: unknown): string {
  if (!data) return "";
  if (typeof data === "string") return data;
  if (Array.isArray(data)) {
    return data.map((item) => {
      if (typeof item === "string") return item;
      if (typeof item === "object" && item !== null) {
        // 常见格式：{name, price} 或 {amount, bonus}
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
    const entries = Object.entries(data as Record<string, unknown>);
    return entries.map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`).join("\n");
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
    target_customers: form.target_customers.trim() || null,
    style: form.style.trim() || null,
    advantages: form.advantages.trim() || null,
    common_activities: form.common_activities.trim() || null,
    pricing: parseFlexibleField(form.pricing) as PricingTier[] | string | null,
    member_cards: parseFlexibleField(form.member_cards) as MemberCard[] | string | null,
    coach_count: Number.isNaN(coachCount) ? null : coachCount,
    coach_service_types: form.coach_service_types.trim() || null,
    coach_price_range: form.coach_price_range.trim() || null,
    beverage_price_range: form.beverage_price_range.trim() || null,
    snack_price_range: form.snack_price_range.trim() || null,
    cue_price_range: form.cue_price_range.trim() || null,
    table_brands: form.table_brands.trim() || null,
    cue_brands: form.cue_brands.trim() || null,
    other_equipment: form.other_equipment.trim() || null,
    daily_avg_customers: Number.isNaN(dailyAvg) ? null : dailyAvg,
    peak_hours: form.peak_hours.trim() || null,
    avg_spend_range: form.avg_spend_range.trim() || null,
    membership_types: parseFlexibleField(form.membership_types),
    recharge_rules: parseFlexibleField(form.recharge_rules),
    membership_benefits: parseFlexibleField(form.membership_benefits),
  };
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (typeof value === "object" && !Array.isArray(value)) return Object.keys(value as object).length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function getCoreFieldStatus(store: StoreResponse | null | undefined, form: FormData, isNew: boolean) {
  if (store && !isNew) {
    return [
      { label: "门店名称", done: !!store.name },
      { label: "地址 / 电话", done: !!(store.address && store.phone) },
      { label: "营业时间", done: !!store.business_hours },
      { label: "价格体系", done: isNonEmpty(store.pricing) },
      { label: "会员卡套餐", done: isNonEmpty(store.member_cards) },
      { label: "门店优势", done: !!store.advantages },
      { label: "Logo", done: !!store.logo_url },
      { label: "微信二维码", done: !!store.qrcode_url },
    ];
  }
  return [
    { label: "门店名称", done: !!form.name.trim() },
    { label: "地址 / 电话", done: !!(form.address.trim() && form.phone.trim()) },
    { label: "营业时间", done: !!form.business_hours.trim() },
    { label: "价格体系", done: !!form.pricing.trim() },
    { label: "会员卡套餐", done: !!form.member_cards.trim() },
    { label: "门店优势", done: !!form.advantages.trim() },
    { label: "Logo", done: false },
    { label: "微信二维码", done: false },
  ];
}

function getCompletenessMessage(completeness: number): string {
  if (completeness < 70) {
    return "资料还不够完整，AI 可能无法准确写出你的价格、优势和活动信息。";
  }
  if (completeness < 90) {
    return "资料已经基本可用，继续补充 Logo、二维码或会员卡信息，生成效果会更好。";
  }
  return "资料很完整，可以放心生成文案和海报。";
}

const INPUT_CLASS = "w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-slate-900 placeholder-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20";

export default function StoreSettingsPage() {
  const [store, setStore] = useState<StoreResponse | null | undefined>(undefined);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [isNew, setIsNew] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [logoUploading, setLogoUploading] = useState(false);
  const [qrcodeUploading, setQrcodeUploading] = useState(false);
  const [showPostSaveHint, setShowPostSaveHint] = useState(false);
  const [profileForm, setProfileForm] = useState<ProfileFormData>(EMPTY_PROFILE_FORM);

  /* Step wizard state */
  const [step, setStep] = useState(1); // 1, 2, 3
  const [viewMode, setViewMode] = useState<"wizard" | "all">("wizard");
  const logoInputRef = useRef<HTMLInputElement>(null);
  const qrcodeInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    api.getMyStore()
      .then((s) => {
        if (cancelled) return;
        setStore(s);
        setIsNew(false);
        setForm({
          name: s.name || "",
          city: s.city || "",
          district: s.district || "",
          address: s.address || "",
          phone: s.phone || "",
          business_hours: s.business_hours || "",
          table_count: s.table_count != null ? String(s.table_count) : "",
          table_types: s.table_types || "",
          has_private_room: s.has_private_room || false,
          has_coaching: s.has_coaching || false,
          has_tournament: s.has_tournament || false,
          has_parking: s.has_parking || false,
          target_customers: s.target_customers || "",
          style: s.style || "",
          advantages: s.advantages || "",
          common_activities: s.common_activities || "",
          pricing: formatJsonForDisplay(s.pricing),
          member_cards: formatJsonForDisplay(s.member_cards),
          coach_count: s.coach_count != null ? String(s.coach_count) : "",
          coach_service_types: s.coach_service_types || "",
          coach_price_range: s.coach_price_range || "",
          beverage_price_range: s.beverage_price_range || "",
          snack_price_range: s.snack_price_range || "",
          cue_price_range: s.cue_price_range || "",
          table_brands: s.table_brands || "",
          cue_brands: s.cue_brands || "",
          other_equipment: s.other_equipment || "",
          daily_avg_customers: s.daily_avg_customers != null ? String(s.daily_avg_customers) : "",
          peak_hours: s.peak_hours || "",
          avg_spend_range: s.avg_spend_range || "",
          membership_types: formatJsonForDisplay(s.membership_types),
          recharge_rules: formatJsonForDisplay(s.recharge_rules),
          membership_benefits: formatJsonForDisplay(s.membership_benefits),
        });
        setProfileForm(profileToFormData(s.operation_profile));
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && (err.status === 404 || err.status === 403)) {
          setStore(null);
          setIsNew(true);
        } else {
          setError("加载门店信息失败");
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const updateField = (key: keyof FormData, value: string | boolean) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setShowPostSaveHint(false);
  };

  const updateProfileField = <K extends keyof ProfileFormData>(
    key: K,
    value: ProfileFormData[K],
  ) => {
    setProfileForm((prev) => ({ ...prev, [key]: value }));
    setShowPostSaveHint(false);
  };

  const toggleProfileArray = (key: "main_customer_types" | "current_goals" | "private_domain_groups" | "assistant_types" | "equipment_table_types" | "target_conversion_types", value: string) => {
    setProfileForm((prev) => {
      const arr = prev[key];
      const next = arr.includes(value) ? arr.filter((v) => v !== value) : [...arr, value];
      return { ...prev, [key]: next };
    });
    setShowPostSaveHint(false);
  };

  const handleSave = async () => {
    setError("");
    setSuccess("");

    if (!form.name.trim()) {
      setError("门店名称不能为空");
      return;
    }

    setSaving(true);
    try {
      const profileData = profileFormDataToProfile(profileForm);
      const payload = formDataToPayload(form);
      if (isNew) {
        const created = await api.createStore({
          ...payload,
          operation_profile: profileData,
        });
        setStore(created);
        setIsNew(false);
      } else {
        const updated = await api.updateStore({
          ...payload,
          operation_profile: profileData,
        });
        setStore(updated);
      }
      setSuccess("保存成功");
      setShowPostSaveHint(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.detail);
      } else {
        setError("保存失败，请重试");
      }
    } finally {
      setSaving(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLogoUploading(true);
    setError("");
    try {
      await api.uploadLogo(file);
      const updated = await api.getMyStore();
      setStore(updated);
      setSuccess("Logo 上传成功");
      setShowPostSaveHint(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.detail);
      } else {
        setError("Logo 上传失败");
      }
    } finally {
      setLogoUploading(false);
      if (logoInputRef.current) logoInputRef.current.value = "";
    }
  };

  const handleQrcodeUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setQrcodeUploading(true);
    setError("");
    try {
      await api.uploadQrcode(file);
      const updated = await api.getMyStore();
      setStore(updated);
      setSuccess("二维码上传成功");
      setShowPostSaveHint(true);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.detail);
      } else {
        setError("二维码上传失败");
      }
    } finally {
      setQrcodeUploading(false);
      if (qrcodeInputRef.current) qrcodeInputRef.current.value = "";
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-20">
        <p className="text-slate-500">加载中...</p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-bold text-slate-900">
          {isNew ? "创建门店" : "门店资料"}
        </h2>
        {store && (
          <span className={`rounded-full px-3 py-1 text-xs font-medium ${
            store.completeness >= 70 ? "bg-emerald-50 border border-emerald-200 text-emerald-600" :
            store.completeness >= 40 ? "bg-amber-50 border border-amber-200 text-amber-600" :
            "bg-red-50 border border-red-200 text-red-600"
          }`}>
            完整度 {store.completeness}%
          </span>
        )}
      </div>

      {/* 完整度文字说明 */}
      {store && (
        <p className="mb-4 text-slate-500">
          {getCompletenessMessage(store.completeness)}
        </p>
      )}

      {error && (
        <div className="mb-4 rounded-md bg-red-50 border border-red-200 p-3 text-red-700">{error}</div>
      )}
      {success && (
        <div className="mb-4 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-600">{success}</div>
      )}

      {/* 保存成功后下一步提示 */}
      {showPostSaveHint && store && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 p-4">
          <p className="mb-3 text-sm text-emerald-600">
            资料已保存。现在可以去生成 AI 文案或海报了。
          </p>
          <div className="flex gap-3">
            <Link
              href="/dashboard/workbench"
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
            >
              <Sparkles className="h-4 w-4" />
              去生成文案
            </Link>
            <Link
              href="/dashboard/posters"
              className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              <ImageIcon className="h-4 w-4" />
              去生成海报
            </Link>
          </div>
        </div>
      )}

      {/* 核心资料 checklist */}
      {(isNew || (store && store.completeness < 70)) && (
        <div className="mb-6">
          <ProfileGuide
            fields={getCoreFieldStatus(store, form, isNew)}
          />
        </div>
      )}

      {/* Step wizard navigation */}
      {viewMode === "wizard" ? (
        <div className="mb-6">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-1">
              {[
                { n: 1, label: "门店基础" },
                { n: 2, label: "设施与经营" },
                { n: 3, label: "AI 运营画像" },
              ].map(({ n, label }) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setStep(n)}
                  className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    step === n
                      ? "bg-indigo-600 text-white"
                      : step > n
                      ? "bg-emerald-50 text-emerald-600 border border-emerald-200"
                      : "text-slate-500 border border-slate-200 bg-white"
                  }`}
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full text-xs font-bold bg-white/20">
                    {step > n ? "✓" : n}
                  </span>
                  {label}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setViewMode("all")}
              className="text-xs text-slate-400 hover:text-slate-600"
            >
              全部编辑
            </button>
          </div>
          {/* Progress bar */}
          <div className="h-1 w-full rounded-full bg-slate-200">
            <div
              className="h-1 rounded-full bg-indigo-600 transition-all"
              style={{ width: `${(step / 3) * 100}%` }}
            />
          </div>
        </div>
      ) : (
        <div className="mb-4 flex justify-end">
          <button
            type="button"
            onClick={() => setViewMode("wizard")}
            className="text-xs text-slate-400 hover:text-slate-600"
          >
            分步模式
          </button>
        </div>
      )}

      <div className="space-y-6">
        {/* Step 1: 门店基础 — 基础信息 + 图片上传 */}
        {(viewMode === "all" || step === 1) && (
        <>
        {/* 基础信息 */}
        <Section title="基础信息" icon={Building2}>
          <Field label="门店名称" required>
            <input
              type="text" maxLength={200}
              value={form.name}
              onChange={(e) => updateField("name", e.target.value)}
              className={INPUT_CLASS}
              placeholder="请输入门店名称"
            />
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

        {/* 图片上传 — 放在 Step 1 基础信息之后 */}
        {!isNew && (
          <Section title="图片上传" icon={ImageIcon}>
            <div className="grid gap-6 sm:grid-cols-2">
              <div>
                <label className="mb-1 block font-medium text-slate-700">Logo</label>
                {store?.logo_url ? (
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
                  onChange={handleLogoUpload} className="hidden" id="logo-upload" />
                <button type="button" disabled={logoUploading}
                  onClick={() => logoInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  <Upload className="h-3.5 w-3.5" />
                  {logoUploading ? "上传中..." : "上传 Logo"}
                </button>
              </div>

              <div>
                <label className="mb-1 block font-medium text-slate-700">微信二维码</label>
                {store?.qrcode_url ? (
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
                  onChange={handleQrcodeUpload} className="hidden" id="qrcode-upload" />
                <button type="button" disabled={qrcodeUploading}
                  onClick={() => qrcodeInputRef.current?.click()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  <Upload className="h-3.5 w-3.5" />
                  {qrcodeUploading ? "上传中..." : "上传二维码"}
                </button>
              </div>
            </div>
          </Section>
        )}
        </>
        )}

        {/* Step 2: 设施与经营 */}
        {(viewMode === "all" || step === 2) && (
        <>
        {/* 设施信息 */}
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
                className={INPUT_CLASS} placeholder="如：中式黑八 8张，美式 4张" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="球桌品牌">
              <input type="text" maxLength={200} value={form.table_brands}
                onChange={(e) => updateField("table_brands", e.target.value)}
                className={INPUT_CLASS} placeholder="如：乔氏、独牙、星牌" />
            </Field>
            <Field label="球杆品牌">
              <input type="text" maxLength={200} value={form.cue_brands}
                onChange={(e) => updateField("cue_brands", e.target.value)}
                className={INPUT_CLASS} placeholder="如：环球、LP、匠心" />
            </Field>
          </div>
          <Field label="其他设备（选填）">
            <input type="text" maxLength={200} value={form.other_equipment}
              onChange={(e) => updateField("other_equipment", e.target.value)}
              className={INPUT_CLASS} placeholder="如：飞镖机、投影仪、自助售货机" />
          </Field>
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
            <Field label="教练/助教人数">
              <input type="number" min={0} value={form.coach_count}
                onChange={(e) => updateField("coach_count", e.target.value)}
                className={INPUT_CLASS} placeholder="如：5" />
            </Field>
            <Field label="助教服务类型">
              <input type="text" maxLength={200} value={form.coach_service_types}
                onChange={(e) => updateField("coach_service_types", e.target.value)}
                className={INPUT_CLASS} placeholder="如：陪练、教学、组局" />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="助教价格范围">
              <input type="text" maxLength={100} value={form.coach_price_range}
                onChange={(e) => updateField("coach_price_range", e.target.value)}
                className={INPUT_CLASS} placeholder="如：50-80元/小时" />
            </Field>
            <Field label="饮品价格范围">
              <input type="text" maxLength={100} value={form.beverage_price_range}
                onChange={(e) => updateField("beverage_price_range", e.target.value)}
                className={INPUT_CLASS} placeholder="如：5-20元" />
            </Field>
            <Field label="零食价格范围">
              <input type="text" maxLength={100} value={form.snack_price_range}
                onChange={(e) => updateField("snack_price_range", e.target.value)}
                className={INPUT_CLASS} placeholder="如：3-15元" />
            </Field>
          </div>
          <Field label="球杆价格范围（选填）">
            <input type="text" maxLength={100} value={form.cue_price_range}
              onChange={(e) => updateField("cue_price_range", e.target.value)}
              className={INPUT_CLASS} placeholder="如：100-500元" />
          </Field>
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
        </Section>

        {/* 经营信息 */}
        <Section title="经营信息" icon={FileText}>
          <Field label="主要客群">
            <input type="text" maxLength={500} value={form.target_customers}
              onChange={(e) => updateField("target_customers", e.target.value)}
              className={INPUT_CLASS} placeholder="如：周边大学生、上班族" />
          </Field>
          <Field label="门店风格">
            <input type="text" maxLength={200} value={form.style}
              onChange={(e) => updateField("style", e.target.value)}
              className={INPUT_CLASS} placeholder="如：潮酷风、休闲风" />
          </Field>
          <Field label="门店优势">
            <textarea rows={3} value={form.advantages}
              onChange={(e) => updateField("advantages", e.target.value)}
              className={INPUT_CLASS} placeholder="描述门店的核心竞争优势" />
          </Field>
          <Field label="常用活动">
            <textarea rows={3} value={form.common_activities}
              onChange={(e) => updateField("common_activities", e.target.value)}
              className={INPUT_CLASS} placeholder="门店经常举办的活动类型" />
          </Field>
          <Field label="价格体系">
            <textarea rows={3} value={form.pricing}
              onChange={(e) => updateField("pricing", e.target.value)}
              className={INPUT_CLASS} placeholder="如：中式黑八 30元/小时，美式九球 40元/小时" />
          </Field>
          <Field label="会员卡套餐">
            <textarea rows={3} value={form.member_cards}
              onChange={(e) => updateField("member_cards", e.target.value)}
              className={INPUT_CLASS} placeholder="如：月卡 300元，季卡 800元" />
          </Field>
          <Field label="会员类型（选填）">
            <textarea rows={2} value={form.membership_types}
              onChange={(e) => updateField("membership_types", e.target.value)}
              className={INPUT_CLASS} placeholder="如：月卡、季卡、年卡" />
          </Field>
          <Field label="充值规则（选填）">
            <textarea rows={2} value={form.recharge_rules}
              onChange={(e) => updateField("recharge_rules", e.target.value)}
              className={INPUT_CLASS} placeholder="如：充1000送99，充3000送399" />
          </Field>
          <Field label="会员权益（选填）">
            <textarea rows={2} value={form.membership_benefits}
              onChange={(e) => updateField("membership_benefits", e.target.value)}
              className={INPUT_CLASS} placeholder="如：台费折扣、免费饮料、专属时段" />
          </Field>
        </Section>
        </>
        )}

        {/* Step 3: AI 运营画像 */}
        {(viewMode === "all" || step === 3) && (
        <>
        {/* AI 运营画像 */}
        <Section title="AI 运营画像" icon={Brain}>
          <p className="text-slate-500">
            让 AI 更懂你这家球房，生成内容更像本店的人写的。勾选后，AI 在生成群公告、活动通知、约局话术时会自动区分不同群的说法。
          </p>

          {/* 完整度评分卡片 */}
          {store?.operation_profile_completeness && (
            <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
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
              {/* 进度条 */}
              <div className="mb-3 h-1.5 w-full rounded-full bg-slate-200">
                <div
                  className={`h-1.5 rounded-full transition-all ${
                    store.operation_profile_completeness.overall_score >= 70
                      ? "bg-emerald-500"
                      : store.operation_profile_completeness.overall_score >= 40
                      ? "bg-amber-500"
                      : "bg-red-500"
                  }`}
                  style={{ width: `${store.operation_profile_completeness.overall_score}%` }}
                />
              </div>
              <div className="space-y-1 text-xs text-slate-500">
                {store.operation_profile_completeness.completed_modules.length > 0 && (
                  <p>已完善：{store.operation_profile_completeness.completed_modules.map(m =>
                    MODULE_LABELS[m] || m
                  ).join("、")}</p>
                )}
                {store.operation_profile_completeness.suggested_modules.length > 0 && (
                  <p className="text-orange-600">建议补充：{store.operation_profile_completeness.suggested_modules.map(m =>
                    MODULE_LABELS[m] || m
                  ).join("、")}</p>
                )}
              </div>
            </div>
          )}

          {/* 门店定位 + 商圈 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="门店定位/风格">
              <select
                value={profileForm.positioning}
                onChange={(e) => updateProfileField("positioning", e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">请选择</option>
                <option value="community_affordable">社区球房</option>
                <option value="commercial_premium">商业球房</option>
                <option value="competition_focused">竞技球房</option>
                <option value="competition_commercial">竞技商业球房</option>
              </select>
            </Field>
            <Field label="所在商圈/区域">
              <input type="text" maxLength={100}
                value={profileForm.business_district}
                onChange={(e) => updateProfileField("business_district", e.target.value)}
                className={INPUT_CLASS}
                placeholder="如：南山中心区" />
            </Field>
          </div>

          {/* 主要卖点 */}
          <Field label="门店主要卖点（用逗号分隔）">
            <textarea rows={2} maxLength={500}
              value={profileForm.main_selling_points}
              onChange={(e) => updateProfileField("main_selling_points", e.target.value)}
              className={INPUT_CLASS}
              placeholder="如：24小时营业、乔氏台球桌、免费停车、新装修" />
          </Field>

          {/* 主要客户类型 */}
          <Field label="主要客户类型（多选）">
            <TagGroup>
              {[
                ["casual", "散客"],
                ["competitive", "竞技客户"],
                ["assistant", "助教客户"],
                ["point_chaser", "追分客户"],
              ].map(([value, label]) => (
                <TagCheckbox key={value} label={label}
                  checked={profileForm.main_customer_types.includes(value)}
                  onChange={() => toggleProfileArray("main_customer_types", value)} />
              ))}
            </TagGroup>
          </Field>


          {/* 重点转化客户 */}
          <Field label="重点转化客户（多选）">
            <TagGroup>
              {[
                ["casual", "散客"],
                ["competitive", "竞技客户"],
                ["assistant", "助教客户"],
                ["point_chaser", "追分客户"],
              ].map(([value, label]) => (
                <TagCheckbox key={value} label={label}
                  checked={profileForm.target_conversion_types.includes(value)}
                  onChange={() => toggleProfileArray("target_conversion_types", value)} />
              ))}
            </TagGroup>
          </Field>
          {/* 当前最想提升目标 */}
          <Field label="当前最想提升（多选）">
            <TagGroup>
              {[
                ["customer_acquisition", "拉新"],
                ["old_customer_recall", "老客户回流"],
                ["groupbuy_conversion", "团购客转私域"],
                ["assistant_booking", "助教预约转化"],
                ["tournament_growth", "提升周赛人气"],
                ["content_output", "提高朋友圈发布频率"],
                ["frontdesk_conversion", "提升前厅转化"],
                ["assistant_attendance", "提升助教上钟"],
                ["matchmaking_active", "搭子群活跃"],
              ].map(([value, label]) => (
                <TagCheckbox key={value} label={label}
                  checked={profileForm.current_goals.includes(value)}
                  onChange={() => toggleProfileArray("current_goals", value)} />
              ))}
            </TagGroup>
          </Field>


          {/* 本月重点 + 避免推荐 */}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="本月经营重点">
              <input type="text" maxLength={200}
                value={profileForm.monthly_focus}
                onChange={(e) => updateProfileField("monthly_focus", e.target.value)}
                className={INPUT_CLASS}
                placeholder="如：推团购核销、提升助教上钟" />
            </Field>
            <Field label="避免推荐的内容（用逗号分隔）">
              <input type="text" maxLength={300}
                value={profileForm.avoid_recommendations}
                onChange={(e) => updateProfileField("avoid_recommendations", e.target.value)}
                className={INPUT_CLASS}
                placeholder="如：充值赠送、免费体验" />
            </Field>
          </div>
          {/* 私域群矩阵 */}
          <Field label="你们门店有哪些群？（多选）">
            <div className="space-y-2">
              <TagGroup>
                {[
                  ["customer_group", "客户群"],
                  ["member_group", "会员群"],
                  ["competition_group", "竞技群"],
                  ["partner_group", "搭子群"],
                  ["assistant_customer_group", "助教客户群"],
                  ["event_group", "赛事群"],
                  ["staff_group", "员工群"],
                ].map(([value, label]) => (
                  <TagCheckbox key={value} label={label}
                    checked={profileForm.private_domain_groups.includes(value)}
                    onChange={() => toggleProfileArray("private_domain_groups", value)} />
                ))}
              </TagGroup>
              <div className="space-y-1 rounded-md bg-indigo-50 p-3 text-xs text-indigo-800">
                {profileForm.private_domain_groups.includes("member_group") && (
                  <p>会员群：会员维护、空台提醒、活动通知。不会自动编造会员专属优惠、充值规则或会员权益。</p>
                )}
                {profileForm.private_domain_groups.includes("competition_group") && (
                  <p>竞技群：约局、周赛/月赛、轻竞技活动、赛后战报、找搭子。不会写赌博、追分、大额输赢。</p>
                )}
                {profileForm.private_domain_groups.includes("partner_group") && (
                  <p>搭子群：找人打球、拼局、新人融入。表达自然，不写赌博或高风险对局。</p>
                )}
                {profileForm.private_domain_groups.includes("assistant_customer_group") && (
                  <p>助教客户群：助教到店通知、可约提醒。不写免费助教、送助教课或低俗擦边表达。</p>
                )}
                {profileForm.private_domain_groups.includes("staff_group") && (
                  <p>员工群：员工通知、SOP提醒。不擅自安排调休、奖金、处罚或顶班。</p>
                )}
              </div>
            </div>
          </Field>

          {/* 设备桌型 */}
          <Field label="台球桌类型（多选）">
            <div className="space-y-2">
              <TagGroup>
                {[
                  ["normal_pool_table", "普通台球桌"],
                  ["duya_pool_table", "独牙台球桌"],
                  ["joy_billiards_table", "乔氏台球桌"],
                  ["snooker_table", "斯诺克"],
                ].map(([value, label]) => (
                  <TagCheckbox key={value} label={label}
                    checked={profileForm.equipment_table_types.includes(value)}
                    onChange={() => toggleProfileArray("equipment_table_types", value)} />
                ))}
              </TagGroup>
              <p className="text-xs text-slate-400">
                除独牙、乔氏以外的中式八球台球桌，统一按普通台球桌处理。勾选后，AI 在生成赛事、约局、客户邀约内容时会参考门店桌型。
              </p>
            </div>
          </Field>
          <Field label="桌型补充说明（选填）">
            <input type="text" maxLength={200}
              value={profileForm.equipment_table_type_note}
              onChange={(e) => updateProfileField("equipment_table_type_note", e.target.value)}
              className={INPUT_CLASS}
              placeholder="如：12 张普通台，2 张乔氏，1 张斯诺克" />
          </Field>

          {/* 助教配置 */}
          <div className="space-y-3">
            <Toggle label="店里有助教" checked={profileForm.has_assistant}
              onChange={(v) => updateProfileField("has_assistant", v)} />

            {profileForm.has_assistant && (
              <>
                <Field label="助教类型（多选）">
                  <TagGroup>
                    {[
                      ["service_experience", "服务体验型"],
                      ["technical_coaching", "技术陪练型/高级助教"],
                    ].map(([value, label]) => (
                      <TagCheckbox key={value} label={label}
                        checked={profileForm.assistant_types.includes(value)}
                        onChange={() => toggleProfileArray("assistant_types", value)} />
                    ))}
                  </TagGroup>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                <Toggle label="有专门的助教管理" checked={profileForm.has_assistant_manager}
                  onChange={(v) => updateProfileField("has_assistant_manager", v)} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="助教预约方式">
                    <input type="text" maxLength={200}
                      value={profileForm.assistant_booking_rule}
                      onChange={(e) => updateProfileField("assistant_booking_rule", e.target.value)}
                      className={INPUT_CLASS}
                      placeholder="如：微信预约、到店前台预约" />
                  </Field>
                  <Field label="助教内容禁用词（用逗号分隔）">
                    <input type="text" maxLength={300}
                      value={profileForm.assistant_forbidden_words}
                      onChange={(e) => updateProfileField("assistant_forbidden_words", e.target.value)}
                      className={INPUT_CLASS}
                      placeholder="如：美女助教、陪玩" />
                  </Field>
                </div>
                  <Toggle label="允许写「新助教到店」" checked={profileForm.allow_new_assistant_notice}
                    onChange={(v) => updateProfileField("allow_new_assistant_notice", v)} />
                  <Toggle label="允许写「今日助教可约」" checked={profileForm.allow_today_assistant_available}
                    onChange={(v) => updateProfileField("allow_today_assistant_available", v)} />
                </div>
              </>
            )}
          </div>

          {/* 赛事/团购/价格规则 */}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <Toggle label="固定做周赛/活动" checked={profileForm.has_weekly_match}
              onChange={(v) => updateProfileField("has_weekly_match", v)} />
            <Toggle label="有轻竞技/台费局" checked={profileForm.has_light_competition}
              onChange={(v) => updateProfileField("has_light_competition", v)} />
            <Toggle label="有搭子群活动" checked={profileForm.has_partner_group_activity}
              onChange={(v) => updateProfileField("has_partner_group_activity", v)} />
            <Toggle label="做团购（美团/抖音）" checked={profileForm.has_groupbuy}
              onChange={(v) => updateProfileField("has_groupbuy", v)} />
            <Toggle label="有会员体系" checked={profileForm.has_membership}
              onChange={(v) => updateProfileField("has_membership", v)} />
            <Toggle label="允许写优惠/折扣" checked={profileForm.allow_discount_copy}
              onChange={(v) => updateProfileField("allow_discount_copy", v)} />
            <Toggle label="允许写价格" checked={profileForm.allow_price_copy}
              onChange={(v) => updateProfileField("allow_price_copy", v)} />
          </div>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="朋友圈语气">
              <select
                value={profileForm.moments_tone}
                onChange={(e) => updateProfileField("moments_tone", e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">请选择</option>
                <option value="casual_friendly">熟人自然</option>
                <option value="light_humorous">轻松幽默</option>
                <option value="premium_business">高端商务</option>
                <option value="young_trendy">年轻潮流</option>
                <option value="short_direct">简短直接</option>
              </select>
            </Field>
            <Field label="私聊语气">
              <select
                value={profileForm.private_chat_tone}
                onChange={(e) => updateProfileField("private_chat_tone", e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">请选择</option>
                <option value="casual_friendly">熟人自然</option>
                <option value="light_humorous">轻松幽默</option>
                <option value="premium_business">高端商务</option>
                <option value="young_trendy">年轻潮流</option>
                <option value="short_direct">简短直接</option>
              </select>
            </Field>
            <Field label="群公告语气">
              <select
                value={profileForm.group_notice_tone}
                onChange={(e) => updateProfileField("group_notice_tone", e.target.value)}
                className={INPUT_CLASS}
              >
                <option value="">请选择</option>
                <option value="casual_friendly">熟人自然</option>
                <option value="light_humorous">轻松幽默</option>
                <option value="premium_business">高端商务</option>
                <option value="young_trendy">年轻潮流</option>
                <option value="short_direct">简短直接</option>
              </select>
            </Field>
          </div>

          <Field label="禁用表达（用逗号分隔）">
            <input type="text" maxLength={300}
              value={profileForm.forbidden_phrases}
              onChange={(e) => updateProfileField("forbidden_phrases", e.target.value)}
              className={INPUT_CLASS}
              placeholder="如：包教包会、全城最低" />
          </Field>

          <Toggle label="允许内容里带电话/地址" checked={profileForm.allow_phone_address}
            onChange={(v) => updateProfileField("allow_phone_address", v)} />
        </Section>
        </>
        )}

        {/* Step navigation + Save */}
        <div className="flex items-center justify-between pb-4">
          {viewMode === "wizard" && step > 1 ? (
            <button
              type="button"
              onClick={() => setStep((s) => s - 1)}
              className="rounded-md border border-slate-200 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              上一步
            </button>
          ) : (
            <div />
          )}
          <div className="flex items-center gap-2">
            <button type="button" disabled={saving}
              onClick={handleSave}
              className="rounded-md bg-indigo-600 px-6 py-2.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50">
              {saving ? "保存中..." : "保存门店资料"}
            </button>
            {viewMode === "wizard" && step < 3 && (
              <button
                type="button"
                onClick={() => setStep((s) => s + 1)}
                className="rounded-md border border-indigo-200 bg-indigo-50 px-4 py-2.5 text-sm font-medium text-indigo-600 hover:bg-indigo-100"
              >
                下一步
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
