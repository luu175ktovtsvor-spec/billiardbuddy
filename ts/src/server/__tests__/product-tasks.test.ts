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

function makeCore(): AgentCoreAdapter {
  const sessions = new Map<string, AgentCoreSession>()
  let nextId = 0

  const add = (workDir: string, title: string): AgentCoreSession => {
    const now = new Date(1_700_000_000_000 + nextId * 1_000).toISOString()
    const id = `session-${++nextId}`
    const session: AgentCoreSession = {
      id,
      title,
      createdAt: now,
      modifiedAt: now,
      projectRoot: workDir,
      workDir,
    }
    sessions.set(id, session)
    return session
  }

  return {
    listSessions: async () => [...sessions.values()],
    createSession: async ({ workDir }) => {
      const session = add(workDir, '新任务')
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
    branchSession: async (sessionId, title) => {
      const source = sessions.get(sessionId)
      if (!source) throw new Error('missing core session')
      const session = add(source.workDir ?? '', title ?? `继续：${source.title}`)
      return { sessionId: session.id, workDir: session.workDir ?? '' }
    },
  }
}

describe('ProductTaskService', () => {
  it('keeps BilliardBuddy task lifecycle metadata outside the Agent core sessions', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core: makeCore(),
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

    const index = await service.listTasks()
    expect(index.projects).toHaveLength(1)
    expect(index.projects[0]?.taskCount).toBe(2)
    expect(index.tasks).toHaveLength(2)
    expect(index.total).toBe(2)
  })

  it('keeps the continuation target fixed to the source session workspace', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core: makeCore(),
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })

    const continuation = await service.continueTask(task.id, { title: '继续整理' })

    expect(continuation.title).toBe('继续整理')
    expect(continuation.workDir).toBe('/workspace/hall-operations')
  })
})
