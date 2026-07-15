import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  type AgentSettingsIssue,
  type AgentUserSettings,
  type AgentUserSettingsPatch,
} from '../../../shared/contracts/agent-settings'

/** App 级用户设置。未知字段原样保留，损坏文件可读安全默认但不会被后续保存覆盖。 */

export type UserSettings = AgentUserSettings

export const DEFAULT_USER_SETTINGS: UserSettings = {
  defaultPermissionMode: 'default',
  theme: 'auto',
  allowBypassPermissionsMode: false,
}

interface SettingsSnapshot {
  settings: UserSettings
  issues: AgentSettingsIssue[]
  source: 'default' | 'user'
  raw: Record<string, unknown>
}

export class UserSettingsWriteError extends Error {
  readonly status = 409
  constructor(message: string) {
    super(message)
    this.name = 'UserSettingsWriteError'
  }
}

function nonEmptyPath(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

function coerce(raw: Record<string, unknown>): UserSettings {
  const mode = raw.defaultPermissionMode === 'acceptEdits' || raw.defaultPermissionMode === 'plan'
    ? raw.defaultPermissionMode
    : 'default'
  const theme = raw.theme === 'light' || raw.theme === 'dark' ? raw.theme : 'auto'
  const out: UserSettings = {
    defaultPermissionMode: mode,
    theme,
    allowBypassPermissionsMode: raw.allowBypassPermissionsMode === true,
  }
  const lastWorkspaceRoot = nonEmptyPath(raw.lastWorkspaceRoot)
  const workspaceBaseDir = nonEmptyPath(raw.workspaceBaseDir)
  if (lastWorkspaceRoot) out.lastWorkspaceRoot = lastWorkspaceRoot
  if (workspaceBaseDir) out.workspaceBaseDir = workspaceBaseDir
  return out
}

export class UserSettingsStore {
  private readonly path: string

  constructor(rootDir: string) {
    this.path = join(rootDir, 'user-settings.json')
  }

  private async snapshot(): Promise<SettingsSnapshot> {
    let text: string
    try {
      text = await readFile(this.path, 'utf8')
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return { settings: { ...DEFAULT_USER_SETTINGS }, issues: [], source: 'default', raw: {} }
      }
      return {
        settings: { ...DEFAULT_USER_SETTINGS },
        issues: [{ code: 'invalid_json', message: `无法读取 user-settings.json: ${error instanceof Error ? error.message : String(error)}` }],
        source: 'user',
        raw: {},
      }
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      return {
        settings: { ...DEFAULT_USER_SETTINGS },
        issues: [{ code: 'invalid_json', message: `user-settings.json 不是有效 JSON: ${error instanceof Error ? error.message : String(error)}` }],
        source: 'user',
        raw: {},
      }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        settings: { ...DEFAULT_USER_SETTINGS },
        issues: [{ code: 'invalid_shape', message: 'user-settings.json 顶层必须是对象。' }],
        source: 'user',
        raw: {},
      }
    }
    const raw = parsed as Record<string, unknown>
    return { settings: coerce(raw), issues: [], source: 'user', raw }
  }

  async inspect(): Promise<Omit<SettingsSnapshot, 'raw'>> {
    const { raw: _raw, ...visible } = await this.snapshot()
    return visible
  }

  async get(): Promise<UserSettings> {
    return (await this.snapshot()).settings
  }

  /** 合并更新并原子写；非法字段忽略，未知字段保留，损坏源文件拒绝覆盖。 */
  async update(patch: AgentUserSettingsPatch | Record<string, unknown>): Promise<UserSettings> {
    const current = await this.snapshot()
    if (current.issues.length > 0) {
      throw new UserSettingsWriteError(`无法保存：请先修复 user-settings.json。${current.issues[0]!.message}`)
    }

    const parsedPatch = patch as Record<string, unknown>
    const valid: Record<string, unknown> = {}
    if (parsedPatch.defaultPermissionMode === 'default' || parsedPatch.defaultPermissionMode === 'acceptEdits' || parsedPatch.defaultPermissionMode === 'plan') valid.defaultPermissionMode = parsedPatch.defaultPermissionMode
    if (parsedPatch.theme === 'light' || parsedPatch.theme === 'dark' || parsedPatch.theme === 'auto') valid.theme = parsedPatch.theme
    if (typeof parsedPatch.allowBypassPermissionsMode === 'boolean') valid.allowBypassPermissionsMode = parsedPatch.allowBypassPermissionsMode
    const lastWorkspaceRoot = nonEmptyPath(parsedPatch.lastWorkspaceRoot)
    const workspaceBaseDir = nonEmptyPath(parsedPatch.workspaceBaseDir)
    if (lastWorkspaceRoot) valid.lastWorkspaceRoot = lastWorkspaceRoot
    if (workspaceBaseDir) valid.workspaceBaseDir = workspaceBaseDir

    const settings = coerce({ ...current.raw, ...current.settings, ...valid })
    const persisted = { ...current.raw, ...settings }
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')
    await rename(tmp, this.path)
    return settings
  }
}
