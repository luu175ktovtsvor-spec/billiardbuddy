import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { WORKSPACE_DIR_ENV, ensureDefaultWorkspace, getDefaultWorkspaceDir } from './desktopEnvNames'

const ORIG = process.env[WORKSPACE_DIR_ENV]
afterEach(() => {
  if (ORIG === undefined) delete process.env[WORKSPACE_DIR_ENV]
  else process.env[WORKSPACE_DIR_ENV] = ORIG
})

test('getDefaultWorkspaceDir:默认落用户可见的 ~/Documents/球房管家/', () => {
  delete process.env[WORKSPACE_DIR_ENV]
  expect(getDefaultWorkspaceDir()).toBe(join(homedir(), 'Documents', '球房管家').normalize('NFC'))
})

test('getDefaultWorkspaceDir:env 覆盖优先(测试/多环境)', () => {
  process.env[WORKSPACE_DIR_ENV] = '/tmp/billiardbuddy-ws-override'
  expect(getDefaultWorkspaceDir()).toBe('/tmp/billiardbuddy-ws-override')
})

test('ensureDefaultWorkspace:首启 mkdir -p 建出多级目录', async () => {
  const base = mkdtempSync(join(tmpdir(), 'ws-ensure-'))
  const target = join(base, 'nested', 'workspace')
  process.env[WORKSPACE_DIR_ENV] = target
  try {
    const dir = await ensureDefaultWorkspace()
    expect(dir).toBe(target)
    expect(existsSync(target)).toBe(true)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
