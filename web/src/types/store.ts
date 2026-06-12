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
  beverage_price_range?: string | null;
  snack_price_range?: string | null;
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
  beverage_price_range?: string | null;
  snack_price_range?: string | null;
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
  beverage_price_range: string | null;
  snack_price_range: string | null;
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

export interface StoreListItem {
  id: string;
  name: string;
}

export interface UploadResponse {
  url: string;
}
