import { ApiError } from "@/types/api";
import type { OrchestrationTask, RepurposeResponse } from "@/types/api";
import type { LoginRequest, RegisterRequest, TokenResponse, User } from "@/types/auth";
import type { StoreCreate, StoreResponse, StoreUpdate, StoreListItem, UploadResponse, StoreMemoryItem, ByokConfigOut, ByokConfigIn, ByokValidateResult, ByokProfile } from "@/types/store";
import type { GenerateActivityRequest, GenerateOperationRequest, GenerateWorkbenchRequest, GenerateOutreachRequest, GenerateSOPRequest, GenerateGamesRequest, GeneratePerformanceRequest, GenerateDiagnosisRequest, GenerationResponse } from "@/types/generate";
import type { ImageGenerateRequest, ImageGenerateResponse, SizeOption, PromptExpandRequest, PromptExpandResponse } from "@/types/poster";
import type {
  GenerationHistoryListResponse,
  GenerationHistoryItem,
  ListGenerationsParams,
} from "@/types/generation-history";
import type { DashboardTodayResponse, CardSignals } from "@/types/dashboard";
import type { ReportSchema, ReportListItem, ReportSubmitResponse, ReportData } from "@/types/report";

const configuredBaseUrl = process.env.NEXT_PUBLIC_API_URL;
const BASE_URL = !configuredBaseUrl
  ? ""
  : configuredBaseUrl.replace(/\/$/, "");

/** Agent 流式对话事件回调（对应后端 /agent/chat 的 SSE 事件：token/tool_call/tool_result/final/done/error）。 */
export interface AgentStreamHandlers {
  onToken?: (token: string) => void;
  onToolCall?: (tool: string, args: Record<string, unknown>, id?: string) => void;
  onToolResult?: (tool: string, content: string, id?: string) => void;
  onApprovalRequest?: (tool: string, args: Record<string, unknown>, id?: string, token?: string, preview?: string) => void;
  onAskQuestion?: (q: { question: string; options: { label: string; description?: string }[]; multi?: boolean; id?: string }) => void;
  onFinal?: (content: string) => void;
  onDone?: (info: { turns: number; stopped_reason: string; conversation_id?: string; generation_id?: string }) => void;
  onError?: (error: string) => void;
}

export interface AgentChatPayload {
  message: string;
  history?: unknown[];
  model?: string;
  conversation_id?: string | null;
  selected_files?: string[]; // 桌面版：老板选定、授权 Agent 读/改的文件绝对路径
  permission_mode?: "ask" | "auto_files" | "full"; // 权限：每次问/自动改文件/全自动
  full_disk_access?: boolean; // 高级·全盘：文件工具不限内容库+选定文件
}

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
        // max-age 与 7 天 JWT 同寿命(604800s)。否则是会话级 cookie：微信 WebView 回收进程后
        // cookie 即丢，而 middleware 只认这个 cookie → 已登录用户被误踢回登录页(微信第一天高频)。
        document.cookie = `token=${token}; path=/; max-age=604800; SameSite=Lax${secure}`;
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
    signal?: AbortSignal,
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
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
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

  changePassword(oldPassword: string, newPassword: string) {
    return this.request<{ status: string }>("PUT", "/api/v1/auth/password", {
      old_password: oldPassword,
      new_password: newPassword,
    });
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

  // BYOK：门店自带大模型 Key（仅 owner，后端 owner_id 校验）
  getByokConfig() {
    return this.request<ByokConfigOut>("GET", "/api/v1/stores/me/byok");
  }
  updateByokConfig(data: ByokConfigIn) {
    return this.request<ByokConfigOut>("PUT", "/api/v1/stores/me/byok", data);
  }
  validateByokConfig(data: ByokConfigIn) {
    return this.request<ByokValidateResult>("POST", "/api/v1/stores/me/byok/validate", data);
  }

  // 多供应商配置档（CC Switch 式：存好几套、一键切换）
  listByokProfiles() {
    return this.request<{ profiles: ByokProfile[] }>("GET", "/api/v1/stores/me/byok/profiles");
  }
  saveByokProfile(data: { name: string; base_url?: string | null; api_key?: string | null; model?: string | null }) {
    return this.request<{ profiles: ByokProfile[] }>("POST", "/api/v1/stores/me/byok/profiles", data);
  }
  activateByokProfile(name: string) {
    return this.request<{ active: string; profiles: ByokProfile[] }>(
      "POST", `/api/v1/stores/me/byok/profiles/${encodeURIComponent(name)}/activate`, {});
  }
  deleteByokProfile(name: string) {
    return this.request<{ profiles: ByokProfile[] }>(
      "DELETE", `/api/v1/stores/me/byok/profiles/${encodeURIComponent(name)}`);
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

  generateActivity(data: GenerateActivityRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/generate/activity", data);
  }

  generateOperation(data: GenerateOperationRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/generate/operation", data);
  }

  generateWorkbench(data: GenerateWorkbenchRequest) {
    return this.request<GenerationResponse>("POST", "/api/v1/generate/workbench", data);
  }

  /** 内容变体：把生成结果转换为指定平台格式 */
  repurposeContent(generationId: string, targetPlatform: string) {
    return this.request<RepurposeResponse>("POST", "/api/v1/generate/repurpose", {
      generation_id: generationId,
      target_platform: targetPlatform,
    });
  }

  /** 画布定向改写：圈了段(selection)只改那段、不动别处；不传则整篇修订。 */
  canvasEdit(content: string, instruction: string, selection?: string, deliverableType?: string) {
    return this.request<{ content: string; mode: string; changed_span?: string }>("POST", "/api/v1/canvas/edit", {
      content,
      instruction,
      selection: selection ?? null,
      deliverable_type: deliverableType ?? null,
    });
  }

  /** 看本机报表为表格（桌面专属） */
  readSheet(path: string) {
    return this.request<{ name: string; sheets: { name: string; rows: string[][] }[]; truncated: boolean }>(
      "POST",
      "/api/v1/canvas/sheet",
      { path },
    );
  }

  /** 点格改：改本机报表一个单元格（桌面专属，自动备份） */
  excelEditCell(path: string, cell: string, value: string, sheet?: string) {
    return this.request<{ ok: boolean; sheet: string; cell: string; old: string; new: string }>(
      "POST",
      "/api/v1/canvas/excel-edit",
      { path, cell, value, sheet: sheet ?? null },
    );
  }

  // ─── Orchestrate（多 Agent 协作） ───

  startOrchestration(data: { task_type: string; description: string; auto_orchestrate?: boolean }) {
    return this.request<OrchestrationTask>("POST", "/api/v1/orchestrate", data);
  }

  getOrchestration(taskId: string) {
    return this.request<OrchestrationTask>("GET", `/api/v1/orchestrate/${taskId}`);
  }

  /** SSE 流式工作台生成 */
  async streamWorkbench(
    data: GenerateWorkbenchRequest,
    onToken: (token: string) => void,
    onDone: (fullContent: string, generationId: string, conversationId?: string) => void,
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
              onError(await this.friendlyStreamError(retryRes));
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
        onError(await this.friendlyStreamError(res));
        return;
      }

      return this._consumeSSEStream(res, onToken, onDone, onError);
    } catch {
      onError("网络异常，请检查后重试");
    }
  }

  /** SSE 建流失败时给用户可读文案。429 必须透传后端的提额引导
   * (后端文案带具体上限和"联系服务商",别降级成裸状态码劝退用户)。 */
  private async friendlyStreamError(res: Response): Promise<string> {
    let detail = "";
    try {
      const body = await res.json();
      if (typeof body?.detail === "string") detail = body.detail;
    } catch {
      // 非 JSON 响应,走默认文案
    }
    if (res.status === 429) {
      return detail || "本月生成次数已达上限。如需提升额度，请联系您的服务商";
    }
    if (res.status >= 400 && res.status < 500 && detail) return detail;
    return `生成失败，请稍后重试 (${res.status})`;
  }

  private async _consumeSSEStream(
    res: Response,
    onToken: (token: string) => void,
    onDone: (fullContent: string, generationId: string, conversationId?: string) => void,
    onError: (error: string) => void,
  ): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) {
      onError("无法读取流式响应");
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";

    try {
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
              fullContent += parsed.token;
              onToken(parsed.token);
            }
            if (parsed.done && parsed.full_content) {
              onDone(parsed.full_content, parsed.generation_id || "", parsed.conversation_id);
              return;
            }
          } catch {
            // Skip malformed JSON
          }
        }
      }
      // 流结束但没有收到 done 信号
      if (fullContent) {
        onDone(fullContent, "", "");
      }
    } catch (err) {
      // 网络断开时的友好提示
      if (err instanceof DOMException && err.name === "AbortError") {
        // 用户主动取消，不报错
        return;
      }
      onError("连接中断，请检查网络后重试");
    }
  }

  /** Agent 流式对话：POST /agent/chat，按事件类型回调（token/tool_call/tool_result/final/done/error）。 */
  async streamAgent(
    data: AgentChatPayload,
    handlers: AgentStreamHandlers,
    signal?: AbortSignal,
  ): Promise<void> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "text/event-stream",
    };
    if (this.token) headers["Authorization"] = `Bearer ${this.token}`;
    if (this.storeId) headers["X-Store-Id"] = this.storeId;

    const url = `${this.baseUrl}/api/v1/agent/chat`;
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(data), signal });
      if (!res.ok) {
        if (res.status === 401 && this.token) {
          const newToken = await this.refreshAccessToken();
          if (newToken) {
            headers["Authorization"] = `Bearer ${newToken}`;
            const retryRes = await fetch(url, { method: "POST", headers, body: JSON.stringify(data), signal });
            if (!retryRes.ok) {
              if (retryRes.status === 401) {
                this.setToken(null);
                if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
                  window.location.href = "/login";
                }
              }
              handlers.onError?.(await this.friendlyStreamError(retryRes));
              return;
            }
            return this._consumeAgentSSEStream(retryRes, handlers);
          }
        }
        if (res.status === 401) {
          this.setToken(null);
          if (typeof window !== "undefined" && !window.location.pathname.startsWith("/login")) {
            window.location.href = "/login";
          }
        }
        handlers.onError?.(await this.friendlyStreamError(res));
        return;
      }
      return this._consumeAgentSSEStream(res, handlers);
    } catch {
      handlers.onError?.("网络异常，请检查后重试");
    }
  }

  private async _consumeAgentSSEStream(res: Response, handlers: AgentStreamHandlers): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) {
      handlers.onError?.("无法读取流式响应");
      return;
    }
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            switch (ev.type) {
              case "token": handlers.onToken?.(ev.content || ""); break;
              case "tool_call": handlers.onToolCall?.(ev.tool, ev.args || {}, ev.id); break;
              case "tool_result": handlers.onToolResult?.(ev.tool, ev.content || "", ev.id); break;
              case "approval_request": handlers.onApprovalRequest?.(ev.tool, ev.args || {}, ev.id, ev.token, ev.preview); break;
              case "ask_question": handlers.onAskQuestion?.({ question: ev.question || "", options: ev.options || [], multi: ev.multi, id: ev.id }); break;
              case "final": handlers.onFinal?.(ev.content || ""); break;
              case "done": handlers.onDone?.({ turns: ev.turns, stopped_reason: ev.stopped_reason, conversation_id: ev.conversation_id, generation_id: ev.generation_id }); return;
              case "error": handlers.onError?.(ev.error || "生成出错，请重试"); return;
            }
          } catch {
            // 跳过非法 JSON 行
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      handlers.onError?.("连接中断，请检查网络后重试");
    }
  }

  /** 确认执行一个需审批的 Agent 工具（如生图、改本地文件）。⚠️ 生图慢，可能要几分钟，靠 request 的长超时承接。
   * selectedFiles：桌面版改本地选定文件时透传，授权 execute 端可动这些文件（与 chat 一致）。 */
  /** 主动出击：据今日推荐预生成几条文字草稿给老板过目（老板主动点触发，只产草稿不自动发）。 */
  async dailyDrafts(): Promise<{
    drafts: { title: string; category: string; prompt_key: string | null; content: string }[];
  }> {
    return this.request("POST", "/api/v1/agent/daily-drafts", {});
  }

  async executeAgentTool(
    tool: string,
    args: Record<string, unknown>,
    selectedFiles?: string[],
    fullDiskAccess?: boolean,
    token?: string,
    conversationId?: string | null,
  ): Promise<{
    tool: string;
    result: string;
    continuation?: string;  // 审批回灌：执行后管家基于结果的自然接话
    approval?: { tool: string; args: Record<string, unknown>; token?: string; preview?: string } | null;
  }> {
    return this.request("POST", "/api/v1/agent/execute", {
      tool,
      args,
      selected_files: selectedFiles,
      full_disk_access: fullDiskAccess,
      token,
      conversation_id: conversationId,
    });
  }

  generateImage(data: ImageGenerateRequest, signal?: AbortSignal) {
    return this.request<ImageGenerateResponse>("POST", "/api/v1/posters/generate", data, false, false, signal);
  }

  uploadReferenceImage(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    return this.request<{ path: string; url: string }>("POST", "/api/v1/posters/reference", formData, true);
  }

  listSizeOptions() {
    return this.request<{ sizes: SizeOption[] }>("GET", "/api/v1/posters/size-options");
  }

  expandPosterPrompt(data: PromptExpandRequest, signal?: AbortSignal) {
    return this.request<PromptExpandResponse>("POST", "/api/v1/posters/expand", data, false, false, signal);
  }

  listPosterConversations() {
    return this.request<{ conversations: Array<{ id: string; title: string; message_count: number; thumbnail_url: string | null; created_at: string; updated_at: string }> }>("GET", "/api/v1/posters/conversations");
  }

  getPosterConversationDetail(conversationId: string) {
    return this.request<{ id: string; title: string; created_at: string; updated_at: string; messages: Array<{ generation_id: string; poster_url: string; created_at: string; prompt: string; reference_images: string[]; refine_from: string | null; ratio: string | null }> }>("GET", `/api/v1/posters/conversations/${conversationId}`);
  }

  // ─── Generations ───

  async listGenerations(params?: ListGenerationsParams): Promise<GenerationHistoryListResponse> {
    const searchParams = new URLSearchParams();
    if (params?.page) searchParams.set("page", String(params.page));
    if (params?.page_size) searchParams.set("page_size", String(params.page_size));
    if (params?.type) searchParams.set("type", params.type);
    if (params?.sub_type) searchParams.set("sub_type", params.sub_type);
    if (params?.is_favorite !== undefined) searchParams.set("is_favorite", String(params.is_favorite));
    if (params?.effect_rating) searchParams.set("effect_rating", params.effect_rating);
    if (params?.search) searchParams.set("search", params.search);
    const qs = searchParams.toString();
    return this.request<GenerationHistoryListResponse>("GET", `/api/v1/generations${qs ? `?${qs}` : ""}`);
  }

  async getGeneration(id: string): Promise<GenerationHistoryItem> {
    return this.request<GenerationHistoryItem>("GET", `/api/v1/generations/${id}`);
  }

  /** 前端错误上报(fire-and-forget,失败静默) */
  async reportClientError(payload: { message: string; stack?: string; url?: string }): Promise<void> {
    await this.request("POST", "/api/v1/logs/client", payload);
  }

  async toggleFavorite(id: string): Promise<{ is_favorite: boolean }> {
    return this.request<{ is_favorite: boolean }>("PATCH", `/api/v1/generations/${id}/favorite`);
  }

  /** 保存用户手动编辑后的内容（历史里存实际发出去的版本） */
  async updateGenerationContent(id: string, content: string): Promise<void> {
    await this.request<{ status: string }>("PATCH", `/api/v1/generations/${id}/content`, { content });
  }

  // ── 店脑：门店 AI 记忆（「AI 眼里的你的店」页）──
  async getStoreMemory(): Promise<StoreMemoryItem[]> {
    return this.request<StoreMemoryItem[]>("GET", "/api/v1/store-memory");
  }
  async addStoreMemory(content: string, type = "semantic"): Promise<StoreMemoryItem> {
    return this.request<StoreMemoryItem>("POST", "/api/v1/store-memory", { content, type });
  }
  async updateStoreMemory(id: string, content: string): Promise<StoreMemoryItem> {
    return this.request<StoreMemoryItem>("PATCH", `/api/v1/store-memory/${id}`, { content });
  }
  async deleteStoreMemory(id: string): Promise<void> {
    await this.request("DELETE", `/api/v1/store-memory/${id}`);
  }

  /** 给生成记录命名(海报找图友好) */
  async updateGenerationTitle(id: string, title: string): Promise<{ title: string | null }> {
    return this.request<{ status: string; title: string | null }>(
      "PATCH",
      `/api/v1/generations/${id}/title`,
      { title }
    );
  }

  async submitFeedback(generationId: string, rating: "good" | "bad", note?: string): Promise<void> {
    await this.request("POST", `/api/v1/feedback/generations/${generationId}/feedback`, { rating, note });
  }

  async deleteGeneration(id: string): Promise<void> {
    await this.request("DELETE", `/api/v1/generations/${id}`);
  }

  async exportGenerations(type?: string): Promise<Blob> {
    const typeParam = type ? `?type=${type}` : "";
    const headers: Record<string, string> = {};
    const token = this.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (this.storeId) headers["X-Store-Id"] = this.storeId; // 多门店用户导出当前门店而非默认门店
    const res = await fetch(`${this.baseUrl}/api/v1/generations/export${typeParam}`, { headers });
    if (!res.ok) throw new Error("导出失败");
    return res.blob();
  }

  async deletePosterConversation(conversationId: string): Promise<void> {
    await this.request("DELETE", `/api/v1/generations/conversations/${conversationId}`);
  }

  // ─── 报表 / 日报 ───
  async getReportSchema(reportType: string): Promise<ReportSchema> {
    return this.request<ReportSchema>("GET", `/api/v1/reports/schema/${reportType}`);
  }
  async listReports(): Promise<ReportListItem[]> {
    return this.request<ReportListItem[]>("GET", "/api/v1/reports");
  }
  async submitReport(reportType: string, data: ReportData, note: string): Promise<ReportSubmitResponse> {
    return this.request<ReportSubmitResponse>("POST", `/api/v1/reports/${reportType}`, { data, note });
  }
  /** 「说一句话」→ AI 抽取字段，前端拿去预填表单 */
  async extractReport(reportType: string, text: string): Promise<{ data: ReportData }> {
    return this.request<{ data: ReportData }>("POST", `/api/v1/reports/${reportType}/extract`, { text });
  }
  /** 今天哪些日报已交（老板/团队看交付状态） */
  async getReportTodayStatus(): Promise<{ date: string; submitted: string[] }> {
    return this.request<{ date: string; submitted: string[] }>("GET", "/api/v1/reports/today-status");
  }
  /** 导出 Excel：手写 fetch + 手动补 X-Store-Id（不能走 request，它 res.json()） */
  async exportReport(reportId: string): Promise<Blob> {
    const headers: Record<string, string> = {};
    const token = this.getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    if (this.storeId) headers["X-Store-Id"] = this.storeId; // 多门店导当前门店
    const res = await fetch(`${this.baseUrl}/api/v1/reports/${reportId}/export`, { headers });
    if (!res.ok) throw new Error("导出失败");
    return res.blob();
  }

  // ─── Dashboard ───

  getTodayDashboard() {
    return this.request<DashboardTodayResponse>("GET", "/api/v1/dashboard/today");
  }

  getCardSignals() {
    return this.request<CardSignals>("GET", "/api/v1/dashboard/card-signals");
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
      monthly_poster_limit: number;
      monthly_posters_used: number;
      posters_remaining: number;
      plan_name: string | null;
    }>("GET", "/api/v1/quota");
  }

  /** BYOK 本月用量与粗估花费 */
  getCost() {
    return this.request<{
      month: string;
      total_tokens: number;
      total_count: number;
      est_cost_yuan: number;
      rate_per_m_tokens: number;
      by_feature: Array<{ feature: string; tokens: number; count: number }>;
    }>("GET", "/api/v1/quota/cost");
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

}

export const api = new ApiClient();
