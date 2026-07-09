import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/**
 * App 级用户设置(配置基座):存单个 JSON 文件(`<stateRoot>/user-settings.json`),供设置抽屉读写。
 * 与 provider 配置(providerService)、网络设置(networkSettings)、权限规则(permissionsSettings)分工:
 * 这里放"通用偏好"(默认权限档、主题等)。刻意小而稳,新设置项按需加字段即可。
 */

const PERMISSION_MODES = ['default', 'acceptEdits', 'plan'] as const
const THEMES = ['light', 'dark', 'auto'] as const

export interface UserSettings {
  /** 新对话默认权限档(前端发起 run 时用) */
  defaultPermissionMode: (typeof PERMISSION_MODES)[number]
  /** 界面主题 */
  theme: (typeof THEMES)[number]
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  defaultPermissionMode: 'default',
  theme: 'auto',
}

function coerce(raw: unknown): UserSettings {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const mode = PERMISSION_MODES.includes(obj.defaultPermissionMode as never) ? (obj.defaultPermissionMode as UserSettings['defaultPermissionMode']) : DEFAULT_USER_SETTINGS.defaultPermissionMode
  const theme = THEMES.includes(obj.theme as never) ? (obj.theme as UserSettings['theme']) : DEFAULT_USER_SETTINGS.theme
  return { defaultPermissionMode: mode, theme }
}

export class UserSettingsStore {
  private readonly path: string
  constructor(rootDir: string) {
    this.path = join(rootDir, 'user-settings.json')
  }

  async get(): Promise<UserSettings> {
    try {
      return coerce(JSON.parse(await readFile(this.path, 'utf8')) as unknown)
    } catch {
      return { ...DEFAULT_USER_SETTINGS }
    }
  }

  /** 合并式更新:只覆盖传入的**合法**字段,非法/缺省字段保持现值(非退回默认),原子写。 */
  async update(patch: Partial<UserSettings>): Promise<UserSettings> {
    const current = await this.get()
    const valid: Partial<UserSettings> = {}
    if (PERMISSION_MODES.includes(patch.defaultPermissionMode as never)) valid.defaultPermissionMode = patch.defaultPermissionMode
    if (THEMES.includes(patch.theme as never)) valid.theme = patch.theme
    const merged: UserSettings = { ...current, ...valid }
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    await rename(tmp, this.path)
    return merged
  }
}
