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
  /** 当前阶段：planning(指挥官规划) / executing(岗位执行) / synthesizing(汇总) / 终态 */
  stage?: "planning" | "executing" | "synthesizing" | string;
  /** 指挥官产出的《协作框架》（规划阶段后出现） */
  framework?: string | null;
  agents: OrchestrationAgent[];
  summary?: string;
  generation_id?: string | null;
}

export interface RepurposeResponse {
  content: string;
  platform: string;
  /** 变体是独立的新生成记录；前端必须切换到该 id，否则后续编辑/反馈会写到原记录上 */
  generation_id: string;
}
