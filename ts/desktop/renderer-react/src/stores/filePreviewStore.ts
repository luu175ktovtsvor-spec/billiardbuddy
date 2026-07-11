// 右侧「工作区面板」store(照 Codex artifact 面板:多 tab 文件展示 + 工作目录树 + 环境信息)。
// 数据全接真实后端:
//   - GET /api/v1/agent/workspace-status → { root, git(汇总), tree(工作目录树 depth-2) }
//   - GET /api/v1/agent/fs/read?path=    → 单文件内容(打开一个 tab)
//   - GET /api/v1/agent/fs/list?path=    → 懒加载更深目录
// 契约:工具行文件名点击 → openFile(绝对路径) → 加/激活一个 tab + 打开面板(ToolCallCard 已用,别改名)。
import { create } from 'zustand'
import { api } from '../api/client'

export interface OpenFile {
  path: string // 绝对路径
  content: string
  loading: boolean
  error: string | null
  diff?: { oldString: string; newString: string; changed: boolean } | null
}
export interface TreeEntry {
  name: string
  path: string // 相对 root
  type: 'file' | 'directory'
  children?: TreeEntry[]
  truncated?: boolean
}
export interface GitSummary {
  isGit: boolean
  branch: string | null
  dirty: boolean
  changed: number
  staged: number
  unstaged: number
  untracked: number
  ahead: number
  behind: number
}

interface WorkspaceStatusResp {
  root?: string
  git?: GitSummary
  tree?: TreeEntry[]
}
interface FsReadResp {
  path?: string
  content?: string
  truncated?: boolean
  error?: string
}
interface FsDiffResp {
  oldString?: string
  newString?: string
  changed?: boolean
}

interface FilePreviewState {
  panelOpen: boolean
  tabs: OpenFile[]
  activePath: string | null
  root: string | null
  tree: TreeEntry[] | null
  git: GitSummary | null
  treeLoading: boolean
  treeError: string | null
  togglePanel: () => void
  setPanelOpen: (open: boolean) => void
  openFile: (path: string) => void
  closeTab: (path: string) => void
  closeOthers: (path: string) => void
  closeAll: () => void
  setActive: (path: string) => void
  loadWorkspace: () => void
}

export const useFilePreviewStore = create<FilePreviewState>((set, get) => ({
  panelOpen: false,
  tabs: [],
  activePath: null,
  root: null,
  tree: null,
  git: null,
  treeLoading: false,
  treeError: null,

  loadWorkspace: () => {
    if (get().treeLoading) return
    set({ treeLoading: true, treeError: null })
    void api
      .get<WorkspaceStatusResp>('/api/v1/agent/workspace-status')
      .then((res) => set({ treeLoading: false, tree: res.tree ?? [], git: res.git ?? null, root: res.root ?? null }))
      .catch((err) => set({ treeLoading: false, treeError: err instanceof Error ? err.message : String(err) }))
  },

  togglePanel: () => {
    const next = !get().panelOpen
    set({ panelOpen: next })
    if (next && get().tree === null) get().loadWorkspace()
  },
  setPanelOpen: (open) => {
    set({ panelOpen: open })
    if (open && get().tree === null) get().loadWorkspace()
  },

  openFile: (path) => {
    set({ panelOpen: true, activePath: path })
    if (get().tree === null) get().loadWorkspace()
    if (get().tabs.some((tb) => tb.path === path)) return // 已打开,只激活
    set((s) => ({ tabs: [...s.tabs, { path, content: '', loading: true, error: null }] }))
    void api
      .get<FsReadResp>(`/api/v1/agent/fs/read?path=${encodeURIComponent(path)}`)
      .then((res) =>
        set((s) => ({
          tabs: s.tabs.map((tb) => (tb.path === path ? { ...tb, loading: false, content: res.content ?? '', error: res.error ?? null } : tb)),
        })),
      )
      .catch((err) =>
        set((s) => ({
          tabs: s.tabs.map((tb) => (tb.path === path ? { ...tb, loading: false, error: err instanceof Error ? err.message : String(err) } : tb)),
        })),
      )
    // 额外拉改动 diff(git HEAD vs 工作区);有改动才挂,失败静默
    void api
      .get<FsDiffResp>(`/api/v1/agent/fs/diff?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (res.changed) {
          set((s) => ({
            tabs: s.tabs.map((tb) => (tb.path === path ? { ...tb, diff: { oldString: res.oldString ?? '', newString: res.newString ?? '', changed: true } } : tb)),
          }))
        }
      })
      .catch(() => { /* 静默 */ })
  },

  closeTab: (path) =>
    set((s) => {
      const tabs = s.tabs.filter((tb) => tb.path !== path)
      const activePath = s.activePath === path ? (tabs[tabs.length - 1]?.path ?? null) : s.activePath
      return { tabs, activePath }
    }),
  closeOthers: (path) => set((s) => ({ tabs: s.tabs.filter((tb) => tb.path === path), activePath: path })),
  closeAll: () => set({ tabs: [], activePath: null }),

  setActive: (path) => set({ activePath: path }),
}))
