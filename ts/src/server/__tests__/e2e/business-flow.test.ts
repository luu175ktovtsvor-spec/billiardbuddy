/**
 * Business Flow E2E Tests
 *
 * 完整的业务流程测试：涵盖定时任务、
 * WebSocket 对话、搜索、会话历史互通等所有核心业务逻辑。
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { fileURLToPath } from 'node:url'

let server: ReturnType<typeof Bun.serve>
let baseUrl: string
let tmpDir: string
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalCliPath = process.env.CLAUDE_CLI_PATH
const originalDisableTerminalShellEnv = process.env.BB_DISABLE_TERMINAL_SHELL_ENV
const mockSdkCliPath = fileURLToPath(new URL('../fixtures/mock-sdk-cli.ts', import.meta.url))

function restoreEnv() {
  if (originalConfigDir !== undefined) {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  } else {
    delete process.env.CLAUDE_CONFIG_DIR
  }
  if (originalCliPath !== undefined) {
    process.env.CLAUDE_CLI_PATH = originalCliPath
  } else {
    delete process.env.CLAUDE_CLI_PATH
  }
  if (originalDisableTerminalShellEnv !== undefined) {
    process.env.BB_DISABLE_TERMINAL_SHELL_ENV = originalDisableTerminalShellEnv
  } else {
    delete process.env.BB_DISABLE_TERMINAL_SHELL_ENV
  }
}

afterAll(() => {
  restoreEnv()
})

async function startTestServer() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-biz-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.CLAUDE_CLI_PATH = mockSdkCliPath
  process.env.BB_DISABLE_TERMINAL_SHELL_ENV = '1'
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })
  await fs.mkdir(path.join(tmpDir, 'agents'), { recursive: true })

  const { startServer } = await import('../../index.js')
  server = startServer(0, '127.0.0.1')
  baseUrl = `http://127.0.0.1:${server.port}`
}

async function api(method: string, urlPath: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

describe('Business Flow: Scheduled Tasks', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // ==========================================================================
  // 定时任务完整生命周期
  // ==========================================================================

  it('should start with no scheduled tasks', async () => {
    const { status, data } = await api('GET', '/api/product/scheduled-tasks')
    expect(status).toBe(200)
    expect(data.tasks).toEqual([])
  })

  it('should create a daily task with all fields', async () => {
    const { status, data } = await api('POST', '/api/product/scheduled-tasks', {
      title: 'morning-standup',
      description: 'Generate standup report from yesterday',
      schedule: '0 9 * * 1-5',
      instruction: 'Look at git log from yesterday, summarize changes, list blockers',
      recurring: true,
      workDir: '/Users/dev/project',
    })
    expect(status).toBe(201)
    expect(data.task).toBeDefined()
    expect(data.task.id).toMatch(/^[0-9a-f]{8}$/)
    expect(data.task.title).toBe('morning-standup')
    expect(data.task.schedule).toBe('0 9 * * 1-5')
    expect(data.task.instruction).toContain('git log')
    expect(data.task.recurring).toBe(true)
    expect(data.task.permissionMode).toBeUndefined()
    expect(data.task.model).toBeUndefined()
    expect(data.task.createdAt).toBeGreaterThan(0)
  })

  it('should create a second one-shot task', async () => {
    const { status, data } = await api('POST', '/api/product/scheduled-tasks', {
      title: 'security audit',
      schedule: '30 14 5 4 *',
      instruction: 'Run security audit',
      recurring: false,
    })
    expect(status).toBe(201)
    expect(data.task.recurring).toBe(false)
  })

  it('should list both tasks', async () => {
    const { data } = await api('GET', '/api/product/scheduled-tasks')
    expect(data.tasks.length).toBe(2)
    expect(data.tasks[0].title).toBe('morning-standup')
  })

  it('should update task schedule', async () => {
    const { data: listData } = await api('GET', '/api/product/scheduled-tasks')
    const taskId = listData.tasks[0].id

    const { status, data } = await api('PATCH', `/api/product/scheduled-tasks/${taskId}`, {
      schedule: '0 8 * * 1-5',
      description: 'Updated: earlier standup',
    })
    expect(status).toBe(200)
    expect(data.task.schedule).toBe('0 8 * * 1-5')
    expect(data.task.description).toBe('Updated: earlier standup')
    // Other fields should remain unchanged
    expect(data.task.title).toBe('morning-standup')
    expect(data.task.instruction).toContain('git log')
  })

  it('should reject creating task without a schedule', async () => {
    const { status, data } = await api('POST', '/api/product/scheduled-tasks', {
      title: 'missing schedule',
      instruction: 'missing schedule field',
    })
    expect(status).toBe(400)
    expect(data.error).toBeDefined()
  })

  it('should reject creating task without instructions', async () => {
    const { status } = await api('POST', '/api/product/scheduled-tasks', {
      title: 'missing instruction',
      schedule: '0 * * * *',
    })
    expect(status).toBe(400)
  })

  it('should reject updating non-existent task', async () => {
    const { status } = await api('PATCH', '/api/product/scheduled-tasks/nonexistent', {
      schedule: '0 * * * *',
    })
    expect(status).toBe(404)
  })

  it('should reject deleting non-existent task', async () => {
    const { status } = await api('DELETE', '/api/product/scheduled-tasks/nonexistent')
    expect(status).toBe(404)
  })

  it('should delete one task', async () => {
    const { data: listData } = await api('GET', '/api/product/scheduled-tasks')
    const taskId = listData.tasks[1].id

    const { status } = await api('DELETE', `/api/product/scheduled-tasks/${taskId}`)
    expect([200, 204]).toContain(status)

    const { data: afterDelete } = await api('GET', '/api/product/scheduled-tasks')
    expect(afterDelete.tasks.length).toBe(1)
  })

  it('should persist tasks to disk', async () => {
    const filePath = path.join(tmpDir, 'scheduled_tasks.json')
    const raw = await fs.readFile(filePath, 'utf-8')
    const parsed = JSON.parse(raw)
    expect(parsed.tasks.length).toBe(1)
    expect(parsed.tasks[0].name).toBe('morning-standup')
  })
})

describe('Business Flow: Sessions & CLI Interop', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  let sessionId: string

  it('should create a session', async () => {
    const workDir = path.join(tmpDir, 'my-project')
    await fs.mkdir(workDir, { recursive: true })
    const { status, data } = await api('POST', '/api/sessions', {
      workDir,
    })
    expect(status).toBe(201)
    expect(data.sessionId).toMatch(/^[0-9a-f-]{36}$/)
    sessionId = data.sessionId
  })

  it('should create session JSONL file on disk (CLI compatible)', async () => {
    const projectDir = path.join(tmpDir, 'projects')
    const dirs = await fs.readdir(projectDir)
    expect(dirs.length).toBeGreaterThan(0)

    // Find the session file
    let found = false
    for (const dir of dirs) {
      const files = await fs.readdir(path.join(projectDir, dir))
      if (files.some((f) => f === `${sessionId}.jsonl`)) {
        found = true
        break
      }
    }
    expect(found).toBe(true)
  })

  it('should simulate CLI writing messages (JSONL format)', async () => {
    // Simulate what CLI does: append JSONL entries
    const projectDir = path.join(tmpDir, 'projects')
    const dirs = await fs.readdir(projectDir)
    let sessionFile = ''
    for (const dir of dirs) {
      const candidate = path.join(projectDir, dir, `${sessionId}.jsonl`)
      try {
        await fs.access(candidate)
        sessionFile = candidate
        break
      } catch {}
    }
    expect(sessionFile).not.toBe('')

    // Append user message (mimicking CLI JSONL format - must include message.role)
    const userEntry = {
      type: 'user',
      uuid: 'msg-001',
      message: { role: 'user', content: [{ type: 'text', text: 'Hello from CLI' }] },
      timestamp: new Date().toISOString(),
      sessionId,
    }
    await fs.appendFile(sessionFile, JSON.stringify(userEntry) + '\n')

    // Append assistant message
    const assistantEntry = {
      type: 'assistant',
      uuid: 'msg-002',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello! How can I help you today?' }] },
      timestamp: new Date().toISOString(),
      sessionId,
      parentUuid: 'msg-001',
    }
    await fs.appendFile(sessionFile, JSON.stringify(assistantEntry) + '\n')
  })

  it('should read CLI-written messages via API', async () => {
    const { status, data } = await api('GET', `/api/sessions/${sessionId}/messages`)
    expect(status).toBe(200)
    expect(data.messages.length).toBe(2)
    expect(data.messages[0].type).toBe('user')
    expect(data.messages[0].content).toBeDefined()
    expect(data.messages[1].type).toBe('assistant')
  })

  it('should show CLI messages in session list', async () => {
    const { data } = await api('GET', '/api/sessions')
    const session = data.sessions.find((s: any) => s.id === sessionId)
    expect(session).toBeDefined()
    expect(session.messageCount).toBeGreaterThanOrEqual(2)
    expect(session.title).toContain('Hello from CLI')
  })

  it('should rename session and verify', async () => {
    await api('PATCH', `/api/sessions/${sessionId}`, { title: 'CLI Test Session' })
    const { data } = await api('GET', `/api/sessions/${sessionId}`)
    expect(data.title).toBe('CLI Test Session')
  })

  it('should rename be persisted as JSONL entry (CLI compatible)', async () => {
    const projectDir = path.join(tmpDir, 'projects')
    const dirs = await fs.readdir(projectDir)
    let sessionFile = ''
    for (const dir of dirs) {
      const candidate = path.join(projectDir, dir, `${sessionId}.jsonl`)
      try {
        await fs.access(candidate)
        sessionFile = candidate
        break
      } catch {}
    }

    const raw = await fs.readFile(sessionFile, 'utf-8')
    const lines = raw.trim().split('\n')
    const lastEntry = JSON.parse(lines[lines.length - 1])
    expect(lastEntry.type).toBe('custom-title')
    expect(lastEntry.customTitle).toBe('CLI Test Session')
  })
})

describe('Business Flow: Retired generic session WebSocket', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('does not expose the retired Core-session upgrade endpoint', async () => {
    const res = await fetch(`${baseUrl}/ws/legacy-session`, {
      headers: { 'Upgrade': 'websocket', 'Connection': 'Upgrade' },
    })
    expect(res.status).toBe(404)
  })
})

describe('Business Flow: Settings Persistence', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should write and read ordinary product preferences', async () => {
    const settings = {
      theme: 'dark',
      chatSendBehavior: 'modifierEnter',
      desktopNotificationsEnabled: true,
      webSearch: { enabled: false },
    }

    const { status } = await api('PUT', '/api/settings/user', settings)
    expect(status).toBe(200)
    const { data } = await api('GET', '/api/settings/user')

    expect(data.theme).toBe('dark')
    expect(data.chatSendBehavior).toBe('modifierEnter')
    expect(data.desktopNotificationsEnabled).toBe(true)
    expect(data.webSearch).toEqual({ enabled: false })
  })

  it('should merge ordinary preferences without accepting Core settings', async () => {
    // First write
    await api('PUT', '/api/settings/user', { theme: 'dark' })
    // Second write (should merge, not overwrite)
    await api('PUT', '/api/settings/user', { language: 'chinese' })

    const { data } = await api('GET', '/api/settings/user')
    expect(data.theme).toBe('dark') // Should still be there
    expect(data.language).toBe('chinese')

    const rejected = await api('PUT', '/api/settings/user', { model: 'not-allowed' })
    expect(rejected.status).toBe(400)
  })

  it('should retire generic and project settings endpoints', async () => {
    expect((await api('GET', '/api/settings')).status).toBe(404)
    expect((await api('GET', '/api/settings/project')).status).toBe(404)
  })
})

describe('Business Flow: Health Check', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should return health with uptime', async () => {
    const { data } = await api('GET', '/api/status')
    expect(data.status).toBe('ok')
    expect(data.uptime).toBeGreaterThanOrEqual(0)
  })

  it('does not expose retired status details', async () => {
    for (const path of ['/api/status/diagnostics', '/api/status/usage', '/api/status/user']) {
      const { status } = await api('GET', path)
      expect(status).toBe(404)
    }
  })

  it('should reject non-GET methods', async () => {
    const { status } = await api('POST', '/api/status')
    expect(status).toBe(405)
  })
})

describe('Business Flow: Error Handling', () => {
  beforeAll(startTestServer)
  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should return 404 for unknown API resource', async () => {
    const { status, data } = await api('GET', '/api/unknown')
    expect(status).toBe(404)
    expect(data.error).toBeDefined()
  })

  it('should return 404 for unknown session', async () => {
    const { status } = await api('GET', '/api/sessions/00000000-0000-0000-0000-000000000000')
    expect(status).toBe(404)
  })

  it('should handle malformed JSON body gracefully', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{invalid json',
    })
    expect(res.status).toBe(400)
  })

  it('should return proper error structure', async () => {
    const { data } = await api('GET', '/api/sessions/nonexistent')
    expect(data).toHaveProperty('error')
    expect(data).toHaveProperty('message')
  })
})
