import { afterEach, describe, expect, test } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, truncateSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from '../index'
import { createWorkspaceFileRouteHandler } from './workspaceFileRoutes'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function createHarness() {
  const root = mkdtempSync(join(tmpdir(), 'workspace-file-routes-'))
  roots.push(root)
  const workspaceRoot = join(root, 'workspace')
  mkdirSync(workspaceRoot)
  const handler = createWorkspaceFileRouteHandler({ defaultWorkspaceRoot: () => workspaceRoot })
  return { root, workspaceRoot, handler }
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://127.0.0.1${path}`, init)
}

async function route(handler: ReturnType<typeof createWorkspaceFileRouteHandler>, path: string, init?: RequestInit): Promise<Response> {
  const response = await handler(new URL(`http://127.0.0.1${path}`), request(path, init))
  if (!response) throw new Error(`route not handled: ${path}`)
  return response
}

describe('workspace file routes', () => {
  test('ignores unrelated paths and preserves non-GET fallthrough', async () => {
    const { handler } = createHarness()
    expect(await handler(new URL('http://127.0.0.1/health'), request('/health'))).toBeNull()
    for (const path of ['/api/v1/agent/fs/list', '/api/v1/agent/fs/read', '/api/v1/agent/fs/raw', '/api/v1/agent/fs/diff']) {
      expect(await handler(new URL(`http://127.0.0.1${path}`), request(path, { method: 'POST' }))).toBeNull()
    }
  })

  test('lists visible entries with directories first and resolves relative paths from the workspace', async () => {
    const { workspaceRoot, handler } = createHarness()
    mkdirSync(join(workspaceRoot, 'z-dir'))
    mkdirSync(join(workspaceRoot, 'a-dir'))
    writeFileSync(join(workspaceRoot, 'b.txt'), 'b')
    writeFileSync(join(workspaceRoot, 'a.txt'), 'a')
    writeFileSync(join(workspaceRoot, '.hidden'), 'hidden')

    expect((await route(handler, '/api/v1/agent/fs/list')).status).toBe(400)
    const listed = await (await route(handler, '/api/v1/agent/fs/list?path=.')).json() as any
    expect(listed.path).toBe(workspaceRoot)
    expect(listed.entries).toEqual([
      { name: 'a-dir', isDir: true },
      { name: 'z-dir', isDir: true },
      { name: 'a.txt', isDir: false },
      { name: 'b.txt', isDir: false },
    ])
    expect((await route(handler, '/api/v1/agent/fs/list?path=a.txt')).status).toBe(404)
  })

  test('reads text and returns the existing large-file truncation response', async () => {
    const { workspaceRoot, handler } = createHarness()
    writeFileSync(join(workspaceRoot, 'small.txt'), 'small text')
    writeFileSync(join(workspaceRoot, 'large.txt'), 'x'.repeat(256 * 1024 + 1))

    expect((await route(handler, '/api/v1/agent/fs/read')).status).toBe(400)
    expect(await (await route(handler, '/api/v1/agent/fs/read?path=small.txt')).json()).toEqual({
      path: join(workspaceRoot, 'small.txt'),
      content: 'small text',
    })
    expect(await (await route(handler, '/api/v1/agent/fs/read?path=large.txt')).json()).toEqual({
      path: join(workspaceRoot, 'large.txt'),
      truncated: true,
      content: '(文件超过 256KB,预览已截断)',
    })
  })

  test('serves raw bytes with MIME headers and rejects escapes and oversized files', async () => {
    const { root, workspaceRoot, handler } = createHarness()
    const image = join(workspaceRoot, 'image.png')
    writeFileSync(image, new Uint8Array([0x89, 0x50, 0x4e, 0x47]))
    const outside = join(root, 'outside.png')
    writeFileSync(outside, 'outside')
    const large = join(workspaceRoot, 'large.bin')
    writeFileSync(large, '')
    truncateSync(large, 20 * 1024 * 1024 + 1)

    expect((await route(handler, '/api/v1/agent/fs/raw')).status).toBe(400)
    const raw = await route(handler, '/api/v1/agent/fs/raw?path=image.png')
    expect(raw.status).toBe(200)
    expect(raw.headers.get('content-type')).toBe('image/png')
    expect(raw.headers.get('cache-control')).toBe('no-cache')
    expect([...new Uint8Array(await raw.arrayBuffer())]).toEqual([0x89, 0x50, 0x4e, 0x47])
    expect((await route(handler, `/api/v1/agent/fs/raw?path=${encodeURIComponent(outside)}`)).status).toBe(403)
    expect((await route(handler, '/api/v1/agent/fs/raw?path=large.bin')).status).toBe(413)
  })

  test('returns non-Git content without a false diff and compares Git files with HEAD', async () => {
    const { workspaceRoot, handler } = createHarness()
    writeFileSync(join(workspaceRoot, 'plain.txt'), 'plain')
    expect(await (await route(handler, '/api/v1/agent/fs/diff?path=plain.txt')).json()).toEqual({
      path: join(workspaceRoot, 'plain.txt'),
      oldString: '',
      newString: 'plain',
      changed: false,
    })
    expect(await (await route(handler, '/api/v1/agent/fs/diff?path=missing.txt')).json()).toEqual({
      path: join(workspaceRoot, 'missing.txt'),
      oldString: '',
      newString: '',
      changed: false,
    })

    execFileSync('git', ['init'], { cwd: workspaceRoot, stdio: 'ignore' })
    writeFileSync(join(workspaceRoot, 'tracked.txt'), 'before\n')
    execFileSync('git', ['add', 'tracked.txt'], { cwd: workspaceRoot })
    execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'initial'], {
      cwd: workspaceRoot,
      stdio: 'ignore',
    })
    writeFileSync(join(workspaceRoot, 'tracked.txt'), 'after\n')
    const realWorkspaceRoot = realpathSync(workspaceRoot)
    const gitDiff = `/api/v1/agent/fs/diff?path=tracked.txt&working_dir=${encodeURIComponent(realWorkspaceRoot)}`
    expect(await (await route(handler, gitDiff)).json()).toEqual({
      path: join(realWorkspaceRoot, 'tracked.txt'),
      oldString: 'before\n',
      newString: 'after\n',
      changed: true,
    })
  })

  test('startServer mounts workspace file routes', async () => {
    const { root, workspaceRoot } = createHarness()
    writeFileSync(join(workspaceRoot, 'mounted.txt'), 'mounted')
    const server = startServer({ port: 0, transcriptRoot: join(root, 'state'), mcpConfigPath: join(root, 'missing.mcp.json') })
    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/api/v1/agent/fs/read?path=mounted.txt&working_dir=${encodeURIComponent(workspaceRoot)}`,
      )
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ path: join(workspaceRoot, 'mounted.txt'), content: 'mounted' })
    } finally {
      server.stop(true)
    }
  })
})
