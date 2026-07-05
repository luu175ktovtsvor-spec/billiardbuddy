import { isAbsolute, relative, resolve } from 'node:path'

export class WorkspaceBoundaryError extends Error {
  constructor(
    readonly requested: string,
    readonly root: string,
  ) {
    super(`越界：路径 ${requested} 在工作区 ${root} 之外，拒绝`)
    this.name = 'WorkspaceBoundaryError'
  }
}

/**
 * 把 requested 解析到工作区内的绝对路径。相对路径相对 root 解析,绝对路径原样;
 * resolve 折叠 `..` 后用 relative 判是否逃出 root——逃出(`..` 开头或跨盘绝对)即抛。
 * 不盲目拒 `..`:`a/../b` 停在区内、合法。硬 OS 沙箱 + TOCTOU(UNC/~user/$展开)是 W3。
 */
export function resolveInWorkspace(root: string, requested: string): string {
  const absRoot = resolve(root)
  const target = isAbsolute(requested) ? resolve(requested) : resolve(absRoot, requested)
  const rel = relative(absRoot, target)
  if (rel === '') return target
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) {
    throw new WorkspaceBoundaryError(requested, absRoot)
  }
  return target
}
