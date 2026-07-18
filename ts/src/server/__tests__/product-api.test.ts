import { describe, expect, it } from 'bun:test'
import { handleProductApi } from '../api/product.js'

const task = {
  id: 'task-1',
  title: '整理本周球房活动',
  lifecycle: 'active',
  actions: ['archive'],
}

const sideTask = {
  id: 'side-task-1',
  parentTaskId: task.id,
  sourceTurnId: 'transcript-turn-42',
  coreSessionId: 'session-side-1',
  title: '单独核对优惠规则',
  status: 'open',
  createdAt: '2026-07-19T00:00:00.000Z',
  updatedAt: '2026-07-19T00:00:00.000Z',
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
      listSideTasks: record('listSideTasks', [sideTask]),
      createSideTask: record('createSideTask', sideTask),
      closeSideTask: record('closeSideTask', { ...sideTask, status: 'closed' }),
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
      target: 'new_worktree',
    })

    expect(response.status).toBe(201)
    expect(calls).toEqual([
      {
        name: 'continueTask',
        args: ['task-1', {
          title: '继续整理本周活动',
          sourceTurnId: 'transcript-turn-42',
          target: 'new_worktree',
        }],
      },
    ])
  })

  it('routes temporary side-task lifecycle actions separately from normal tasks', async () => {
    const { service, calls } = createService()

    const listed = await request(service, 'GET', '/api/product/tasks/task-1/side-tasks')
    const created = await request(service, 'POST', '/api/product/tasks/task-1/side-tasks', {
      title: '单独核对优惠规则',
      sourceTurnId: 'transcript-turn-42',
    })
    const closed = await request(
      service,
      'POST',
      '/api/product/tasks/task-1/side-tasks/side-task-1/close',
      {},
    )

    expect(listed).toEqual({ status: 200, body: { sideTasks: [sideTask] } })
    expect(created).toEqual({ status: 201, body: { sideTask } })
    expect(closed).toEqual({
      status: 200,
      body: { sideTask: { ...sideTask, status: 'closed' } },
    })
    expect(calls).toEqual([
      { name: 'listSideTasks', args: ['task-1'] },
      {
        name: 'createSideTask',
        args: ['task-1', {
          title: '单独核对优惠规则',
          sourceTurnId: 'transcript-turn-42',
        }],
      },
      { name: 'closeSideTask', args: ['task-1', 'side-task-1'] },
    ])
  })
})
