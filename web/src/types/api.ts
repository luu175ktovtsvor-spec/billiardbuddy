export class ApiError extends Error {
  status: number;
  detail: string;

  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
  }
}

/* ─── 协作任务（orchestrate） ─── */

export interface OrchestrationAgent {
  role: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped" | string;
  content?: string;
}

export interface OrchestrationTask {
  task_id: string;
  status: "pending" | "running" | "completed" | "failed" | "cancelled" | string;
  agents: OrchestrationAgent[];
  summary?: string;
}

export interface RepurposeResponse {
  content: string;
  platform: string;
  /** 变体是独立的新生成记录；前端必须切换到该 id，否则后续编辑/反馈会写到原记录上 */
  generation_id: string;
}
