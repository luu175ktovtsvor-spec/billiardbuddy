// 设置 store。工作目录(workspaceRoot)是店主选的"程序在哪读写/执行"的文件夹,
// localStorage 持久化(重启还在);null = 后端默认 cwd。聊天 run.working_dir + 右侧工作区面板都用它。
import { create } from 'zustand'
import type { PermissionMode } from '../types/chat'

const WS_KEY = 'qf-workspace-root'

function readStoredWorkspace(): string | null {
  if (typeof window === 'undefined') return null
  const v = window.localStorage.getItem(WS_KEY)
  return v && v.trim() ? v : null
}

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
  workspaceRoot: readStoredWorkspace(),
  setPermissionMode: (mode) => set({ defaultPermissionMode: mode }),
  setEnabledPacks: (packs) => set({ enabledPacks: packs }),
  setWorkspaceRoot: (root) => {
    if (typeof window !== 'undefined') {
      if (root && root.trim()) window.localStorage.setItem(WS_KEY, root)
      else window.localStorage.removeItem(WS_KEY)
    }
    set({ workspaceRoot: root })
  },
}))
