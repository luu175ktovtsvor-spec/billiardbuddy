export interface RegisterRequest {
  phone: string;
  password: string;
  name?: string;
}

export interface LoginRequest {
  phone: string;
  password: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
}

export interface User {
  id: string;
  phone: string;
  name: string | null;
  is_admin?: boolean;
  created_at: string;
}
