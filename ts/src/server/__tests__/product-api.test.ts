import { describe, expect, it } from 'bun:test'
import { handleProductApi } from '../api/product.js'

const task = {
  id: 'task-1',
  title: '整理本周球房活动',
  lifecycle: 'active',
  actions: ['archive'],
}

function createService() {
  const calls: Array<{ name: string; args: unknown[] }> = []
  const record = (name: string, value = task) => async (...args: unknown[]) => {
    calls.push({ name, args })
    return value
  }

  return {
    calls,
    service: {
      listTasks: record('listTasks', {
        schemaVersion: 1,
        projects: [],
        workspaces: [],
        worktrees: [],
        tasks: [task],
        total: 1,
        capabilities: { createTask: true },
      }),
      createTask: record('createTask'),
      updateTask: record('updateTask'),
      setPinned: record('setPinned'),
      setArchived: record('setArchived'),
      continueTask: record('continueTask'),
    },
  }
}

async function request(
  service: ReturnType<typeof createService>['service'],
  method: string,
  path: string,
  body?: unknown,
) {
  const url = new URL(`http://localhost${path}`)
  const response = await handleProductApi(
    new Request(url, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    url,
    url.pathname.split('/').filter(Boolean),
    service,
  )
  return { status: response.status, body: await response.json() }
}

describe('Product tasks API', () => {
  it('routes real lifecycle actions to the product task service', async () => {
    const { service, calls } = createService()

    const created = await request(service, 'POST', '/api/product/tasks', {
      workDir: '/workspace/hall-operations',
      title: '整理本周球房活动',
    })
    const pinned = await request(service, 'POST', '/api/product/tasks/task-1/pin', {})
    const archived = await request(service, 'POST', '/api/product/tasks/task-1/archive', {})

    expect(created.status).toBe(201)
    expect(pinned.status).toBe(200)
    expect(archived.status).toBe(200)
    expect(calls).toEqual([
      { name: 'createTask', args: [{ workDir: '/workspace/hall-operations', title: '整理本周球房活动' }] },
      { name: 'setPinned', args: ['task-1', true] },
      { name: 'setArchived', args: ['task-1', true] },
    ])
  })

  it('routes message continuations to the product task service', async () => {
    const { service, calls } = createService()

    const response = await request(service, 'POST', '/api/product/tasks/task-1/continue', {
      title: '继续整理本周活动',
      sourceTurnId: 'transcript-turn-42',
    })

    expect(response.status).toBe(201)
    expect(calls).toEqual([
      {
        name: 'continueTask',
        args: ['task-1', {
          title: '继续整理本周活动',
          sourceTurnId: 'transcript-turn-42',
        }],
      },
    ])
  })

  it('does not expose an unconsumed side-task endpoint', async () => {
    const { service, calls } = createService()

    const response = await request(service, 'POST', '/api/product/tasks/task-1/side-tasks', {})

    expect(response.status).toBe(404)
    expect(response.body).toEqual({
      error: 'NOT_FOUND',
      message: '未知任务操作：side-tasks',
    })
    expect(calls).toEqual([])
  })
})
