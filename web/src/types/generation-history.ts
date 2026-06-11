export type GenerationType = "copywriting" | "activity" | "poster" | "operation" | "workbench";

export interface GenerationHistoryItem {
  id: string;
  type: GenerationType;
  sub_type: string;
  input_params: Record<string, unknown> | null;
  content: string | null;
  result: string | null;
  model_used: string | null;
  tokens_used: number | null;
  is_favorite: boolean;
  effect_rating?: string | null;
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
  effect_rating?: string;
}
