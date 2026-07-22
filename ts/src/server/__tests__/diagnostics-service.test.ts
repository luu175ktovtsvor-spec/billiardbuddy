import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createServer } from 'node:net'
import * as os from 'node:os'
import * as path from 'node:path'
import { handleDiagnosticsApi } from '../api/diagnostics.js'
import { DiagnosticsService, diagnosticsService } from '../services/diagnosticsService.js'

let tmpDir: string
let originalConfigDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'billiardbuddy-diagnostics-test-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = tmpDir
})

afterEach(async () => {
  diagnosticsService.restoreConsoleCaptureForTests()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeRequest(
  method: string,
  urlStr: string,
  body?: unknown,
): { req: Request; url: URL; segments: string[] } {
  const url = new URL(urlStr, 'http://localhost:3456')
  const req = new Request(url.toString(), {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
  })
  const segments = url.pathname.split('/').filter(Boolean)
  return { req, url, segments }
}

async function getPort(): Promise<{ server: ReturnType<typeof createServer>; port: number }> {
  return await new Promise((resolve, reject) => {
    const server = createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a local port')))
        return
      }
      resolve({ server, port: address.port })
    })
  })
}

describe('DiagnosticsService', () => {
  test('writes sanitized structured events and runtime error summaries', async () => {
    const service = new DiagnosticsService()
    await service.recordEvent({
      type: 'cli_start_failed',
      severity: 'error',
      sessionId: 'session-1',
      summary: 'Authorization: Bearer sk-secret-token /Users/example/path',
      details: {
        apiKey: 'sk-secret',
        url: 'https://api.example.com?api_key=secret-value',
        proxyUrl: 'https://proxy-user:p%40ss@example.com:8443/api',
        nested: { message: `home=${os.homedir()}` },
      },
    })

    const raw = await fs.readFile(path.join(tmpDir, 'billiardbuddy', 'diagnostics', 'diagnostics.jsonl'), 'utf-8')
    expect(raw).toContain('cli_start_failed')
    expect(raw).toContain('[REDACTED]')
    expect(raw).toContain('https://[REDACTED]@example.com:8443/api')
    expect(raw).not.toContain('sk-secret')
    expect(raw).not.toContain('proxy-user')
    expect(raw).not.toContain('p%40ss')
    expect(raw).not.toContain(os.homedir())

    const runtime = await fs.readFile(path.join(tmpDir, 'billiardbuddy', 'diagnostics', 'runtime-errors.log'), 'utf-8')
    expect(runtime).toContain('cli_start_failed')
    expect(runtime).toContain('"nested"')
    expect(runtime).toContain('[REDACTED]')
    expect(runtime).not.toContain('sk-secret-token')
  })

  test('defaults an unclassified event to info, not error', async () => {
    const service = new DiagnosticsService()
    await service.recordEvent({ type: 'some_unclassified_event', summary: 'no severity given' })

    const raw = await fs.readFile(path.join(tmpDir, 'billiardbuddy', 'diagnostics', 'diagnostics.jsonl'), 'utf-8')
    const event = JSON.parse(raw.trim().split('\n').at(-1)!)
    expect(event.severity).toBe('info')

    await expect(
      fs.readFile(path.join(tmpDir, 'billiardbuddy', 'diagnostics', 'runtime-errors.log'), 'utf-8'),
    ).rejects.toThrow()
  })

  test('drops events under NODE_ENV=test when no CLAUDE_CONFIG_DIR is set', async () => {
    const service = new DiagnosticsService()
    const appendSpy = spyOn(fs, 'appendFile')
    const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
    delete process.env.CLAUDE_CONFIG_DIR
    try {
      await service.recordEvent({ type: 'leaked_test_event', severity: 'error', summary: 'should not be written' })
      expect(appendSpy).not.toHaveBeenCalled()
    } finally {
      appendSpy.mockRestore()
      if (savedConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
      else process.env.CLAUDE_CONFIG_DIR = savedConfigDir
    }
  })

  test('keeps fatal startup errors visible on stderr while recording diagnostics', async () => {
    const { server: blocker, port } = await getPort()
    const serverArgs = ['bun', 'run', 'src/server/index.ts', '--host', '127.0.0.1', '--port', String(port)]
    const env = {
      ...process.env,
      CLAUDE_CONFIG_DIR: tmpDir,
    }
    delete (env as Record<string, string | undefined>).NODE_ENV

    try {
      const duplicate = Bun.spawn(serverArgs, {
        cwd: process.cwd(),
        env,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(duplicate.stdout).text(),
        new Response(duplicate.stderr).text(),
        duplicate.exited,
      ])

      expect(exitCode).toBe(1)
      expect(stdout).toBe('')
      expect(stderr).toContain('[Server] Uncaught exception:')
      expect(stderr).toContain(`Failed to start server. Is port ${port} in use?`)

      const raw = await fs.readFile(path.join(tmpDir, 'billiardbuddy', 'diagnostics', 'diagnostics.jsonl'), 'utf-8')
      expect(raw).toContain('server_uncaught_exception')
      expect(raw).toContain(`Failed to start server. Is port ${port} in use?`)
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close(error => (error ? reject(error) : resolve()))
      })
    }
  }, 15_000)
})

describe('diagnostics API', () => {
  test('accepts only bounded automatic client reports and retires the console endpoints', async () => {
    const report = makeRequest('POST', '/api/diagnostics/events', {
      type: 'client_unhandled_rejection',
      severity: 'error',
      summary: 'frontend exploded token=client-secret at /private/client.ts',
      sessionId: 'task-private-id',
      details: {
        accessToken: 'client-secret',
        stack: 'Error: boom',
        url: 'https://example.test/?token=client-secret',
        headers: { authorization: 'Bearer client-secret' },
        provider: 'internal-provider',
        model: 'internal-model',
      },
    })
    const reportResponse = await handleDiagnosticsApi(report.req, report.url, report.segments)
    expect(reportResponse.status).toBe(200)
    expect(await reportResponse.json()).toEqual({ ok: true })

    const raw = await fs.readFile(
      path.join(tmpDir, 'billiardbuddy', 'diagnostics', 'diagnostics.jsonl'),
      'utf-8',
    )
    expect(raw).toContain('client_unhandled_rejection')
    expect(raw).toContain('A desktop application issue was recorded.')
    expect(raw).not.toContain('client-secret')
    expect(raw).not.toContain('task-private-id')
    expect(raw).not.toContain('/private/client.ts')
    expect(raw).not.toContain('Error: boom')
    expect(raw).not.toContain('internal-provider')
    expect(raw).not.toContain('internal-model')

    for (const retired of [
      makeRequest('GET', '/api/diagnostics/status'),
      makeRequest('GET', '/api/diagnostics/events?limit=10'),
      makeRequest('POST', '/api/diagnostics/export'),
      makeRequest('POST', '/api/diagnostics/open-log-dir'),
      makeRequest('DELETE', '/api/diagnostics'),
    ]) {
      const response = await handleDiagnosticsApi(retired.req, retired.url, retired.segments)
      expect(response.status).toBe(404)
    }
  })

  test('maps unsupported client types to a generic safe incident', async () => {
    const report = makeRequest('POST', '/api/diagnostics/events', {
      type: 'provider-model-stack-leak',
      severity: 'not-a-severity',
      summary: '/private/provider.ts',
      details: { model: 'secret-model', stack: 'Error: leaked' },
    })
    const response = await handleDiagnosticsApi(report.req, report.url, report.segments)
    expect(response.status).toBe(200)

    const raw = await fs.readFile(
      path.join(tmpDir, 'billiardbuddy', 'diagnostics', 'diagnostics.jsonl'),
      'utf-8',
    )
    expect(raw).toContain('client_diagnostic_event')
    expect(raw).toContain('A desktop application issue was recorded.')
    expect(raw).not.toContain('provider-model-stack-leak')
    expect(raw).not.toContain('/private/provider.ts')
    expect(raw).not.toContain('secret-model')
  })
})
