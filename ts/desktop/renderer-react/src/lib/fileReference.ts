// 正文文件名识别(对齐 Codex markdown.fileReference):判断行内代码 `...` 是不是一个可打开的文件引用。
// 规则:
//   - 含 / 的路径(docs/plans/x.md、/abs/图.png):形状即认——basename 有扩展名、全串无代码字符。
//   - 单文件名(package.json、README.md):必须在工作树里真实存在才认,防把 res.json、console.log
//     这类代码点缀误当文件;树还没加载时返回 'need-tree',由调用方触发加载、树到位后重渲再判。
// mac 优先:不认 C:\ 盘符路径(冒号/反斜杠都在排除字符里,Windows 对等在 Windows 波做)。
import type { TreeEntry } from '../stores/filePreviewStore'

export interface FileRef {
  path: string // 原样路径(相对/绝对都可能;相对路径后端 fs/read 按 working_dir 解析)
  name: string // basename(色点取色用)
  sheet: boolean // 表格类(csv/xlsx/xls):渲成蓝链接+类型色点,其余灰底 chip
}

const SHEET_EXTS = new Set(['csv', 'xlsx', 'xls'])
// 出现这些字符基本是代码/URL 而不是文件路径(: 挡 http:// 和 file.ts:12,= 挡赋值,() 挡函数调用…)。
const CODE_CHARS = /[(){}[\];$<>|*?"'`=:!,\n\\]/
// 扩展名 1-8 位、至少含一个字母(挡 `v1.2` 这类版本号的假扩展名)。
const EXT_RE = /\.(?=[a-z0-9]{0,7}[a-z])[a-z0-9]{1,8}$/i

export function fileRefFromCode(raw: string, tree: TreeEntry[] | null): FileRef | 'need-tree' | null {
  const t = raw.trim()
  if (t.length < 3 || t.length > 300 || CODE_CHARS.test(t)) return null
  const name = t.split('/').pop() ?? t
  if (!EXT_RE.test(name)) return null
  const sheet = SHEET_EXTS.has(name.slice(name.lastIndexOf('.') + 1).toLowerCase())
  if (t.includes('/')) return { path: t, name, sheet }
  if (/\s/.test(t)) return null // 单文件名不含空格(`hello world.md` 这类散文不认)
  if (!tree) return 'need-tree'
  const rel = treeFileIndex(tree).get(t)
  return rel ? { path: rel, name, sheet } : null
}

// 工作树 basename → 相对路径 索引(同名取第一个);按 tree 引用缓存,树重载换引用后自动重建。
let indexCache: { tree: TreeEntry[]; map: Map<string, string> } | null = null
function treeFileIndex(tree: TreeEntry[]): Map<string, string> {
  if (indexCache?.tree === tree) return indexCache.map
  const map = new Map<string, string>()
  const walk = (nodes: TreeEntry[]) => {
    for (const n of nodes) {
      if (n.type === 'file' && !map.has(n.name)) map.set(n.name, n.path)
      if (n.children) walk(n.children)
    }
  }
  walk(tree)
  indexCache = { tree, map }
  return map
}
