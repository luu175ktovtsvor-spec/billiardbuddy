import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 「已应用迁移版本」的持久化记录(存 stateRoot,契合我们的文件式存储)。
 *
 * cc 把 `migrationVersion` 塞进全局配置 JSON(~/.claude config);我们没有那份全局配置、且状态一律锚 stateRoot,
 * 所以落在 `<stateRoot>/migrations.json`。坏文件/缺文件一律当「首启 = 版本 0」处理,绝不因此报错
 * (对齐 mcpTrust / providerHealthStore 的「读失败退安全默认」姿态)。
 */

const RECORD_FILENAME = 'migrations.json'

interface MigrationRecord {
  /** 已成功应用到的最高 schema 版本。 */
  version: number
  /** 最后一次推进的时间(仅供人看/排障)。 */
  updatedAt?: string
}

/** 版本记录文件的绝对路径:`<stateRoot>/migrations.json`。 */
export function migrationRecordPath(stateRoot: string): string {
  return join(stateRoot, RECORD_FILENAME)
}

/** 读已应用版本;无记录 / 文件损坏 / 非法值一律返回 0(= 首启,从头跑)。永不抛。 */
export function readAppliedVersion(stateRoot: string): number {
  try {
    const p = migrationRecordPath(stateRoot)
    if (!existsSync(p)) return 0
    const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown
    const v = (parsed as { version?: unknown } | null)?.version
    return typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : 0
  } catch {
    return 0
  }
}

/** 原子写已应用版本(tmp + rename,对齐仓库其它 store)。stateRoot 目录会按需建出。写失败向上抛,由 runner 处理。 */
export function writeAppliedVersion(stateRoot: string, version: number): void {
  const p = migrationRecordPath(stateRoot)
  mkdirSync(stateRoot, { recursive: true })
  const tmp = `${p}.tmp`
  const record: MigrationRecord = { version, updatedAt: new Date().toISOString() }
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8')
  renameSync(tmp, p)
}
