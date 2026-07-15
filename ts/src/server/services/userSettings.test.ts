import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_USER_SETTINGS, UserSettingsStore } from './userSettings'

test('UserSettingsStore:无文件返回默认', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usettings-'))
  try {
    expect(await new UserSettingsStore(root).get()).toEqual(DEFAULT_USER_SETTINGS)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('UserSettingsStore:合并更新 + 持久化 + 非法值忽略', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usettings-'))
  try {
    const store = new UserSettingsStore(root)
    const r1 = await store.update({ defaultPermissionMode: 'acceptEdits' })
    expect(r1.defaultPermissionMode).toBe('acceptEdits')
    expect(r1.theme).toBe('auto') // 未传保持默认
    expect(r1.allowBypassPermissionsMode).toBe(false)
    // 非法值忽略,退回现值
    const r2 = await store.update({ defaultPermissionMode: 'garbage' as never, theme: 'dark' })
    expect(r2.defaultPermissionMode).toBe('acceptEdits')
    expect(r2.theme).toBe('dark')
    // 跨实例(重启)持久化
    expect(await new UserSettingsStore(root).get()).toEqual({ defaultPermissionMode: 'acceptEdits', theme: 'dark', allowBypassPermissionsMode: false })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('UserSettingsStore:坏 JSON 可读安全默认，但拒绝静默覆盖原文件', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usettings-'))
  try {
    const path = join(root, 'user-settings.json')
    writeFileSync(path, 'not-json')
    const store = new UserSettingsStore(root)
    expect(await store.get()).toEqual(DEFAULT_USER_SETTINGS)
    expect((await store.inspect()).issues).toHaveLength(1)
    await expect(store.update({ theme: 'dark' })).rejects.toThrow('user-settings.json')
    expect(readFileSync(path, 'utf8')).toBe('not-json')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('UserSettingsStore:更新已知字段时保留未来版本字段', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usettings-'))
  try {
    const path = join(root, 'user-settings.json')
    writeFileSync(path, JSON.stringify({ theme: 'light', futureSetting: { enabled: true } }))
    const store = new UserSettingsStore(root)
    await store.update({ allowBypassPermissionsMode: true })
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({
      theme: 'light',
      allowBypassPermissionsMode: true,
      futureSetting: { enabled: true },
    })
  } finally { rmSync(root, { recursive: true, force: true }) }
})
