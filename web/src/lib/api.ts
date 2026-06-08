import { ApiError } from "@/types/api";
import type { LoginRequest, RegisterRequest, TokenResponse, User } from "@/types/auth";
import type { StoreCreate, StoreResponse, StoreUpdate, StoreListItem, UploadResponse } from "@/types/store";
import type { GenerateActivityRequest, GenerateCopywritingRequest, GenerateOperationRequest, GenerateWorkbenchRequest, GenerateOutreachRequest, GenerateSOPRequest, GenerateGamesRequest, GeneratePerformanceRequest, GenerateDiagnosisRequest, GenerationResponse } from "@/types/generate";
import type { ImageGenerateRequest, ImageGenerateResponse, ImageModel, InspirationTag, SizeOption } from "@/types/poster";
import type {
  GenerationHistoryItem,
  GenerationHistoryListResponse,
  ListGenerationsParams,
} from "@/types/generation-history";
import type { DashboardTodayResponse } from "@/types/dashboard";

const configuredBaseUrl = process.env.NEXT_PUBLIC_API_URL;
const BASE_URL = !configuredBaseUrl
  ? ""
  : configuredBaseUrl.replace(/\/$/, "");

class ApiClient {
  private token: string | null = null;
  baseUrl: string;
  private storeId: string | null = null;
  private refreshPromise: Promise<string | null> | null = null;

  constructor() {
    this.baseUrl = BASE_URL;
    if (typeof window !== "undefined") {
      this.token = localStorage.getItem("access_token");
      this.storeId = localStorage.getItem("current_store_id");
    }
  }

  setToken(token: string | null) {
    this.token = token;
    if (token) {
      localStorage.setItem("access_token", token);
      if (typeof document !== "undefined") {
        const secure = window.location.protocol === "https:" ? "; Secure" : "";
        document.cookie = `token=${token}; path=/; SameSite=Lax${secure}`;
      }
    } else {
      localStorage.removeItem("access_token");
      if (typeof document !== "undefined") {
        document.cookie = "token=; path=/; SameSite=Lax; max-age=0";
      }
    }
  }

  getToken(): string | null {
    return this.token;
  }

  isAuthenticated(): boolean {
    return !!this.token;
  }

  getStoreId(): string | null {
    return this.storeId;
  }

  setStoreId(id: string | null) {
    this.storeId = id;
    if (id) {
      localStorage.setItem("current_store_id", id);
    } else {
      localStorage.removeItem("current_store_id");
    }
  }

  /** 刷新 access_token，带全局锁防止并发刷新 */
  async refreshAccessToken(): Promise<string | null> {
    if (this.refreshPromise) {
      return this.refreshPromise;
    }
    this.refreshPromise = this._doRefresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async _doRefresh(): Promise<string | null> {
    const currentToken = this.token;
    if (!currentToken) return null;
    try {
      const res = await fetch(`${this.baseUrl}/api/v1/auth/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ access_token: currentToken }),
      });
      if (!res.ok) return null;
      const data = await res.json();
      const newToken: string | null = data.access_token ?? null;
      if (newToken) {
        this.setToken(newToken);
      }
      return newToken;
    } catch {
      return null;
    }
  }

  /** 将相对路径（如 /uploads/...）解析为完整 API URL */
  resolveUrl(path: string): string {
    if (!path) return "";
    if (path.startsWith("http://") || path.startsWith("https://")) {
      return path;
    }
    return `${this.baseUrl}${path}`;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    isFormData?: boolean,
    _isRetry?: boolean,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (!isFormData) {
      headers["Content-Type"] = "application/json";
    }
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    if (this.storeId) {
      headers["X-Store-Id"] = this.storeId;
    }

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: isFormData ? (body as FormData) : body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, "网络连接失败，请检查网络后重试");
    }

    if (res.status === 401) {
      // 如果不是重试，尝试用全局锁刷新 token
      if (!_isRetry && this.token) {
        const newToken = await this.refreshAccessToken();
        if (newToken) {
          // 重试原请求
          return this.request<T>(method, path, body, isFormData, true);
        }
      }
      this.setToken(null);
      if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
        window.location.href = "/login";
      }
      throw new ApiError(res.status, "登录已过期，请重新登录");
    }

    if (!res.ok) {
      let detail = `请求失败 (${res.status})`;
      try {
        const errData = await res.json();
        if (errData.detail) {
          detail = typeof errData.detail === "string"
            ? errData.detail
            : JSON.stringify(errData.detail);
        }
      } catch {
        // ignore parse error
      }
      throw new ApiError(res.status, detail);
    }

    return res.json();
  }

  // ─── Auth ───

  login(phone: string, password: string) {
    return this.request<TokenResponse>("POST", "/api/v1/auth/login", {
      phone,
      password,
    } satisfies LoginRequest);
  }

  register(data: RegisterRequest) {
    return this.request<TokenResponse>("POST", "/api/v1/auth/register", data);
  }

  getMe() {
    return this.request<User>("GET", "/api/v1/auth/me");
  }

  // ─── Store ───

  createStore(data: StoreCreate) {
    return this.request<StoreResponse>("POST", "/api/v1/stores", data);
  }

  getMyStore() {
    return this.request<StoreResponse>("GET", "/api/v1/stores/me");
  }

  listStores() {
    return this.request<StoreListItem[]>("GET", "/api/v1/stores/list");
  }

  updateStore(data: StoreUpdate) {
    return this.request<StoreResponse>("PUT", "/api/v1/stores/me", data);
  }

  uploadLogo(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    return this.request<UploadResponse>("POST", "/api/v1/stores/me/logo", formData, true);
  }

  uploadQrcode(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    return this.request<UploadResponse>("POST", "/api/v1/stores/me/qrcode", formData, true);
  }

  // ─── Generate ───

  generateCopywriting(data: GenerateCopywritingRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/generate/copywriting", data);
  }

  generateActivity(data: GenerateActivityRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/generate/activity", data);
  }

  generateOperation(data: GenerateOperationRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/generate/operation", data);
  }

  generateWorkbench(data: GenerateWorkbenchRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/generate/workbench", data);
  }

  /** SSE 流式工作台生成 */
  async streamWorkbench(
    data: GenerateWorkbenchRequest,
    onToken: (token: string) => void,
    onDone: (fullContent: string, generationId: string) => void,
    onError: (error: string) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    };
    if (this.token) {
      headers["Authorization"] = `Bearer ${this.token}`;
    }
    if (this.storeId) {
      headers["X-Store-Id"] = this.storeId;
    }

    try {
      const res = await fetch(`${this.baseUrl}/api/v1/stream/workbench`, {
        method: "POST",
        headers,
        body: JSON.stringify(data),
        signal,
      });

      if (!res.ok) {
        if (res.status === 401 && this.token) {
          const newToken = await this.refreshAccessToken();
          if (newToken) {
            headers["Authorization"] = `Bearer ${newToken}`;
            const retryRes = await fetch(`${this.baseUrl}/api/v1/stream/workbench`, {
              method: "POST",
              headers,
              body: JSON.stringify(data),
            });
            if (!retryRes.ok) {
              if (retryRes.status === 401) {
                this.setToken(null);
                if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
                  window.location.href = "/login";
                }
              }
              onError(`请求失败 (${retryRes.status})`);
              return;
            }
            return this._consumeSSEStream(retryRes, onToken, onDone, onError);
          }
        }
        if (res.status === 401) {
          this.setToken(null);
          if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
            window.location.href = "/login";
          }
        }
        onError(`请求失败 (${res.status})`);
        return;
      }

      return this._consumeSSEStream(res, onToken, onDone, onError);
    } catch {
      onError("网络异常，请检查后重试");
    }
  }

  private async _consumeSSEStream(
    res: Response,
    onToken: (token: string) => void,
    onDone: (fullContent: string, generationId: string) => void,
    onError: (error: string) => void,
  ): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) {
      onError("无法读取流式响应");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const jsonStr = line.slice(6);
        try {
          const parsed = JSON.parse(jsonStr);
          if (parsed.error) {
            onError(parsed.error);
            return;
          }
          if (parsed.token) {
            onToken(parsed.token);
          }
          if (parsed.done && parsed.full_content) {
            onDone(parsed.full_content, parsed.generation_id || "");
            return;
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }
  }

  generateImage(data: ImageGenerateRequest) {
    return this.request<ImageGenerateResponse>("POST", "/api/v1/posters/generate", data);
  }

  uploadReferenceImage(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    return this.request<{ path: string; url: string }>("POST", "/api/v1/posters/reference", formData, true);
  }

  listImageModels() {
    return this.request<{ models: ImageModel[] }>("GET", "/api/v1/posters/image-models");
  }

  listInspirationTags() {
    return this.request<{ tags: InspirationTag[] }>("GET", "/api/v1/posters/inspiration-tags");
  }

  listSizeOptions() {
    return this.request<{ sizes: SizeOption[] }>("GET", "/api/v1/posters/size-options");
  }

  listPosterConversations() {
    return this.request<{ conversations: Array<{ id: string; title: string; message_count: number; thumbnail_url: string | null; created_at: string; updated_at: string }> }>("GET", "/api/v1/posters/conversations");
  }

  getPosterConversationDetail(conversationId: string) {
    return this.request<{ id: string; title: string; created_at: string; updated_at: string; messages: Array<{ generation_id: string; poster_url: string; created_at: string; prompt: string; openai_response_id: string | null }> }>("GET", `/api/v1/posters/conversations/${conversationId}`);
  }

  // ─── Generations ───

  async listGenerations(params?: ListGenerationsParams): Promise<GenerationHistoryListResponse> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.page_size) searchParams.set("page_size", String(params.page_size));
    if (params?.type) searchParams.set("type", params.type);
    if (params?.sub_type) searchParams.set("sub_type", params.sub_type);
    if (params?.is_favorite !== undefined) searchParams.set("is_favorite", String(params.is_favorite));
    const qs = searchParams.toString();
    return this.request<GenerationHistoryListResponse>("GET", `/api/v1/generations${qs ? `?${qs}` : ""}`);
  }

  async getGenerationDetail(id: string): Promise<GenerationHistoryItem> {
    return this.request<GenerationHistoryItem>("GET", `/api/v1/generations/${id}`);
  }

  async toggleFavorite(id: string): Promise<{ is_favorite: boolean }> {
    return this.request<{ is_favorite: boolean }>("PATCH", `/api/v1/generations/${id}/favorite`);
  }

  // ─── Dashboard ───

  getTodayDashboard() {
    return this.request<DashboardTodayResponse>("GET", "/api/v1/dashboard/today");
  }

  // ─── New Operation APIs ───

  outreachGenerate(data: GenerateOutreachRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/outreach/generate", data);
  }

  sopQuery(data: GenerateSOPRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/sop/query", data);
  }

  gamesRecommend(data: GenerateGamesRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/games/recommend", data);
  }

  performanceTemplate(data: GeneratePerformanceRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/performance/template", data);
  }

  diagnosisAnalyze(data: GenerateDiagnosisRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/diagnosis/analyze", data);
  }

  // ─── Knowledge ───

  listKnowledge() {
    return this.request<{ items: { key: string; name: string }[]; total: number }>("GET", "/api/v1/knowledge/list");
  }

  // ─── Quota ───

  getQuota() {
    return this.request<{
      monthly_generation_limit: number;
      monthly_generations_used: number;
      monthly_tokens_limit: number;
      monthly_tokens_used: number;
      remaining: number;
    }>("GET", "/api/v1/quota");
  }

  // ─── Members ───

  createInvitation(data: { role: string; max_uses?: number; expires_in_hours?: number }) {
    return this.request<{
      id: string; code: string; role: string; is_active: boolean;
      max_uses: number | null; use_count: number; expires_at: string | null; created_at: string;
    }>("POST", "/api/v1/members/invitations", data);
  }

  listInvitations() {
    return this.request<Array<{
      id: string; code: string; role: string; is_active: boolean;
      max_uses: number | null; use_count: number; expires_at: string | null; created_at: string;
    }>>("GET", "/api/v1/members/invitations");
  }

  toggleInvitation(id: string) {
    return this.request<{ is_active: boolean }>("PATCH", `/api/v1/members/invitations/${id}`);
  }

  deleteInvitation(id: string) {
    return this.request<{ detail: string }>("DELETE", `/api/v1/members/invitations/${id}`);
  }

  joinStore(inviteCode: string) {
    return this.request<{ detail: string; store_id: string; role: string }>("POST", "/api/v1/members/join", { invite_code: inviteCode });
  }

  listMembers() {
    return this.request<Array<{
      user_id: string; name: string | null; phone: string; role: string; joined_at: string;
    }>>("GET", "/api/v1/members/list");
  }

  changeMemberRole(userId: string, role: string) {
    return this.request<{ detail: string; role: string }>("PATCH", `/api/v1/members/${userId}/role`, { role });
  }

  removeMember(userId: string) {
    return this.request<{ detail: string }>("DELETE", `/api/v1/members/${userId}`);
  }

  addMemberByPhone(phone: string, role: string) {
    return this.request<{ detail: string; user_id: string; role: string }>("POST", "/api/v1/members/add", { phone, role });
  }

  // ─── Models ───

  listTextModels() {
    return this.request<{
      models: Array<{
        id: string;
        name: string;
        provider: string;
        provider_name: string;
        description: string;
        best_for: string;
        is_default: boolean;
      }>;
    }>("GET", "/api/v1/models/text-models");
  }
}

export const api = new ApiClient();
