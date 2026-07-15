// 经营工作流 api(接后端 /api/v1/workflows)。已安排页用它:选工作流建定时任务、看运行记录。
// 响应一律经共享契约 Schema 解析,不让原始 JSON 直接进组件。
import { api } from './client'
import {
  workflowListResponseSchema,
  workflowRunListResponseSchema,
  workflowRunSchema,
  type WorkflowDefinition,
  type WorkflowRun,
} from '../../../../shared/contracts/workflows'

export type { WorkflowDefinition, WorkflowRun }

export const workflowsApi = {
  list: async (): Promise<WorkflowDefinition[]> =>
    workflowListResponseSchema.parse(await api.get<unknown>('/api/v1/workflows')).workflows,
  listRuns: async (workflowId?: string): Promise<WorkflowRun[]> =>
    workflowRunListResponseSchema.parse(await api.get<unknown>(
      `/api/v1/workflows/runs${workflowId ? `?workflow_id=${encodeURIComponent(workflowId)}` : ''}`,
    )).runs,
  run: async (id: string, workingDir?: string): Promise<WorkflowRun> =>
    workflowRunSchema.parse(await api.post<unknown>(
      `/api/v1/workflows/${encodeURIComponent(id)}/run`,
      workingDir ? { working_dir: workingDir } : {},
    )),
}
