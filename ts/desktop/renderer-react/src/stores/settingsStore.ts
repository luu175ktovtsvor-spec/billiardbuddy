// 设置 store。工作目录(workspaceRoot)是店主选的"程序在哪读写/执行"的文件夹。
//
// ⚠️ 按会话隔离(2026-07-11 修架构缺口):后端是"每回合请求驱动"——每条 run 消息里的 working_dir
// 当场 new Workspace()、天然按会话隔离、绝不串台(见 docs 后端追踪);但前端此前只有**一个全局
// workspaceRoot**,多对话窗口各选不同文件夹时会互相覆盖:会话A选folder1、会话B选folder2 → 全局被
// B覆盖,切回A再发消息 working_dir=folder2 = 跑错目录 + 覆写A的会话记录 + transcript 劈到别的目录丢历史。
// 修法:按 conversationId 存一张映射(localStorage 持久化),activeConvId 决定当前生效的 workspaceRoot;
// 选文件夹只绑当前会话,切会话恢复该会话自己的目录。后端已按会话回传 meta.workspaceRoot(SessionSummary),
// 打开老会话时 adopt 进来 = 跨重启也记得每个会话的文件夹。
import { create } from 'zustand'
import type { PermissionMode } from '../types/chat'

const MAP_KEY = 'qf-workspace-by-conv'
const LEGACY_KEY = 'qf-workspace-root' // 旧的单一全局值(已废弃);仅在此清理,不再用它当任何会话的默认

function readStoredMap(): Record<string, string> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(MAP_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string>
    }
  } catch {
    /* 坏 JSON → 空表 */
  }
  // 旧全局键已废弃:主动清掉,免得留着误导(工作目录改为按会话隔离,不存在"全局工作目录"了)。
  if (typeof window !== 'undefined') window.localStorage.removeItem(LEGACY_KEY)
  return {}
}

function persistMap(map: Record<string, string>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(MAP_KEY, JSON.stringify(map))
  } catch {
    /* 配额满/隐私模式 → 忽略 */
  }
}

interface SettingsState {
  defaultPermissionMode: PermissionMode
  /** 当前挂载的领域包(如 'billiards');空 = 通用 Agent。 */
  enabledPacks: string[]
  /** 按 conversationId 记的工作目录映射(持久化)。 */
  workspaceByConv: Record<string, string>
  /** 当前激活的会话 id(由 chatStore.startConversation 切换)。 */
  activeConvId: string | null
  /** 当前激活会话的工作目录(= workspaceByConv[activeConvId] ?? null);sendMessage 的 working_dir + 右侧面板都读它。 */
  workspaceRoot: string | null
  setPermissionMode: (mode: PermissionMode) => void
  setEnabledPacks: (packs: string[]) => void
  /** 切到某会话:workspaceRoot 变成它记住的目录(没有则回退旧全局默认一次,仍不串台)。 */
  activateConversation: (conversationId: string | null) => void
  /** 选文件夹:把目录绑到**当前激活会话**(不是全局);null = 解绑回后端默认。 */
  setWorkspaceRoot: (root: string | null) => void
  /** 采纳后端会话记录的工作目录(打开老会话时,若本地还没记 → 用后端 meta.workspaceRoot 兜底)。 */
  adoptConversationWorkspace: (conversationId: string, root: string | null | undefined) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  defaultPermissionMode: 'default',
  enabledPacks: [],
  workspaceByConv: readStoredMap(),
  activeConvId: null,
  workspaceRoot: null,
  setPermissionMode: (mode) => set({ defaultPermissionMode: mode }),
  setEnabledPacks: (packs) => set({ enabledPacks: packs }),

  activateConversation: (conversationId) => {
    if (!conversationId) {
      set({ activeConvId: null, workspaceRoot: null })
      return
    }
    // 该会话已有自己的目录记录 → 用它;否则 null(= 后端默认 ~/Documents/球房管家/)。
    // 刻意不继承任何"全局/最近"值:未绑定会话继承可变全局会导致改一个会话连带改别的会话默认(漂移串台)。
    const bound = get().workspaceByConv[conversationId] ?? null
    set({ activeConvId: conversationId, workspaceRoot: bound })
  },

  setWorkspaceRoot: (root) => {
    const convId = get().activeConvId
    // 没有激活会话(理论上不该发生)→ 只更当前值,不落映射。
    if (!convId) {
      set({ workspaceRoot: root })
      return
    }
    const map = { ...get().workspaceByConv }
    if (root && root.trim()) map[convId] = root
    else delete map[convId]
    persistMap(map)
    set({ workspaceByConv: map, workspaceRoot: root })
  },

  adoptConversationWorkspace: (conversationId, root) => {
    if (!root || !root.trim()) return
    // 本地已有该会话的记录 → 前端为准(用户可能刚在本地改过),不覆盖。
    if (get().workspaceByConv[conversationId]) return
    const map = { ...get().workspaceByConv, [conversationId]: root }
    persistMap(map)
    set((s) => ({
      workspaceByConv: map,
      // 若采纳的正是当前激活会话 → 同步生效值。
      workspaceRoot: s.activeConvId === conversationId ? root : s.workspaceRoot,
    }))
  },
}))
