export interface PricingTier {
  table_type: string;
  price: number;
  unit: string;
  description?: string;
}

export interface MemberCard {
  name: string;
  price: number;
  duration?: string;
  benefits?: string[];
}

export interface OperationProfile {
  facility_features?: string[];
  pricing_features?: string[];
  coach_features?: string[];
  tournament_features?: string[];
  member_features?: string[];
  atmosphere_features?: string[];
  service_features?: string[];
  marketing_features?: string[];
  target_audience?: string[];
}

export interface StoreCreate {
  name: string;
  city?: string | null;
  district?: string | null;
  address?: string | null;
  phone?: string | null;
  business_hours?: string | null;
  table_count?: number | null;
  table_types?: string | null;
  pricing?: PricingTier[] | string | null;
  member_cards?: MemberCard[] | string | null;
  operation_profile?: OperationProfile | null;
  has_private_room?: boolean;
  has_coaching?: boolean;
  has_tournament?: boolean;
  has_parking?: boolean;
  target_customers?: string | null;
  style?: string | null;
  brand_style?: string | null;
  advantages?: string | null;
  common_activities?: string | null;
  // Expanded profile fields
  coach_count?: number | null;
  coach_service_types?: string | null;
  coach_price_range?: string | null;
  cue_price_range?: string | null;
  table_brands?: string | null;
  cue_brands?: string | null;
  other_equipment?: string | null;
  membership_types?: unknown | null;
  recharge_rules?: unknown | null;
  membership_benefits?: unknown | null;
  daily_avg_customers?: number | null;
  peak_hours?: string | null;
  avg_spend_range?: string | null;
}

export interface StoreUpdate {
  name?: string | null;
  city?: string | null;
  district?: string | null;
  address?: string | null;
  phone?: string | null;
  business_hours?: string | null;
  table_count?: number | null;
  table_types?: string | null;
  pricing?: PricingTier[] | string | null;
  member_cards?: MemberCard[] | string | null;
  operation_profile?: OperationProfile | null;
  has_private_room?: boolean;
  has_coaching?: boolean;
  has_tournament?: boolean;
  has_parking?: boolean;
  target_customers?: string | null;
  style?: string | null;
  brand_style?: string | null;
  advantages?: string | null;
  common_activities?: string | null;
  // Expanded profile fields
  coach_count?: number | null;
  coach_service_types?: string | null;
  coach_price_range?: string | null;
  cue_price_range?: string | null;
  table_brands?: string | null;
  cue_brands?: string | null;
  other_equipment?: string | null;
  membership_types?: unknown | null;
  recharge_rules?: unknown | null;
  membership_benefits?: unknown | null;
  daily_avg_customers?: number | null;
  peak_hours?: string | null;
  avg_spend_range?: string | null;
}

export interface StoreResponse {
  id: string;
  owner_id: string;
  name: string;
  city: string | null;
  district: string | null;
  address: string | null;
  phone: string | null;
  business_hours: string | null;
  table_count: number | null;
  table_types: string | null;
  pricing: PricingTier[] | null;
  member_cards: MemberCard[] | null;
  logo_url: string | null;
  qrcode_url: string | null;
  has_private_room: boolean;
  has_coaching: boolean;
  has_tournament: boolean;
  has_parking: boolean;
  target_customers: string | null;
  style: string | null;
  brand_style?: string | null;
  advantages: string | null;
  common_activities: string | null;
  operation_profile: Record<string, unknown> | null;
  operation_profile_completeness: {
    overall_score: number;
    modules: Record<string, { score: number; completed: boolean; missing_fields: string[] }>;
    completed_modules: string[];
    suggested_modules: string[];
  } | null;
  completeness: number;
  /** 当前用户在本店的角色(owner/manager/...)——工作台默认选中自己的岗位 */
  my_role?: string | null;
  // Expanded profile fields
  coach_count: number | null;
  coach_service_types: string | null;
  coach_price_range: string | null;
  cue_price_range: string | null;
  table_brands: string | null;
  cue_brands: string | null;
  other_equipment: string | null;
  membership_types: unknown | null;
  recharge_rules: unknown | null;
  membership_benefits: unknown | null;
  daily_avg_customers: number | null;
  peak_hours: string | null;
  avg_spend_range: string | null;
  created_at: string;
  updated_at: string;
}


export interface UploadResponse {
  url: string;
}

/** 店脑：门店 AI 记忆条目（「AI 眼里的你的店」页） */
export interface StoreMemoryItem {
  id: string;
  type: string;
  type_label: string;
  content: string;
  confidence: string;
  /** manual=老板亲定的「我的店规矩」 | auto=AI 从使用里学到的 */
  source: "manual" | "auto";
  /** 大白话来源标签：店主定 / AI学到 */
  source_label: string;
}

/** BYOK：门店自带大模型 Key 配置（读，不含明文 key） */
export interface ByokConfigOut {
  enabled: boolean;
  base_url: string | null;
  model: string | null;
  key_configured: boolean;
  key_mask: string;
  image_enabled: boolean;
  image_base_url: string | null;
  image_model: string | null;
  image_key_configured: boolean;
  image_key_mask: string;
  agent_auto_spend_limit: number | null;
}

/** BYOK 多供应商配置档（CC Switch 式：存好几套、一键切换） */
export interface ByokProfile {
  name: string;
  base_url: string | null;
  model: string | null;
  has_key: boolean;
  is_active: boolean;
}

/** BYOK：写配置（api_key 明文，仅提交时传；不传则保留原 key） */
export interface ByokConfigIn {
  enabled: boolean;
  base_url?: string | null;
  api_key?: string | null;
  model?: string | null;
  image_enabled?: boolean;
  image_base_url?: string | null;
  image_api_key?: string | null;
  image_model?: string | null;
  /** 做海报自动出图上限（B-5）：>=0=上限(0=每张先问)；-1=关闭上限闸；不传=不改 */
  agent_auto_spend_limit?: number | null;
}

/** BYOK：测试连接结果 */
export interface ByokValidateResult {
  ok: boolean;
  model?: string;
  sample?: string;
  error?: string;
}
