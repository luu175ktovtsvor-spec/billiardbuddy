export interface ImageModel {
  id: string;
  name: string;
  desc: string;
  price: string;
  best_for: string;
  provider: string;
  provider_name: string;
}

export interface ImageGenerateRequest {
  prompt: string;
  image_model: string;
  ratio?: string;
  images?: string[];
  reference_image_paths?: string[];
  count?: number;
  refine_from?: string;
  add_store_info?: boolean;
  no_text?: boolean;
  conversation_id?: string;
  quality?: "low" | "medium" | "high" | "auto";
  // 生图重构（新增，可选）
  image_prompt?: string;
  poster_text?: PosterText;
  background_mode?: "ai_generate" | "store_photo";
  store_photo_path?: string;
  logo_path?: string;
  qr_path?: string;
}

export interface PosterText {
  title?: string;
  lines?: string[];
  contact?: string;
}

export interface PromptExpandRequest {
  description: string;
  poster_text?: PosterText;
  background_mode?: "ai_generate" | "store_photo";
  has_logo?: boolean;
  has_qr?: boolean;
  ratio?: string;
}

export interface PromptExpandResponse {
  image_prompt: string;
  needs: string[];
}

export interface ShowcaseExample {
  idea_text: string;
  image_url: string | null;
}

export interface GeneratedImage {
  generation_id: string;
  poster_url: string;
  created_at: string;
}

export interface ImageGenerateResponse {
  images: GeneratedImage[];
  model_used: string;
  count: number;
  conversation_id?: string;
}

export interface SizeOption {
  value: string;
  label: string;
  desc: string;
}
