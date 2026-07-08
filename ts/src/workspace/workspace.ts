import { createHash } from 'node:crypto'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { existsSync, statSync } from 'node:fs'
import { type FileOperation, normalizeRequestedPathForValidation, validatePath } from './pathValidation'
import { WorkspaceBoundaryError } from './pathBoundary'
import { pathContainedInRoots } from './symlinkResolve'

export type BackupHook = (absPath: string) => Promise<void>

export interface WorkspaceOptions {
  backupHook?: BackupHook
  allowedPaths?: string[]
  fullDiskAccess?: boolean
}

/** 选一个文件夹当工作区:读/写/列/跑命令都经 resolve() 在边界内解析;写前经 backup() 备份。 */
export class Workspace {
  readonly root: string
  private readonly backupHook: BackupHook
  private readonly allowedPathInputs: string[]
  private readonly allowedPaths: Array<{ path: string; isDirectory: boolean }>
  private readonly fullDiskAccess: boolean

  constructor(root: string, opts: WorkspaceOptions = {}) {
    this.root = resolve(root)
    this.backupHook = opts.backupHook ?? defaultBackupHook(this.root)
    this.fullDiskAccess = opts.fullDiskAccess === true
    this.allowedPathInputs = opts.allowedPaths ?? []
    this.allowedPaths = this.allowedPathInputs.map(normalizeAllowedPath).filter((item): item is { path: string; isDirectory: boolean } => !!item)
  }

  resolve(requested: string, operation: FileOperation = 'read'): string {
    try {
      const target = validatePath(requested, { root: this.root, operation })
      // 字符串边界过了,再验 symlink:堵"工作区内 symlink 指向工作区外"的逃逸
      // (纯 resolve/relative 看不出 <root>/link -> /etc 这类,真实读写会跟随 symlink 逃出工作区)。
      if (!this.fullDiskAccess && !pathContainedInRoots(target, [this.root]) && !this.isAllowedPath(target)) {
        throw new WorkspaceBoundaryError(requested, this.root)
      }
      return target
    } catch (err) {
      if (!(err instanceof WorkspaceBoundaryError)) throw err
      const target = this.resolveOutsideRoot(requested, operation)
      if (this.fullDiskAccess || this.isAllowedPath(target)) return target
      throw err
    }
  }

  async backup(absPath: string): Promise<void> {
    await this.backupHook(absPath)
  }

  withAllowedPaths(paths: string[]): Workspace {
    return new Workspace(this.root, {
      backupHook: this.backupHook,
      allowedPaths: [...this.allowedPathInputs, ...paths],
      fullDiskAccess: this.fullDiskAccess,
    })
  }

  private resolveOutsideRoot(requested: string, operation: FileOperation): string {
    const cleaned = normalizeRequestedPathForValidation(requested, { operation })
    return isAbsolute(cleaned) ? resolve(cleaned) : resolve(this.root, cleaned)
  }

  private isAllowedPath(target: string): boolean {
    return this.allowedPaths.some(item => item.isDirectory ? isInside(item.path, target) : item.path === target)
  }
}

function normalizeAllowedPath(raw: string): { path: string; isDirectory: boolean } | null {
  try {
    const path = resolve(raw)
    const s = existsSync(path) ? statSync(path) : null
    return { path, isDirectory: s?.isDirectory() ?? false }
  } catch {
    return null
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function shortHash(s: string): string {
  return createHash('md5').update(s).digest('hex').slice(0, 8)
}

/** 改前把已存在文件 copy 进 <root>/.backups(红线:改文件前可回滚)。完整 shadow-git 版留后面。 */
export function defaultBackupHook(root: string): BackupHook {
  return async absPath => {
    try {
      const s = await stat(absPath).catch(() => null)
      if (!s || !s.isFile()) return
      const dir = join(root, '.backups')
      await mkdir(dir, { recursive: true })
      await copyFile(absPath, join(dir, `${basename(absPath)}.${shortHash(absPath)}.bak`))
    } catch {
      // 备份尽力而为,绝不因备份失败阻塞写
    }
  }
}
