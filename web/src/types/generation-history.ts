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
  /** 用户自定义命名(海报找图友好);空则前端用 prompt 派生展示名 */
  title?: string | null;
  /** 所属对话(海报可跳回原编辑台"基于此调整") */
  conversation_id?: string | null;
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
  search?: string;
}
