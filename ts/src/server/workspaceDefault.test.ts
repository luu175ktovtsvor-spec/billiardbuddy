import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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

// P1:选中工作区存盘 + 下次启动恢复上次工作目录(关窗即忘 → 修好)。
// 用单个 server 跑端点;「重启恢复」直接查 UserSettingsStore(端点读的就是它),避免多起一个并发 server 加压拖累别的用例。
test('/api/v1/workspace:默认工作区 + 持久化 + 重启恢复', async () => {
  const stateRoot = mkdtempSync(join(tmpdir(), 'ws-state-'))
  const defaultWs = mkdtempSync(join(tmpdir(), 'ws-default-'))
  const picked = mkdtempSync(join(tmpdir(), 'ws-picked-'))
  process.env[WORKSPACE_DIR_ENV] = defaultWs
  const server = startServer({ port: 0, transcriptRoot: stateRoot, mcpConfigPath: join(stateRoot, 'missing.mcp.json') })
  const url = `http://127.0.0.1:${server.port}/api/v1/workspace`
  try {
    // 初始:未选过 → current = 显式全局默认工作区, persisted = null。
    const g0 = await (await fetch(url)).json() as Record<string, unknown>
    expect(g0.default).toBe(defaultWs)
    expect(g0.persisted).toBeNull()
    expect(g0.current).toBe(defaultWs)
    expect(g0.exists).toBe(true)

    // 空 path → 400。
    const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: '' }) })
    expect(bad.status).toBe(400)

    // 选中一个目录 → 存盘,current 切到它。
    const p = await (await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: picked }) })).json() as Record<string, unknown>
    expect(p.persisted).toBe(picked)
    expect(p.current).toBe(picked)

    // GET 再读一次,反映已存盘的选中值。
    const g1 = await (await fetch(url)).json() as Record<string, unknown>
    expect(g1.persisted).toBe(picked)
    expect(g1.current).toBe(picked)

    // 模拟重启:新建 UserSettingsStore 从同 stateRoot 落盘文件读回(端点读的就是它)→ 上次工作目录不丢。
    const persisted = (await new UserSettingsStore(stateRoot).get()).lastWorkspaceRoot
    expect(persisted).toBe(picked)

    // 改「默认工作空间存储路径」= base(新建工作空间落这里)。
    const base = mkdtempSync(join(tmpdir(), 'ws-base-'))
    const setBase = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/workspace/base`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: base }) })).json() as Record<string, unknown>
    expect(setBase.base).toBe(base)

    // 「新建工作空间」:在 base 下建同名文件夹 + 初始化项目记忆 + 设为当前。
    const created = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/workspace/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '新店' }) })).json() as Record<string, unknown>
    expect(created.path).toBe(join(base, '新店'))
    expect(created.current).toBe(join(base, '新店'))
    expect(existsSync(join(base, '新店', 'BILLIARDBUDDY.md'))).toBe(true)

    // 非法名 → 400。
    const badName = await fetch(`http://127.0.0.1:${server.port}/api/v1/workspace/create`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '../逃逸' }) })
    expect(badName.status).toBe(400)

    rmSync(base, { recursive: true, force: true })
  } finally {
    server.stop(true)
    rmSync(stateRoot, { recursive: true, force: true })
    rmSync(defaultWs, { recursive: true, force: true })
    rmSync(picked, { recursive: true, force: true })
  }
})
