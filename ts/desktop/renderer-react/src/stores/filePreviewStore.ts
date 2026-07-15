// 右侧工作区面板状态：多标签文件预览、工作目录树和工作区状态。
// 数据全接真实后端:
//   - GET /api/v1/agent/workspace-status → { root, git(汇总), tree(工作目录树 depth-2) }
//   - GET /api/v1/agent/fs/read?path=    → 单文件内容(打开一个 tab)
//   - GET /api/v1/agent/fs/list?path=    → 懒加载更深目录
// 契约:工具行文件名点击 → openFile(绝对路径) → 加/激活一个 tab + 打开面板(ToolCallCard 已用,别改名)。
import { create } from 'zustand'
import { api, authenticatedResourceUrl, getBaseUrl } from '../api/client'
import { useSettingsStore } from './settingsStore'
import { workspaceFilePreviewSchema, type WorkspaceFilePreview } from '../../../../shared/contracts/workspace-files'

/** 工作目录查询参(店主选的 workspaceRoot);让 fs 接口相对该目录解析,而不是 sidecar 的 cwd。 */
function wdParam(sep: '?' | '&', workspaceRoot: string | null = useSettingsStore.getState().workspaceRoot): string {
  const wd = workspaceRoot
  return wd ? `${sep}working_dir=${encodeURIComponent(wd)}` : ''
}

let workspaceLoadRequestId = 0
let loadingWorkspaceRoot: string | null | undefined
let fileLoadRequestId = 0
const fileLoadRequestIds = new Map<string, number>()

function beginFileLoad(path: string): number {
  const requestId = ++fileLoadRequestId
  fileLoadRequestIds.set(path, requestId)
  return requestId
}

function isCurrentFileLoad(path: string, requestId: number): boolean {
  return fileLoadRequestIds.get(path) === requestId
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif'])
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'ogv'])
const TEXT_EXTS = new Set([
  '', 'txt', 'md', 'mdx', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'scss',
  'js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'py', 'go', 'rs', 'java', 'kt', 'swift', 'sh', 'zsh', 'bash',
  'sql', 'ini', 'conf', 'env', 'log', 'gitignore', 'dockerfile',
])

export type FilePreviewKind = 'text' | 'image' | 'video' | 'pdf' | 'spreadsheet' | 'document' | 'unsupported'

function extensionOf(path: string): string {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  if (name === 'dockerfile' || name === 'makefile') return name
  const i = name.lastIndexOf('.')
  return i >= 0 ? name.slice(i + 1) : ''
}

export function previewKindForPath(path: string): FilePreviewKind {
  const extension = extensionOf(path)
  if (IMAGE_EXTS.has(extension)) return 'image'
  if (VIDEO_EXTS.has(extension)) return 'video'
  if (extension === 'pdf') return 'pdf'
  if (extension === 'csv' || extension === 'xlsx') return 'spreadsheet'
  if (extension === 'docx' || extension === 'pptx') return 'document'
  if (TEXT_EXTS.has(extension)) return 'text'
  return 'unsupported'
}

export function isImagePath(path: string): boolean {
  return previewKindForPath(path) === 'image'
}
/** 原始文件的绝对 URL(供右面板 <img> 直接加载):sidecar base + fs/raw + 工作目录。 */
export function rawFileUrl(path: string, workspaceRoot?: string | null): string {
  return authenticatedResourceUrl(`${getBaseUrl()}/api/v1/agent/fs/raw?path=${encodeURIComponent(path)}${wdParam('&', workspaceRoot ?? null)}`)
}

export interface OpenFile {
  path: string // 绝对路径
  content: string
  loading: boolean
  error: string | null
  kind: FilePreviewKind
  workspaceRoot: string | null
  preview?: WorkspaceFilePreview
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
  reloadFile: (path: string) => void
  selectSpreadsheetSheet: (path: string, sheetName: string) => void
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
    const workspaceRoot = useSettingsStore.getState().workspaceRoot
    if (get().treeLoading && loadingWorkspaceRoot === workspaceRoot) return
    const requestId = ++workspaceLoadRequestId
    loadingWorkspaceRoot = workspaceRoot
    set({ treeLoading: true, treeError: null })
    void api
      .get<WorkspaceStatusResp>(`/api/v1/agent/workspace-status${wdParam('?', workspaceRoot)}`)
      // 取 tree.entries(真正的文件数组);root 优先 tree.root 再退顶层 root。
      .then((res) => {
        if (requestId !== workspaceLoadRequestId || useSettingsStore.getState().workspaceRoot !== workspaceRoot) return
        loadingWorkspaceRoot = undefined
        set({ treeLoading: false, tree: res.tree?.entries ?? [], git: res.git ?? null, root: res.tree?.root ?? res.root ?? null })
      })
      .catch((err) => {
        if (requestId !== workspaceLoadRequestId || useSettingsStore.getState().workspaceRoot !== workspaceRoot) return
        loadingWorkspaceRoot = undefined
        set({ treeLoading: false, treeError: err instanceof Error ? err.message : String(err) })
      })
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
    const kind = previewKindForPath(path)
    const workspaceRoot = useSettingsStore.getState().workspaceRoot
    const needsRequest = kind === 'text' || kind === 'spreadsheet' || kind === 'document'
    set((s) => ({ tabs: [...s.tabs, { path, content: '', loading: needsRequest, error: null, kind, workspaceRoot }] }))
    if (!needsRequest) return
    const requestId = beginFileLoad(path)
    const endpoint = kind === 'text' ? 'read' : 'preview'
    void api
      .get<unknown>(`/api/v1/agent/fs/${endpoint}?path=${encodeURIComponent(path)}${wdParam('&', workspaceRoot)}`)
      .then((res) =>
        set((s) => ({
          tabs: s.tabs.map((tb) => {
            if (tb.path !== path || !isCurrentFileLoad(path, requestId)) return tb
            if (kind === 'text') {
              const text = res as FsReadResp
              return { ...tb, loading: false, content: text.content ?? '', error: text.error ?? null }
            }
            return { ...tb, loading: false, preview: workspaceFilePreviewSchema.parse(res), error: null }
          }),
        })),
      )
      .catch((err) =>
        set((s) => ({
          tabs: s.tabs.map((tb) => (tb.path === path && isCurrentFileLoad(path, requestId) ? { ...tb, loading: false, error: err instanceof Error ? err.message : String(err) } : tb)),
        })),
      )
    // ⚠️ 普通打开文件 = 显示工作目录原本的内容,**不做 diff 对比**(对齐 Codex:红绿修改/删除只在「审查」
    // 语境显示,普通点开就是原文)。改动 diff 后续做成独立「审查」tab,不塞进普通文件打开。
  },

  reloadFile: (path) => {
    const current = get().tabs.find(tab => tab.path === path)
    if (!current || !['text', 'spreadsheet', 'document'].includes(current.kind)) return
    set((state) => ({ tabs: state.tabs.map(tab => tab.path === path ? { ...tab, loading: true, error: null } : tab) }))
    const requestId = beginFileLoad(path)
    const endpoint = current.kind === 'text' ? 'read' : 'preview'
    void api.get<unknown>(`/api/v1/agent/fs/${endpoint}?path=${encodeURIComponent(path)}${wdParam('&', current.workspaceRoot)}`)
      .then((res) => set((state) => ({
        tabs: state.tabs.map(tab => {
          if (tab.path !== path || !isCurrentFileLoad(path, requestId)) return tab
          if (current.kind === 'text') {
            const text = res as FsReadResp
            return { ...tab, loading: false, content: text.content ?? '', error: text.error ?? null }
          }
          return { ...tab, loading: false, preview: workspaceFilePreviewSchema.parse(res), error: null }
        }),
      })))
      .catch((err) => set((state) => ({
        tabs: state.tabs.map(tab => tab.path === path && isCurrentFileLoad(path, requestId) ? { ...tab, loading: false, error: err instanceof Error ? err.message : String(err) } : tab),
      })))
  },

  selectSpreadsheetSheet: (path, sheetName) => {
    const current = get().tabs.find(tab => tab.path === path)
    if (!current || current.kind !== 'spreadsheet' || current.preview?.kind !== 'spreadsheet') return
    if (current.preview.sheets[0]?.name === sheetName) return
    set((state) => ({ tabs: state.tabs.map(tab => tab.path === path ? { ...tab, loading: true, error: null } : tab) }))
    const requestId = beginFileLoad(path)
    void api.get<unknown>(`/api/v1/agent/fs/preview?path=${encodeURIComponent(path)}${wdParam('&', current.workspaceRoot)}&sheet=${encodeURIComponent(sheetName)}`)
      .then((res) => set((state) => ({
        tabs: state.tabs.map(tab => tab.path === path && isCurrentFileLoad(path, requestId)
          ? { ...tab, loading: false, preview: workspaceFilePreviewSchema.parse(res), error: null }
          : tab),
      })))
      .catch((err) => set((state) => ({
        tabs: state.tabs.map(tab => tab.path === path && isCurrentFileLoad(path, requestId) ? { ...tab, loading: false, error: err instanceof Error ? err.message : String(err) } : tab),
      })))
  },

  closeTab: (path) => {
    fileLoadRequestIds.delete(path)
    set((s) => {
      const tabs = s.tabs.filter((tb) => tb.path !== path)
      const activePath = s.activePath === path ? (tabs[tabs.length - 1]?.path ?? null) : s.activePath
      return { tabs, activePath }
    })
  },
  closeOthers: (path) => {
    for (const openPath of fileLoadRequestIds.keys()) if (openPath !== path) fileLoadRequestIds.delete(openPath)
    set((s) => ({ tabs: s.tabs.filter((tb) => tb.path === path), activePath: path }))
  },
  closeAll: () => {
    fileLoadRequestIds.clear()
    set({ tabs: [], activePath: null })
  },

  setActive: (path) => set({ activePath: path }),
}))
