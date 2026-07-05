import { createHash } from 'node:crypto'
import { copyFile, mkdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { resolveInWorkspace } from './pathBoundary'

export type BackupHook = (absPath: string) => Promise<void>

/** 选一个文件夹当工作区:读/写/列/跑命令都经 resolve() 在边界内解析;写前经 backup() 备份。 */
export class Workspace {
  readonly root: string
  private readonly backupHook: BackupHook

  constructor(root: string, opts: { backupHook?: BackupHook } = {}) {
    this.root = resolve(root)
    this.backupHook = opts.backupHook ?? defaultBackupHook(this.root)
  }

  resolve(requested: string): string {
    return resolveInWorkspace(this.root, requested)
  }

  async backup(absPath: string): Promise<void> {
    await this.backupHook(absPath)
  }
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
