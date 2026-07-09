// 设置 store(最小集)。Block F 会接管全量设置(模型/MCP/记忆/技能/定时任务等,含白标改语义)。
// ⚠️ 白标接入点:defaultPermissionMode 默认 'default';模型/供应商相关设置由另一子代理定代称映射,这里先不写死真实模型名。
import { create } from 'zustand'
import type { PermissionMode } from '../types/chat'

interface SettingsState {
  defaultPermissionMode: PermissionMode
  /** 当前挂载的领域包(如 'billiards');空 = 通用 Agent。 */
  enabledPacks: string[]
  /** 用户选定的工作区(模型在此读写/执行);null = 后端默认 cwd。 */
  workspaceRoot: string | null
  setPermissionMode: (mode: PermissionMode) => void
  setEnabledPacks: (packs: string[]) => void
  setWorkspaceRoot: (root: string | null) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  defaultPermissionMode: 'default',
  enabledPacks: [],
  workspaceRoot: null,
  setPermissionMode: (mode) => set({ defaultPermissionMode: mode }),
  setEnabledPacks: (packs) => set({ enabledPacks: packs }),
  setWorkspaceRoot: (root) => set({ workspaceRoot: root }),
}))
