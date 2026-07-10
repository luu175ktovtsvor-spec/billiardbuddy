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
  /** 上次选中的工作区绝对路径(§P1 持久化:关窗不忘,下次启动前端据此恢复上次工作目录)。未选过则缺省。 */
  lastWorkspaceRoot?: string
  /** 默认工作空间存储路径(WorkBuddy 式:新建工作空间就建在这个目录下)。缺省时用 getDefaultWorkspaceDir()。 */
  workspaceBaseDir?: string
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  defaultPermissionMode: 'default',
  theme: 'auto',
}

function coerce(raw: unknown): UserSettings {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const mode = PERMISSION_MODES.includes(obj.defaultPermissionMode as never) ? (obj.defaultPermissionMode as UserSettings['defaultPermissionMode']) : DEFAULT_USER_SETTINGS.defaultPermissionMode
  const theme = THEMES.includes(obj.theme as never) ? (obj.theme as UserSettings['theme']) : DEFAULT_USER_SETTINGS.theme
  const out: UserSettings = { defaultPermissionMode: mode, theme }
  // 可选路径字段:只在是非空字符串时保留,缺省/非法则不带该键(保持默认对象干净)。
  if (typeof obj.lastWorkspaceRoot === 'string' && obj.lastWorkspaceRoot.trim().length > 0) {
    out.lastWorkspaceRoot = obj.lastWorkspaceRoot
  }
  if (typeof obj.workspaceBaseDir === 'string' && obj.workspaceBaseDir.trim().length > 0) {
    out.workspaceBaseDir = obj.workspaceBaseDir
  }
  return out
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
    if (typeof patch.lastWorkspaceRoot === 'string' && patch.lastWorkspaceRoot.trim().length > 0) valid.lastWorkspaceRoot = patch.lastWorkspaceRoot
    if (typeof patch.workspaceBaseDir === 'string' && patch.workspaceBaseDir.trim().length > 0) valid.workspaceBaseDir = patch.workspaceBaseDir
    const merged: UserSettings = { ...current, ...valid }
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    await writeFile(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    await rename(tmp, this.path)
    return merged
  }
}
