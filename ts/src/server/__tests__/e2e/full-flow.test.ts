/**
 * E2E Test — 完整流程测试
 *
 * 启动真实服务器，模拟 UI 前端的完整操作流程。
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

// Use dynamic import to avoid bundling issues
async function startTestServer() {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-e2e-'))
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  process.env.CLAUDE_CLI_PATH = mockSdkCliPath
  process.env.BB_DISABLE_TERMINAL_SHELL_ENV = '1'

  // Create required directories
  await fs.mkdir(path.join(tmpDir, 'projects'), { recursive: true })

  const { startServer } = await import('../../index.js')
  server = startServer(0, '127.0.0.1')
  baseUrl = `http://127.0.0.1:${server.port}`
}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => null)
  return { status: res.status, data }
}

describe('E2E: Full Flow', () => {
  beforeAll(async () => {
    await startTestServer()
  })

  afterAll(async () => {
    server?.stop()
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // =============================================
  // 1. Health & Status
  // =============================================

  it('should return healthy status', async () => {
    const res = await fetch(`${baseUrl}/health`)
    const data = await res.json()
    expect(data.status).toBe('ok')
  })

  it('should return server status', async () => {
    const { data } = await api('GET', '/api/status')
    expect(data.status).toBe('ok')
    expect(data.version).toBeDefined()
  })

  it('does not expose retired diagnostics', async () => {
    const { status } = await api('GET', '/api/status/diagnostics')
    expect(status).toBe(404)
  })

  // =============================================
  // 2. Settings
  // =============================================

  it('should get empty settings initially', async () => {
    const { data } = await api('GET', '/api/product/settings/user')
    expect(data).toEqual({})
  })

  it('should update and read user settings', async () => {
    const { status } = await api('PATCH', '/api/product/settings/user', {
      theme: 'dark',
      webSearch: { enabled: false },
    })
    expect(status).toBe(200)

    const { data } = await api('GET', '/api/product/settings/user')
    expect(data.theme).toBe('dark')
    expect(data.webSearch).toEqual({ enabled: false })
  })

  // =============================================
  // 3. Scheduled Tasks
  // =============================================

  let taskId: string

  it('should start with empty task list', async () => {
    const { data } = await api('GET', '/api/product/scheduled-tasks')
    expect(data.tasks).toEqual([])
  })

  it('should create a scheduled task', async () => {
    const { status, data } = await api('POST', '/api/product/scheduled-tasks', {
      schedule: '0 9 * * *',
      instruction: 'Review commits from last 24h',
      recurring: true,
      title: 'daily-review',
      description: 'Daily code review',
    })
    expect(status).toBe(201)
    expect(data.task.id).toBeDefined()
    expect(data.task.schedule).toBe('0 9 * * *')
    taskId = data.task.id
  })

  it('should list the created task', async () => {
    const { data } = await api('GET', '/api/product/scheduled-tasks')
    expect(data.tasks.length).toBe(1)
    expect(data.tasks[0].id).toBe(taskId)
  })

  it('should update a task', async () => {
    const { status, data } = await api('PATCH', `/api/product/scheduled-tasks/${taskId}`, {
      schedule: '0 10 * * 1-5',
    })
    expect(status).toBe(200)
    expect(data.task.schedule).toBe('0 10 * * 1-5')
  })

  it('should delete a task', async () => {
    const { status } = await api('DELETE', `/api/product/scheduled-tasks/${taskId}`)
    expect([200, 204]).toContain(status)

    const { data } = await api('GET', '/api/product/scheduled-tasks')
    expect(data.tasks).toEqual([])
  })

  // =============================================
  // 4. Task command discovery
  // =============================================

  it('should discover safe product task Agent command descriptors', async () => {
    const { data } = await api('GET', '/api/product/task-commands/agents')
    expect(Array.isArray(data.agents)).toBe(true)
    expect(data.agents.length).toBeGreaterThan(0)
    expect(data.agents).toContainEqual({
      displayName: 'agent-guide',
      runtimeName: 'claude-code-guide',
    })
    expect(data).not.toHaveProperty('activeAgents')
    expect(data).not.toHaveProperty('allAgents')
    for (const agent of data.agents) {
      expect(Object.keys(agent).sort()).toEqual(['displayName', 'runtimeName'])
    }
  })

  // =============================================
  // 5. Task-scoped WebSocket
  // =============================================

  it('streams a product task without exposing its private Core session binding', async () => {
    const workDir = path.join(tmpDir, 'task-scoped-socket-project')
    await fs.mkdir(workDir, { recursive: true })
    const { status, data } = await api('POST', '/api/product/tasks', {
      workDir,
      title: '整理本周球房活动',
    })
    expect(status).toBe(201)
    expect(typeof data.task?.id).toBe('string')

    const wsUrl = baseUrl.replace('http://', 'ws://') +
      `/ws/product/tasks/${encodeURIComponent(data.task.id)}`

    const messages: any[] = []
    const ws = new WebSocket(wsUrl)

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Timed out waiting for product task completion'))
      }, 15_000)

      ws.onmessage = (event) => {
        const msg = JSON.parse(event.data as string)
        messages.push(msg)
        if (msg.type === 'connected') {
          ws.send(JSON.stringify({ type: 'user_message', content: '整理本周球房活动' }))
        }
        if (msg.type === 'turn_complete') {
          clearTimeout(timeout)
          ws.close()
          resolve()
        }
      }
      ws.onerror = () => {
        clearTimeout(timeout)
        ws.close()
        reject(new Error('Product task WebSocket error'))
      }
    })

    expect(messages[0]).toEqual({ type: 'connected' })
    expect(messages).toContainEqual({ type: 'assistant_text_delta', text: 'Echo: 整理本周球房活动' })
    expect(messages).toContainEqual({ type: 'turn_complete' })
    expect(messages.every((message) => !Object.prototype.hasOwnProperty.call(message, 'sessionId'))).toBe(true)
  }, 20_000)

  // =============================================
  // 6. CORS
  // =============================================

  // Loopback browser origins (local dev servers) are trusted without a token
  // since 9238481e; only remote origins stay blocked while H5 is disabled.
  it('should allow loopback browser CORS preflight while H5 access is disabled', async () => {
    const res = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: { 'Origin': 'http://localhost:3000' },
    })
    expect(res.status).toBe(204)
  })

  it('should block remote browser CORS preflight while H5 access is disabled', async () => {
    const res = await fetch(`${baseUrl}/api/status`, {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://phone.example' },
    })
    expect(res.status).toBe(403)
  })

  // =============================================
  // 7. Error Handling
  // =============================================

  it('should return 404 for unknown API', async () => {
    const { status } = await api('GET', '/api/nonexistent')
    expect(status).toBe(404)
  })

})
