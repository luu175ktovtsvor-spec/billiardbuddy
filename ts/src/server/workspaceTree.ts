// 工作区文件树摘要与文件面板支持:懒加载树、原始字节预览 MIME 和敏感文件判定。

import { basename, relative, resolve } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'

export interface WorkspaceTreeEntry {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: WorkspaceTreeEntry[]
  truncated?: boolean
}

const WORKSPACE_TREE_SKIP = new Set([
  '.git',
  '.next',
  '.agent-state',
  '.cache',
  '.mypy_cache',
  '.playwright-cli',
  '.pytest_cache',
  '.ruff_cache',
  '.superpowers',
  '.venv',
  '__pycache__',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'out',
  'output',
])

// 原始文件字节预览的 content-type(右面板 <img> 渲染图片、pdf 等):按扩展名给,查不到走 octet-stream。
export const RAW_MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.avif': 'image/avif', '.pdf': 'application/pdf',
}

export async function summarizeWorkspaceTree(root: string, opts: { maxDepth?: number; maxEntries?: number } = {}) {
  const maxDepth = opts.maxDepth ?? 2
  const maxEntries = opts.maxEntries ?? 400
  let total = 0
  let truncated = false

  // ⚠️ 顶层(depth 0)永不因预算腰斩:此前是纯深度优先 + 总预算(120),排在前面的目录(如 .claude/.github)
  // 一递归就把预算吃光,轮不到 ts/ docs/ 这些真正重要的顶层目录 → 文件树只显示头几个点目录=废。
  // 现在保证同级(尤其顶层)条目全部露出,预算只管"深层要不要展开";深层没展开的目录留 children 为 undefined,
  // 前端点开时按 fs/list 懒加载(契约已验证),既不丢顶层、又不无限膨胀。
  async function walk(dir: string, depth: number): Promise<WorkspaceTreeEntry[]> {
    let entries = await readdir(dir, { withFileTypes: true })
    entries = entries
      .filter(entry => entry.name !== '.DS_Store')
      .filter(entry => !(entry.isDirectory() && WORKSPACE_TREE_SKIP.has(entry.name)))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, 'zh-Hans-CN'))

    const out: WorkspaceTreeEntry[] = []
    for (const entry of entries) {
      // 只有深层(depth>0)才受预算约束;顶层一律全列(顶层条目数=目录实际数,通常可控)。
      if (depth > 0 && total >= maxEntries) {
        truncated = true
        break
      }
      const abs = resolve(dir, entry.name)
      const item: WorkspaceTreeEntry = {
        name: entry.name,
        path: relative(root, abs) || entry.name,
        type: entry.isDirectory() ? 'directory' : 'file',
      }
      total += 1
      if (entry.isDirectory() && depth < maxDepth) {
        if (total >= maxEntries) {
          // 预算已尽:不预展开,标记 truncated,children 留空 → 前端点开时懒加载,不丢这个目录本身。
          truncated = true
          item.truncated = true
        } else {
          item.children = await walk(abs, depth + 1)
          if (item.children.some(c => c.truncated)) item.truncated = true
        }
      }
      out.push(item)
    }
    return out
  }

  try {
    return { root, entries: await walk(root, 0), total, truncated }
  } catch (err) {
    return { root, entries: [], total: 0, truncated: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function isSensitiveFilePath(path: string): boolean {
  const name = basename(path).toLowerCase()
  if (name === '.env' || name.startsWith('.env.')) return true
  if (/\.(pem|key|p12|pfx|crt|cer)$/i.test(name)) return true
  return /(secret|credential|token|password|api[_-]?key)/i.test(name)
}

export async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}
