// 右侧「工作区面板」store(照 Codex artifact 面板:多 tab 文件展示 + 工作目录树 + 环境信息)。
// 数据全接真实后端:
//   - GET /api/v1/agent/workspace-status → { root, git(汇总), tree(工作目录树 depth-2) }
//   - GET /api/v1/agent/fs/read?path=    → 单文件内容(打开一个 tab)
//   - GET /api/v1/agent/fs/list?path=    → 懒加载更深目录
// 契约:工具行文件名点击 → openFile(绝对路径) → 加/激活一个 tab + 打开面板(ToolCallCard 已用,别改名)。
import { create } from 'zustand'
import { api } from '../api/client'
import { useSettingsStore } from './settingsStore'

/** 工作目录查询参(店主选的 workspaceRoot);让 fs 接口相对该目录解析,而不是 sidecar 的 cwd。 */
function wdParam(sep: '?' | '&'): string {
  const wd = useSettingsStore.getState().workspaceRoot
  return wd ? `${sep}working_dir=${encodeURIComponent(wd)}` : ''
}

export interface OpenFile {
  path: string // 绝对路径
  content: string
  loading: boolean
  error: string | null
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
  // ⚠️ 后端 workspace-status 的 tree 是**对象** { root, entries, total, truncated },真正的文件数组在 entries 里
  //(不是裸数组);此前 store 把整个对象当数组存、FileTree 直接 .map() 会崩、文件树从没真正渲染出文件。
  tree?: { root?: string; entries?: TreeEntry[]; total?: number; truncated?: boolean }
}
interface FsReadResp {
  path?: string
  content?: string
  truncated?: boolean
  error?: string
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
      .get<WorkspaceStatusResp>(`/api/v1/agent/workspace-status${wdParam('?')}`)
      // 取 tree.entries(真正的文件数组);root 优先 tree.root 再退顶层 root。
      .then((res) => set({ treeLoading: false, tree: res.tree?.entries ?? [], git: res.git ?? null, root: res.tree?.root ?? res.root ?? null }))
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
      .get<FsReadResp>(`/api/v1/agent/fs/read?path=${encodeURIComponent(path)}${wdParam('&')}`)
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
    // ⚠️ 普通打开文件 = 显示工作目录原本的内容,**不做 diff 对比**(对齐 Codex:红绿修改/删除只在「审查」
    // 语境显示,普通点开就是原文)。改动 diff 后续做成独立「审查」tab,不塞进普通文件打开。
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
