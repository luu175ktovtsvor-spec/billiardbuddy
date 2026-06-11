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
}
