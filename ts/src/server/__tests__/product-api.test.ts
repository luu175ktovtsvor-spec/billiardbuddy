import { describe, expect, it } from 'bun:test'
import { handleProductApi } from '../api/product.js'

const task = {
  id: 'task-1',
  title: '整理本周球房活动',
  coreSessionId: 'internal-session-1',
  sourceTurnId: 'internal-turn-1',
  parentThreadId: 'internal-parent-session-1',
  lifecycle: 'active',
  actions: ['archive'],
}

const sideTask = {
  id: 'side-task-1',
  parentTaskId: task.id,
  taskId: 'task-side-1',
  sourceTurnId: 'transcript-turn-42',
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
  const recentProjects = {
    projects: [{
      projectPath: '/workspace/hall-operations',
      realPath: '/workspace/hall-operations',
      projectName: 'hall-operations',
      isGit: true,
      repoName: 'BilliardBuddy/hall-operations',
      branch: 'main',
      modifiedAt: '2026-07-19T00:00:00.000Z',
      sessionCount: 2,
      coreSessionId: 'internal-session-1',
    }],
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
      listRecentProjects: record('listRecentProjects', recentProjects),
      createTask: record('createTask'),
      updateTask: record('updateTask'),
      setPinned: record('setPinned'),
      setArchived: record('setArchived'),
      continueTask: record('continueTask'),
      getTaskThread: record('getTaskThread', { taskId: task.id, entries: [] }),
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
  it('serves recent projects from the product task service without Core bindings', async () => {
    const { service, calls } = createService()

    const response = await request(service, 'GET', '/api/product/projects/recent?limit=20')

    expect(response).toEqual({
      status: 200,
      body: {
        projects: [expect.objectContaining({
          projectPath: '/workspace/hall-operations',
          projectName: 'hall-operations',
          sessionCount: 2,
        })],
      },
    })
    expect(JSON.stringify(response.body)).not.toContain('internal-session-1')
    expect(response.body.projects[0]).not.toHaveProperty('coreSessionId')
    expect(calls).toEqual([{ name: 'listRecentProjects', args: [20] }])
  })

  it('does not expose the legacy Core binding in ordinary task JSON', async () => {
    const { service } = createService()

    const listed = await request(service, 'GET', '/api/product/tasks')
    const created = await request(service, 'POST', '/api/product/tasks', {
      workDir: '/workspace/hall-operations',
    })

    expect(listed.body.tasks[0]).toEqual(expect.objectContaining({ id: task.id }))
    expect(listed.body.tasks[0]).not.toHaveProperty('coreSessionId')
    expect(listed.body.tasks[0]).not.toHaveProperty('sourceTurnId')
    expect(listed.body.tasks[0]).not.toHaveProperty('parentThreadId')
    expect(created.body.task).toEqual(expect.objectContaining({ id: task.id }))
    expect(created.body.task).not.toHaveProperty('coreSessionId')
    expect(created.body.task).not.toHaveProperty('sourceTurnId')
    expect(created.body.task).not.toHaveProperty('parentThreadId')
    const serialized = JSON.stringify({ listed: listed.body, created: created.body })
    expect(serialized).not.toContain('internal-session-1')
    expect(serialized).not.toContain('internal-turn-1')
    expect(serialized).not.toContain('internal-parent-session-1')
  })

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

  it('routes product-thread anchored continuations to the product task service', async () => {
    const { service, calls } = createService()

    const response = await request(service, 'POST', '/api/product/tasks/task-1/continue', {
      title: '继续整理本周活动',
      sourceEntryId: 'thread_0123456789abcdef0123',
      target: 'new_worktree',
    })

    expect(response.status).toBe(201)
    expect(calls).toEqual([
      {
        name: 'continueTask',
        args: ['task-1', {
          title: '继续整理本周活动',
          sourceEntryId: 'thread_0123456789abcdef0123',
          target: 'new_worktree',
        }],
      },
    ])
  })

  it('serves a task-scoped product thread instead of a Core session transcript', async () => {
    const { service, calls } = createService()

    const response = await request(service, 'GET', '/api/product/tasks/task-1/thread')

    expect(response).toEqual({ status: 200, body: { taskId: task.id, entries: [] } })
    expect(calls).toEqual([{ name: 'getTaskThread', args: ['task-1'] }])
  })

  it('routes task-scoped review resources without falling back to session APIs', async () => {
    const { service } = createService()
    const calls: Array<{ name: string; args: unknown[] }> = []
    const review = {
      getStatus: async (...args: unknown[]) => {
        calls.push({ name: 'getStatus', args })
        return { taskId: task.id, state: 'ready' as const, repository: null, changedFiles: [] }
      },
      getTree: async (...args: unknown[]) => {
        calls.push({ name: 'getTree', args })
        return { taskId: task.id, state: 'ok' as const, path: 'src', entries: [] }
      },
      getFile: async (...args: unknown[]) => {
        calls.push({ name: 'getFile', args })
        return {
          taskId: task.id,
          state: 'ok' as const,
          path: 'assets/replay.webm',
          previewType: 'video' as const,
          dataUrl: 'data:video/webm;base64,AAAA',
          mimeType: 'video/webm',
          language: 'video',
          size: 3,
        }
      },
      getDiff: async (...args: unknown[]) => {
        calls.push({ name: 'getDiff', args })
        return { taskId: task.id, state: 'missing' as const, path: 'src/price.ts' }
      },
    }

    const callReviewRoute = async (path: string) => {
      const url = new URL(`http://localhost${path}`)
      const response = await handleProductApi(
        new Request(url),
        url,
        url.pathname.split('/').filter(Boolean),
        service,
        review,
      )
      return { status: response.status, body: await response.json() }
    }

    expect(await callReviewRoute('/api/product/tasks/task-1/review/status')).toEqual({
      status: 200,
      body: { taskId: task.id, state: 'ready', repository: null, changedFiles: [] },
    })
    expect(await callReviewRoute('/api/product/tasks/task-1/review/tree?path=src')).toEqual({
      status: 200,
      body: { taskId: task.id, state: 'ok', path: 'src', entries: [] },
    })
    expect(await callReviewRoute('/api/product/tasks/task-1/review/file?path=assets%2Freplay.webm')).toEqual({
      status: 200,
      body: {
        taskId: task.id,
        state: 'ok',
        path: 'assets/replay.webm',
        previewType: 'video',
        dataUrl: 'data:video/webm;base64,AAAA',
        mimeType: 'video/webm',
        language: 'video',
        size: 3,
      },
    })
    expect(await callReviewRoute('/api/product/tasks/task-1/review/diff?path=src%2Fprice.ts')).toEqual({
      status: 200,
      body: { taskId: task.id, state: 'missing', path: 'src/price.ts' },
    })
    expect(calls).toEqual([
      { name: 'getStatus', args: ['task-1'] },
      { name: 'getTree', args: ['task-1', 'src'] },
      { name: 'getFile', args: ['task-1', 'assets/replay.webm'] },
      { name: 'getDiff', args: ['task-1', 'src/price.ts'] },
    ])
  })

  it('routes temporary side-task lifecycle actions separately from normal tasks', async () => {
    const { service, calls } = createService()

    const listed = await request(service, 'GET', '/api/product/tasks/task-1/side-tasks')
    const created = await request(service, 'POST', '/api/product/tasks/task-1/side-tasks', {
      title: '单独核对优惠规则',
      sourceEntryId: 'thread_0123456789abcdef0123',
    })
    const closed = await request(
      service,
      'POST',
      '/api/product/tasks/task-1/side-tasks/side-task-1/close',
      {},
    )

    const publicSideTask = {
      id: sideTask.id,
      parentTaskId: sideTask.parentTaskId,
      taskId: sideTask.taskId,
      title: sideTask.title,
      status: sideTask.status,
      createdAt: sideTask.createdAt,
      updatedAt: sideTask.updatedAt,
    }
    expect(listed).toEqual({ status: 200, body: { sideTasks: [publicSideTask] } })
    expect(created).toEqual({ status: 201, body: { sideTask: publicSideTask } })
    expect(closed).toEqual({
      status: 200,
      body: { sideTask: { ...publicSideTask, status: 'closed' } },
    })
    expect(listed.body.sideTasks[0]).toEqual(expect.objectContaining({ taskId: sideTask.taskId }))
    expect(JSON.stringify({ listed: listed.body, created: created.body, closed: closed.body }))
      .not.toContain('coreSessionId')
    expect(JSON.stringify({ listed: listed.body, created: created.body, closed: closed.body }))
      .not.toContain('sourceTurnId')
    expect(JSON.stringify({ listed: listed.body, created: created.body, closed: closed.body }))
      .not.toContain('transcript-turn-42')
    expect(calls).toEqual([
      { name: 'listSideTasks', args: ['task-1'] },
      {
        name: 'createSideTask',
        args: ['task-1', {
          title: '单独核对优惠规则',
          sourceEntryId: 'thread_0123456789abcdef0123',
        }],
      },
      { name: 'closeSideTask', args: ['task-1', 'side-task-1'] },
    ])
  })
})
