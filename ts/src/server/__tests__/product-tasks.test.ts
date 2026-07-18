import { afterEach, describe, expect, it } from 'bun:test'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import {
  ProductTaskService,
  type AgentCoreAdapter,
  type AgentCoreSession,
} from '../product/taskService.js'

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
  hasSession: (sessionId: string) => boolean
}

function makeCore(): TestCore {
  const sessions = new Map<string, AgentCoreSession>()
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
    createSession: async ({ workDir, useWorktree }) => {
      const session = add(workDir, '新任务')
      if (useWorktree) worktreeLaunchStates.set(session.id, 'planned')
      return { sessionId: session.id, workDir }
    },
    renameSession: async (sessionId, title) => {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('missing core session')
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
    hasSession: (sessionId) => sessions.has(sessionId),
  }
}

describe('ProductTaskService', () => {
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
    expect(task.title).toBe('整理本周球房活动')
    expect(task.lifecycle).toBe('active')
    expect(task.kind).toBe('main')
    expect(task.actions).toContain('archive')
    expect(task.worktreeState).toBe('planned')

    core.setWorktreeLaunchState(task.id, 'materialized')
    core.setSessionWorkDir(task.id, '/workspace/hall-operations/.claude/worktrees/desktop-task')
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

  it('keeps the continuation target fixed to the source session workspace', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })

    const continuation = await service.continueTask(task.id, {
      title: '继续整理',
      sourceTurnId: 'turn-42',
    })

    expect(continuation.title).toBe('继续整理 (Branch)')
    expect(continuation.sourceTurnId).toBe('turn-42')
    expect(continuation.workDir).toBe('/workspace/hall-operations')
    expect(core.getLastBranchInput()).toEqual({
      sessionId: task.coreSessionId,
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

    const continuation = await service.continueTask(task.id, {
      sourceTurnId: 'turn-43',
      target: 'new_worktree',
    })

    expect(core.getLastBranchInput()).toEqual({
      sessionId: task.coreSessionId,
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

    const sideTask = await service.createSideTask(task.id, {
      title: '单独核对优惠规则',
      sourceTurnId: 'turn-42',
    })

    const sideSessionId = sideTask.coreSessionId
    expect(sideTask.parentTaskId).toBe(task.id)
    expect(sideTask.sourceTurnId).toBe('turn-42')
    expect(sideSessionId).toEqual(expect.any(String))
    expect(sideTask.title).toBe('单独核对优惠规则 (Branch)')
    expect(sideTask.status).toBe('open')
    expect(sideTask.createdAt).toEqual(expect.any(String))
    expect(sideTask.updatedAt).toEqual(expect.any(String))
    expect(core.getLastBranchInput()).toEqual({
      sessionId: task.coreSessionId,
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
    expect(closed.sourceTurnId).toBe(sideTask.sourceTurnId)
    expect(closed.coreSessionId).toBe(sideSessionId)
    expect(closed.status).toBe('closed')
    expect(closed.closedAt).toEqual(expect.any(String))
    expect(closed.updatedAt).toEqual(expect.any(String))
    expect(core.hasSession(sideSessionId)).toBe(true)
    expect(await service.listSideTasks(task.id)).toEqual([closed])

    const afterClose = await service.listTasks()
    expect(afterClose.tasks.map((candidate) => candidate.id)).toEqual([task.id])
    expect(afterClose.total).toBe(1)
    expect(afterClose.projects[0]?.taskCount).toBe(1)

    const continuation = await service.continueTask(task.id, { sourceTurnId: 'turn-43' })
    const afterContinuation = await service.listTasks()
    expect(continuation.kind).toBe('continuation')
    expect(afterContinuation.tasks.map((candidate) => candidate.id)).toEqual(
      expect.arrayContaining([task.id, continuation.id]),
    )
    expect(afterContinuation.total).toBe(2)
    expect(afterContinuation.projects[0]?.taskCount).toBe(2)
  })

  it('requires a source turn for a temporary side fork', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core: makeCore(),
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })

    await expect(service.createSideTask(task.id, {} as never)).rejects.toThrow(
      'sourceTurnId 必须是字符串',
    )
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
