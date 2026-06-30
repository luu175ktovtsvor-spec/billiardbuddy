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

/** Agent 流式对话事件回调（对应后端 /agent/chat 的 SSE 事件：token/tool_call/tool_result/final/done/error）。 */
export interface AgentStreamHandlers {
  onToken?: (token: string) => void;
  // F.1 思考过程：模型 reasoning_content 流式片段（灰斜体思考块展示，不是正文）。
  onReasoning?: (chunk: string) => void;
  onToolCall?: (tool: string, args: Record<string, unknown>, id?: string) => void;
  onToolResult?: (tool: string, content: string, id?: string, knowledgeUsed?: string[]) => void;
  // 命令边跑边显示：工具执行中实时推来的输出片段（chunk），按 id 累进对应步骤的终端块。
  onToolProgress?: (tool: string, id: string | undefined, chunk: string, stream?: string) => void;
  // SH-8：reason = 结构化审批理由 {what 要做什么 / why 为什么要你确认 / impact 影响}，让审批卡说清楚再让老板点头。
  onApprovalRequest?: (tool: string, args: Record<string, unknown>, id?: string, token?: string, preview?: string, reason?: ApprovalReason) => void;
  onAskQuestion?: (q: { question: string; options: { label: string; description?: string }[]; multi?: boolean; id?: string }) => void;
  onFinal?: (content: string) => void;
  onDone?: (info: { turns: number; stopped_reason: string; conversation_id?: string; generation_id?: string; task_id?: string; offset?: number; memory_refs?: string[] }) => void;
  onError?: (error: string) => void;
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
  media: Record<string, { src: string; duration: number }>;
  clips: { id: string; media: string | null; src_in: number; src_out: number; order: number }[];
  captions: { id: string; text: string | null; start: number | null; end: number | null; style: string | null }[];
  music: string | null;
  grade: string | null;
}

export interface AgentChatPayload {
  message: string;
  history?: unknown[];
  model?: string;
  conversation_id?: string | null;
  selected_files?: string[]; // 桌面版：老板选定、授权 Agent 读/改的文件绝对路径
  permission_mode?: "ask" | "auto_files" | "full" | "plan"; // 权限：每次问/自动改文件/全自动/计划
  full_disk_access?: boolean; // 高级·全盘：文件工具不限内容库+选定文件
  knowledge_packs?: string[]; // @ 挂载的知识库（如 ["billiards"]）；含 billiards → 台球专家模式，否则通用
  output_style?: string; // 输出风格名（explanatory/concise…），空=默认
  goal?: string; // /goal 目标驱动：本次会话目标条件
  deep_thinking?: boolean; // F.2 深度思考：true=开/false=关/省略=跟随模型默认（mimo 默认开）
  source_rec_id?: string; // 隐式反馈：本次对话由今日推荐哪一条触发（rec.id）→ 后端落到 generation 做"采纳上浮"
  working_dir?: string; // 本会话工作目录:相对路径默认落它 + 自动接受编辑范围
}

export interface AgentTaskStartResponse {
  task_id: string;
  status: "running" | "done" | "error" | "cancelled" | string;
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

  uploadQrcode(file: File) {
    const formData = new FormData();
    formData.append("file", file);
    return this.request<UploadResponse>("POST", "/api/v1/stores/me/qrcode", formData, true);
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
        handlers.onError?.(await this.friendlyStreamError(res));
        return;
      }
      return this._consumeAgentSSEStream(res, handlers);
    } catch {
      if (signal?.aborted) return;
      handlers.onError?.("网络异常，请检查后重试");
    }
  }

  async cancelAgentTask(taskId: string): Promise<{ ok: boolean; task_id: string; status: string }> {
    return this.request("POST", `/api/v1/agent/tasks/${encodeURIComponent(taskId)}/cancel`, {});
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
            handlers.onEvent?.(ev);
            switch (ev.type) {
              case "token": handlers.onToken?.(ev.content || ""); break;
              case "reasoning": handlers.onReasoning?.(ev.content || ""); break;
              case "tool_call": handlers.onToolCall?.(ev.tool, ev.args || {}, ev.id); break;
              case "tool_result": handlers.onToolResult?.(ev.tool, ev.content || "", ev.id, Array.isArray(ev.knowledge_used) ? ev.knowledge_used : undefined); break;
              case "tool_progress": handlers.onToolProgress?.(ev.tool, ev.id, ev.chunk || "", ev.stream); break;
              case "approval_request": handlers.onApprovalRequest?.(ev.tool, ev.args || {}, ev.id, ev.token, ev.preview, ev.reason); break;
              case "ask_question": handlers.onAskQuestion?.({ question: ev.question || "", options: ev.options || [], multi: ev.multi, id: ev.id }); break;
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
    knowledgePacks?: string[],
    workingDir?: string,
  ): Promise<{
    tool: string;
    result: string;
    continuation?: string;  // 审批回灌：执行后管家基于结果的自然接话
    approval?: { tool: string; args: Record<string, unknown>; token?: string; preview?: string; reason?: ApprovalReason } | null;
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

  // ─── Dashboard ───

  getTodayDashboard() {
    return this.request<DashboardTodayResponse>("GET", "/api/v1/dashboard/today");
  }

  // 隐式反馈·采纳上浮：老板点某条今日推荐去做时记一次"采纳"（故障安全，失败不阻断跳转）
  adoptRecommendation(recId: string) {
    return this.request<{ status: string; rec_id: string }>("POST", "/api/v1/dashboard/adopt-rec", { rec_id: recId });
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
  getMediaJob(id: string) {
    return this.request<MediaJobStatus>("GET", `/api/v1/agent/media-jobs/${encodeURIComponent(id)}`);
  }

  // 阶段2 生成工作室：文生图（绕 LLM 直连，异步出图，返回 job_id 后轮询 getMediaJob）
  studioGenerate(input: { prompt: string; ratio?: string; style?: string; count?: number; reference_image_paths?: string[]; conversation_id?: string | null }) {
    return this.request<{ job_id: string }>("POST", "/api/v1/studio/generate", input);
  }

  // 阶段2/3 生成工作室：基于这张成品改（source_generation_id=底图来源+血缘父；可选 mask_path 局部重绘），异步出图
  studioEdit(input: { prompt: string; source_generation_id: string; mask_path?: string; ratio?: string; count?: number; conversation_id?: string | null }) {
    return this.request<{ job_id: string }>("POST", "/api/v1/studio/edit", input);
  }

  // 阶段4 生成工作室：把一张图做成视频（可配音/多图锁人物/首尾帧），异步出片，返回 job_id
  studioI2v(input: { first_frame: string; prompt?: string; source_generation_id?: string; ratio?: string; duration?: number; generate_audio?: boolean; image_refs?: string[]; conversation_id?: string | null }) {
    return this.request<{ job_id: string }>("POST", "/api/v1/studio/i2v", input);
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

  // 轮询一个 media job 到结束（done/error），onTick 给进度回调。失败/超时抛错。
  async pollMediaJob(id: string, onTick?: (j: MediaJobStatus) => void, timeoutMs = 1_200_000): Promise<MediaJobStatus> {
    const start = Date.now();
    // 出图慢（gpt-image-2 单张可能 5-10 分），轮询间隔 2s，整体上限默认 20 分钟
    for (;;) {
      const j = await this.getMediaJob(id);
      onTick?.(j);
      if (j.status === "done") return j;
      if (j.status === "error") throw new Error(j.error || "生成失败");
      if (Date.now() - start > timeoutMs) throw new Error("生成超时了，稍后到「最近作品」看看，或重试");
      await new Promise((r) => setTimeout(r, 2000));
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

  // 桌面端：取某个 agent 会话的全部消息（点开回看）
  getAgentConversation(id: string) {
    return this.request<{ conversation_id: string; messages: { role: "user" | "assistant"; content: string }[] }>(
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

  // 桌面端：列出可用输出风格
  listOutputStyles() {
    return this.request<{ output_styles: OutputStyleMeta[] }>("GET", "/api/v1/agent/output-styles");
  }

  // 桌面端：MCP 服务器状态（连接状态 + 工具数，要真连一下）
  listMcp() {
    return this.request<{ servers: { name: string; command?: string; status: string; tools: number }[] }>("GET", "/api/v1/agent/mcp");
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

export interface OutputStyleMeta {
  name: string;
  description: string;
  source: string;
}

export const api = new ApiClient();
