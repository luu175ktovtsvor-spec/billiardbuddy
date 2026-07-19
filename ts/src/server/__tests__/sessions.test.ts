/**
 * Unit tests for SessionService and Core worktree/session behavior
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import * as fs from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import * as path from 'node:path'
import * as os from 'node:os'
import { SessionService, sessionService } from '../services/sessionService.js'
import {
  cleanupPreparedSessionWorkspace,
  getRepositoryContext,
  isMaterializedWorktreeLaunch,
  prepareSessionWorkspace,
} from '../services/repositoryLaunchService.js'
import { clearCommandsCache } from '../../commands.js'
import { parseJSONL } from '../../utils/json.js'
import { createSessionBranch } from '../../utils/sessionBranching.js'
import { sanitizePath } from '../../utils/sessionStoragePortable.js'
import { clearInstalledPluginsCache } from '../../utils/plugins/installedPluginsManager.js'
import { clearPluginCache } from '../../utils/plugins/pluginLoader.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'

// ============================================================================
// Test helpers
// ============================================================================

let tmpDir: string
let service: SessionService

/** Create a temporary config dir and configure the service to use it. */
async function setupTmpConfigDir(): Promise<string> {
  tmpDir = path.join(os.tmpdir(), `claude-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  // Legacy custom slash-commands are discovered via loadMarkdownFiles; force the native fs
  // walk so command discovery is deterministic on hosts without a system/vendored ripgrep.
  process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH = '1'
  return tmpDir
}

async function cleanupTmpDir(): Promise<void> {
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CLAUDE_CODE_USE_NATIVE_FILE_SEARCH
}

/** Write a JSONL session file with given entries. */
async function writeSessionFile(
  projectDir: string,
  sessionId: string,
  entries: Record<string, unknown>[]
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir)
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, `${sessionId}.jsonl`)
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

async function writeSubagentTranscriptFile(
  projectDir: string,
  sessionId: string,
  agentId: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const dir = path.join(tmpDir, 'projects', projectDir, sessionId, 'subagents')
  await fs.mkdir(dir, { recursive: true })
  const normalizedAgentId = agentId.startsWith('agent-') ? agentId : `agent-${agentId}`
  const filePath = path.join(dir, `${normalizedAgentId}.jsonl`)
  const content = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.writeFile(filePath, content, 'utf-8')
  return filePath
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  })
}

async function createCleanGitRepo(baseDir: string): Promise<string> {
  const workDir = path.join(
    baseDir,
    `repo-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )

  await fs.mkdir(workDir, { recursive: true })
  git(workDir, 'init')
  git(workDir, 'config', 'user.email', 'sessions-api@example.com')
  git(workDir, 'config', 'user.name', 'Sessions API')
  git(workDir, 'checkout', '-b', 'main')
  await fs.writeFile(path.join(workDir, 'README.md'), 'main\n')
  git(workDir, 'add', 'README.md')
  git(workDir, 'commit', '-m', 'initial')
  git(workDir, 'checkout', '-b', 'feature/rail')
  await fs.writeFile(path.join(workDir, 'feature.txt'), 'feature\n')
  git(workDir, 'add', 'feature.txt')
  git(workDir, 'commit', '-m', 'feature')
  git(workDir, 'checkout', 'main')

  return workDir
}

// Sample entries matching real CLI format
function makeSnapshotEntry(): Record<string, unknown> {
  return {
    type: 'file-history-snapshot',
    messageId: crypto.randomUUID(),
    snapshot: {
      messageId: crypto.randomUUID(),
      trackedFileBackups: {},
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    isSnapshotUpdate: false,
  }
}

function makeFileHistorySnapshotEntry(
  snapshotMessageId: string,
  trackedFileBackups: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'file-history-snapshot',
    messageId: crypto.randomUUID(),
    snapshot: {
      messageId: snapshotMessageId,
      trackedFileBackups,
      timestamp: '2026-01-01T00:00:00.000Z',
    },
    isSnapshotUpdate: false,
  }
}

function makeUserEntry(content: string, uuid?: string): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content },
    uuid: uuid || crypto.randomUUID(),
    timestamp: '2026-01-01T00:01:00.000Z',
    userType: 'external',
    cwd: '/tmp/test',
    sessionId: 'test-session',
  }
}

function makeAssistantEntry(
  content: string,
  parentUuid?: string,
  usage?: {
    input_tokens?: number
    output_tokens?: number
    cache_read_input_tokens?: number
    cache_creation_input_tokens?: number
  },
): Record<string, unknown> {
  return {
    parentUuid: parentUuid || null,
    isSidechain: false,
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      id: `msg_${crypto.randomUUID().slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: content }],
      ...(usage ? { usage } : {}),
    },
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:02:00.000Z',
  }
}

function makeAssistantToolUseEntry(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  parentUuid?: string,
): Record<string, unknown> {
  return {
    parentUuid: parentUuid || null,
    isSidechain: false,
    type: 'assistant',
    message: {
      model: 'claude-opus-4-7',
      id: `msg_${crypto.randomUUID().slice(0, 20)}`,
      type: 'message',
      role: 'assistant',
      content: toolUses.map((toolUse) => ({
        type: 'tool_use',
        id: toolUse.id,
        name: toolUse.name,
        input: toolUse.input,
      })),
    },
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:02:00.000Z',
  }
}

function makeToolResultUserEntry(
  toolUseId: string,
  content: string,
  uuid?: string,
  parentUuid?: string,
  sessionId = 'test-session',
): Record<string, unknown> {
  return {
    parentUuid: parentUuid || null,
    isSidechain: false,
    type: 'user',
    message: {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: toolUseId,
        content,
      }],
    },
    uuid: uuid || crypto.randomUUID(),
    timestamp: '2026-01-01T00:02:30.000Z',
    userType: 'external',
    cwd: '/tmp/test',
    sessionId,
  }
}

function makeMetaUserEntry(): Record<string, unknown> {
  return {
    parentUuid: null,
    isSidechain: false,
    type: 'user',
    message: { role: 'user', content: '<local-command-caveat>internal</local-command-caveat>' },
    isMeta: true,
    uuid: crypto.randomUUID(),
    timestamp: '2026-01-01T00:00:30.000Z',
  }
}

function makeSessionMetaEntry(workDir: string): Record<string, unknown> {
  return {
    type: 'session-meta',
    isMeta: true,
    workDir,
    timestamp: '2026-01-01T00:00:00.000Z',
  }
}

function makeWorktreeStateEntry(
  sessionId: string,
  worktreePath: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'worktree-state',
    sessionId,
    worktreeSession: {
      originalCwd: '/tmp/source',
      worktreePath,
      worktreeName: 'desktop-main-12345678',
      worktreeBranch: 'worktree-desktop-main-12345678',
      originalBranch: 'main',
      sessionId,
      ...overrides,
    },
  }
}

function makeContentReplacementEntry(
  sessionId: string,
  replacements: Array<{ kind: 'tool-result'; toolUseId: string; replacement: string }>,
): Record<string, unknown> {
  return {
    type: 'content-replacement',
    sessionId,
    replacements,
  }
}

async function writeFileHistoryBackup(
  sessionId: string,
  backupFileName: string,
  content: string,
): Promise<void> {
  const dir = path.join(tmpDir, 'file-history', sessionId)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, backupFileName), content, 'utf-8')
}

type ThreeTurnCheckpointFixture = {
  sessionId: string
  workDir: string
  stepFile: string
  createdFile: string
  firstUserId: string
  secondUserId: string
  thirdUserId: string
}

// ============================================================================
// SessionService tests
// ============================================================================

describe('SessionService', () => {
  beforeEach(async () => {
    await setupTmpConfigDir()
    service = new SessionService()
    clearInstalledPluginsCache()
    clearPluginCache('sessions-api-test-setup')
    resetSettingsCache()
  })

  afterEach(async () => {
    clearCommandsCache()
    clearInstalledPluginsCache()
    clearPluginCache('session-service-test-teardown')
    resetSettingsCache()
    await cleanupTmpDir()
  })

  // --------------------------------------------------------------------------
  // listSessions
  // --------------------------------------------------------------------------

  it('should return empty list when no sessions exist', async () => {
    const result = await service.listSessions()
    expect(result.sessions).toEqual([])
    expect(result.total).toBe(0)
  })

  it('should list sessions from JSONL files', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-testproject', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Hello Claude'),
      makeAssistantEntry('Hi there!'),
    ])

    const result = await service.listSessions()
    expect(result.total).toBe(1)
    expect(result.sessions).toHaveLength(1)

    const session = result.sessions[0]!
    expect(session.id).toBe(sessionId)
    expect(session.title).toBe('Hello Claude')
    expect(session.messageCount).toBe(2) // 1 user + 1 assistant
    expect(session.projectPath).toBe('-tmp-testproject')
    expect(session.projectRoot).toBe('/tmp/test')
  })

  it('should expose the source project root for persisted worktree sessions', async () => {
    const sourceWorkDir = path.join(tmpDir, 'source-repo')
    const worktreePath = path.join(sourceWorkDir, '.claude', 'worktrees', 'desktop-main-12345678')
    await fs.mkdir(worktreePath, { recursive: true })
    const sessionId = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile(sanitizePath(worktreePath), sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry(worktreePath),
      makeWorktreeStateEntry(sessionId, worktreePath, {
        originalCwd: sourceWorkDir,
      }),
      makeUserEntry('Hello from worktree'),
    ])

    const result = await service.listSessions()

    expect(result.sessions).toHaveLength(1)
    expect(result.sessions[0]).toMatchObject({
      id: sessionId,
      projectPath: sanitizePath(worktreePath),
      projectRoot: await fs.realpath(sourceWorkDir),
      workDir: worktreePath,
    })
  })

  it('should paginate results with limit and offset', async () => {
    // Create 3 sessions
    for (let i = 0; i < 3; i++) {
      const id = `0000000${i}-bbbb-cccc-dddd-eeeeeeeeeeee`
      await writeSessionFile('-tmp-test', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Message ${i}`),
      ])
    }

    const page1 = await service.listSessions({ limit: 2, offset: 0 })
    expect(page1.total).toBe(3)
    expect(page1.sessions).toHaveLength(2)

    const page2 = await service.listSessions({ limit: 2, offset: 2 })
    expect(page2.total).toBe(3)
    expect(page2.sessions).toHaveLength(1)
  })

  it('should scan summaries before pagination so metadata-only writes cannot skew order', async () => {
    for (let i = 0; i < 12; i++) {
      const id = `1000000${i.toString(16)}-bbbb-cccc-dddd-eeeeeeeeeeee`
      const filePath = await writeSessionFile('-tmp-many-sessions', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Message ${i}`),
      ])
      const mtime = new Date(Date.now() - i * 1000)
      await fs.utimes(filePath, mtime, mtime)
    }

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let scanCount = 0
    serviceWithSpy.scanSessionListSummary = async (...args) => {
      scanCount += 1
      return originalScanSessionListSummary(...args)
    }

    const result = await service.listSessions({ limit: 3, offset: 0 })

    expect(result.total).toBe(12)
    expect(result.sessions).toHaveLength(3)
    expect(scanCount).toBe(12)
  })

  it('should ignore metadata-only writes when sorting and dating the session list', async () => {
    const activeSessionId = '10000000-aaaa-bbbb-cccc-eeeeeeeeeeee'
    const viewedHistorySessionId = '10000001-aaaa-bbbb-cccc-eeeeeeeeeeee'
    const activeFilePath = await writeSessionFile('-tmp-viewed-history-sessions', activeSessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('Recent real work'),
        timestamp: '2026-07-02T02:00:00.000Z',
      },
      {
        ...makeAssistantEntry('Recent reply'),
        timestamp: '2026-07-02T02:05:00.000Z',
      },
    ])
    const historyFilePath = await writeSessionFile('-tmp-viewed-history-sessions', viewedHistorySessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('Older work'),
        timestamp: '2026-07-01T02:00:00.000Z',
      },
      {
        ...makeAssistantEntry('Older reply'),
        timestamp: '2026-07-01T02:05:00.000Z',
      },
      {
        ...makeSessionMetaEntry('/tmp/viewed-history'),
        timestamp: '2026-07-02T03:00:00.000Z',
      },
    ])
    await fs.utimes(activeFilePath, new Date('2026-07-02T02:05:00.000Z'), new Date('2026-07-02T02:05:00.000Z'))
    await fs.utimes(historyFilePath, new Date('2026-07-02T03:00:00.000Z'), new Date('2026-07-02T03:00:00.000Z'))

    const result = await service.listSessions({ project: '/tmp/viewed-history-sessions', limit: 2 })

    expect(result.sessions.map((session) => session.id)).toEqual([
      activeSessionId,
      viewedHistorySessionId,
    ])
    expect(result.sessions.find((session) => session.id === viewedHistorySessionId)?.modifiedAt)
      .toBe('2026-07-01T02:05:00.000Z')
  })

  it('should reuse cached list metadata for repeated requests', async () => {
    for (let i = 0; i < 5; i++) {
      const id = `2000000${i.toString(16)}-bbbb-cccc-dddd-eeeeeeeeeeee`
      const filePath = await writeSessionFile('-tmp-cached-sessions', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Cached message ${i}`),
      ])
      const mtime = new Date(Date.now() - i * 1000)
      await fs.utimes(filePath, mtime, mtime)
    }

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let scanCount = 0
    serviceWithSpy.scanSessionListSummary = async (...args) => {
      scanCount += 1
      return originalScanSessionListSummary(...args)
    }

    const first = await service.listSessions({ limit: 3, offset: 0 })
    const second = await service.listSessions({ limit: 3, offset: 0 })

    expect(first.sessions.map((session) => session.id)).toEqual(second.sessions.map((session) => session.id))
    expect(scanCount).toBe(5)
  })

  it('should reuse unchanged file summaries after the list response cache is cleared', async () => {
    const sessionFiles: Array<{ id: string; filePath: string }> = []
    for (let i = 0; i < 3; i++) {
      const id = `2500000${i.toString(16)}-bbbb-cccc-dddd-eeeeeeeeeeee`
      const filePath = await writeSessionFile('-tmp-file-summary-cache', id, [
        makeSnapshotEntry(),
        makeUserEntry(`Cached file summary ${i}`),
      ])
      const mtime = new Date(Date.now() - i * 1000)
      await fs.utimes(filePath, mtime, mtime)
      sessionFiles.push({ id, filePath })
    }

    const serviceWithSpy = service as unknown as {
      scanSessionListSummary: (...args: unknown[]) => Promise<unknown>
    }
    const serviceInternals = service as unknown as {
      sessionListCache: Map<string, unknown>
    }
    const originalScanSessionListSummary = serviceWithSpy.scanSessionListSummary.bind(service)
    let scanCount = 0
    serviceWithSpy.scanSessionListSummary = async (...args) => {
      scanCount += 1
      return originalScanSessionListSummary(...args)
    }

    await service.listSessions({ limit: 3, offset: 0 })
    expect(scanCount).toBe(3)

    serviceInternals.sessionListCache.clear()
    const second = await service.listSessions({ limit: 3, offset: 0 })
    expect(second.sessions).toHaveLength(3)
    expect(scanCount).toBe(3)

    await fs.appendFile(
      sessionFiles[1]!.filePath,
      `${JSON.stringify({
        type: 'custom-title',
        customTitle: 'Changed cached file summary',
        timestamp: new Date().toISOString(),
      })}\n`,
      'utf-8',
    )
    serviceInternals.sessionListCache.clear()

    const third = await service.listSessions({ limit: 3, offset: 0 })
    expect(third.sessions.find((session) => session.id === sessionFiles[1]!.id)?.title)
      .toBe('Changed cached file summary')
    expect(scanCount).toBe(4)
  })

  it('should invalidate cached list metadata after writes', async () => {
    const sessionId = '30000000-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-cache-invalidation', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Original title'),
    ])

    const first = await service.listSessions({ limit: 10, offset: 0 })
    expect(first.sessions[0]!.title).toBe('Original title')

    await service.renameSession(sessionId, 'Renamed title')
    const second = await service.listSessions({ limit: 10, offset: 0 })

    expect(second.sessions[0]!.title).toBe('Renamed title')
  })

  it('should filter sessions by project', async () => {
    const id1 = 'aaaaaaaa-1111-cccc-dddd-eeeeeeeeeeee'
    const id2 = 'aaaaaaaa-2222-cccc-dddd-eeeeeeeeeeee'

    await writeSessionFile('-project-a', id1, [makeSnapshotEntry(), makeUserEntry('In A')])
    await writeSessionFile('-project-b', id2, [makeSnapshotEntry(), makeUserEntry('In B')])

    const resultA = await service.listSessions({ project: '/project/a' })
    expect(resultA.total).toBe(1)
    expect(resultA.sessions[0]!.id).toBe(id1)
  })

  // --------------------------------------------------------------------------
  // getSessionMessages
  // --------------------------------------------------------------------------

  it('should throw for non-existent session messages', async () => {
    expect(
      service.getSessionMessages('00000000-0000-0000-0000-000000000000')
    ).rejects.toThrow('Session not found')
  })

  it('should return transcript messages in order', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Hello', userUuid),
      makeAssistantEntry('World', userUuid),
    ])

    const messages = await service.getSessionMessages(sessionId)
    expect(messages).toHaveLength(2)
    expect(messages[0]).toMatchObject({ type: 'user', content: 'Hello' })
    expect(messages[1]).toMatchObject({
      type: 'assistant',
      content: [{ type: 'text', text: 'World' }],
    })
  })

  it('should skip meta entries in session messages', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeMetaUserEntry(),
      makeUserEntry('Real message'),
    ])

    const messages = await service.getSessionMessages(sessionId)
    expect(messages).toHaveLength(1)
    expect(messages[0]!.content).toBe('Real message')
  })

  it('preserves structured toolUseResult metadata for AskUserQuestion answers', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'ask-1',
              content: 'User has answered your questions: "Pick one?"="A". You can now continue with the user\'s answers in mind.',
            },
          ],
        },
        toolUseResult: {
          questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
          answers: { 'Pick one?': 'A' },
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:01.000Z',
      },
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({
      type: 'tool_result',
      toolUseResult: {
        answers: { 'Pick one?': 'A' },
      },
    })
  })

  it('should append subagent tool calls under their parent agent tool result', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const projectDir = '-tmp-project'
    const agentId = 'abc123'

    await writeSessionFile(projectDir, sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Dispatch an agent'),
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'Agent:0',
              name: 'Agent',
              input: { description: 'Inspect alpha' },
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'Agent:0',
              content: [
                {
                  type: 'text',
                  text: `alpha summary\nagentId: ${agentId} (use SendMessage with to: '${agentId}' to continue this agent)\n<usage>total_tokens: 10\ntool_uses: 2\nduration_ms: 30</usage>`,
                },
              ],
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:03.000Z',
      },
    ])
    await writeSubagentTranscriptFile(projectDir, sessionId, agentId, [
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'Read:0',
              name: 'Read',
              input: { file_path: '/tmp/alpha.txt' },
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'Read:0',
              content: 'alpha body',
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:05.000Z',
      },
    ])

    const messages = await service.getSessionMessages(sessionId)
    const childToolUse = messages.find(
      (message) => message.type === 'tool_use' && message.parentToolUseId === 'Agent:0',
    )
    const childToolResult = messages.find(
      (message) => message.type === 'tool_result' && message.parentToolUseId === 'Agent:0',
    )

    expect(childToolUse?.content).toEqual([
      {
        type: 'tool_use',
        id: 'Agent:0/abc123/Read:0',
        name: 'Read',
        input: { file_path: '/tmp/alpha.txt' },
      },
    ])
    expect(childToolResult?.content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'Agent:0/abc123/Read:0',
        content: 'alpha body',
      },
    ])
  })

  it('should hide synthetic interruption, no-response, and malformed command breadcrumb transcript entries', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('正常用户消息', crypto.randomUUID()),
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '[Request interrupted by user]' }],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:02.000Z',
      },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'No response requested.' }],
          model: '<synthetic>',
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:03.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>',
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:04.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '<command-name>/agent</command-name>\n<command-message>agent</command-message>\n<command-args>Plan 222</command-args>',
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:05.000Z',
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: '<command-name>/agent</command-name> malformed breadcrumb',
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:00:06.000Z',
      },
      makeAssistantEntry('正常助手消息', crypto.randomUUID()),
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages).toHaveLength(4)
    expect(messages[0]).toMatchObject({ type: 'user', content: '正常用户消息' })
    expect(messages[1]).toMatchObject({
      type: 'user',
      content: '<command-name>/exit</command-name>\n<command-message>exit</command-message>\n<command-args></command-args>',
    })
    expect(messages[2]).toMatchObject({
      type: 'user',
      content: [{
        type: 'text',
        text: '<command-name>/agent</command-name>\n<command-message>agent</command-message>\n<command-args>Plan 222</command-args>',
      }],
    })
    expect(messages[3]).toMatchObject({
      type: 'assistant',
      content: [{ type: 'text', text: '正常助手消息' }],
    })
  })

  it('should keep user-invoked skill command metadata for desktop history restore', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry([
        '<command-message>frontend-design</command-message>',
        '<command-name>/frontend-design</command-name>',
        '<command-args>redesign the settings page</command-args>',
      ].join('\n'), 'skill-command-user'),
      makeAssistantEntry('正常助手消息', 'skill-command-user'),
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages).toHaveLength(2)
    const skillCommandContent = String(messages[0]!.content)
    expect(messages[0]).toMatchObject({
      id: 'skill-command-user',
      type: 'user',
      content: expect.stringContaining('<command-name>/frontend-design</command-name>'),
    })
    expect(skillCommandContent).toContain('<command-args>redesign the settings page</command-args>')
    expect(messages[1]).toMatchObject({ type: 'assistant' })
  })

  it('should keep /goal local command transcript entries for desktop history restore', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        parentUuid: null,
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship persisted goal</command-args>',
        level: 'info',
        timestamp: '2026-01-01T00:00:01.000Z',
        uuid: 'goal-command',
      },
      {
        parentUuid: 'goal-command',
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>Goal set: ship persisted goal</local-command-stdout>',
        level: 'info',
        timestamp: '2026-01-01T00:00:02.000Z',
        uuid: 'goal-output',
      },
      {
        parentUuid: 'goal-output',
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: '<local-command-stdout>Goal continuing: verify persisted follow-up</local-command-stdout>',
        level: 'info',
        timestamp: '2026-01-01T00:00:03.000Z',
        uuid: 'goal-continuing',
      },
      makeAssistantEntry('正常助手消息', crypto.randomUUID()),
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages).toMatchObject([
      {
        id: 'goal-command',
        type: 'system',
        content: expect.stringContaining('<command-name>/goal</command-name>'),
      },
      {
        id: 'goal-output',
        type: 'system',
        content: expect.stringContaining('Goal set: ship persisted goal'),
      },
      {
        id: 'goal-continuing',
        type: 'system',
        content: expect.stringContaining('Goal continuing: verify persisted follow-up'),
      },
      {
        type: 'assistant',
      },
    ])
  })

  it('should hide task-notification turns and their automatic responses from history', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const taskNotificationId = crypto.randomUUID()
    const taskAssistantId = crypto.randomUUID()
    const taskToolUseMessageId = crypto.randomUUID()
    const taskToolResultId = crypto.randomUUID()
    const taskAfterToolId = crypto.randomUUID()
    const realFollowUpId = crypto.randomUUID()
    const realAssistantId = crypto.randomUUID()

    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('创建一个项目', firstUserId),
        parentUuid: null,
      },
      {
        ...makeAssistantEntry('项目已经创建', firstUserId),
        uuid: firstAssistantId,
      },
      {
        ...makeUserEntry(
          '<task-notification>\n<task-id>bg-1</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>Background command completed</summary>\n</task-notification>',
          taskNotificationId,
        ),
        parentUuid: firstAssistantId,
      },
      {
        ...makeAssistantEntry('旧后台任务通知，无需处理', taskNotificationId),
        uuid: taskAssistantId,
      },
      {
        ...makeAssistantToolUseEntry([{
          id: 'toolu_restart',
          name: 'Bash',
          input: { command: 'npm run dev' },
        }], taskAssistantId),
        uuid: taskToolUseMessageId,
      },
      {
        type: 'user',
        message: {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'toolu_restart',
            content: 'server restarted',
          }],
        },
        uuid: taskToolResultId,
        parentUuid: taskToolUseMessageId,
        timestamp: '2026-01-01T00:03:00.000Z',
      },
      {
        ...makeAssistantEntry('后台任务触发的工具调用完成', taskToolResultId),
        uuid: taskAfterToolId,
      },
      {
        ...makeUserEntry('继续真实问题', realFollowUpId),
        parentUuid: taskAfterToolId,
      },
      {
        ...makeAssistantEntry('真实回答', realFollowUpId),
        uuid: realAssistantId,
      },
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
      realFollowUpId,
      realAssistantId,
    ])
    expect(JSON.stringify(messages)).not.toContain('<task-notification>')
    expect(JSON.stringify(messages)).not.toContain('旧后台任务通知')
    expect(JSON.stringify(messages)).not.toContain('server restarted')
    expect(JSON.stringify(messages)).not.toContain('后台任务触发的工具调用完成')
  })

  it('should reconstruct parent agent tool linkage from parentUuid chains', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    const agentAssistantUuid = crypto.randomUUID()
    const childAssistantUuid = crypto.randomUUID()

    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Inspect the codebase', userUuid),
      {
        parentUuid: userUuid,
        isSidechain: false,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Agent',
              id: 'agent-tool-1',
              input: { description: 'Inspect src/components' },
            },
          ],
        },
        uuid: agentAssistantUuid,
        timestamp: '2026-01-01T00:02:00.000Z',
      },
      {
        parentUuid: agentAssistantUuid,
        isSidechain: true,
        type: 'assistant',
        message: {
          model: 'claude-opus-4-7',
          id: `msg_${crypto.randomUUID().slice(0, 20)}`,
          type: 'message',
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              name: 'Read',
              id: 'read-tool-1',
              input: { file_path: 'src/components/App.tsx' },
            },
          ],
        },
        uuid: childAssistantUuid,
        timestamp: '2026-01-01T00:02:30.000Z',
      },
      {
        parentUuid: childAssistantUuid,
        isSidechain: true,
        type: 'user',
        message: {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'read-tool-1',
              content: 'ok',
              is_error: false,
            },
          ],
        },
        uuid: crypto.randomUUID(),
        timestamp: '2026-01-01T00:03:00.000Z',
        userType: 'external',
        cwd: '/tmp/test',
        sessionId: 'test-session',
      },
    ])

    const messages = await service.getSessionMessages(sessionId)

    expect(messages[1]).toMatchObject({
      type: 'tool_use',
      parentToolUseId: undefined,
    })
    expect(messages[2]).toMatchObject({
      type: 'tool_use',
      parentToolUseId: 'agent-tool-1',
    })
    expect(messages[3]).toMatchObject({
      type: 'tool_result',
      parentToolUseId: 'agent-tool-1',
    })
  })

  it('should recover workDir from session-meta entries', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/from-meta'),
      makeUserEntry('Hello'),
    ])

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/from-meta')
  })

  it('should recover workDir from the latest session-meta entry', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/old-worktree'),
      makeUserEntry('Hello'),
      makeSessionMetaEntry('/tmp/latest-worktree'),
    ])

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/latest-worktree')
  })

  it('should prefer the newest duplicate session file when worktree metadata moves', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const sourceFile = await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/project'),
    ])
    const worktreeFile = await writeSessionFile('-tmp-project--claude-worktrees-desktop-main-12345678', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/project/.claude/worktrees/desktop-main-12345678'),
    ])

    const oldTime = new Date('2026-01-01T00:00:00.000Z')
    const newTime = new Date('2026-01-01T00:00:01.000Z')
    await fs.utimes(sourceFile, oldTime, oldTime)
    await fs.utimes(worktreeFile, newTime, newTime)

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/project/.claude/worktrees/desktop-main-12345678')
  })

  it('should recover CLI worktree state from transcript metadata', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project--claude-worktrees-desktop-main-12345678', sessionId, [
      makeSnapshotEntry(),
      makeSessionMetaEntry('/tmp/project/.claude/worktrees/desktop-main-12345678'),
      makeWorktreeStateEntry(sessionId, '/tmp/project/.claude/worktrees/desktop-main-12345678', {
        originalCwd: '/tmp/project',
      }),
      makeUserEntry('Hello from CLI worktree'),
    ])

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo?.worktreeSession).toMatchObject({
      originalCwd: '/tmp/project',
      worktreePath: '/tmp/project/.claude/worktrees/desktop-main-12345678',
      worktreeName: 'desktop-main-12345678',
      worktreeBranch: 'worktree-desktop-main-12345678',
      originalBranch: 'main',
    })
  })

  it('should preserve repository metadata when replacing placeholder transcripts', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId, workDir: sessionWorkDir } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )

    await service.clearSessionTranscript(sessionId, sessionWorkDir)
    const launchInfo = await service.getSessionLaunchInfo(sessionId)

    expect(launchInfo?.workDir).toBe(sessionWorkDir)
    expect(launchInfo?.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      worktree: true,
      worktreePath: expect.stringContaining(path.join('.claude', 'worktrees', 'desktop-feature-rail-')),
    })
  })

  it('should preserve permission metadata when clearing placeholder transcripts', async () => {
    const workDir = path.join(tmpDir, 'clear-permission-workdir')
    await fs.mkdir(workDir, { recursive: true })
    const { sessionId } = await (service.createSession as unknown as (
      workDir?: string,
      repositoryOptions?: unknown,
      permissionMode?: string,
    ) => Promise<{ sessionId: string; workDir: string }>)(workDir, undefined, 'acceptEdits')

    await service.clearSessionTranscript(sessionId, workDir)
    const launchInfo = await service.getSessionLaunchInfo(sessionId)

    expect(launchInfo?.workDir).toBe(await fs.realpath(workDir))
    expect(launchInfo?.permissionMode).toBe('acceptEdits')
  })

  it('should persist session permission mode in launch metadata', async () => {
    const workDir = path.join(tmpDir, 'permission-workdir')
    await fs.mkdir(workDir, { recursive: true })
    const { sessionId } = await (service.createSession as unknown as (
      workDir?: string,
      repositoryOptions?: unknown,
      permissionMode?: string,
    ) => Promise<{ sessionId: string; workDir: string }>)(workDir, undefined, 'acceptEdits')

    let launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo?.permissionMode).toBe('acceptEdits')

    await (service.appendSessionMetadata as unknown as (
      sessionId: string,
      metadata: { workDir: string; permissionMode?: string },
    ) => Promise<void>)(sessionId, {
      workDir,
      permissionMode: 'plan',
    })

    launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo?.permissionMode).toBe('plan')
  })

  it('should not append duplicate runtime metadata when it already matches', async () => {
    const workDir = '/tmp/runtime-idempotent'
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const filePath = await writeSessionFile(sanitizePath(workDir), sessionId, [
      makeSnapshotEntry(),
      {
        ...makeSessionMetaEntry(workDir),
        runtimeProviderId: 'provider-a',
        runtimeModelId: 'model-a',
        effortLevel: 'max',
      },
      makeUserEntry('Runtime metadata should stay stable'),
    ])
    const before = await fs.readFile(filePath, 'utf-8')

    await service.appendSessionMetadata(sessionId, {
      workDir,
      runtimeProviderId: 'provider-a',
      runtimeModelId: 'model-a',
      effortLevel: 'max',
    })

    expect(await fs.readFile(filePath, 'utf-8')).toBe(before)

    await service.appendSessionMetadata(sessionId, {
      workDir,
      runtimeProviderId: 'provider-a',
      runtimeModelId: 'model-b',
      effortLevel: 'max',
    })

    const afterChange = await fs.readFile(filePath, 'utf-8')
    expect(afterChange).not.toBe(before)
    expect(afterChange).toContain('"runtimeModelId":"model-b"')
  })

  it('should remove stale placeholder files after native CLI worktree startup', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const sourceFile = await writeSessionFile('-tmp-source', sessionId, [
      makeSnapshotEntry(),
      { type: 'session-meta', isMeta: true, workDir: '/tmp/source', timestamp: '2026-01-01T00:00:00.000Z' },
      { type: 'session-meta', isMeta: true, workDir: '/tmp/source/.claude/worktrees/desktop-agent', timestamp: '2026-01-01T00:00:02.000Z' },
    ])
    const worktreeFile = await writeSessionFile('-tmp-source--claude-worktrees-desktop-agent', sessionId, [
      makeSnapshotEntry(),
      { type: 'session-meta', isMeta: true, workDir: '/tmp/source/.claude/worktrees/desktop-agent', timestamp: '2026-01-01T00:00:01.000Z' },
      makeUserEntry('Hello from worktree'),
    ])

    const removed = await service.deletePlaceholderSessionFiles(
      sessionId,
      '/tmp/source/.claude/worktrees/desktop-agent',
    )

    expect(removed).toBe(1)
    await expect(fs.access(sourceFile)).rejects.toThrow()
    await expect(fs.access(worktreeFile)).resolves.toBeNull()
  })

  it('should move repository metadata to the CLI worktree transcript before deleting placeholders', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'main', worktree: true },
    )
    const initialLaunchInfo = await service.getSessionLaunchInfo(sessionId)
    const worktreePath = initialLaunchInfo?.repository?.worktreePath
    expect(worktreePath).toBeTruthy()

    const worktreeFile = await writeSessionFile(sanitizePath(worktreePath!), sessionId, [
      makeSnapshotEntry(),
      {
        type: 'system',
        subtype: 'init',
        cwd: worktreePath,
        timestamp: '2026-01-01T00:00:01.000Z',
      },
      makeUserEntry('Hello from worktree'),
    ])

    await service.appendSessionMetadata(sessionId, {
      workDir: worktreePath!,
    })
    const removed = await service.deletePlaceholderSessionFiles(sessionId, worktreePath!)
    const launchInfo = await service.getSessionLaunchInfo(sessionId)

    expect(removed).toBe(1)
    await expect(fs.access(worktreeFile)).resolves.toBeNull()
    expect(launchInfo?.workDir).toBe(worktreePath)
    expect(launchInfo?.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      branch: 'main',
      worktree: true,
      worktreePath,
      worktreeSlug: initialLaunchInfo?.repository?.worktreeSlug,
    })
  })

  it('should recover workDir from transcript cwd when session-meta is missing', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        ...makeUserEntry('Hello'),
        cwd: '/tmp/from-cwd',
      },
    ])

    const workDir = await service.getSessionWorkDir(sessionId)
    expect(workDir).toBe('/tmp/from-cwd')
  })

  // --------------------------------------------------------------------------
  // createSession
  // --------------------------------------------------------------------------

  it('should create a new session file', async () => {
    const workDir = path.join(tmpDir, 'workspace', 'my-project')
    await fs.mkdir(workDir, { recursive: true })
    const { sessionId } = await service.createSession(workDir)
    expect(sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    )

    // Verify the file was created
    const canonicalWorkDir = await fs.realpath(workDir)
    const sanitized = sanitizePath(canonicalWorkDir)
    const filePath = path.join(tmpDir, 'projects', sanitized, `${sessionId}.jsonl`)
    const stat = await fs.stat(filePath)
    expect(stat.isFile()).toBe(true)

    // Verify the file starts with the initial snapshot entry
    const content = await fs.readFile(filePath, 'utf-8')
    const entry = JSON.parse(content.trim().split('\n')[0]!)
    expect(entry.type).toBe('file-history-snapshot')
  })

  it('should defer isolated worktree creation until CLI startup', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId, workDir: sessionWorkDir } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )

    expect(sessionWorkDir).toBe(await fs.realpath(workDir))
    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    expect(git(workDir, 'status', '--porcelain')).toBe('')

    const sanitized = sanitizePath(await fs.realpath(workDir))
    const filePath = path.join(tmpDir, 'projects', sanitized, `${sessionId}.jsonl`)
    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n')
    const metadata = JSON.parse(lines[1]!)
    const plannedWorktreePath = metadata.repository.worktreePath as string
    expect(metadata.workDir).toBe(await fs.realpath(workDir))
    expect(metadata.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      branch: 'feature/rail',
      worktree: true,
      baseRef: 'feature/rail',
      worktreePath: expect.stringContaining(path.join('.claude', 'worktrees', 'desktop-feature-rail-')),
      worktreeBranch: expect.stringContaining('worktree-desktop-feature-rail-'),
      worktreeSlug: expect.stringContaining('desktop-feature-rail-'),
    })
    await expect(fs.access(plannedWorktreePath)).rejects.toThrow()

    const context = await getRepositoryContext(workDir)
    expect(context.state).toBe('ok')
    expect(context.branches.map((branch) => branch.name)).not.toContain(
      path.basename(plannedWorktreePath).replace(/^desktop-/, 'worktree-desktop-'),
    )
    expect(context.branches.some((branch) => branch.name.startsWith('worktree-desktop-'))).toBe(false)
  })

  it('should defer direct branch switching until CLI startup when worktree isolation is disabled', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const { sessionId, workDir: sessionWorkDir } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: false },
    )

    expect(sessionWorkDir).toBe(await fs.realpath(workDir))
    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')

    const sanitized = sanitizePath(await fs.realpath(workDir))
    const filePath = path.join(tmpDir, 'projects', sanitized, `${sessionId}.jsonl`)
    const lines = (await fs.readFile(filePath, 'utf-8')).trim().split('\n')
    const metadata = JSON.parse(lines[1]!)
    expect(metadata.workDir).toBe(await fs.realpath(workDir))
    expect(metadata.repository).toMatchObject({
      requestedWorkDir: await fs.realpath(workDir),
      branch: 'feature/rail',
      worktree: false,
      baseRef: 'feature/rail',
    })
  })

  it('should not list hidden desktop worktree branches', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const existingWorktree = path.join(tmpDir, `desktop-hidden-${Date.now()}`)
    git(workDir, 'worktree', 'add', '-b', 'worktree-desktop-hidden', existingWorktree, 'feature/rail')

    expect(git(existingWorktree, 'branch', '--show-current')).toBe('worktree-desktop-hidden\n')

    const context = await getRepositoryContext(existingWorktree)
    expect(context.state).toBe('ok')
    expect(context.currentBranch).toBe('worktree-desktop-hidden')
    expect(context.branches.some((branch) => branch.name === context.currentBranch)).toBe(false)
    expect(context.branches.some((branch) => branch.name.startsWith('worktree-desktop-'))).toBe(false)
  })

  it('should keep stale worktree records when their paths cannot be resolved', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const staleWorktreeName = `stale-worktree-${Date.now()}`
    const staleWorktree = path.join(tmpDir, staleWorktreeName)
    git(workDir, 'worktree', 'add', '-b', 'stale-worktree', staleWorktree, 'feature/rail')
    await fs.rm(staleWorktree, { recursive: true, force: true })

    const context = await getRepositoryContext(workDir)
    const expectedPath = path.join(await fs.realpath(tmpDir), staleWorktreeName).normalize('NFC')
    expect(context.state).toBe('ok')
    expect(context.worktrees.some((worktree) => (
      worktree.path === expectedPath && worktree.branch === 'stale-worktree' && !worktree.current
    ))).toBe(true)
  })

  it('should let git carry compatible dirty changes during direct branch launch', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    await fs.writeFile(path.join(workDir, 'README.md'), 'main\nlocal-pricing-edit\n')

    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: false },
    )

    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    expect(await fs.readFile(path.join(workDir, 'README.md'), 'utf-8'))
      .toContain('local-pricing-edit')
    const prepared = await prepareSessionWorkspace(
      workDir,
      { branch: 'feature/rail', worktree: false },
      sessionId,
    )

    expect(prepared.workDir).toBe(await fs.realpath(workDir))
    expect(git(workDir, 'branch', '--show-current')).toBe('feature/rail\n')
    expect(await fs.readFile(path.join(workDir, 'README.md'), 'utf-8'))
      .toContain('local-pricing-edit')
  })

  it('should plan isolated worktrees from dirty source checkouts without switching branches', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    await fs.writeFile(path.join(workDir, 'README.md'), 'main\nlocal-pricing-edit\n')

    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: true },
    )
    const launchInfo = await service.getSessionLaunchInfo(sessionId)

    expect(launchInfo?.repository).toMatchObject({
      branch: 'feature/rail',
      worktree: true,
      baseRef: 'feature/rail',
    })
    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    expect(await fs.readFile(path.join(workDir, 'README.md'), 'utf-8'))
      .toContain('local-pricing-edit')
  })

  it('should defer checked-out direct branch launch validation until CLI startup', async () => {
    const workDir = await createCleanGitRepo(tmpDir)
    const existingWorktree = path.join(tmpDir, `existing-feature-rail-${Date.now()}`)
    git(workDir, 'worktree', 'add', existingWorktree, 'feature/rail')

    const { sessionId } = await service.createSession(
      workDir,
      { branch: 'feature/rail', worktree: false },
    )

    expect(git(workDir, 'branch', '--show-current')).toBe('main\n')
    await expect(prepareSessionWorkspace(
      workDir,
      { branch: 'feature/rail', worktree: false },
      sessionId,
    )).rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_CHECKED_OUT' })
  })

  it('should reject branch launch outside Git repositories with a stable error code', async () => {
    const workDir = path.join(tmpDir, `not-git-${Date.now()}`)
    await fs.mkdir(workDir, { recursive: true })

    await expect(service.createSession(
      workDir,
      { branch: 'main', worktree: false },
    )).rejects.toMatchObject({ code: 'REPOSITORY_NOT_GIT' })
  })

  it('should reject missing selected branches with a stable error code', async () => {
    const workDir = await createCleanGitRepo(tmpDir)

    await expect(service.createSession(
      workDir,
      { branch: 'missing/branch', worktree: true },
    )).rejects.toMatchObject({ code: 'REPOSITORY_BRANCH_NOT_FOUND' })
  })

  it('should create a Windows-safe project directory name', async () => {
    if (process.platform !== 'win32') return

    const workDir = process.cwd()
    const { sessionId } = await service.createSession(workDir)
    const sanitized = sanitizePath(workDir)
    const projectDir = path.join(tmpDir, 'projects', sanitized)

    expect(sanitized.includes(':')).toBe(false)
    const stat = await fs.stat(path.join(projectDir, `${sessionId}.jsonl`))
    expect(stat.isFile()).toBe(true)
  })

  it('should default to the user home directory when workDir is missing', async () => {
    const { sessionId } = await service.createSession('')
    const filePath = path.join(
      tmpDir,
      'projects',
      sanitizePath(os.homedir()),
      `${sessionId}.jsonl`,
    )

    const stat = await fs.stat(filePath)
    expect(stat.isFile()).toBe(true)
  })

  it('should throw when workDir does not exist', async () => {
    expect(service.createSession('/tmp/definitely-missing-billiardbuddy')).rejects.toThrow(
      'Working directory does not exist'
    )
  })

  // --------------------------------------------------------------------------
  // renameSession
  // --------------------------------------------------------------------------

  it('should rename a session by appending custom-title entry', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const filePath = await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('Original message'),
    ])

    await service.renameSession(sessionId, 'My Custom Title')

    // Read the file and check the last entry
    const content = await fs.readFile(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    const lastEntry = JSON.parse(lines[lines.length - 1]!)
    expect(lastEntry.type).toBe('custom-title')
    expect(lastEntry.customTitle).toBe('My Custom Title')

    const { sessions } = await service.listSessions()
    expect(sessions.find((session) => session.id === sessionId)?.title).toBe('My Custom Title')
    expect(await service.getCustomTitle(sessionId)).toBe('My Custom Title')
  })

  it('should throw when renaming non-existent session', async () => {
    expect(
      service.renameSession('00000000-0000-0000-0000-000000000000', 'Title')
    ).rejects.toThrow('Session not found')
  })

  // --------------------------------------------------------------------------
  // Title extraction
  // --------------------------------------------------------------------------

  it('should use first user message as title when no custom title', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeMetaUserEntry(),
      makeUserEntry('This is my first real question'),
    ])

    const { sessions } = await service.listSessions()
    expect(sessions.find((session) => session.id === sessionId)?.title)
      .toBe('This is my first real question')
  })

  it('should derive a clean title from slash command breadcrumb metadata', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry([
        '<command-message>frontend-design</command-message>',
        '<command-name>/frontend-design</command-name>',
        '<command-args>@website 重新设计首页</command-args>',
      ].join('\n')),
    ])

    const { sessions } = await service.listSessions()
    expect(sessions.find((session) => session.id === sessionId)?.title)
      .toBe('/frontend-design @website 重新设计首页')
  })

  it('should keep a goal creation title instead of later goal status titles', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      {
        parentUuid: null,
        isSidechain: false,
        type: 'system',
        subtype: 'local_command',
        content: '<command-name>/goal</command-name>\n<command-message>goal</command-message>\n<command-args>ship the actual objective</command-args>',
        level: 'info',
        timestamp: '2026-01-01T00:00:01.000Z',
        uuid: 'goal-command',
      },
      {
        type: 'ai-title',
        aiTitle: '/goal status',
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    ])

    const { sessions } = await service.listSessions()
    expect(sessions.find((session) => session.id === sessionId)?.title)
      .toBe('/goal ship the actual objective')
  })

  it('should display stored AI titles without internal XML tags', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry('fallback message'),
      {
        type: 'ai-title',
        aiTitle: [
          '<command-message>frontend-design</command-message>',
          '<command-name>/frontend-design</command-name>',
          '<command-args>@website</command-args>',
        ].join(' '),
        timestamp: '2026-01-01T00:02:00.000Z',
      },
    ])

    const { sessions } = await service.listSessions()
    expect(sessions.find((session) => session.id === sessionId)?.title)
      .toBe('/frontend-design @website')
  })

  it('should truncate long titles to 80 chars', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const longMessage = 'A'.repeat(120)
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      makeUserEntry(longMessage),
    ])

    const { sessions } = await service.listSessions()
    const title = sessions.find((session) => session.id === sessionId)?.title
    expect(title).toHaveLength(83) // 80 + '...'
    expect(title?.endsWith('...')).toBe(true)
  })

  it('should fall back to "Untitled Session" when no user message', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    await writeSessionFile('-tmp-project', sessionId, [makeSnapshotEntry()])

    const { sessions } = await service.listSessions()
    expect(sessions.find((session) => session.id === sessionId)?.title).toBe('Untitled Session')
  })

  it('should detect placeholder launch info for desktop-created sessions', async () => {
    const workDir = await fs.realpath(os.tmpdir())
    const { sessionId } = await service.createSession(workDir)

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe(workDir)
    expect(launchInfo!.transcriptMessageCount).toBe(0)
    expect(launchInfo!.customTitle).toBeNull()
  })

  it('should detect resumable launch info for transcript sessions', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const userUuid = crypto.randomUUID()
    await writeSessionFile('-tmp-project', sessionId, [
      makeSnapshotEntry(),
      { type: 'session-meta', isMeta: true, workDir: '/tmp/project', timestamp: '2026-01-01T00:00:00.000Z' },
      makeUserEntry('Hello again', userUuid),
      makeAssistantEntry('Welcome back', userUuid),
      { type: 'custom-title', customTitle: 'Saved chat', timestamp: '2026-01-01T00:03:00.000Z' },
    ])

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe('/tmp/project')
    expect(launchInfo!.transcriptMessageCount).toBe(2)
    expect(launchInfo!.customTitle).toBe('Saved chat')
  })

  it('should recover Windows drive paths from sanitized project dirs for old transcripts without metadata', async () => {
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff'
    const userUuid = crypto.randomUUID()
    const userEntry = makeUserEntry('Resume this Windows session', userUuid)
    delete userEntry.cwd
    await writeSessionFile('g--AI-NTos-NT-deepseek-nano-core', sessionId, [
      makeSnapshotEntry(),
      userEntry,
      makeAssistantEntry('Welcome back', userUuid),
    ])

    const expectedWorkDir = 'g:\\AI\\NTos\\NT\\deepseek\\nano\\core'
    expect(await service.getSessionWorkDir(sessionId)).toBe(expectedWorkDir)

    const launchInfo = await service.getSessionLaunchInfo(sessionId)
    expect(launchInfo).not.toBeNull()
    expect(launchInfo!.workDir).toBe(expectedWorkDir)
    expect(launchInfo!.transcriptMessageCount).toBe(2)
  })

  it('createSessionBranch should preserve branch metadata, copied snapshots, and filtered replacements', async () => {
    const sessionId = 'branch-source-session'
    const workDir = path.join(tmpDir, 'branch-source')
    const worktreePath = path.join(workDir, '.claude', 'worktrees', 'desktop-main-12345678')
    const firstUserId = crypto.randomUUID()
    const firstAssistantId = crypto.randomUUID()
    const firstToolResultId = crypto.randomUUID()
    const laterUserId = crypto.randomUUID()
    const laterAssistantId = crypto.randomUUID()
    const repository = {
      branch: 'feature/rail',
      worktree: true,
      baseRef: 'feature/rail',
      repoRoot: workDir,
    }
    const sourceProjectDir = sanitizePath(workDir)
    const sourcePath = await writeSessionFile(sourceProjectDir, sessionId, [
      makeSessionMetaEntry(workDir),
      {
        type: 'session-meta',
        isMeta: true,
        workDir,
        repository,
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      makeWorktreeStateEntry(sessionId, worktreePath, {
        originalCwd: workDir,
      }),
      makeFileHistorySnapshotEntry(firstUserId, {
        'src/step.js': {
          backupFileName: 'branch-source-step@v1',
          version: 1,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('branch this conversation', firstUserId),
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantToolUseEntry([
          { id: 'tool-1', name: 'Read', input: { path: 'src/step.js' } },
        ], firstUserId),
        uuid: firstAssistantId,
        cwd: workDir,
        sessionId,
      },
      {
        ...makeToolResultUserEntry('tool-1', 'first tool result', firstToolResultId, firstAssistantId, sessionId),
        cwd: workDir,
      },
      makeContentReplacementEntry(sessionId, [
        { kind: 'tool-result', toolUseId: 'tool-1', replacement: 'preview-1' },
        { kind: 'tool-result', toolUseId: 'tool-2', replacement: 'preview-2' },
      ]),
      makeFileHistorySnapshotEntry(laterUserId, {
        'src/step.js': {
          backupFileName: 'branch-source-step@v2',
          version: 2,
          backupTime: '2026-01-01T00:00:00.000Z',
        },
      }),
      {
        ...makeUserEntry('later prompt', laterUserId),
        parentUuid: firstToolResultId,
        cwd: workDir,
        sessionId,
      },
      {
        ...makeAssistantEntry('later reply', laterUserId),
        uuid: laterAssistantId,
        cwd: workDir,
        sessionId,
      },
    ])

    const sourceBefore = await fs.readFile(sourcePath, 'utf-8')

    const branch = await createSessionBranch({
      sourceSessionId: sessionId,
      sourceTranscriptPath: sourcePath,
      targetMessageId: firstToolResultId,
      title: 'Desktop branch',
      sourceWorkDir: workDir,
      sourceRepository: repository,
      sourceWorktreeSession: {
        originalCwd: workDir,
        worktreePath,
        worktreeName: 'desktop-main-12345678',
        worktreeBranch: 'worktree-desktop-main-12345678',
        originalBranch: 'main',
        sessionId,
      },
    })

    const branchMessages = await service.getSessionMessages(branch.sessionId)
    expect(branchMessages.map((message) => message.id)).toEqual([
      firstUserId,
      firstAssistantId,
      firstToolResultId,
    ])
    expect(branch.title).toBe('Desktop branch (Branch)')

    const launchInfo = await service.getSessionLaunchInfo(branch.sessionId)
    expect(launchInfo).toMatchObject({
      workDir,
      repository,
      worktreeSession: {
        originalCwd: workDir,
        worktreePath,
      },
    })

    const branchEntries = parseJSONL<Record<string, unknown>>(await fs.readFile(branch.forkPath))
    expect(branchEntries.some((entry) => (
      entry.type === 'content-replacement' &&
      entry.sessionId === branch.sessionId &&
      Array.isArray(entry.replacements) &&
      entry.replacements.length === 1 &&
      (entry.replacements[0] as { toolUseId?: string }).toolUseId === 'tool-1'
    ))).toBe(true)
    expect(branchEntries.some((entry) => (
      entry.type === 'file-history-snapshot' &&
      typeof (entry.snapshot as { messageId?: string } | undefined)?.messageId === 'string' &&
      (entry.snapshot as { messageId?: string }).messageId === firstUserId
    ))).toBe(true)
    expect(branchEntries.some((entry) => (
      entry.type === 'file-history-snapshot' &&
      typeof (entry.snapshot as { messageId?: string } | undefined)?.messageId === 'string' &&
      (entry.snapshot as { messageId?: string }).messageId === laterUserId
    ))).toBe(false)
    expect(branchEntries.some((entry) => (
      entry.type === 'custom-title' &&
      entry.customTitle === 'Desktop branch (Branch)'
    ))).toBe(true)
    expect(branchEntries.filter((entry) => (
      entry.type === 'user' ||
      entry.type === 'assistant'
    )).every((entry) => (
      entry.sessionId === branch.sessionId &&
      typeof (entry.forkedFrom as { sessionId?: string } | undefined)?.sessionId === 'string'
    ))).toBe(true)

    const sourceAfter = await fs.readFile(sourcePath, 'utf-8')
    expect(sourceAfter).toBe(sourceBefore)
  })

  it('createSessionBranch should write an isolated workspace only after it is materialized', async () => {
    const sourceSessionId = 'branch-isolated-source'
    const workDir = await createCleanGitRepo(tmpDir)
    const sourceWorktreePath = path.join(workDir, '.claude', 'worktrees', 'desktop-source')
    const sourceProjectDir = sanitizePath(workDir)
    const userId = crypto.randomUUID()
    const sourcePath = await writeSessionFile(sourceProjectDir, sourceSessionId, [
      {
        type: 'session-meta',
        isMeta: true,
        workDir,
        repository: {
          requestedWorkDir: workDir,
          repoRoot: workDir,
          branch: 'main',
          worktree: true,
          baseRef: 'main',
          worktreePath: sourceWorktreePath,
          worktreeBranch: 'worktree-desktop-source',
          worktreeSlug: 'desktop-source',
        },
        timestamp: '2026-01-01T00:00:00.000Z',
      },
      makeWorktreeStateEntry(sourceSessionId, sourceWorktreePath, {
        originalCwd: workDir,
      }),
      {
        ...makeUserEntry('continue in a clean worktree', userId),
        cwd: workDir,
        sessionId: sourceSessionId,
      },
      {
        ...makeAssistantEntry('ready to continue', userId),
        cwd: workDir,
        sessionId: sourceSessionId,
      },
    ])
    const targetSessionId = crypto.randomUUID()
    const preparedWorkspace = await prepareSessionWorkspace(
      workDir,
      { branch: 'main', worktree: true },
      targetSessionId,
    )

    try {
      const branch = await createSessionBranch({
        sourceSessionId,
        sourceTranscriptPath: sourcePath,
        sourceWorkDir: workDir,
        targetSessionId,
        targetWorkDir: preparedWorkspace.workDir,
        targetRepository: preparedWorkspace.repository,
      })

      expect(branch.sessionId).toBe(targetSessionId)
      const launchInfo = await service.getSessionLaunchInfo(branch.sessionId)
      expect(launchInfo?.workDir).toBe(preparedWorkspace.workDir)
      expect(launchInfo?.repository).toEqual(preparedWorkspace.repository)
      expect(launchInfo && isMaterializedWorktreeLaunch(launchInfo)).toBe(true)

      const branchEntries = parseJSONL<Record<string, unknown>>(
        await fs.readFile(branch.forkPath),
      )
      expect(branchEntries.some((entry) => entry.type === 'worktree-state')).toBe(false)
    } finally {
      await cleanupPreparedSessionWorkspace(preparedWorkspace)
    }
  })
})
