export type GenerationType = "copywriting" | "activity" | "poster" | "operation" | "workbench";

export type GenerationSubType =
  | "moments"
  | "group_notice"
  | "planning"
  | "daily_invite"
  | "activity_promo"
  | "tournament_notice"
  | "recharge_promo"
  | "afternoon_special"
  | "groupbuy_to_private"
  | "assistant_promo"
  | "partner_match"
  | "tournament"
  | "old_customer_recall"
  | "boss"
  | "manager"
  | "assistant_manager"
  | "coach"
  | "frontdesk"
  | "operator";

export interface GenerationHistoryItem {
  id: string;
  type: GenerationType;
  sub_type: string;
  input_params: Record<string, unknown> | null;
  content: string | null;
  model_used: string | null;
  tokens_used: number | null;
  is_favorite: boolean;
  created_at: string;
}

export interface GenerationHistoryListResponse {
  items: GenerationHistoryItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface ListGenerationsParams {
  page?: number;
  page_size?: number;
  type?: string;
  sub_type?: string;
  is_favorite?: boolean;
}
