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
  add_overlay?: boolean;
  add_logo_overlay?: boolean;
  add_qrcode_overlay?: boolean;
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
}

export interface InspirationTag {
  key: string;
  label: string;
  prompt: string;
}

export interface SizeOption {
  value: string;
  label: string;
  desc: string;
}