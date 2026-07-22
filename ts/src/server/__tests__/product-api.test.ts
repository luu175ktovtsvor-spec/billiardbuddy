import { describe, expect, it } from 'bun:test'
import { handleProductApi } from '../api/product.js'
import type { ProductTaskMediaApi } from '../product/taskMediaService.js'

const task = {
  id: 'task-1',
  projectId: 'project-1',
  directoryId: 'directory-1',
  workDir: '/workspace/hall-operations',
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
      listTasksAuthoritatively: record('listTasksAuthoritatively', {
        schemaVersion: 2,
        projects: [],
        directories: [],
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
      getTask: record('getTask'),
      getTaskThread: record('getTaskThread', { taskId: task.id, entries: [] }),
      listSideTasksAuthoritatively: record('listSideTasksAuthoritatively', [sideTask]),
      createSideTask: record('createSideTask', sideTask),
      closeSideTask: record('closeSideTask', { ...sideTask, status: 'closed' }),
      createTaskAuthoritatively: record('createTaskAuthoritatively', { task, receipt: { outcome: 'accepted', revision: 1 } }),
      mutateTaskAuthoritatively: record('mutateTaskAuthoritatively', { task, receipt: { outcome: 'accepted', revision: 1 }, snapshot: { revision: 1, event_sequence: 1, tasks: [task] } }),
      continueTaskAuthoritatively: record('continueTaskAuthoritatively', { outcome: 'accepted', revision: 1 }),
      createSideTaskAuthoritatively: record('createSideTaskAuthoritatively', { outcome: 'accepted', revision: 1 }),
      closeSideTaskAuthoritatively: record('closeSideTaskAuthoritatively', { outcome: 'accepted', revision: 1 }),
      renameTaskAuthoritatively: record('renameTaskAuthoritatively', { task, receipt: { outcome: 'accepted', revision: 1 }, snapshot: { revision: 1, event_sequence: 1, tasks: [task] }, mirror: { state: 'pending' } }),
      reconcileRenameAuthoritatively: record('reconcileRenameAuthoritatively', { state: 'reconciled' }),
      getAuthorityOperation: record('getAuthorityOperation', { receipt: { outcome: 'accepted', revision: 1 }, authority: { revision: 1, event_sequence: 1, tasks: [task] } }),
    },
  }
}

async function request(
  service: ReturnType<typeof createService>['service'],
  method: string,
  path: string,
  body?: unknown,
  media?: ProductTaskMediaApi,
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
    undefined,
    media,
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
    const { service, calls } = createService()

    const listed = await request(service, 'GET', '/api/product/tasks')
    const created = await request(service, 'POST', '/api/product/tasks', {
      workDir: '/workspace/hall-operations',
      expected_revision: 0,
      client_operation_id: 'create-request',
    })

    expect(listed.body.tasks[0]).toEqual(expect.objectContaining({ id: task.id }))
    expect(listed.body.tasks[0]).not.toHaveProperty('coreSessionId')
    expect(listed.body.tasks[0]).not.toHaveProperty('sourceTurnId')
    expect(listed.body.tasks[0]).not.toHaveProperty('parentThreadId')
    expect(created.body.receipt).toEqual({ outcome: 'accepted', revision: 1 })
    expect(created.body.authority).toEqual(expect.objectContaining({ revision: 1, tasks: [expect.objectContaining({ id: task.id })] }))
    expect(created.body.task).toEqual(expect.objectContaining({ id: task.id }))
    expect(created.body.task).not.toHaveProperty('coreSessionId')
    expect(created.body.task).not.toHaveProperty('sourceTurnId')
    expect(created.body.task).not.toHaveProperty('parentThreadId')
    const serialized = JSON.stringify({ listed: listed.body, created: created.body })
    expect(serialized).not.toContain('internal-session-1')
    expect(serialized).not.toContain('internal-turn-1')
    expect(serialized).not.toContain('internal-parent-session-1')
    expect(calls.map((call) => call.name)).toContain('createTaskAuthoritatively')
    expect(calls.map((call) => call.name)).not.toContain('createTask')
  })

  it('routes real lifecycle actions to the product task service', async () => {
    const { service, calls } = createService()

    const created = await request(service, 'POST', '/api/product/tasks', {
      workDir: '/workspace/hall-operations',
      title: '整理本周球房活动',
      expected_revision: 0,
      client_operation_id: 'create-1',
    })
    const pinned = await request(service, 'POST', '/api/product/tasks/task-1/pin', { expected_revision: 0, client_operation_id: 'pin-1' })
    const archived = await request(service, 'POST', '/api/product/tasks/task-1/archive', { expected_revision: 1, client_operation_id: 'archive-1' })

    const restored = await request(service, 'POST', '/api/product/tasks/task-1/restore', { expected_revision: 2, client_operation_id: 'restore-1' })
    expect([created, pinned, archived, restored].every((response) => response.status === (response === created ? 201 : 200))).toBeTrue()
    for (const response of [created, pinned, archived, restored]) {
      expect(response.body).toEqual(expect.objectContaining({ receipt: expect.any(Object), authority: expect.objectContaining({ revision: 1, tasks: expect.any(Array) }) }))
    }
    expect(calls.find((call) => call.name === 'createTaskAuthoritatively')?.args[0]).toEqual({ workDir: '/workspace/hall-operations', title: '整理本周球房活动', expected_revision: 0, client_operation_id: 'create-1' })
    expect(calls.filter((call) => call.name === 'mutateTaskAuthoritatively').map((call) => call.args[0])).toEqual([
      { taskId: 'task-1', patch: { pinned: true }, expected_revision: 0, client_operation_id: 'pin-1' },
      { taskId: 'task-1', patch: { archived: true }, expected_revision: 1, client_operation_id: 'archive-1' },
      { taskId: 'task-1', patch: { archived: false }, expected_revision: 2, client_operation_id: 'restore-1' },
    ])
    expect(calls.map((call) => call.name)).not.toContain('createTask')
  })

  it('routes product-thread anchored continuations to the product task service', async () => {
    const { service, calls } = createService()

    const response = await request(service, 'POST', '/api/product/tasks/task-1/continue', {
      title: '继续整理本周活动',
      sourceEntryId: 'thread_0123456789abcdef0123',
      sideTaskId: 'task-side-1',
      target: 'new_worktree',
      expected_revision: 0,
      client_operation_id: 'continue-1',
    })

    expect(response).toEqual(expect.objectContaining({ status: 201, body: expect.objectContaining({ receipt: { outcome: 'accepted', revision: 1 }, authority: expect.objectContaining({ revision: 1, tasks: expect.any(Array) }) }) }))
    const continuation = calls.find((call) => call.name === 'continueTaskAuthoritatively')!
    expect(continuation.args[0]).toEqual({ taskId: 'task-1', title: '继续整理本周活动', sourceEntryId: 'thread_0123456789abcdef0123', sideTaskId: 'task-side-1', target: 'new_worktree', expected_revision: 0, client_operation_id: 'continue-1', canonical_input: JSON.stringify({ title: '继续整理本周活动', sourceEntryId: 'thread_0123456789abcdef0123', sideTaskId: 'task-side-1', target: 'new_worktree', expected_revision: 0, client_operation_id: 'continue-1' }) })
    expect(calls.find((call) => call.name === 'getAuthorityOperation')?.args.slice(0, 2)).toEqual(['task-1', 'continue-1'])
    expect(calls.map((call) => call.name)).not.toContain('continueTask')
  })

  it('serves a task-scoped product thread instead of a Core session transcript', async () => {
    const { service, calls } = createService()

    const response = await request(service, 'GET', '/api/product/tasks/task-1/thread')

    expect(response).toEqual({ status: 200, body: { taskId: task.id, entries: [] } })
    expect(calls).toEqual([{ name: 'getTaskThread', args: ['task-1'] }])
  })

  it('routes task-scoped media listing and explicit attachment', async () => {
    const { service } = createService()
    const calls: Array<{ name: string; args: unknown[] }> = []
    const media: ProductTaskMediaApi = {
      listForTask: async (...args) => {
        calls.push({ name: 'listForTask', args })
        return { taskId: task.id, projects: [] }
      },
      listAttachableForTask: async (...args) => {
        calls.push({ name: 'listAttachableForTask', args })
        return { taskId: task.id, projects: [] }
      },
      attachProject: async (...args) => {
        calls.push({ name: 'attachProject', args })
        return {
          id: 'img_12345678',
          kind: 'image',
          title: '会员日海报',
          state: 'ready',
          updatedAt: '2026-07-19T00:00:00.000Z',
          mediaTask: null,
          assets: [],
        }
      },
      assetResponse: async (...args) => {
        calls.push({ name: 'assetResponse', args })
        return new Response('image-bytes', { status: 206, headers: { 'Content-Type': 'image/png' } })
      },
    }

    const listed = await request(service, 'GET', '/api/product/tasks/task-1/media', undefined, media)
    const attachable = await request(
      service,
      'GET',
      '/api/product/tasks/task-1/media/attachable-projects',
      undefined,
      media,
    )
    const attached = await request(
      service,
      'POST',
      '/api/product/tasks/task-1/media/projects/img_12345678/attach',
      undefined,
      media,
    )
    const assetUrl = new URL('http://localhost/api/product/tasks/task-1/media/projects/img_12345678/assets/out_12345678')
    const asset = await handleProductApi(
      new Request(assetUrl),
      assetUrl,
      assetUrl.pathname.split('/').filter(Boolean),
      service,
      undefined,
      media,
    )
    expect(listed).toEqual({ status: 200, body: { taskId: task.id, projects: [] } })
    expect(attachable).toEqual({ status: 200, body: { taskId: task.id, projects: [] } })
    expect(attached).toEqual({
      status: 200,
      body: {
        project: expect.objectContaining({ id: 'img_12345678', kind: 'image', assets: [] }),
      },
    })
    expect(asset.status).toBe(206)
    expect(await asset.text()).toBe('image-bytes')
    expect(calls).toEqual([
      { name: 'listForTask', args: [task.id] },
      { name: 'listAttachableForTask', args: [task.id] },
      { name: 'attachProject', args: [task.id, 'img_12345678'] },
      { name: 'assetResponse', args: [task.id, 'img_12345678', 'out_12345678', expect.any(Request)] },
    ])
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
      sideTaskId: 'task-side-1',
      expected_revision: 0,
      client_operation_id: 'side-create-1',
    })
    const closed = await request(
      service,
      'POST',
      '/api/product/tasks/task-1/side-tasks/side-task-1/close',
      { expected_revision: 1, client_operation_id: 'side-close-1' },
    )

    expect(listed.body.sideTasks[0]).toEqual(expect.objectContaining({ taskId: sideTask.taskId }))
    expect(created).toEqual(expect.objectContaining({ status: 201, body: expect.objectContaining({ receipt: { outcome: 'accepted', revision: 1 }, authority: expect.objectContaining({ revision: 1, tasks: expect.any(Array) }) }) }))
    expect(closed).toEqual(expect.objectContaining({ status: 200, body: expect.objectContaining({ receipt: { outcome: 'accepted', revision: 1 }, authority: expect.objectContaining({ revision: 1, tasks: expect.any(Array) }) }) }))
    expect(calls.find((call) => call.name === 'createSideTaskAuthoritatively')?.args[0]).toEqual({ taskId: 'task-1', sideTaskId: 'task-side-1', title: '单独核对优惠规则', sourceEntryId: 'thread_0123456789abcdef0123', expected_revision: 0, client_operation_id: 'side-create-1', canonical_input: JSON.stringify({ title: '单独核对优惠规则', sourceEntryId: 'thread_0123456789abcdef0123', sideTaskId: 'task-side-1', expected_revision: 0, client_operation_id: 'side-create-1' }) })
    expect(calls.find((call) => call.name === 'closeSideTaskAuthoritatively')?.args[0]).toEqual({ taskId: 'task-1', sideTaskId: 'side-task-1', expected_revision: 1, client_operation_id: 'side-close-1', canonical_input: JSON.stringify({ expected_revision: 1, client_operation_id: 'side-close-1' }) })
    expect(calls.map((call) => call.name)).not.toContain('createSideTask')
    expect(calls.map((call) => call.name)).not.toContain('closeSideTask')
    expect(JSON.stringify({ listed: listed.body, created: created.body, closed: closed.body })).not.toContain('coreSessionId')
  })
})
