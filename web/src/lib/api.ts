import { ApiError } from "@/types/api";
import type { User } from "@/types/auth";
import type { StoreCreate, StoreResponse, StoreUpdate, UploadResponse, StoreMemoryItem, ByokConfigOut, ByokConfigIn, ByokValidateResult, ByokProfile } from "@/types/store";
import type { DashboardTodayResponse } from "@/types/dashboard";

const configuredBaseUrl = process.env.NEXT_PUBLIC_API_URL;
const BASE_URL = !configuredBaseUrl
  ? ""
  : configuredBaseUrl.replace(/\/$/, "");

/** SH-8 结构化审批理由：审批卡用它列清【要做什么 / 为什么要你确认 / 影响】。三件套都是字符串，后端兜底保证有话可说。 */
export interface ApprovalReason {
  what: string;
  why: string;
  impact: string;
}

export interface AskQuestionOption {
  label: string;
  description?: string;
  preview?: string;
}

export interface AskQuestionField {
  name: string;
  label: string;
  type?: "text" | "textarea" | "number" | "boolean" | "select" | "multiselect";
  required?: boolean;
  description?: string;
  defaultValue?: string | number | boolean | string[];
  options?: string[];
  placeholder?: string;
}

export interface AskQuestionPayload {
  question: string;
  options: AskQuestionOption[];
  multi?: boolean;
  id?: string;
  allowFreeform?: boolean;
  placeholder?: string;
  fields?: AskQuestionField[];
  url?: string;
}

export interface AgentUsagePayload {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  last_input_tokens: number;
  last_output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  context_window?: number;
  context_percent?: number;
}

/** Agent 流式对话事件回调（对应后端 /agent/chat 的 SSE 事件：token/tool_call/tool_result/final/done/error）。 */
export interface AgentStreamHandlers {
  onToken?: (token: string) => void;
  // F.1 思考过程：模型 reasoning_content 流式片段（灰斜体思考块展示，不是正文）。
  onReasoning?: (chunk: string) => void;
  onToolCall?: (tool: string, args: Record<string, unknown>, id?: string) => void;
  // imageGenerationIds：E1-C2・生图工具(make_poster/generate_image)这批图真实的 Generation.id
  // （做成视频 openWorkbench({fromGen}) handoff 要用；本轮对话自己的 agent-chat generation_id 不是这个）。
  onToolResult?: (tool: string, content: string, id?: string, knowledgeUsed?: string[], imageGenerationIds?: string[]) => void;
  // 命令边跑边显示：工具执行中实时推来的输出片段（chunk），按 id 累进对应步骤的终端块。
  onToolProgress?: (tool: string, id: string | undefined, chunk: string, stream?: string) => void;
  // SH-8：reason = 结构化审批理由 {what 要做什么 / why 为什么要你确认 / impact 影响}，让审批卡说清楚再让老板点头。
  onApprovalRequest?: (tool: string, args: Record<string, unknown>, id?: string, token?: string, preview?: string, reason?: ApprovalReason, rememberable?: boolean) => void;
  onAskQuestion?: (q: AskQuestionPayload) => void;
  // 方向盘：跑动中捎的话已注入下一轮（content=插话原文）。本窗口发的已乐观上屏、据此去重；刷新重放据此把插话补回对话流。
  onSteering?: (content: string) => void;
  // F9：AI 自动把前文归纳了一次（autocompact 真发生），大白话告诉老板一句（不带机制细节）；
  // 只在临近窗口时发一次，不刷屏。前端渲成低调的灰色内联提示，不是错误/toast。
  onContextNote?: (content: string) => void;
  // F4 Focus Chain：AI 顺手更新了任务进度清单（task_progress 参数 / todo_write 工具，两条路径
  // 后端已归并成同一个事件），content 是渲染好的展示文本（"任务清单（共 N 步，已完成 M 步）：..."）。
  // 每次都是【最新完整状态】，不是增量——前端应原地覆盖同一张清单卡，不要每次都新开一张。
  onTodoUpdate?: (content: string) => void;
  onUsageUpdate?: (usage: AgentUsagePayload) => void;
  onFinal?: (content: string) => void;
  onDone?: (info: { turns: number; stopped_reason: string; conversation_id?: string; generation_id?: string; task_id?: string; offset?: number; memory_refs?: string[] }) => void;
  onError?: (error: string) => void;
  // F1c 断线重连：连接本身断了（网络抖动/连接中途被掐断，含发起阶段就没连上），跟 onError（应用层/后端主动
  // 吐的 error 事件，语义上属于"正常收到了结果只是结果是失败"）区分开——onDone 恒在 onError 之后收尾，
  // 但断线时既不会有 onError 也不会有 onDone。调用方据此判断"要不要自动重连"，别跟 onError 的报错文案混在一起。
  // 不传时退回旧行为（走 onError，兼容还没接手这个信号的调用方）。
  onDisconnect?: () => void;
  onEvent?: (event: Record<string, unknown>) => void;
}

export interface RecentArtifact {
  id: string;
  kind: "poster" | "video" | "content" | "task" | "memory" | "file_change";
  type: string;
  title: string;
  subtitle: string;
  url?: string | null;
  content?: string | null;
  conversation_id?: string | null;
  created_at?: string | null;
  ratio?: string | null;
  duration?: number | null;
  width?: number | null;
  height?: number | null;
  path?: string | null;
  backup_path?: string | null;
}

// 阶段1 生成工作室异步任务进度(轮询返回)
export interface MediaJobStatus {
  id: string;
  kind: string;
  status: "queued" | "running" | "done" | "error";
  progress: number;          // 0-100
  stage: string | null;      // 大白话阶段文案
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface BackgroundTaskItem {
  id: string;
  agentId?: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  kind?: string;
  conversationId?: string;
  workspaceRoot?: string;
  progress?: number;
  stage?: string;
  result?: unknown;
  error?: string;
}

export interface BackgroundTaskDetailResponse {
  task: BackgroundTaskItem;
  events?: { seq: number; ts: string; event: Record<string, unknown> }[];
  agentId?: string;
  requestedTaskId?: string;
  resolvedTaskId?: string;
}

export interface WorkspaceGitStatus {
  isGit: boolean;
  branch: string | null;
  dirty: boolean;
  changed: number;
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
}

export interface WorkspaceProjectInstructionSummary {
  files: Array<{ file: string; truncated: boolean }>;
  count: number;
  truncated: boolean;
}

export interface WorkspaceTreeEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  children?: WorkspaceTreeEntry[];
  truncated?: boolean;
}

export interface WorkspaceTreeSummary {
  root: string;
  entries: WorkspaceTreeEntry[];
  total: number;
  truncated: boolean;
  error?: string;
}

export interface ModelRuntimeSummary {
  apiFormat: "anthropic" | "openai_chat" | string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  hasAuthToken: boolean;
  reasoningEffort?: string;
  networkProxyMode?: string;
}

export interface ModelProviderItem {
  id: string;
  name: string;
  enabled: boolean;
  apiFormat: "anthropic" | "openai_chat" | string;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  hasAuthToken: boolean;
  createdAt?: string;
  updatedAt?: string;
}

export interface ModelStatusResponse {
  ok: boolean;
  activeId: string | null;
  providers?: ModelProviderItem[];
  fallbackCount: number;
  coolingCount?: number;
  health?: Array<{
    source: "saved-provider" | "env" | string;
    providerId?: string;
    providerName?: string;
    label: string;
    model: string;
    state: "ready" | "cooling" | string;
    failureCount: number;
    cooldownMsRemaining: number;
    lastError?: string;
    failureCategory?: "configuration" | "rate_limit" | "transient" | string;
  }>;
  healthHistory?: Array<{
    kind: "failure" | "success" | "clear" | string;
    key: string;
    label: string;
    ts: string;
    failureCount?: number;
    failureCategory?: "configuration" | "rate_limit" | "transient" | string;
    error?: string;
  }>;
  runtime: {
    source: "saved-provider" | "env" | string;
    providerId?: string;
    providerName?: string;
    summary: ModelRuntimeSummary;
  } | null;
}

// AI 剪辑台：inventory 返回的候选片段(前端渲染选段卡片)
export interface VideoCandidate {
  media: string;
  name: string;
  duration: number;
  is_portrait: boolean;
  has_speech: boolean;
  scenes: [number, number][];
  phrases: { start: number; end: number; text: string }[];
}

// AI 剪辑台：时间轴文档的前端视图(分段卡片 + 字幕 + 概况)
export interface VideoDocView {
  width: number;
  height: number;
  fps: number;
  duration: number;
  media: Record<string, { src: string; duration: number; has_audio?: boolean }>;
  clips: { id: string; media: string | null; src_in: number; src_out: number; order: number }[];
  captions: { id: string; text: string | null; start: number | null; end: number | null; style: string | null }[];
  music: string | null;
  grade: string | null;
}

export interface AgentChatPayload {
  message: string;
  display_text?: string; // C2 历史回放半：快捷按钮等场景的短标签，纯显示旁路，落库供历史会话回放时仍显示短版
  history?: unknown[];
  model?: string;
  conversation_id?: string | null;
  selected_files?: string[]; // 桌面版：老板选定、授权 Agent 读/改的文件绝对路径
  permission_mode?: "ask" | "auto_files" | "full" | "plan"; // 权限：每次问/自动改文件/全自动/计划
  full_disk_access?: boolean; // 高级·全盘：文件工具不限内容库+选定文件
  knowledge_packs?: string[]; // 专家挂载（如 ["billiards"]）；含 billiards → 台球运营专家，否则通用 Agent
  output_style?: string; // 输出风格名（explanatory/concise…），空=默认
  goal?: string; // /goal 目标驱动：本次会话目标条件
  deep_thinking?: boolean; // F.2 深度思考：true=开/false=关/省略=跟随模型默认（mimo 默认开）
  source_rec_id?: string; // 隐式反馈：本次对话由今日推荐哪一条触发（rec.id）→ 后端落到 generation 做"采纳上浮"
  working_dir?: string; // 本会话工作目录:相对路径默认落它 + 自动接受编辑范围
}

// F1b 通知中心：GET /api/v1/notifications?after= 返回的单条通知
export interface NotificationItem {
  id: number;
  title: string;
  body: string;
  kind: string;
  meta: Record<string, unknown>;
}

export interface AgentTaskStartResponse {
  task_id: string;
  status: "running" | "done" | "error" | "cancelled" | string;
}

// D-Task-4：定时任务(到点自动跑一条 AI 任务，无人值守只出成品)。
// schedule_spec 约定：daily→{hour,minute}；weekly→{weekday(0=周一…6=周日),hour,minute}；interval→{minutes}。
export type ScheduleKind = "daily" | "weekly" | "interval";

export interface ScheduledTaskItem {
  id: string;
  name: string;
  instruction: string;
  billiards_mode: boolean;
  schedule_kind: ScheduleKind;
  schedule_spec: Record<string, number>;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: "success" | "error" | null;
  last_result_summary: string | null;
  enabled: boolean;
}

export interface ScheduledTaskCreatePayload {
  name: string;
  instruction: string;
  schedule_kind: ScheduleKind;
  schedule_spec: Record<string, number>;
  billiards_mode?: boolean;
}

export interface ScheduledTaskUpdatePayload {
  name?: string;
  instruction?: string;
  schedule_kind?: ScheduleKind;
  schedule_spec?: Record<string, number>;
  billiards_mode?: boolean;
  enabled?: boolean;
}

// D-Task-6：店铺资料库(老板自己店里的合同/价目表/排班表/进货单，选个文件夹后台自动本地索引，
// 对话里 AI 用 search_store_docs 工具检索、带出处回答)。跟"台球运营专家"(懂行业打法)分开——
// 这个是"懂你家"。字段跟后端 server/api/v1/store_docs.py 的 StoreDocLibraryItem 严格一致。
export interface StoreDocLibraryItem {
  folder_path: string | null;
  status: "idle" | "indexing" | "ready" | "error";
  indexed_file_count: number;
  indexed_chunk_count: number;
  last_indexed_at: string | null;
  last_error: string | null;
}

export interface StoreDocHit {
  source_id: string;
  file_name: string;
  path: string;
  chunk_index: number;
  score: number;
  confidence: "high" | "medium" | "low";
  matched_terms: string[];
  why: string;
  excerpt: string;
}

class ApiClient {
  baseUrl: string;

  constructor() {
    this.baseUrl = BASE_URL;
  }

  /** 将相对路径（如 /uploads/...）解析为完整 API URL */
  resolveUrl(path: string): string {
    if (!path) return "";
    if (path.startsWith("http://") || path.startsWith("https://")) {
      return path;
    }
    return `${this.baseUrl}${path}`;
  }

  /** G-c 数据安全兜底：主库快照 + uploads 打包成 zip 的下载地址。配合 Electron「另存为」
   * 写到本机任意位置（设置抽屉「备份店铺数据」按钮用，fetch 拿字节自己转 base64，不走
   * JSON+base64——导出包可能带较大的历史图片/视频，直接走字节更省内存）。 */
  exportDataUrl(): string {
    return this.resolveUrl("/api/v1/backup/export");
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
      // 桌面免登录：本地身份不会 401（已删 SaaS 鉴权）；万一出现直接抛，不再刷新/跳登录。
      throw new ApiError(res.status, "本地身份异常，请重启 App");
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

  // ─── Auth（桌面免登录：只剩取本地 owner 身份） ───

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

  uploadQrcode(file: File, content?: string | null) {
    const formData = new FormData();
    formData.append("file", file);
    if (content?.trim()) formData.append("content", content.trim());
    return this.request<UploadResponse>("POST", "/api/v1/stores/me/qrcode", formData, true);
  }

  /** D-Task-9 语音输入:录音 Blob(webm/wav)→ 文字。麦克风按钮走口播同一套「模型就绪门」，
   * 未就绪前composer 不会调这个。 */
  transcribeAudio(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    return this.request<{ text: string }>("POST", "/api/v1/voice/transcribe", formData, true);
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

  /** 看本机报表为表格（桌面专属）。selected_files=被操作文件自身，过后端沙箱(只许动选定的报表) */
  readSheet(path: string) {
    return this.request<{ name: string; sheets: { name: string; rows: string[][] }[]; truncated: boolean }>(
      "POST",
      "/api/v1/canvas/sheet",
      { path, selected_files: [path] },
    );
  }

  /** 点格改：改本机报表一个单元格（桌面专属，自动备份） */
  excelEditCell(path: string, cell: string, value: string, sheet?: string) {
    return this.request<{ ok: boolean; sheet: string; cell: string; old: string; new: string }>(
      "POST",
      "/api/v1/canvas/excel-edit",
      { path, cell, value, sheet: sheet ?? null, selected_files: [path] },
    );
  }

  /** Word/PPT 按块读（桌面专属）：返回带稳定 id 的文本块，供逐块编辑。 */
  docBlocks(path: string) {
    return this.request<{
      name: string;
      kind: "docx" | "pptx";
      blocks: { id: string; kind: string; text: string; slide?: number }[];
    }>("POST", "/api/v1/canvas/doc-blocks", { path, selected_files: [path] });
  }

  /** Word/PPT 按块写回原文件（桌面专属，改前自动备份）。edits = {块id: 新文字}。 */
  docSave(path: string, edits: Record<string, string>) {
    return this.request<{ ok: boolean; path: string; saved: number }>(
      "POST",
      "/api/v1/canvas/doc-save",
      { path, edits, selected_files: [path] },
    );
  }

  /** 定稿渲染：把成品内容渲染成指定格式字节(base64)，配合 Electron「另存为」写到本机任意位置。 */
  renderDeliverable(content: string, format: string) {
    return this.request<{ base64: string; ext: string }>("POST", "/api/v1/canvas/render", { content, format });
  }

  /** 定稿保存到「内容库/成品」（桌面专属，重名自动备份）。 */
  saveToLibrary(content: string, format: string, name: string) {
    return this.request<{ ok: boolean; path: string }>("POST", "/api/v1/canvas/save-to-library", { content, format, name });
  }

  /** 文档预览（桌面专属，只读）：PDF/Word(.docx)/PPT(.pptx)/网页(.html) → 前端可渲染的数据。
   * render: pdf(base64原样) / page(网页原文) / richtext(Word转HTML片段) / slides(PPT逐页大纲) / toobig */
  readDoc(path: string) {
    return this.request<{
      name: string;
      render: "pdf" | "page" | "richtext" | "slides" | "toobig";
      pdf_base64?: string;
      html?: string;
      slides?: { title: string; bullets: string[] }[];
      message?: string;
      truncated?: boolean;
    }>("POST", "/api/v1/canvas/doc", { path, selected_files: [path] });
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
      return detail || "本月生成次数已达上限。";
    }
    if (res.status >= 400 && res.status < 500 && detail) return detail;
    return `生成失败，请稍后重试 (${res.status})`;
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

    const url = `${this.baseUrl}/api/v1/agent/chat`;
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(data), signal });
      if (!res.ok) {
        handlers.onError?.(await this.friendlyStreamError(res));
        return;
      }
      return this._consumeAgentSSEStream(res, handlers);
    } catch {
      handlers.onError?.("网络异常，请检查后重试");
    }
  }

  async startAgentTask(data: AgentChatPayload): Promise<AgentTaskStartResponse> {
    return this.request<AgentTaskStartResponse>("POST", "/api/v1/agent/tasks", data);
  }

  /** 单次订阅一个任务的事件流（GET .../events?after=N）。只负责这一次连接——断了要不要重连、
   * 从哪个 offset 续，是调用方（use-agent-chat 的 subscribeToTask）的事，这里不做重试循环。 */
  async subscribeAgentTask(
    taskId: string,
    handlers: AgentStreamHandlers,
    signal?: AbortSignal,
    after = -1,
  ): Promise<void> {
    const url = `${this.baseUrl}/api/v1/agent/tasks/${encodeURIComponent(taskId)}/events?after=${encodeURIComponent(String(after))}`;
    try {
      const res = await fetch(url, { method: "GET", headers: { "Accept": "text/event-stream" }, signal });
      if (!res.ok) {
        // 明确的 HTTP 错误（如任务已过期 404）：不是"网络断了"，重试也没用，走 onError 终止。
        handlers.onError?.(await this.friendlyStreamError(res));
        return;
      }
      return this._consumeAgentSSEStream(res, handlers);
    } catch {
      // fetch 本身就没连上（DNS/连接被拒等）：跟流中途断掉一样，都算"断线"，交给 onDisconnect。
      if (signal?.aborted) return;
      if (handlers.onDisconnect) handlers.onDisconnect();
      else handlers.onError?.("网络异常，请检查后重试");
    }
  }

  async cancelAgentTask(taskId: string): Promise<{ ok: boolean; task_id: string; status: string }> {
    return this.request("POST", `/api/v1/agent/tasks/${encodeURIComponent(taskId)}/cancel`, {});
  }

  listBackgroundTasks(input: { conversationId?: string | null; status?: string; limit?: number } = {}) {
    const qs = new URLSearchParams();
    if (input.conversationId) qs.set("conversationId", input.conversationId);
    if (input.status) qs.set("status", input.status);
    if (input.limit) qs.set("limit", String(input.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : "";
    return this.request<{ tasks: BackgroundTaskItem[] }>("GET", `/tasks${suffix}`);
  }

  getBackgroundTask(id: string, includeEvents = false) {
    return this.request<BackgroundTaskDetailResponse>(
      "GET",
      `/tasks/${encodeURIComponent(id)}${includeEvents ? "?includeEvents=1" : ""}`,
    );
  }

  cancelBackgroundTask(id: string) {
    return this.request<{ ok: boolean; cancelled: boolean; taskId?: string; requestedTaskId?: string }>("POST", `/tasks/${encodeURIComponent(id)}/cancel`, {});
  }

  /** 方向盘：任务跑动中给它捎话（补充/纠偏）。新话排进任务的插话队列，AI 下一轮注入、当场改道；
   * 不新起任务、不打断当前正在跑的工具。任务已结束 409 / 队列满 429（错误文案由后端说人话）。 */
  async sendTaskMessage(taskId: string, message: string): Promise<{ ok: boolean; task_id: string; queued: number }> {
    return this.request("POST", `/api/v1/agent/tasks/${encodeURIComponent(taskId)}/message`, { message });
  }

  private async _consumeAgentSSEStream(res: Response, handlers: AgentStreamHandlers): Promise<void> {
    const reader = res.body?.getReader();
    if (!reader) {
      handlers.onError?.("无法读取流式响应");
      return;
    }
    // F1c：区分"正常收尾"和"异常断线"。正常收尾恒经 case "done" 直接 return；这里的 disconnect()
    // 只在两种"没收到 done 就没了"的场景触发——连接中途抛异常，或读到 EOF 但压根没见过 done 事件。
    const disconnect = () => {
      if (handlers.onDisconnect) handlers.onDisconnect();
      else handlers.onError?.("连接中断，请检查网络后重试");
    };
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          // 流被提前关掉、没等到后端的 done 事件收尾——当异常断线处理，让调用方决定要不要重连。
          disconnect();
          return;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const ev = JSON.parse(line.slice(6));
            handlers.onEvent?.(ev);
            switch (ev.type) {
              case "token": handlers.onToken?.(ev.content || ""); break;
              case "reasoning": handlers.onReasoning?.(ev.content || ""); break;
              case "tool_call": handlers.onToolCall?.(ev.tool, ev.args || {}, ev.id); break;
              case "tool_result": handlers.onToolResult?.(ev.tool, ev.content || "", ev.id, Array.isArray(ev.knowledge_used) ? ev.knowledge_used : undefined, Array.isArray(ev.image_generation_ids) ? ev.image_generation_ids : undefined); break;
              case "tool_progress": handlers.onToolProgress?.(ev.tool, ev.id, ev.chunk || "", ev.stream); break;
              case "approval_request": handlers.onApprovalRequest?.(ev.tool, ev.args || {}, ev.id, ev.token, ev.preview, ev.reason, ev.rememberable === true); break;
              case "ask_question": handlers.onAskQuestion?.({ question: ev.question || "", options: ev.options || [], multi: ev.multi, id: ev.id, allowFreeform: ev.allowFreeform, placeholder: ev.placeholder, fields: Array.isArray(ev.fields) ? ev.fields : undefined, url: typeof ev.url === "string" ? ev.url : undefined }); break;
              case "steering": handlers.onSteering?.(ev.content || ""); break;
              case "context_note": handlers.onContextNote?.(ev.content || ""); break;
              case "todo_update": handlers.onTodoUpdate?.(ev.content || ""); break;
              case "usage_update": handlers.onUsageUpdate?.(ev); break;
              case "final": handlers.onFinal?.(ev.content || ""); break;
              case "done": handlers.onDone?.({ turns: ev.turns, stopped_reason: ev.stopped_reason, conversation_id: ev.conversation_id, generation_id: ev.generation_id, task_id: ev.task_id, offset: ev.offset, memory_refs: Array.isArray(ev.memory_refs) ? ev.memory_refs : undefined }); return;
              case "error": handlers.onError?.(ev.error || "生成出错，请重试"); break;
            }
          } catch {
            // 跳过非法 JSON 行
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      disconnect();
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
    knowledgePacks?: string[],
    workingDir?: string,
    rememberApproval?: boolean,
    approvalArgs?: Record<string, unknown>,
  ): Promise<{
    tool: string;
    result: string;
    continuation?: string;  // 审批回灌：执行后管家基于结果的自然接话
    approval?: { tool: string; args: Record<string, unknown>; token?: string; preview?: string; reason?: ApprovalReason; rememberable?: boolean } | null;
  }> {
    return this.request("POST", "/api/v1/agent/execute", {
      tool,
      args,
      selected_files: selectedFiles,
      full_disk_access: fullDiskAccess,
      token,
      conversation_id: conversationId,
      knowledge_packs: knowledgePacks,
      working_dir: workingDir,
      remember_approval: rememberApproval,
      approval_args: approvalArgs,
    });
  }

  /** SH-8：老板拒绝/取消某审批动作 → 上报后端记一次（连拒到阈值就别再反复提请）。故障安全，调用方 .catch 吞掉即可。 */
  async rejectAgentTool(tool: string, args: Record<string, unknown>, conversationId?: string | null): Promise<{ ok: boolean }> {
    return this.request("POST", "/api/v1/agent/reject", {
      tool,
      args,
      conversation_id: conversationId,
    });
  }

  /** 前端错误上报(fire-and-forget,失败静默) */
  async reportClientError(payload: { message: string; stack?: string; url?: string }): Promise<void> {
    await this.request("POST", "/api/v1/logs/client", payload);
  }

  // ── 店脑：门店 AI 记忆（「AI 眼里的你的店」页）──
  async getStoreMemory(): Promise<StoreMemoryItem[]> {
    return this.request<StoreMemoryItem[]>("GET", "/api/v1/store-memory");
  }
  async addStoreMemory(content: string, type = "semantic", workingDir?: string | null): Promise<StoreMemoryItem> {
    return this.request<StoreMemoryItem>("POST", "/api/v1/store-memory", { content, type, working_dir: workingDir || undefined });
  }
  async addStoreMemoryCandidate(content: string, type = "semantic", workingDir?: string | null): Promise<StoreMemoryItem> {
    return this.request<StoreMemoryItem>("POST", "/api/v1/store-memory/candidates", { content, type, working_dir: workingDir || undefined });
  }
  async updateStoreMemory(id: string, content: string): Promise<StoreMemoryItem> {
    return this.request<StoreMemoryItem>("PATCH", `/api/v1/store-memory/${id}`, { content });
  }
  async confirmStoreMemory(id: string): Promise<StoreMemoryItem> {
    return this.request<StoreMemoryItem>("POST", `/api/v1/store-memory/${id}/confirm`, {});
  }
  async deleteStoreMemory(id: string): Promise<void> {
    await this.request("DELETE", `/api/v1/store-memory/${id}`);
  }

  // ── 定时任务：到点自动跑一条 AI 任务(每早文案/每周报/每天汇总)，无人值守只出成品不对外 ──
  async getScheduledTasks(): Promise<ScheduledTaskItem[]> {
    return this.request<ScheduledTaskItem[]>("GET", "/api/v1/scheduled-tasks");
  }
  async createScheduledTask(body: ScheduledTaskCreatePayload): Promise<ScheduledTaskItem> {
    return this.request<ScheduledTaskItem>("POST", "/api/v1/scheduled-tasks", body);
  }
  async updateScheduledTask(id: string, patch: ScheduledTaskUpdatePayload): Promise<ScheduledTaskItem> {
    return this.request<ScheduledTaskItem>("PATCH", `/api/v1/scheduled-tasks/${id}`, patch);
  }
  async deleteScheduledTask(id: string): Promise<{ status: string }> {
    return this.request<{ status: string }>("DELETE", `/api/v1/scheduled-tasks/${id}`);
  }

  // ── 店铺资料库：懂你家(合同/价目表/排班表/进货单)，跟台球运营专家(懂行)分开呈现 ──
  async getStoreDocs(): Promise<StoreDocLibraryItem> {
    return this.request<StoreDocLibraryItem>("GET", "/api/v1/store-docs");
  }
  async setStoreDocsFolder(folderPath: string): Promise<StoreDocLibraryItem> {
    return this.request<StoreDocLibraryItem>("PUT", "/api/v1/store-docs", { folder_path: folderPath });
  }
  async reindexStoreDocs(): Promise<StoreDocLibraryItem> {
    return this.request<StoreDocLibraryItem>("POST", "/api/v1/store-docs/reindex", {});
  }
  async clearStoreDocs(): Promise<{ status: string }> {
    return this.request<{ status: string }>("DELETE", "/api/v1/store-docs");
  }
  async searchStoreDocs(query: string, top = 5, options?: { path?: string; paths?: string[] }): Promise<{ hits: StoreDocHit[] }> {
    return this.request<{ hits: StoreDocHit[] }>("POST", "/api/v1/store-docs/search", { query, top, ...options });
  }

  // ─── Dashboard ───

  getTodayDashboard() {
    return this.request<DashboardTodayResponse>("GET", "/api/v1/dashboard/today");
  }

  // 隐式反馈·采纳上浮：老板点某条今日推荐去做时记一次"采纳"（故障安全，失败不阻断跳转）
  adoptRecommendation(recId: string) {
    return this.request<{ status: string; rec_id: string }>("POST", "/api/v1/dashboard/adopt-rec", { rec_id: recId });
  }

  // 隐式反馈·今天先收起：老板踩某条今日推荐（不感兴趣）→ 当天工作台不再显示这条。故障安全，调用方 .catch 吞掉即可。
  dismissRecommendation(recId: string) {
    return this.request<{ status: string; rec_id: string }>("POST", "/api/v1/dashboard/dismiss-rec", { rec_id: recId });
  }

  // 桌面端：列出本店 agent 会话（侧栏回看/切换）
  listAgentConversations() {
    return this.request<{ conversations: { conversation_id: string; title: string | null; last_at: string | null }[] }>(
      "GET", "/api/v1/agent/conversations");
  }

  // 桌面端：最近作品/最近任务（轻量找回，不是完整素材库）
  listRecentArtifacts(limit = 12) {
    return this.request<{ items: RecentArtifact[] }>(
      "GET", `/api/v1/agent/recent-artifacts?limit=${encodeURIComponent(String(limit))}`);
  }

  // 桌面端：用户明确点“保存成品”后，把普通回答/诊断/文案放进最近作品
  saveRecentArtifact(input: { title?: string; content: string; conversation_id?: string | null; kind?: string }) {
    return this.request<RecentArtifact>("POST", "/api/v1/agent/saved-artifacts", input);
  }

  // 桌面端：把单条最近作品移入最近删除（可恢复，彻底删除走 deleted-items/purge）
  deleteRecentArtifact(id: string) {
    return this.request<{ ok: boolean; id: string }>(
      "DELETE", `/api/v1/agent/recent-artifacts/${encodeURIComponent(id)}`);
  }

  // P1-4 效果反馈：给成品打 👍good/👎bad，写 effect_rating（好评喂 RAG 召回/brand voice，闭环不空转）
  rateGeneration(id: string, rating: "good" | "bad", note?: string) {
    return this.request<{ ok: boolean; id: string; rating: string }>(
      "POST", `/api/v1/agent/recent-artifacts/${encodeURIComponent(id)}/rating`, { rating, note });
  }

  // 阶段1 生成工作室：查异步任务进度/结果（轮询）。status: queued/running/done/error；progress 0-100
  getMediaJob(id: string, signal?: AbortSignal) {
    return this.request<MediaJobStatus>("GET", `/api/v1/agent/media-jobs/${encodeURIComponent(id)}`, undefined, undefined, undefined, signal);
  }

  // 阶段2 生成工作室：文生图（绕 LLM 直连，异步出图，返回 job_id 后轮询 getMediaJob）
  // image_model=选的生图模型(gpt-image-2 / doubao-seedream-4-5-251128…)；image_prompt=优化后的提示词(有则当真实 prompt)
  // E2-4・reference_generation_ids="要同款"：拿已出的成品 id 当参考图，重新生成一批相似的（不是改这一张）
  studioGenerate(input: {
    prompt: string;
    ratio?: string;
    style?: string;
    count?: number;
    reference_image_paths?: string[];
    reference_generation_ids?: string[];
    image_model?: string;
    image_prompt?: string;
    poster_text?: string | string[] | Record<string, unknown>;
    print_mode?: boolean;
    qrcode_text?: string;
    conversation_id?: string | null;
  }) {
    return this.request<{ job_id: string }>("POST", "/api/v1/studio/generate", input);
  }

  // 提示词优化：大白话 → 优化后的文生图提示词（前端展示+可改，改后即真实送模型）。同步返回。
  studioExpand(input: { prompt: string }) {
    return this.request<{ image_prompt: string }>("POST", "/api/v1/studio/expand", input);
  }

  // 阶段2/3 生成工作室：基于这张成品改（source_generation_id=底图来源+血缘父；可选 mask_path 局部重绘），异步出图
  studioEdit(input: { prompt: string; source_generation_id: string; mask_path?: string; ratio?: string; count?: number; image_model?: string; conversation_id?: string | null }) {
    return this.request<{ job_id: string }>("POST", "/api/v1/studio/edit", input);
  }

  // 阶段4 生成工作室：把一张图做成视频（可配音/多图锁人物/首尾帧），异步出片，返回 job_id
  studioI2v(input: { first_frame: string; prompt?: string; source_generation_id?: string; ratio?: string; duration?: number; generate_audio?: boolean; image_refs?: string[]; conversation_id?: string | null }) {
    return this.request<{ job_id: string }>("POST", "/api/v1/studio/i2v", input);
  }

  // E1-C2・openWorkbench handoff：视频面板拿着轻标识 fromGen（generation id）换成真实图片 URL 当 i2v 首帧
  studioGetGeneration(id: string) {
    return this.request<{ url: string; ratio: string; is_video: boolean }>(
      "GET", `/api/v1/studio/generation/${encodeURIComponent(id)}`);
  }

  // 阶段5 生成工作室：多镜合成准备——多段视频成品 id（有序）→ 本机路径，交前端 Electron ffmpeg(video.js) concat
  studioCompose(generation_ids: string[]) {
    return this.request<{ inputs: string[]; output_path: string; output_url: string }>(
      "POST", "/api/v1/studio/compose", { generation_ids });
  }

  // 阶段5 助教一条龙：LLM 分镜 + 配文案（主题 → N 个分镜画面描述 + 一条社媒文案）
  studioStoryboard(input: { theme: string; shots?: number; subject?: string }) {
    return this.request<{ shots: string[]; caption: string }>("POST", "/api/v1/studio/storyboard", input);
  }

  // ── AI 剪辑台（/video-edit）：面板直接操作时间轴文档（与 AI 共用同一份真相源）──
  // 理解本机视频素材（转写+切镜头）→ 候选片段菜单 + 草稿文档。慢 → 返回 job_id，轮询 getMediaJob 拿 result.{project,candidates,has_speech}
  videoEditInventory(input: { video_paths: string[]; project?: string; conversation_id?: string | null }) {
    return this.request<{ job_id: string; project: string }>("POST", "/api/v1/video-edit/inventory", input);
  }

  // 一键智能出方案（氛围模式=切窗+VLM挑高光+拼片）。慢 → 返回 job_id，轮询拿 result.{project,report,used_vlm}
  videoEditAutoPlan(input: {
    video_paths: string[];
    mode?: "ambient" | "speech";
    ratio?: "9:16" | "1:1" | "16:9" | "original";
    target_duration?: number;
    project?: string;
    conversation_id?: string | null;
  }) {
    return this.request<{ job_id: string; project: string }>("POST", "/api/v1/video-edit/auto_plan", input);
  }

  // 读当前时间轴文档（面板渲染分段卡片/字幕用）
  getVideoProject(project: string) {
    return this.request<{ project: string; doc: VideoDocView }>(
      "GET", `/api/v1/video-edit/projects/${encodeURIComponent(project)}`);
  }

  // 对文档发原子操作（挑段/裁剪/排序/加删字幕/配乐）；校验不过整批回滚（ok=false 时 doc 不变）
  applyVideoOps(project: string, operations: Record<string, unknown>[]) {
    return this.request<{ ok: boolean; errors: string[]; doc: VideoDocView }>(
      "POST", `/api/v1/video-edit/projects/${encodeURIComponent(project)}/ops`, { operations });
  }

  // 把已挑片段里的口播自动配成字幕
  autoCaptionVideo(project: string, track = "sub") {
    return this.request<{ ok: boolean; added?: number; errors?: string[]; doc: VideoDocView }>(
      "POST", `/api/v1/video-edit/projects/${encodeURIComponent(project)}/auto_caption`, { track });
  }

  // 时间轴文档 → 成片 mp4。慢 → 返回 job_id，轮询 getMediaJob 拿 result.{urls,duration}
  renderVideoProject(project: string, output_name = "成片", conversation_id?: string | null) {
    return this.request<{ job_id: string }>(
      "POST", `/api/v1/video-edit/projects/${encodeURIComponent(project)}/render`, { output_name, conversation_id });
  }

  // ── V2 自研模板渲染器（氛围·有包装·可对话改文案）──
  // V2 出方案+配文案（不渲染）。慢(VLM) → job_id，轮询拿 result.{project,report,brand,captions,used_vlm}
  videoEditAutoPlanV2(input: {
    video_paths: string[];
    mode?: "ambient" | "speech";
    ratio?: "9:16" | "1:1" | "16:9" | "original";
    target_duration?: number;
    project?: string;
    conversation_id?: string | null;
  }) {
    return this.request<{ job_id: string; project: string }>("POST", "/api/v1/video-edit/auto_plan_v2", input);
  }

  // 对话改文案（快·同步）：店主大白话指令 → 新文案（前端即时刷新预览）
  recaptionVideo(project: string, tonality: string) {
    return this.request<{ ok: boolean; brand: string; captions: string[] }>(
      "POST", `/api/v1/video-edit/projects/${encodeURIComponent(project)}/recaption`, { tonality });
  }

  // 对话改任何东西（快·同步）：店主大白话反馈 → LLM 理解 → 改方案（换段/删段/改序/短长/调色/配乐/文案）
  // 返回 shots(带 src/start/end/caption) 供前端重建预览 + reply(大白话回执)
  editVideoFeedback(project: string, feedback: string) {
    return this.request<{
      ok: boolean; reply: string; brand: string;
      shots: { src: string; start: number; end: number; caption: string }[];
      grade?: string; ratio?: string; music_mood?: string;
    }>("POST", `/api/v1/video-edit/projects/${encodeURIComponent(project)}/edit_feedback`, { feedback });
  }

  // V2 出片（带包装）。慢(逐帧渲染) → job_id，轮询拿 result.{urls,duration}
  renderVideoV2(project: string, output_name = "成片", conversation_id?: string | null) {
    return this.request<{ job_id: string }>(
      "POST", `/api/v1/video-edit/projects/${encodeURIComponent(project)}/render_v2`, { output_name, conversation_id });
  }

  // 轮询一个 media job 到结束（done/error），onTick 给进度回调。
  // 只要还能拿到 status（running/queued）就不做客户端超时——任务多久算超时是服务端自己的事（它跑久了会把 status 置 error）；
  // noResponseTimeoutMs 只兜底"长时间连状态响应都拿不到"（网络断/后端挂了）的极端情况，避免用户对着转圈干等。
  // signal：可选，传入后可在组件卸载等场景中途取消轮询（AbortError 会原样往外抛，调用方按需吞掉）。
  async pollMediaJob(
    id: string,
    onTick?: (j: MediaJobStatus) => void,
    noResponseTimeoutMs = 1_200_000,
    signal?: AbortSignal,
  ): Promise<MediaJobStatus> {
    const wait = (ms: number) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException("已取消", "AbortError")); return; }
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("已取消", "AbortError")); }, { once: true });
    });
    let lastOkAt = Date.now();
    for (;;) {
      let j: MediaJobStatus;
      try {
        j = await this.getMediaJob(id, signal);
      } catch (e) {
        if (e instanceof DOMException && e.name === "AbortError") throw e;
        if (Date.now() - lastOkAt > noResponseTimeoutMs) throw e;
        await wait(2000);
        continue;
      }
      lastOkAt = Date.now();
      onTick?.(j);
      if (j.status === "done") return j;
      if (j.status === "error") throw new Error(j.error || "生成失败");
      await wait(2000);
    }
  }

  // 桌面端：最近删除（轻量找回）
  listDeletedItems(limit = 30) {
    return this.request<{ items: RecentArtifact[] }>(
      "GET", `/api/v1/agent/deleted-items?limit=${encodeURIComponent(String(limit))}`);
  }

  restoreDeletedItem(item: { id?: string | null; conversation_id?: string | null; kind?: string | null }) {
    return this.request<{ ok: boolean }>("POST", "/api/v1/agent/deleted-items/restore", item);
  }

  purgeDeletedItem(item: { id?: string | null; conversation_id?: string | null; kind?: string | null }) {
    return this.request<{ ok: boolean }>("POST", "/api/v1/agent/deleted-items/purge", item);
  }

  clearDeletedItems() {
    return this.request<{ ok: boolean; removed_file_backups?: number }>("POST", "/api/v1/agent/deleted-items/clear", {});
  }

  // F1b 通知中心：渲染进程持久轮询，after=已拿到的最后一条 id，返回新通知 + 下次要用的游标。
  getNotifications(after: number, signal?: AbortSignal) {
    return this.request<{ items: NotificationItem[]; cursor: number }>(
      "GET", `/api/v1/notifications?after=${encodeURIComponent(String(after))}`,
      undefined, undefined, undefined, signal);
  }

  // 桌面端：取某个 agent 会话的全部消息（点开回看）
  // display_content：C2 历史回放半——该条 user 消息若是快捷按钮等短标签场景才带此字段，老会话没有（向后兼容）。
  getAgentConversation(id: string) {
    return this.request<{ conversation_id: string; messages: { role: "user" | "assistant"; content: string; display_content?: string }[] }>(
      "GET", `/api/v1/agent/conversations/${encodeURIComponent(id)}`);
  }

  // 桌面端：删除（软删）某个 agent 会话（侧栏垃圾桶按钮）。P1-3b。
  deleteAgentConversation(id: string) {
    return this.request<{ ok: boolean; conversation_id: string }>(
      "DELETE", `/api/v1/agent/conversations/${encodeURIComponent(id)}`);
  }

  // 桌面端：取 AI 改过的本机文件的"改前/改后"对比数据（B.2 右侧 diff 视图）
  fileDiff(path: string, backupPath?: string | null) {
    const q = new URLSearchParams({ path });
    if (backupPath) q.set("backup_path", backupPath);
    return this.request<{ ok: boolean; path?: string; backup_path?: string | null; old?: string; new?: string; error?: string }>(
      "GET", `/api/v1/agent/file-diff?${q.toString()}`);
  }

  fileRestore(path: string, backupPath?: string | null) {
    return this.request<{ ok: boolean; path?: string; backup_path?: string; current_backup_path?: string; error?: string }>(
      "POST", "/api/v1/agent/file-restore", { path, backup_path: backupPath });
  }

  // 桌面端：列出已安装技能(Skill)，供 `/` 命令面板展示
  listSkills() {
    return this.request<{ skills: SkillMeta[] }>("GET", "/api/v1/agent/skills");
  }

  // 桌面端：列出后端 markdown slash commands（server/commands + 当前项目 .claude/.codex commands）
  listCommands(workingDir?: string | null, knowledgePacks?: string[]) {
    const q = new URLSearchParams();
    if (workingDir) q.set("working_dir", workingDir);
    for (const pack of knowledgePacks || []) {
      if (pack.trim()) q.append("knowledge_packs", pack.trim());
    }
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return this.request<{ commands: CommandMeta[] }>("GET", `/api/commands${suffix}`);
  }

  // 桌面端：列出可用输出风格
  listOutputStyles() {
    return this.request<{ output_styles: OutputStyleMeta[] }>("GET", "/api/v1/agent/output-styles");
  }

  // 桌面端：列出可挂载专家（行业知识/工具上下文）
  listKnowledgePacks() {
    return this.request<{ packs: KnowledgePackMeta[] }>("GET", "/api/v1/agent/packs");
  }

  // 桌面端：MCP 服务器状态（连接状态 + 工具数，要真连一下）
  listMcp() {
    return this.request<{ servers: { name: string; command?: string; status: string; tools: number }[] }>("GET", "/api/v1/agent/mcp");
  }

  workspaceStatus(workingDir?: string | null) {
    const q = new URLSearchParams();
    if (workingDir) q.set("working_dir", workingDir);
    const suffix = q.toString() ? `?${q.toString()}` : "";
    return this.request<{ git: WorkspaceGitStatus; projectInstructions?: WorkspaceProjectInstructionSummary; tree?: WorkspaceTreeSummary }>("GET", `/api/v1/agent/workspace-status${suffix}`);
  }

  getModelStatus() {
    return this.request<ModelStatusResponse>("GET", "/api/model");
  }

  clearModelHealth(input: { providerId?: string; source?: string; all?: boolean }) {
    return this.request<{ ok: boolean; cleared: number; status: ModelStatusResponse }>("POST", "/api/model/health/clear", input);
  }

  setProviderEnabled(providerId: string, enabled: boolean) {
    return this.request<{ provider: ModelProviderItem }>("PATCH", `/api/providers/${encodeURIComponent(providerId)}/enabled`, { enabled });
  }

  reorderProviders(ids: string[]) {
    return this.request<{ providers: ModelProviderItem[]; activeId: string | null }>("POST", "/api/providers/reorder", { ids });
  }

  // 桌面端：免 key 的官方 MCP 预设（一键加）
  listMcpPresets() {
    return this.request<{ presets: { id: string; name: string; desc: string; command: string; args: string[] }[] }>("GET", "/api/v1/agent/mcp/presets");
  }

  // 桌面端：加/覆盖一个 MCP server
  addMcp(data: { name: string; command: string; args?: string[]; env?: Record<string, string> }) {
    return this.request<{ ok: boolean; message: string }>("POST", "/api/v1/agent/mcp/add", data);
  }

  // 桌面端：删一个 MCP server
  removeMcp(name: string) {
    return this.request<{ ok: boolean; message: string }>("POST", "/api/v1/agent/mcp/remove", { name });
  }

  // 桌面端：启用/停用一个 MCP server
  toggleMcp(name: string, disabled: boolean) {
    return this.request<{ ok: boolean; message: string }>("POST", "/api/v1/agent/mcp/toggle", { name, disabled });
  }

  // 桌面端：已装插件
  listPlugins() {
    return this.request<{ plugins: { name: string; enabled: boolean; description: string; components: Record<string, number> }[] }>("GET", "/api/v1/agent/plugins");
  }

  // 桌面端：启用/停用一个插件
  togglePlugin(name: string, enabled: boolean) {
    return this.request<{ ok: boolean; message: string }>("POST", "/api/v1/agent/plugins/toggle", { name, enabled });
  }

  // 桌面端：从 GitHub 装插件
  installPlugin(repo: string) {
    return this.request<{ ok: boolean; message: string }>("POST", "/api/v1/agent/plugins/install", { repo });
  }

  // 桌面端：温和校验生图 model↔供应商是否对得上
  validateImageModel(base_url: string, model: string) {
    return this.request<{ ok: boolean; level: string; message: string; provider: string; known_models: string[] }>("POST", "/api/v1/agent/image/validate", { base_url, model });
  }

  // 注：getCardSignals(工作台卡片排序信号)前端已不接——单窗口无卡片网格消费场景；后端接口保留供个性化。

  // ─── Quota ───

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

}

export interface SkillMeta {
  name: string;
  description: string;
  source: string;
  argument_hint?: string;
  user_invocable: boolean;
}

export interface CommandMeta {
  name: string;
  description: string;
  whenToUse?: string;
  allowedTools?: string[];
  model?: string;
  source: string;
  contentLength: number;
}

export interface OutputStyleMeta {
  name: string;
  description: string;
  source: string;
}

export interface KnowledgePackMeta {
  id: string;
  name: string;
  description: string;
  aliases: string[];
  default_enabled: boolean;
  suggested_skills: string[];
  suggested_commands?: string[];
  suggested_tools?: string[];
}

export const api = new ApiClient();
