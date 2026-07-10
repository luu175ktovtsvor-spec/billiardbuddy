import { MIGRATIONS } from './registry'
import type { Migration, MigrationResult } from './types'
import { readAppliedVersion, writeAppliedVersion } from './versionStore'

/**
 * 当前 schema 版本号 = 注册表里最高的 migration version(空注册表 = 0)。
 * 对齐 cc 的 CURRENT_MIGRATION_VERSION,只是我们由注册表推导而非手写常量,加一条就自动 +1。
 */
export function currentSchemaVersion(migrations: readonly Migration[] = MIGRATIONS): number {
  return migrations.reduce((max, m) => Math.max(max, m.version), 0)
}

/**
 * 开发期守卫:版本必须唯一、为 ≥1 的整数。违反直接抛(这是注册表写错 = 编程错误,
 * 该在测试/CI 尽早暴露,不是运行期数据问题)。空注册表天然通过。
 */
export function assertValidRegistry(migrations: readonly Migration[]): void {
  const seen = new Set<number>()
  for (const m of migrations) {
    if (!Number.isInteger(m.version) || m.version < 1) {
      throw new Error(`迁移 "${m.id}" 的 version 非法(必须是 ≥1 的整数):${m.version}`)
    }
    if (seen.has(m.version)) {
      throw new Error(`迁移版本号重复:${m.version}(id="${m.id}")—— 每条迁移的 version 必须唯一`)
    }
    seen.add(m.version)
  }
}

/**
 * 按序、幂等地跑迁移(同步,对齐 cc `runMigrations()`)。启动接线处调一次。
 *
 * - 读已应用版本(无记录/坏文件 = 0 = 首启)。
 * - 只跑 version > 已应用版本 的迁移,严格按 version 升序 —— 保证「版本按序执行」。
 * - 每成功一条就把已应用版本推进并原子落盘 —— 部分进度也持久,重启从断点续跑;
 *   配合 run 的幂等性,达成「重跑不重复」。
 * - 某条迁移抛错 / 版本落盘失败:停在它、不往后跑、不推进版本,记进 result.error 后**返回**(不抛)——
 *   迁移不该拖垮 sidecar 启动;失败的那条下次启动会因幂等而安全重跑。
 * - 注册表非法(重复/非法 version)才抛,这是开发期编程错误,由 assertValidRegistry 尽早暴露。
 */
export function runMigrations(
  stateRoot: string,
  migrations: readonly Migration[] = MIGRATIONS,
): MigrationResult {
  assertValidRegistry(migrations)

  const fromVersion = readAppliedVersion(stateRoot)
  const result: MigrationResult = { fromVersion, toVersion: fromVersion, ran: [] }

  const pending = migrations
    .filter(m => m.version > fromVersion)
    .sort((a, b) => a.version - b.version)

  for (const migration of pending) {
    try {
      migration.run({ stateRoot })
    } catch (err) {
      result.error = {
        id: migration.id,
        version: migration.version,
        message: err instanceof Error ? err.message : String(err),
      }
      break
    }
    try {
      writeAppliedVersion(stateRoot, migration.version)
    } catch (err) {
      // 迁移已生效但版本没记上 → 停在此(不推进内存版本,避免给出「已到该版本」的假象);
      // 下次启动会因 run 幂等而安全重跑这一条。
      result.error = {
        id: migration.id,
        version: migration.version,
        message: `已应用版本落盘失败:${err instanceof Error ? err.message : String(err)}`,
      }
      break
    }
    result.toVersion = migration.version
    result.ran.push(migration.id)
  }

  return result
}
