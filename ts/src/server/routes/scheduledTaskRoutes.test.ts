import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DesktopDataStore } from '../services/desktopDataStore'
import type { ScheduledTaskRun } from '../services/scheduledTaskRunner'
import { createScheduledTaskRouteHandler } from './scheduledTaskRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness(options: { runFound?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'scheduled-routes-'))
  roots.push(root)
  const store = new DesktopDataStore(root)
  const run: ScheduledTaskRun = {
    id: 'run-1',
    task_id: 'task-1',
    task_name: '每日汇总',
    status: 'completed',
    instruction: '汇总昨天数据',
    started_at: '2026-07-13T01:00:00.000Z',
    completed_at: '2026-07-13T01:01:00.000Z',
  }
  const handler = createScheduledTaskRouteHandler({
    store,
    runner: {
      async getTaskRuns() { return [run] },
      async runTaskNow() { return options.runFound === false ? null : run },
    },
  })
  return { handler }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createScheduledTaskRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('scheduled task routes', () => {
  test('ignores unrelated paths', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
  })

  test('creates, lists, patches and deletes tasks through the real JSON store', async () => {
    const { handler } = createHarness()
    const createdResponse = await route(handler, '/api/v1/scheduled-tasks', {
      method: 'POST',
      body: JSON.stringify({
        name: '每日汇总',
        instruction: '汇总昨天数据',
        schedule_kind: 'daily',
        schedule_spec: { hour: 9, minute: 0 },
        enabled: true,
      }),
    })
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json() as Record<string, unknown>
    expect(created).toMatchObject({ name: '每日汇总', instruction: '汇总昨天数据', schedule_kind: 'daily', enabled: true })

    const listed = await (await route(handler, '/api/v1/scheduled-tasks')).json() as Array<Record<string, unknown>>
    expect(listed).toHaveLength(1)

    const id = encodeURIComponent(String(created.id))
    const updated = await (await route(handler, `/api/v1/scheduled-tasks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ enabled: false }),
    })).json() as Record<string, unknown>
    expect(updated.enabled).toBe(false)

    expect((await route(handler, `/api/v1/scheduled-tasks/${id}`, { method: 'DELETE' })).status).toBe(200)
    expect(await (await route(handler, '/api/v1/scheduled-tasks')).json()).toEqual([])
  })

  test('returns run history and accepts an immediate run', async () => {
    const { handler } = createHarness()
    const history = await (await route(handler, '/api/v1/scheduled-tasks/task-1/runs')).json() as { runs: ScheduledTaskRun[] }
    expect(history.runs[0]).toMatchObject({ id: 'run-1', task_id: 'task-1', status: 'completed' })

    const runResponse = await route(handler, '/api/v1/scheduled-tasks/task-1/run', { method: 'POST', body: '{}' })
    expect(runResponse.status).toBe(202)
    expect(await runResponse.json()).toMatchObject({ id: 'run-1', task_name: '每日汇总' })
  })

  test('preserves 404 and 405 compatibility behavior', async () => {
    const { handler } = createHarness({ runFound: false })
    expect((await route(handler, '/api/v1/scheduled-tasks/missing/run', { method: 'POST', body: '{}' })).status).toBe(404)
    expect((await route(handler, '/api/v1/scheduled-tasks/missing', { method: 'PATCH', body: '{}' })).status).toBe(404)
    expect((await route(handler, '/api/v1/scheduled-tasks', { method: 'PUT', body: '{}' })).status).toBe(405)
    expect((await route(handler, '/api/v1/scheduled-tasks/task-1/runs', { method: 'POST', body: '{}' })).status).toBe(405)
  })
})
