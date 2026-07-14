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
const PACKS_MAP_KEY = 'qf-packs-by-conv' // 领域知识包也按会话隔离,与工作目录同构
const PERMISSION_MAP_KEY = 'qf-permission-mode-by-conv'

const PERMISSION_MODES = new Set<PermissionMode>([
  'default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk',
])

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

function readStoredPacksMap(): Record<string, string[]> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(PACKS_MAP_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object') return parsed as Record<string, string[]>
    }
  } catch {
    /* 坏 JSON → 空表 */
  }
  return {}
}

function persistPacksMap(map: Record<string, string[]>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PACKS_MAP_KEY, JSON.stringify(map))
  } catch {
    /* 配额满/隐私模式 → 忽略 */
  }
}

function readStoredPermissionMap(): Record<string, PermissionMode> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(PERMISSION_MAP_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, PermissionMode] =>
      typeof entry[1] === 'string' && PERMISSION_MODES.has(entry[1] as PermissionMode)))
  } catch {
    return {}
  }
}

function persistPermissionMap(map: Record<string, PermissionMode>): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(PERMISSION_MAP_KEY, JSON.stringify(map))
  } catch {
    /* 配额满/隐私模式 → 忽略 */
  }
}

// —— 设置页偏好(localStorage;对齐 Codex settings.agent.permissionsMode「在选择器中显示 XX」语义 + power.preventSleepWhileRunning)——
const HIDDEN_MODES_KEY = 'qf.settings.hiddenPermissionModes'
const PREVENT_SLEEP_KEY = 'qf.settings.preventSleepWhileRunning'
function readHiddenModes(): PermissionMode[] {
  try { return JSON.parse(window.localStorage.getItem(HIDDEN_MODES_KEY) ?? '[]') as PermissionMode[] } catch { return [] }
}
function readPreventSleep(): boolean {
  try { return window.localStorage.getItem(PREVENT_SLEEP_KEY) === '1' } catch { return false }
}

interface SettingsState {
  defaultPermissionMode: PermissionMode
  /** 权限选择器里隐藏的档位(对齐 Codex「在编排器中显示 XX 权限」toggle 的关闭态;default/plan 永不可隐藏)。 */
  hiddenPermissionModes: PermissionMode[]
  /** 运行任务时防止系统休眠(对齐 Codex preventSleepWhileRunning;App 层按 chat running 状态调 desktopHost.preventSleep)。 */
  preventSleepWhileRunning: boolean
  /** 当前激活会话挂载的领域包(= enabledPacksByConv[activeConvId] ?? []);空 = 通用 Agent。sendMessage 读它。 */
  enabledPacks: string[]
  /** 按 conversationId 记的领域包映射(持久化)。挂件按会话隔离:某窗口开台球、别的窗口不受影响。 */
  enabledPacksByConv: Record<string, string[]>
  /** 按 conversationId 记的工作目录映射(持久化)。 */
  workspaceByConv: Record<string, string>
  /** 按 conversationId 记的权限档(持久化),避免切会话串档或重启回落。 */
  permissionModeByConv: Record<string, PermissionMode>
  /** 当前激活的会话 id(由 chatStore.startConversation 切换)。 */
  activeConvId: string | null
  /** 当前激活会话的工作目录(= workspaceByConv[activeConvId] ?? null);sendMessage 的 working_dir + 右侧面板都读它。 */
  workspaceRoot: string | null
  setPermissionMode: (mode: PermissionMode) => void
  /** 切换某档在权限选择器里的显隐(default/plan 不接受隐藏)。 */
  togglePermissionModeHidden: (mode: PermissionMode) => void
  setPreventSleepWhileRunning: (on: boolean) => void
  /** 设当前**激活会话**的领域包(不是全局);落 per-conv 映射。斜杠 /台球 开、/台球关闭 关、设置开关都走它。 */
  setEnabledPacks: (packs: string[]) => void
  /** 切到某会话:workspaceRoot + enabledPacks 都变成它自己记住的(没有则空,不串台)。 */
  activateConversation: (conversationId: string | null) => void
  /** 选文件夹:把目录绑到**当前激活会话**(不是全局);null = 解绑回后端默认。 */
  setWorkspaceRoot: (root: string | null) => void
  /** 采纳后端会话记录的工作目录(打开老会话时,若本地还没记 → 用后端 meta.workspaceRoot 兜底)。 */
  adoptConversationWorkspace: (conversationId: string, root: string | null | undefined) => void
  /** 采纳后端会话记录的领域包(打开老会话时,若本地还没记 → 用后端 meta.enabledPacks 兜底)。 */
  adoptConversationPacks: (conversationId: string, packs: string[] | null | undefined) => void
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  defaultPermissionMode: 'default',
  hiddenPermissionModes: readHiddenModes(),
  preventSleepWhileRunning: readPreventSleep(),
  enabledPacks: [],
  enabledPacksByConv: readStoredPacksMap(),
  workspaceByConv: readStoredMap(),
  permissionModeByConv: readStoredPermissionMap(),
  activeConvId: null,
  workspaceRoot: null,
  setPermissionMode: (mode) => {
    const convId = get().activeConvId
    if (!convId) {
      set({ defaultPermissionMode: mode })
      return
    }
    const map = { ...get().permissionModeByConv, [convId]: mode }
    persistPermissionMap(map)
    set({ permissionModeByConv: map, defaultPermissionMode: mode })
  },

  togglePermissionModeHidden: (mode) => {
    if (mode === 'default' || mode === 'plan') return // 对齐 Codex「默认权限始终显示」;计划档同样常驻
    const cur = get().hiddenPermissionModes
    const next = cur.includes(mode) ? cur.filter((m) => m !== mode) : [...cur, mode]
    try { window.localStorage.setItem(HIDDEN_MODES_KEY, JSON.stringify(next)) } catch { /* 忽略 */ }
    // 当前档正要被隐藏 → 回落默认档,别让选择器显示一个菜单里不存在的档。
    if (next.includes(get().defaultPermissionMode)) get().setPermissionMode('default')
    set({ hiddenPermissionModes: next })
  },

  setPreventSleepWhileRunning: (on) => {
    try { window.localStorage.setItem(PREVENT_SLEEP_KEY, on ? '1' : '0') } catch { /* 忽略 */ }
    set({ preventSleepWhileRunning: on })
  },

  setEnabledPacks: (packs) => {
    const convId = get().activeConvId
    // 没有激活会话(理论上不该发生)→ 只更当前值,不落映射。
    if (!convId) {
      set({ enabledPacks: packs })
      return
    }
    const map = { ...get().enabledPacksByConv }
    // 空数组是明确关闭,必须保留该键,才能阻止旧的后端会话状态在重开时被 adopt 回来。
    map[convId] = packs
    persistPacksMap(map)
    set({ enabledPacksByConv: map, enabledPacks: packs })
  },

  activateConversation: (conversationId) => {
    if (!conversationId) {
      set({ activeConvId: null, workspaceRoot: null, enabledPacks: [], defaultPermissionMode: 'default' })
      return
    }
    // 该会话已有自己的目录/挂件记录 → 用它;否则空(工作目录=后端默认,挂件=通用助手不挂)。
    // 刻意不继承任何"全局/最近"值:未绑定会话继承可变全局会导致改一个会话连带改别的会话(漂移串台)。
    const bound = get().workspaceByConv[conversationId] ?? null
    const packs = get().enabledPacksByConv[conversationId] ?? []
    let permissionMap = get().permissionModeByConv
    let permissionMode = permissionMap[conversationId]
    // 旧版本已经由用户明确绑定过工作目录的会话,升级后默认采用低打扰的工作区编辑档。
    if (!permissionMode && bound) {
      permissionMode = 'acceptEdits'
      permissionMap = { ...permissionMap, [conversationId]: permissionMode }
      persistPermissionMap(permissionMap)
    }
    set({
      activeConvId: conversationId,
      workspaceRoot: bound,
      enabledPacks: packs,
      permissionModeByConv: permissionMap,
      defaultPermissionMode: permissionMode ?? 'default',
    })
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
    let permissionMap = get().permissionModeByConv
    let permissionMode = get().defaultPermissionMode
    // 选择工作目录就是给当前会话划定可写边界。仅首次绑定时默认自动接受工作区内编辑；
    // 用户此前显式选过 default/plan/full 时保留其选择，不擅自改档。
    if (root && root.trim() && !(convId in permissionMap)) {
      permissionMode = 'acceptEdits'
      permissionMap = { ...permissionMap, [convId]: permissionMode }
      persistPermissionMap(permissionMap)
    }
    set({
      workspaceByConv: map,
      workspaceRoot: root,
      permissionModeByConv: permissionMap,
      defaultPermissionMode: permissionMode,
    })
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

  adoptConversationPacks: (conversationId, packs) => {
    if (!packs || packs.length === 0) return
    // 本地已有该会话的挂件记录(哪怕是空——用户可能刚手动关了)→ 前端为准,不覆盖。
    if (conversationId in get().enabledPacksByConv) return
    const map = { ...get().enabledPacksByConv, [conversationId]: packs }
    persistPacksMap(map)
    set((s) => ({
      enabledPacksByConv: map,
      enabledPacks: s.activeConvId === conversationId ? packs : s.enabledPacks,
    }))
  },
}))
