import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
    // 非法值忽略,退回现值
    const r2 = await store.update({ defaultPermissionMode: 'garbage' as never, theme: 'dark' })
    expect(r2.defaultPermissionMode).toBe('acceptEdits')
    expect(r2.theme).toBe('dark')
    // 跨实例(重启)持久化
    expect(await new UserSettingsStore(root).get()).toEqual({ defaultPermissionMode: 'acceptEdits', theme: 'dark' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('UserSettingsStore:坏 JSON 安全退默认', async () => {
  const root = mkdtempSync(join(tmpdir(), 'usettings-'))
  try {
    writeFileSync(join(root, 'user-settings.json'), 'not-json')
    expect(await new UserSettingsStore(root).get()).toEqual(DEFAULT_USER_SETTINGS)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
