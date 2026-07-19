import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ProductTaskService,
  type AgentCoreAdapter,
  type AgentCoreSession,
} from '../product/taskService.js'
import type { MessageEntry } from '../services/sessionService.js'

let tempDir: string | undefined

afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
  tempDir = undefined
})

type TestCore = AgentCoreAdapter & {
  setWorktreeLaunchState: (
    sessionId: string,
    state: Awaited<ReturnType<AgentCoreAdapter['getWorktreeLaunchState']>>,
  ) => void
  setSessionWorkDir: (sessionId: string, workDir: string) => void
  getWorktreeLaunchCallCount: () => number
  getLastBranchInput: () => {
    sessionId: string
    title?: string
    sourceTurnId?: string
    target?: Parameters<AgentCoreAdapter['branchSession']>[3]
  } | null
  getLastCreateInput: () => Parameters<AgentCoreAdapter['createSession']>[0] | null
  getLastRenameInput: () => { sessionId: string; title: string } | null
  hasSession: (sessionId: string) => boolean
  setSessionMessages: (sessionId: string, messages: MessageEntry[]) => void
}

function makeCore(): TestCore {
  const sessions = new Map<string, AgentCoreSession>()
  const sessionMessages = new Map<string, MessageEntry[]>()
  const worktreeLaunchStates = new Map<
    string,
    Awaited<ReturnType<AgentCoreAdapter['getWorktreeLaunchState']>>
  >()
  let nextId = 0
  let worktreeLaunchCallCount = 0
  let lastBranchInput: {
    sessionId: string
    title?: string
    sourceTurnId?: string
    target?: Parameters<AgentCoreAdapter['branchSession']>[3]
  } | null = null
  let lastCreateInput: Parameters<AgentCoreAdapter['createSession']>[0] | null = null
  let lastRenameInput: { sessionId: string; title: string } | null = null

  const add = (workDir: string, title: string, projectRoot = workDir): AgentCoreSession => {
    const now = new Date(1_700_000_000_000 + nextId * 1_000).toISOString()
    const id = `session-${++nextId}`
    const session: AgentCoreSession = {
      id,
      title,
      createdAt: now,
      modifiedAt: now,
      projectRoot,
      workDir,
    }
    sessions.set(id, session)
    return session
  }

  return {
    listSessions: async () => [...sessions.values()],
    createSession: async ({ workDir, useWorktree, ...input }) => {
      lastCreateInput = { workDir, useWorktree, ...input }
      const session = add(workDir, '新任务')
      if (useWorktree) worktreeLaunchStates.set(session.id, 'planned')
      return { sessionId: session.id, workDir }
    },
    renameSession: async (sessionId, title) => {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('missing core session')
      lastRenameInput = { sessionId, title }
      sessions.set(sessionId, {
        ...session,
        title,
        modifiedAt: new Date(Date.parse(session.modifiedAt) + 1_000).toISOString(),
      })
    },
    branchSession: async (sessionId, title, sourceTurnId, target) => {
      const source = sessions.get(sessionId)
      if (!source) throw new Error('missing core session')
      lastBranchInput = {
        sessionId,
        title,
        sourceTurnId,
        ...(target === undefined ? {} : { target }),
      }
      const useNewWorktree = target === 'new_worktree'
      const branchWorkDir = useNewWorktree
        ? `${source.projectRoot ?? source.workDir ?? ''}/.claude/worktrees/desktop-continuation-${nextId + 1}`
        : source.workDir ?? ''
      const session = add(
        branchWorkDir,
        `${title ?? `继续：${source.title}`} (Branch)`,
        source.projectRoot ?? source.workDir ?? '',
      )
      if (useNewWorktree) {
        worktreeLaunchStates.set(session.id, 'materialized')
      } else {
        const worktreeState = worktreeLaunchStates.get(sessionId)
        if (worktreeState) worktreeLaunchStates.set(session.id, worktreeState)
      }
      return { sessionId: session.id, workDir: session.workDir ?? '', title: session.title }
    },
    getWorktreeLaunchState: async (sessionId) => {
      worktreeLaunchCallCount += 1
      return worktreeLaunchStates.get(sessionId) ?? 'not_requested'
    },
    getSessionMessages: async (sessionId) => sessionMessages.get(sessionId) ?? [],
    setWorktreeLaunchState: (sessionId, state) => {
      worktreeLaunchStates.set(sessionId, state)
    },
    setSessionWorkDir: (sessionId, workDir) => {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('missing core session')
      sessions.set(sessionId, { ...session, workDir })
    },
    getWorktreeLaunchCallCount: () => worktreeLaunchCallCount,
    getLastBranchInput: () => lastBranchInput,
    getLastCreateInput: () => lastCreateInput,
    getLastRenameInput: () => lastRenameInput,
    hasSession: (sessionId) => sessions.has(sessionId),
    setSessionMessages: (sessionId, messages) => {
      sessionMessages.set(sessionId, messages)
    },
  }
}

async function productThreadEntryId(
  service: ProductTaskService,
  taskId: string,
): Promise<string> {
  const entry = (await service.getTaskThread(taskId)).entries.find(
    (candidate) => candidate.type === 'user_text' || candidate.type === 'assistant_text',
  )
  if (!entry) throw new Error('expected product thread entry')
  return entry.id
}

function sourceMessage(id: string, text = '从这条消息继续'): MessageEntry {
  return {
    id,
    type: 'user',
    content: text,
    timestamp: '2026-07-19T08:00:00.000Z',
  }
}

function legacyProductTaskIdForTest(coreSessionId: string): string {
  return `task_${createHash('sha256').update(coreSessionId).digest('hex').slice(0, 16)}`
}

describe('ProductTaskService', () => {
  it('derives recent picker projects from registered product tasks only', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const visibleWorkDir = path.join(tempDir, 'hall-operations')
    const hiddenCoreWorkDir = path.join(tempDir, 'core-only')
    await fs.mkdir(visibleWorkDir)
    await fs.mkdir(hiddenCoreWorkDir)

    // Complete the one-time legacy import before a later Core-only session
    // appears; it must not silently become a product directory choice.
    await service.listTasks()
    const hiddenCore = await core.createSession({ workDir: hiddenCoreWorkDir })
    await service.createTask({ workDir: visibleWorkDir })

    const recent = await service.listRecentProjects(20)

    expect(recent).toEqual({
      projects: [{
        projectPath: visibleWorkDir,
        realPath: await fs.realpath(visibleWorkDir),
        projectName: 'hall-operations',
        isGit: false,
        repoName: null,
        branch: null,
        modifiedAt: expect.any(String),
        sessionCount: 1,
      }],
    })
    expect(JSON.stringify(recent)).not.toContain(hiddenCore.sessionId)
    expect(JSON.stringify(recent)).not.toContain(hiddenCoreWorkDir)
  })

  it('does not expose the Core binding in public task records', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })

    const task = await service.createTask({ workDir: '/workspace/hall-operations' })
    const coreSessionId = await service.resolveCoreSessionId(task.id)
    expect(task).not.toHaveProperty('coreSessionId')
    expect(task.id).toMatch(/^task_/)
    expect(task.id).not.toBe(coreSessionId)
    expect(coreSessionId).toBe('session-1')
    expect(await service.getTaskThread(task.id)).toEqual({ taskId: task.id, entries: [] })
    await expect(service.resolveCoreSessionId(coreSessionId)).rejects.toThrow(`任务不存在：${coreSessionId}`)

    await service.updateTask(task.id, { title: '整理本周球房活动' })
    expect(core.getLastRenameInput()).toEqual({
      sessionId: coreSessionId,
      title: '整理本周球房活动',
    })

    const listed = await service.listTasks()
    expect(listed.tasks[0]).not.toHaveProperty('coreSessionId')
    expect(JSON.parse(JSON.stringify(listed))).not.toHaveProperty('tasks.0.coreSessionId')
    expect(JSON.stringify({ task, listed })).not.toContain(coreSessionId)
  })

  it('maps supported product execution choices to Core permission modes', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })

    const cases = [
      { permissionMode: undefined, corePermissionMode: 'default' },
      { permissionMode: 'allow_edits', corePermissionMode: 'acceptEdits' },
      { permissionMode: 'plan_only', corePermissionMode: 'plan' },
    ] as const

    for (const [index, entry] of cases.entries()) {
      const task = await service.createTask({
        workDir: `/workspace/hall-operations-${index}`,
        ...(entry.permissionMode ? { permissionMode: entry.permissionMode } : {}),
      })

      expect(core.getLastCreateInput()).toEqual({
        workDir: `/workspace/hall-operations-${index}`,
        useWorktree: undefined,
        permissionMode: entry.corePermissionMode,
      })
      expect(task).not.toHaveProperty('permissionMode')
    }
  })

  it('rejects raw or unsafe Core permission values before creating a product task', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })

    await expect(service.createTask({
      workDir: '/workspace/hall-operations',
      permissionMode: 'bypassPermissions',
    } as unknown as Parameters<ProductTaskService['createTask']>[0])).rejects.toThrow(
      'permissionMode 必须是 ask、allow_edits、plan_only 之一',
    )

    expect(core.getLastCreateInput()).toBeNull()
  })

  it('keeps BilliardBuddy task lifecycle metadata outside the Agent core sessions', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })

    const task = await service.createTask({
      workDir: '/workspace/hall-operations',
      title: '整理本周球房活动',
      useWorktree: true,
    })
    const coreSessionId = await service.resolveCoreSessionId(task.id)
    expect(task.title).toBe('整理本周球房活动')
    expect(task.lifecycle).toBe('active')
    expect(task.kind).toBe('main')
    expect(task.actions).toContain('archive')
    expect(task.worktreeState).toBe('planned')

    core.setWorktreeLaunchState(coreSessionId, 'materialized')
    core.setSessionWorkDir(coreSessionId, '/workspace/hall-operations/.claude/worktrees/desktop-task')
    const materialized = (await service.listTasks()).tasks.find((candidate) => candidate.id === task.id)
    expect(materialized?.worktreeState).toBe('materialized')
    expect(materialized?.workDir).toBe('/workspace/hall-operations/.claude/worktrees/desktop-task')

    await service.setPinned(task.id, true)
    await service.setArchived(task.id, true)
    const archived = (await service.listTasks()).tasks.find((candidate) => candidate.id === task.id)
    expect(archived?.pinnedAt).toBeDefined()
    expect(archived?.lifecycle).toBe('archived')
    expect(archived?.actions).toEqual(['restore', 'continue'])

    await service.setArchived(task.id, false)
    const continuation = await service.continueTask(task.id, {})
    expect(continuation.parentTaskId).toBe(task.id)
    expect(continuation.kind).toBe('continuation')
    expect(continuation.worktreeState).toBe('materialized')

    const index = await service.listTasks()
    expect(index.projects).toHaveLength(1)
    expect(index.projects[0]?.workDir).toBe('/workspace/hall-operations')
    expect(index.projects[0]?.taskCount).toBe(2)
    expect(index.tasks).toHaveLength(2)
    expect(index.total).toBe(2)
  })

  it('imports legacy Core sessions once, then indexes only the product task registry', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const storagePath = path.join(tempDir, 'product-tasks.json')
    const legacy = await core.createSession({ workDir: '/workspace/imported-legacy' })
    const service = new ProductTaskService({ storagePath, core })

    const firstIndex = await service.listTasks()
    expect(firstIndex.tasks).toHaveLength(1)
    expect(firstIndex.tasks[0]?.id).toBe(legacyProductTaskIdForTest(legacy.sessionId))
    expect(JSON.stringify(firstIndex)).not.toContain(legacy.sessionId)

    const persistedAfterImport = JSON.parse(await fs.readFile(storagePath, 'utf8')) as {
      version: number
      legacyCoreSessionsImportedAt?: string
      tasks: Record<string, { coreSessionId?: string }>
    }
    expect(persistedAfterImport.version).toBe(3)
    expect(persistedAfterImport.legacyCoreSessionsImportedAt).toEqual(expect.any(String))
    expect(persistedAfterImport.tasks[firstIndex.tasks[0]!.id]?.coreSessionId).toBe(legacy.sessionId)

    const laterCoreSession = await core.createSession({ workDir: '/workspace/late-core-session' })
    const secondIndex = await service.listTasks()
    expect(secondIndex.tasks.map((task) => task.id)).toEqual([firstIndex.tasks[0]!.id])
    await expect(service.resolveCoreSessionId(
      legacyProductTaskIdForTest(laterCoreSession.sessionId),
    )).rejects.toThrow(`任务不存在：${legacyProductTaskIdForTest(laterCoreSession.sessionId)}`)
  })

  it('keeps a project with an active pinned task ahead of a newer unpinned project', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })

    const pinnedTask = await service.createTask({ workDir: '/workspace/pinned-hall' })
    const newerTask = await service.createTask({ workDir: '/workspace/newer-hall' })

    await service.setPinned(pinnedTask.id, true)
    await service.updateTask(newerTask.id, { title: '最近更新但未置顶的任务' })

    const index = await service.listTasks()
    expect(index.tasks.map((task) => task.id)).toEqual([pinnedTask.id, newerTask.id])
    expect(index.projects.map((project) => project.id)).toEqual([
      pinnedTask.projectId,
      newerTask.projectId,
    ])
  })

  it('continues the complete task when no product-thread entry is supplied', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })
    const coreSessionId = await service.resolveCoreSessionId(task.id)

    const continuation = await service.continueTask(task.id, {})

    expect(continuation.parentTaskId).toBe(task.id)
    expect(continuation).not.toHaveProperty('sourceTurnId')
    expect(core.getLastBranchInput()).toEqual({
      sessionId: coreSessionId,
      title: `继续：${task.title}`,
      sourceTurnId: undefined,
      target: 'current_workspace',
    })
  })

  it('keeps the continuation target fixed to the source session workspace', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })
    const coreSessionId = await service.resolveCoreSessionId(task.id)
    core.setSessionMessages(coreSessionId, [sourceMessage('turn-42')])
    const sourceEntryId = await productThreadEntryId(service, task.id)

    const continuation = await service.continueTask(task.id, {
      title: '继续整理',
      sourceEntryId,
    })

    expect(continuation.title).toBe('继续整理 (Branch)')
    expect(continuation).not.toHaveProperty('sourceTurnId')
    expect(JSON.stringify(continuation)).not.toContain('turn-42')
    expect(continuation.workDir).toBe('/workspace/hall-operations')
    expect(core.getLastBranchInput()).toEqual({
      sessionId: coreSessionId,
      title: '继续整理',
      sourceTurnId: 'turn-42',
      target: 'current_workspace',
    })
    expect(core.getWorktreeLaunchCallCount()).toBe(0)
  })

  it('materializes a separate worktree before recording a continuation target', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })
    const coreSessionId = await service.resolveCoreSessionId(task.id)
    core.setSessionMessages(coreSessionId, [sourceMessage('turn-43')])
    const sourceEntryId = await productThreadEntryId(service, task.id)

    const continuation = await service.continueTask(task.id, {
      sourceEntryId,
      target: 'new_worktree',
    })

    expect(core.getLastBranchInput()).toEqual({
      sessionId: coreSessionId,
      title: `继续：${task.title}`,
      sourceTurnId: 'turn-43',
      target: 'new_worktree',
    })
    expect(continuation.worktreeState).toBe('materialized')
    expect(continuation.workDir).toContain('/.claude/worktrees/desktop-continuation-')
  })

  it('rejects unsupported continuation targets', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core: makeCore(),
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })

    await expect(service.continueTask(task.id, {
      target: 'elsewhere' as never,
    })).rejects.toThrow('target 必须是 current_workspace 或 new_worktree')
  })

  it('keeps temporary side forks out of the regular task index and retains their Core transcript when closed', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const task = await service.createTask({
      workDir: '/workspace/hall-operations',
      title: '整理本周球房活动',
    })
    const coreSessionId = await service.resolveCoreSessionId(task.id)
    core.setSessionMessages(coreSessionId, [
      sourceMessage('turn-42', '单独核对优惠规则'),
      sourceMessage('turn-43', '继续整理主任务'),
    ])
    const [sideTaskSourceEntryId, continuationSourceEntryId] = (await service.getTaskThread(task.id)).entries
      .filter((entry) => entry.type === 'user_text')
      .map((entry) => entry.id)

    const sideTask = await service.createSideTask(task.id, {
      title: '单独核对优惠规则',
      sourceEntryId: sideTaskSourceEntryId!,
    })

    const sideSessionId = await service.resolveCoreSessionId(sideTask.taskId)
    expect(sideTask.parentTaskId).toBe(task.id)
    expect(sideTask.taskId).toMatch(/^task_/)
    expect(sideTask.taskId).not.toBe(sideSessionId)
    expect(sideTask).not.toHaveProperty('coreSessionId')
    expect(sideTask).not.toHaveProperty('sourceTurnId')
    expect(JSON.stringify(sideTask)).not.toContain('turn-42')
    expect(sideSessionId).toEqual(expect.any(String))
    expect(sideTask.title).toBe('单独核对优惠规则 (Branch)')
    expect(sideTask.status).toBe('open')
    expect(sideTask.createdAt).toEqual(expect.any(String))
    expect(sideTask.updatedAt).toEqual(expect.any(String))
    expect(core.getLastBranchInput()).toEqual({
      sessionId: coreSessionId,
      title: '单独核对优惠规则',
      sourceTurnId: 'turn-42',
    })
    expect(core.hasSession(sideSessionId)).toBe(true)
    expect(await service.listSideTasks(task.id)).toEqual([sideTask])

    const beforeClose = await service.listTasks()
    expect(beforeClose.tasks.map((candidate) => candidate.id)).toEqual([task.id])
    expect(beforeClose.total).toBe(1)
    expect(beforeClose.projects[0]?.taskCount).toBe(1)

    const closed = await service.closeSideTask(task.id, sideTask.id)
    expect(closed.parentTaskId).toBe(sideTask.parentTaskId)
    expect(closed.taskId).toBe(sideTask.taskId)
    expect(closed).not.toHaveProperty('sourceTurnId')
    expect(closed).not.toHaveProperty('coreSessionId')
    expect(closed.status).toBe('closed')
    expect(closed.closedAt).toEqual(expect.any(String))
    expect(closed.updatedAt).toEqual(expect.any(String))
    expect(core.hasSession(sideSessionId)).toBe(true)
    expect(await service.listSideTasks(task.id)).toEqual([closed])

    const afterClose = await service.listTasks()
    expect(afterClose.tasks.map((candidate) => candidate.id)).toEqual([task.id])
    expect(afterClose.total).toBe(1)
    expect(afterClose.projects[0]?.taskCount).toBe(1)

    const continuation = await service.continueTask(task.id, { sourceEntryId: continuationSourceEntryId! })
    const afterContinuation = await service.listTasks()
    expect(continuation.kind).toBe('continuation')
    expect(afterContinuation.tasks.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining([task.id, continuation.id]),
    )
    expect(afterContinuation.total).toBe(2)
    expect(afterContinuation.projects[0]?.taskCount).toBe(2)
  })

  it('migrates Core-keyed v1 task metadata to opaque product identifiers before returning it', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const storagePath = path.join(tempDir, 'product-tasks.json')
    const created = await core.createSession({ workDir: '/workspace/legacy-hall' })
    const createdAt = '2026-07-18T00:00:00.000Z'
    await fs.writeFile(storagePath, JSON.stringify({
      version: 1,
      tasks: {
        [created.sessionId]: {
          title: '旧版球房任务',
          lifecycle: 'active',
          kind: 'main',
          createdAt,
          updatedAt: createdAt,
          worktreeState: 'not_requested',
        },
      },
      sideTasks: {},
    }), 'utf8')
    const service = new ProductTaskService({ storagePath, core })

    const listed = await service.listTasks()
    const task = listed.tasks[0]
    expect(task).toBeDefined()
    expect(task?.id).toMatch(/^task_[a-f0-9]{16}$/)
    expect(task?.id).not.toBe(created.sessionId)
    expect(JSON.stringify(listed)).not.toContain(created.sessionId)
    expect(await service.resolveCoreSessionId(task!.id)).toBe(created.sessionId)
    await expect(service.resolveCoreSessionId(created.sessionId)).rejects.toThrow(
      `任务不存在：${created.sessionId}`,
    )

    await service.setPinned(task!.id, true)
    const persisted = JSON.parse(await fs.readFile(storagePath, 'utf8')) as {
      version: number
      tasks: Record<string, { coreSessionId?: string }>
    }
    expect(persisted.version).toBe(3)
    expect(persisted.tasks[task!.id]?.coreSessionId).toBe(created.sessionId)
  })

  it('rejects a corrupted v2 store that binds one Core session to multiple product tasks', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const storagePath = path.join(tempDir, 'product-tasks.json')
    const created = await core.createSession({ workDir: '/workspace/duplicate-binding' })
    const timestamp = '2026-07-19T00:00:00.000Z'
    const metadata = {
      coreSessionId: created.sessionId,
      lifecycle: 'active',
      kind: 'main',
      createdAt: timestamp,
      updatedAt: timestamp,
      worktreeState: 'not_requested',
      visibility: 'main',
    }
    await fs.writeFile(storagePath, JSON.stringify({
      version: 2,
      tasks: {
        'task-one': metadata,
        'task-two': { ...metadata },
      },
      sideTasks: {},
    }), 'utf8')
    const service = new ProductTaskService({ storagePath, core })

    await expect(service.listTasks()).rejects.toThrow('无法读取产品任务数据')
  })

  it('requires an opaque product-thread entry for a temporary side fork and rejects Core turn ids', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })
    const coreSessionId = await service.resolveCoreSessionId(task.id)
    core.setSessionMessages(coreSessionId, [
      sourceMessage('turn-42'),
      {
        id: 'assistant-tool-only',
        type: 'assistant',
        timestamp: '2026-07-19T08:00:01.000Z',
        content: [{
          type: 'tool_use',
          id: 'private-tool-call',
          name: 'Bash',
          input: { command: 'PRIVATE_COMMAND' },
        }],
      },
    ])
    const activityEntryId = (await service.getTaskThread(task.id)).entries
      .find((entry) => entry.type === 'activity')
      ?.id
    expect(activityEntryId).toMatch(/^thread_[a-f0-9]{20}$/)

    await expect(service.createSideTask(task.id, {} as never)).rejects.toThrow(
      'sourceEntryId 必须是字符串',
    )
    await expect(service.createSideTask(task.id, {
      sourceEntryId: 'turn-42',
    })).rejects.toThrow('sourceEntryId 格式不正确')
    await expect(service.createSideTask(task.id, {
      sourceEntryId: 'thread_0123456789abcdef0123',
      sourceTurnId: 'turn-42',
    } as never)).rejects.toThrow('产品接口不支持 sourceTurnId；请使用 sourceEntryId')
    await expect(service.continueTask(task.id, {
      sourceTurnId: 'turn-42',
    } as never)).rejects.toThrow('产品接口不支持 sourceTurnId；请使用 sourceEntryId')
    await expect(service.createSideTask(task.id, {
      sourceEntryId: 'thread_0123456789abcdef0123',
    })).rejects.toThrow('请选择当前任务中的一条已保存消息')
    await expect(service.createSideTask(task.id, {
      sourceEntryId: activityEntryId!,
    })).rejects.toThrow('请选择当前任务中的一条已保存消息')
    expect(core.getLastBranchInput()).toBeNull()
  })

  it('keeps a requested worktree planned when the core status cannot be read', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    core.getWorktreeLaunchState = async () => {
      throw new Error('core metadata unavailable')
    }
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })

    const task = await service.createTask({
      workDir: '/workspace/hall-operations',
      useWorktree: true,
    })

    expect(task.worktreeState).toBe('planned')
  })
})
