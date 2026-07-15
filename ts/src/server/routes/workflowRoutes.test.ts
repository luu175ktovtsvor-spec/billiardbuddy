import { describe, expect, it } from 'bun:test'
import type { WorkflowDefinition, WorkflowRun } from '../../../shared/contracts/workflows'
import { WorkflowAlreadyRunningError, WorkflowNotFoundError } from '../../workflows/workflowRunService'
import { createWorkflowRouteHandler } from './workflowRoutes'

const definition: WorkflowDefinition = {
  id: 'venue-daily-report',
  name: '营业日报',
  description: '',
  billiardsMode: true,
  source: 'bundled',
  steps: [{ id: 'collect', title: '收集资料', instruction: '收集' }],
}

const run: WorkflowRun = {
  id: 'run-1',
  workflowId: 'venue-daily-report',
  workflowName: '营业日报',
  trigger: 'manual',
  status: 'running',
  startedAt: '2026-07-16T09:00:00.000Z',
  steps: [{ stepId: 'collect', title: '收集资料', status: 'pending' }],
}

interface HandlerCalls {
  startArgs?: { workflowId: string; workingDir?: string }
}

function makeHandler(overrides: Partial<Parameters<typeof createWorkflowRouteHandler>[0]['service']> = {}, calls: HandlerCalls = {}) {
  return createWorkflowRouteHandler({
    service: {
      listWorkflows: async () => [definition],
      listRuns: async workflowId => (workflowId && workflowId !== run.workflowId ? [] : [run]),
      getRun: async id => (id === run.id ? run : null),
      startRunInBackground: async (workflowId, opts) => {
        calls.startArgs = { workflowId, workingDir: opts.workingDir }
        return run
      },
      ...overrides,
    },
    defaultWorkspaceRoot: () => '/default/workspace',
  })
}

function request(path: string, init?: RequestInit): [URL, Request] {
  const url = new URL(`http://127.0.0.1${path}`)
  return [url, new Request(url.toString(), init)]
}

describe('workflowRoutes', () => {
  it('GET /api/v1/workflows 返回定义列表', async () => {
    const res = await makeHandler()(...request('/api/v1/workflows'))
    expect(res?.status).toBe(200)
    const body = await res!.json() as { workflows: WorkflowDefinition[] }
    expect(body.workflows.map(w => w.id)).toEqual(['venue-daily-report'])
  })

  it('GET /api/v1/workflows/runs 支持 workflow_id 过滤', async () => {
    const all = await makeHandler()(...request('/api/v1/workflows/runs'))
    expect(((await all!.json()) as { runs: WorkflowRun[] }).runs).toHaveLength(1)
    const filtered = await makeHandler()(...request('/api/v1/workflows/runs?workflow_id=other'))
    expect(((await filtered!.json()) as { runs: WorkflowRun[] }).runs).toHaveLength(0)
  })

  it('GET /api/v1/workflows/runs/:id 命中与 404', async () => {
    const hit = await makeHandler()(...request('/api/v1/workflows/runs/run-1'))
    expect(hit?.status).toBe(200)
    const miss = await makeHandler()(...request('/api/v1/workflows/runs/other'))
    expect(miss?.status).toBe(404)
  })

  it('POST /api/v1/workflows/:id/run 返回 202 初始快照,working_dir 缺省用默认工作区', async () => {
    const calls: HandlerCalls = {}
    const res = await makeHandler({}, calls)(...request('/api/v1/workflows/venue-daily-report/run', { method: 'POST' }))
    expect(res?.status).toBe(202)
    expect(calls.startArgs).toEqual({ workflowId: 'venue-daily-report', workingDir: '/default/workspace' })
  })

  it('POST run 透传请求体 working_dir', async () => {
    const calls: HandlerCalls = {}
    await makeHandler({}, calls)(...request('/api/v1/workflows/venue-daily-report/run', {
      method: 'POST',
      body: JSON.stringify({ working_dir: '/my/venue' }),
    }))
    expect(calls.startArgs?.workingDir).toBe('/my/venue')
  })

  it('未知工作流 404,并发运行 409', async () => {
    const notFound = await makeHandler({
      startRunInBackground: async () => { throw new WorkflowNotFoundError('missing') },
    })(...request('/api/v1/workflows/missing/run', { method: 'POST' }))
    expect(notFound?.status).toBe(404)

    const conflict = await makeHandler({
      startRunInBackground: async () => { throw new WorkflowAlreadyRunningError('venue-daily-report', 'run-1') },
    })(...request('/api/v1/workflows/venue-daily-report/run', { method: 'POST' }))
    expect(conflict?.status).toBe(409)
  })

  it('不匹配路径返回 null,错误 method 返回 405', async () => {
    expect(await makeHandler()(...request('/api/v1/other'))).toBeNull()
    const res = await makeHandler()(...request('/api/v1/workflows', { method: 'POST' }))
    expect(res?.status).toBe(405)
  })
})
