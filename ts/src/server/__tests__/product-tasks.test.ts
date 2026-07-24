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
import { ProductTaskRunProjection } from '../product/taskRunProjection.js'
import { ProductTaskAuthorityRepository } from '../product/authorityRepository.js'
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
  setSessionProjectRoot: (sessionId: string, projectRoot: string) => void
  setSessionModifiedAt: (sessionId: string, modifiedAt: string) => void
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
    setSessionProjectRoot: (sessionId, projectRoot) => {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('missing core session')
      sessions.set(sessionId, { ...session, projectRoot })
    },
    setSessionModifiedAt: (sessionId, modifiedAt) => {
      const session = sessions.get(sessionId)
      if (!session) throw new Error('missing core session')
      sessions.set(sessionId, { ...session, modifiedAt })
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

async function createNestedGitProject(name: string): Promise<{
  rootDir: string
  sourceDir: string
}> {
  if (!tempDir) throw new Error('temporary directory has not been created')
  const rootDir = path.join(tempDir, name)
  const sourceDir = path.join(rootDir, 'subdir')
  await fs.mkdir(sourceDir, { recursive: true })
  // The root resolver recognizes both normal `.git` directories and worktree
  // `.git` files, so a minimal regular-repository marker is sufficient here.
  await fs.mkdir(path.join(rootDir, '.git'))
  return {
    rootDir: await fs.realpath(rootDir),
    sourceDir: await fs.realpath(sourceDir),
  }
}

describe('ProductTaskService', () => {
  it('registers a raw nested directory under its git project root with opaque IDs', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const storagePath = path.join(tempDir, 'product-tasks.json')
    const service = new ProductTaskService({ storagePath, core })
    const { rootDir, sourceDir } = await createNestedGitProject('hall-operations')

    const task = await service.createTask({ workDir: sourceDir })

    expect(task.projectId).toMatch(/^project_/)
    expect(task.directoryId).toMatch(/^directory_/)
    expect(task.workDir).toBe(sourceDir)
    expect(core.getLastCreateInput()).toMatchObject({ workDir: sourceDir })

    const index = await service.listTasks()
    expect(index.schemaVersion).toBe(2)
    expect(index.projects).toEqual([
      expect.objectContaining({
        id: task.projectId,
        rootDir,
      }),
    ])
    expect(index.directories).toEqual([
      expect.objectContaining({
        id: task.directoryId,
        projectId: task.projectId,
        path: sourceDir,
      }),
    ])

    const persisted = JSON.parse(await fs.readFile(storagePath, 'utf8')) as {
      projects: Record<string, { rootDir: string }>
      directories: Record<string, { projectId: string; path: string }>
    }
    expect(persisted.projects[task.projectId]).toEqual(expect.objectContaining({ rootDir }))
    expect(persisted.directories[task.directoryId]).toEqual(expect.objectContaining({
      projectId: task.projectId,
      path: sourceDir,
    }))
  })

  it('serializes concurrent first task creation without losing registry bindings', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const originalCreateSession = core.createSession
    let createCount = 0
    let markFirstCreateStarted: (() => void) | undefined
    let releaseFirstCreate: (() => void) | undefined
    const firstCreateStarted = new Promise<void>((resolve) => {
      markFirstCreateStarted = resolve
    })
    const firstCreateGate = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve
    })
    core.createSession = async (input) => {
      const created = await originalCreateSession(input)
      createCount += 1
      if (createCount === 1) {
        markFirstCreateStarted?.()
        await firstCreateGate
      }
      return created
    }
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })

    const first = service.createTask({ workDir: '/workspace/hall-operations' })
    await firstCreateStarted
    const second = service.createTask({ workDir: '/workspace/academy' })
    releaseFirstCreate?.()
    const [firstTask, secondTask] = await Promise.all([first, second])

    expect(createCount).toBe(2)
    const index = await service.listTasks()
    expect(index.tasks.map((task) => task.id)).toEqual(
      expect.arrayContaining([firstTask.id, secondTask.id]),
    )
    expect(index.total).toBe(2)
    expect(index.projects).toHaveLength(2)
    expect(index.directories).toHaveLength(2)
  })

  it('uses a registered project and directory pair instead of a conflicting raw workDir', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const { sourceDir } = await createNestedGitProject('hall-operations')
    const ignoredWorkDir = path.join(tempDir, 'do-not-use-this-directory')
    await fs.mkdir(ignoredWorkDir)
    const source = await service.createTask({ workDir: sourceDir })

    const task = await service.createTask({
      projectId: source.projectId,
      directoryId: source.directoryId,
      workDir: ignoredWorkDir,
    })

    expect(task.projectId).toBe(source.projectId)
    expect(task.directoryId).toBe(source.directoryId)
    expect(task.workDir).toBe(sourceDir)
    expect(core.getLastCreateInput()).toMatchObject({ workDir: sourceDir })
    const index = await service.listTasks()
    expect(index.projects).toHaveLength(1)
    expect(index.directories).toHaveLength(1)
  })

  it('rejects mismatched and one-sided project-directory identifiers before starting Core', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const hall = await service.createTask({ workDir: '/workspace/hall-operations' })
    const academy = await service.createTask({ workDir: '/workspace/academy' })
    const lastCreateInput = core.getLastCreateInput()

    await expect(service.createTask({
      projectId: hall.projectId,
      directoryId: academy.directoryId,
    })).rejects.toThrow('所选目录不属于当前项目')
    await expect(service.createTask({
      projectId: hall.projectId,
    })).rejects.toThrow('projectId 和 directoryId 必须同时提供')
    await expect(service.createTask({
      directoryId: hall.directoryId,
    })).rejects.toThrow('projectId 和 directoryId 必须同时提供')
    expect(core.getLastCreateInput()).toEqual(lastCreateInput)
  })

  it('keeps a nested source directory identity when a continuation runs in a new worktree', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const { rootDir, sourceDir } = await createNestedGitProject('hall-operations')
    const source = await service.createTask({ workDir: sourceDir })
    const sourceSessionId = await service.resolveCoreSessionId(source.id)
    core.setSessionProjectRoot(sourceSessionId, rootDir)

    const continuation = await service.continueTask(source.id, { target: 'new_worktree' })

    expect(continuation.projectId).toBe(source.projectId)
    expect(continuation.directoryId).toBe(source.directoryId)
    expect(continuation.workDir).toContain(`${rootDir}/.claude/worktrees/desktop-continuation-`)
    expect(continuation.worktreeState).toBe('materialized')

    const reloaded = (await service.listTasks()).tasks.find((task) => task.id === continuation.id)
    expect(reloaded).toMatchObject({
      projectId: source.projectId,
      directoryId: source.directoryId,
      worktreeState: 'materialized',
    })
    expect(reloaded?.workDir).toContain(`${rootDir}/.claude/worktrees/desktop-continuation-`)
  })

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

    const canonicalVisibleWorkDir = await fs.realpath(visibleWorkDir)
    expect(recent.projects).toHaveLength(1)
    expect(recent.projects[0]).toMatchObject({
      projectPath: canonicalVisibleWorkDir,
      realPath: canonicalVisibleWorkDir,
      projectName: 'hall-operations',
      isGit: false,
      repoName: null,
      branch: null,
      sessionCount: 1,
    })
    expect(recent.projects[0]?.modifiedAt).toEqual(expect.any(String))
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

  it('reconstructs the current durable lineage from each private run transcript in event order', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const storagePath = path.join(tempDir, 'product-tasks.json')
    const authorityPath = path.join(tempDir, 'product-task-authority.v1.json')
    const service = new ProductTaskService({
      storagePath,
      core,
      now: () => new Date('2026-07-19T08:00:00.000Z'),
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })
    await service.ensureAuthorityProjectionForLegacyTask(task.id, { authorityPath })
    await service.createConversationLineage({
      task_id: task.id,
      expected_task_revision: 0,
      client_operation_id: 'lineage',
    })
    const first = await service.submitTaskRun(task.id, {
      expected_task_revision: 1,
      expected_lineage_revision: 0,
      client_operation_id: 'first',
      text: '第一问',
      attachment_ids: [],
    })
    const second = await service.submitTaskRun(task.id, {
      expected_task_revision: 2,
      expected_lineage_revision: 1,
      client_operation_id: 'second',
      text: '第二问',
      attachment_ids: [],
    })
    const authority = await new ProductTaskAuthorityRepository(authorityPath).read()
    const sessionId = (runId: string) => (
      authority.task_runs[runId] as { core_binding: { session_id: string } }
    ).core_binding.session_id
    core.setSessionMessages(sessionId(first.result!.run_id), [
      sourceMessage('first-user', '第一问'),
      { id: 'first-assistant', type: 'assistant', content: '第一答', timestamp: '2026-07-19T08:00:01.000Z' },
    ])
    core.setSessionMessages(sessionId(second.result!.run_id), [
      sourceMessage('second-user', '第二问'),
      { id: 'second-assistant', type: 'assistant', content: '第二答', timestamp: '2026-07-19T08:00:02.000Z' },
    ])

    expect((await service.getTaskThread(task.id)).entries.map((entry) => (
      entry.type === 'user_text' || entry.type === 'assistant_text' ? entry.text : entry.type
    ))).toEqual(['第一问', '第一答', '第二问', '第二答'])
  })

  it('persists quoted entry identities and forks an independent lineage without changing its parent', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-09b-lineage-fork-'))
    const storagePath = path.join(tempDir, 'product-tasks.json')
    const authorityPath = path.join(tempDir, 'product-task-authority.v1.json')
    const core = makeCore()
    const service = new ProductTaskService({ storagePath, core })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })
    await service.ensureAuthorityProjectionForLegacyTask(task.id, { authorityPath })
    const root = await service.createConversationLineage({ task_id: task.id, expected_task_revision: 0, client_operation_id: 'lineage-root' })
    const first = await service.submitTaskRun(task.id, { expected_task_revision: 1, expected_lineage_revision: 0, client_operation_id: 'first', text: '第一问', attachment_ids: [] })
    const firstState = await new ProductTaskAuthorityRepository(authorityPath).read()
    const firstSessionId = (firstState.task_runs[first.result!.run_id] as { core_binding: { session_id: string } }).core_binding.session_id
    core.setSessionMessages(firstSessionId, [
      sourceMessage('first-user', '第一问'),
      { id: 'first-assistant', type: 'assistant', content: '第一答', timestamp: '2026-07-19T08:00:01.000Z' },
    ])
    const sourceEntryId = (await service.getTaskThread(task.id)).entries.find(entry => entry.type === 'assistant_text')!.id
    const quoted = await service.submitTaskRun(task.id, { expected_task_revision: 2, expected_lineage_revision: 1, client_operation_id: 'quoted', text: '引用后追问', attachment_ids: [], reference_entry_ids: [sourceEntryId] })
    expect(quoted.outcome).toBe('accepted')
    const quotedState = await new ProductTaskAuthorityRepository(authorityPath).read()
    expect(quotedState.thread_entries[quoted.result!.entry_id]).toMatchObject({ reference_entry_ids: [sourceEntryId] })
    expect((await service.listTaskEvents(task.id)).events.at(-1)).toMatchObject({ reference_entry_ids: [sourceEntryId] })
    const quotedSessionId = (quotedState.task_runs[quoted.result!.run_id] as { core_binding: { session_id: string } }).core_binding.session_id
    core.setSessionMessages(quotedSessionId, [sourceMessage('quoted-user', '引用后追问')])
    expect((await service.getTaskThread(task.id)).entries.find(entry => entry.type === 'user_text' && entry.text === '引用后追问')).toMatchObject({ referenceEntryIds: [sourceEntryId] })
    const hiddenAfterForkEntryId = (await service.getTaskThread(task.id)).entries.find(entry => entry.type === 'user_text' && entry.text === '引用后追问')!.id

    const parentId = root.lineage.lineage_id as string
    const parentBefore = JSON.stringify(quotedState.conversation_lineages[parentId])
    let frozenCoreInput = ''
    const input = { taskId: task.id, expected_revision: 3, client_operation_id: 'fork', canonical_input: JSON.stringify({ sourceEntryId, target: 'new_worktree' }) }
    const bridge = { ensureBranch: async (_operationId: string, _taskId: string, canonicalInput: string) => { frozenCoreInput = canonicalInput; return { coreSessionId: 'fork-core', branchWorkDir: '/workspace/fork' } } }
    expect((await service.continueTaskAuthoritatively(input, { authorityPath, bridge })).outcome).toBe('accepted')
    const forked = await new ProductTaskAuthorityRepository(authorityPath).read()
    const current = (forked.tasks[task.id] as { task: { current_lineage_id: string; workDir: string } }).task
    const child = forked.conversation_lineages[current.current_lineage_id] as Record<string, unknown>
    expect(child).toMatchObject({ parent_lineage_id: parentId, fork_checkpoint_id: first.result!.entry_id, execution_directory: '/workspace/fork' })
    expect(current.workDir).toBe('/workspace/fork')
    expect(JSON.stringify(forked.conversation_lineages[parentId])).toBe(parentBefore)
    expect(JSON.parse(frozenCoreInput)).toMatchObject({ sourceSessionId: firstSessionId, targetMessageId: 'first-assistant', target: 'new_worktree' })
    const bytes = await fs.readFile(authorityPath)
    expect((await service.continueTaskAuthoritatively(input, { authorityPath, bridge })).outcome).toBe('duplicate')
    expect(await fs.readFile(authorityPath)).toEqual(bytes)
    expect((await service.getTaskThread(task.id)).entries.map(entry => entry.type === 'user_text' || entry.type === 'assistant_text' ? entry.text : entry.type)).toEqual(['第一问', '第一答'])
    await expect(service.continueTaskAuthoritatively({ taskId: task.id, expected_revision: 4, client_operation_id: 'fork-hidden', canonical_input: JSON.stringify({ sourceEntryId: hiddenAfterForkEntryId, target: 'new_worktree' }) }, { authorityPath, bridge })).rejects.toMatchObject({ statusCode: 400, code: 'BAD_REQUEST' })
  })

  it('maps supported product execution choices to Core permission modes', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })

    const cases = [
      { permissionMode: undefined, corePermissionMode: 'default', sandbox: 'workspace-write', reviewer: 'user' },
      { permissionMode: 'approve_for_me', corePermissionMode: 'default', sandbox: 'workspace-write', reviewer: 'automatic' },
      { permissionMode: 'full_access', corePermissionMode: 'bypassPermissions', sandbox: 'danger-full-access', reviewer: 'none' },
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
      expect(task.permission_snapshot).toMatchObject({
        mode: entry.permissionMode ?? 'ask_for_approval',
        sandbox: entry.sandbox,
        reviewer: entry.reviewer,
      })
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
      'permissionMode 必须是 ask_for_approval、approve_for_me、full_access 之一',
    )

    expect(core.getLastCreateInput()).toBeNull()
  })

  it('rejects a malformed worktree choice before creating a Core session', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })

    await expect(service.createTask({
      workDir: '/workspace/hall-operations',
      useWorktree: 'yes',
    } as unknown as Parameters<ProductTaskService['createTask']>[0])).rejects.toThrow(
      'useWorktree 必须是布尔值',
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
    expect(index.projects[0]?.rootDir).toBe('/workspace/hall-operations')
    expect(index.projects[0]?.taskCount).toBe(2)
    expect(index.directories).toEqual([
      expect.objectContaining({
        id: task.directoryId,
        projectId: task.projectId,
        path: '/workspace/hall-operations',
      }),
    ])
    expect(index.tasks).toHaveLength(2)
    expect(index.total).toBe(2)
  })

  it('rejects task mutations that are not declared for the current lifecycle', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })

    await service.setArchived(task.id, true)

    await expect(service.setPinned(task.id, true)).rejects.toThrow('该任务当前不能执行此操作')
    await expect(service.updateTask(task.id, { title: '归档后重命名' })).rejects.toThrow('该任务当前不能执行此操作')
    await expect(service.setArchived(task.id, true)).rejects.toThrow('该任务当前不能执行此操作')
    await expect(service.createSideTask(task.id, {
      sourceEntryId: 'thread_0123456789abcdef0123',
    })).rejects.toThrow('归档任务不能创建侧边任务')

    const continuation = await service.continueTask(task.id, {})
    expect(continuation.parentTaskId).toBe(task.id)

    const restored = await service.setArchived(task.id, false)
    expect(restored.lifecycle).toBe('active')
    expect(restored.actions).toContain('pin')
  })

  it('keeps a live product run visible and rejects archival until it settles', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const runs = new ProductTaskRunProjection()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
      runs,
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })
    const coreSessionId = await service.resolveCoreSessionId(task.id)

    runs.beginRun(task.id, coreSessionId)

    expect((await service.getTask(task.id)).actions).not.toContain('archive')
    expect((await service.listTasks()).tasks[0]?.actions).not.toContain('archive')
    await expect(service.setArchived(task.id, true)).rejects.toMatchObject({
      statusCode: 409,
      code: 'PRODUCT_TASK_ACTIVE_RUN',
    })

    runs.projectSessionMessage(coreSessionId, {
      type: 'status',
      state: 'permission_pending',
    })

    expect((await service.getTask(task.id)).actions).not.toContain('archive')
    await expect(service.setArchived(task.id, true)).rejects.toThrow(
      '任务正在运行或等待确认，请先停止任务后再归档',
    )

    runs.projectSessionMessage(coreSessionId, {
      type: 'message_complete',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    expect((await service.getTask(task.id)).actions).toContain('archive')
    await expect(service.setArchived(task.id, true)).resolves.toMatchObject({
      lifecycle: 'archived',
    })
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
    expect(persistedAfterImport.version).toBe(4)
    expect(persistedAfterImport.legacyCoreSessionsImportedAt).toEqual(expect.any(String))
    expect(persistedAfterImport.tasks[firstIndex.tasks[0]!.id]?.coreSessionId).toBe(legacy.sessionId)

    const laterCoreSession = await core.createSession({ workDir: '/workspace/late-core-session' })
    const secondIndex = await service.listTasks()
    expect(secondIndex.tasks.map((task) => task.id)).toEqual([firstIndex.tasks[0]!.id])
    await expect(service.resolveCoreSessionId(
      legacyProductTaskIdForTest(laterCoreSession.sessionId),
    )).rejects.toThrow(`任务不存在：${legacyProductTaskIdForTest(laterCoreSession.sessionId)}`)
  })

  it('backfills v3 task project and directory bindings without changing its public task id', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const storagePath = path.join(tempDir, 'product-tasks.json')
    const created = await core.createSession({ workDir: '/workspace/v3-hall' })
    const taskId = 'task-v3-preserved'
    const timestamp = '2026-07-19T00:00:00.000Z'
    await fs.writeFile(storagePath, JSON.stringify({
      version: 3,
      legacyCoreSessionsImportedAt: timestamp,
      tasks: {
        [taskId]: {
          coreSessionId: created.sessionId,
          lifecycle: 'active',
          kind: 'main',
          createdAt: timestamp,
          updatedAt: timestamp,
          worktreeState: 'not_requested',
          visibility: 'main',
        },
      },
      sideTasks: {},
    }), 'utf8')

    const service = new ProductTaskService({ storagePath, core })
    const index = await service.listTasks()
    const task = index.tasks[0]
    expect(task).toEqual(expect.objectContaining({
      id: taskId,
      projectId: expect.stringMatching(/^project_/),
      directoryId: expect.stringMatching(/^directory_/),
    }))
    expect(index.projects).toEqual([
      expect.objectContaining({ id: task?.projectId, rootDir: '/workspace/v3-hall' }),
    ])
    expect(index.directories).toEqual([
      expect.objectContaining({ id: task?.directoryId, projectId: task?.projectId, path: '/workspace/v3-hall' }),
    ])

    const persisted = JSON.parse(await fs.readFile(storagePath, 'utf8')) as {
      version: number
      tasks: Record<string, { projectId?: string; directoryId?: string }>
    }
    expect(persisted.version).toBe(4)
    expect(persisted.tasks[taskId]).toMatchObject({
      projectId: task?.projectId,
      directoryId: task?.directoryId,
    })
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

  it('uses newer Core transcript activity to order persisted tasks and projects', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })

    const olderTask = await service.createTask({ workDir: '/workspace/older-hall' })
    const newerTask = await service.createTask({ workDir: '/workspace/newer-hall' })
    const olderSessionId = await service.resolveCoreSessionId(olderTask.id)
    const futureActivity = '2099-01-01T00:00:00.000Z'
    core.setSessionModifiedAt(olderSessionId, futureActivity)

    const index = await service.listTasks()
    expect(index.tasks.map((task) => task.id)).toEqual([olderTask.id, newerTask.id])
    expect(index.projects.map((project) => project.id)).toEqual([
      olderTask.projectId,
      newerTask.projectId,
    ])
    expect(index.tasks.find((task) => task.id === olderTask.id)?.updatedAt).toBe(futureActivity)
    expect(index.projects.find((project) => project.id === olderTask.projectId)?.updatedAt).toBe(futureActivity)

    const recent = await service.listRecentProjects(2)
    expect(recent.projects[0]).toMatchObject({
      projectPath: '/workspace/older-hall',
      modifiedAt: futureActivity,
    })
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

  it('rejects a malformed continuation payload before branching the task', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bb-product-tasks-'))
    const core = makeCore()
    const service = new ProductTaskService({
      storagePath: path.join(tempDir, 'product-tasks.json'),
      core,
    })
    const task = await service.createTask({ workDir: '/workspace/hall-operations' })

    await expect(service.continueTask(
      task.id,
      [] as unknown as Parameters<ProductTaskService['continueTask']>[1],
    )).rejects.toThrow('继续任务参数必须是对象')

    expect(core.getLastBranchInput()).toBeNull()
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
    expect(persisted.version).toBe(4)
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
