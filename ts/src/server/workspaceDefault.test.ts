import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './index'
import { UserSettingsStore } from './services/userSettings'
import { WORKSPACE_DIR_ENV } from '../harness/desktopEnvNames'

const ORIG_WS = process.env[WORKSPACE_DIR_ENV]
afterEach(() => {
  if (ORIG_WS === undefined) delete process.env[WORKSPACE_DIR_ENV]
  else process.env[WORKSPACE_DIR_ENV] = ORIG_WS
})

test('startServer mounts workspace routes with the configured default and persistent store', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'ws-state-'))
  const defaultWs = mkdtempSync(join(tmpdir(), 'ws-default-'))
  const picked = mkdtempSync(join(tmpdir(), 'ws-picked-'))
  process.env[WORKSPACE_DIR_ENV] = defaultWs
  const server = startServer({ port: 0, transcriptRoot: stateRoot, mcpConfigPath: join(stateRoot, 'missing.mcp.json') })
  const url = `http://127.0.0.1:${server.port}/api/v1/workspace`
  try {
    const g0 = await (await fetch(url)).json() as Record<string, unknown>
    expect(g0.default).toBe(defaultWs)
    expect(g0.persisted).toBeNull()
    expect(g0.current).toBe(defaultWs)

    const p = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: picked }) })).json() as Record<string, unknown>
    expect(p.persisted).toBe(picked)
    expect(p.current).toBe(picked)
    expect((await new UserSettingsStore(stateRoot).get()).lastWorkspaceRoot).toBe(picked)
  } finally {
    server.stop(true)
    rmSync(stateRoot, { recursive: true, force: true })
    rmSync(defaultWs, { recursive: true, force: true })
    rmSync(picked, { recursive: true, force: true })
  }
})
