/**
 * 版本化 schema 迁移(cc `src/migrations/*` + main.tsx runMigrations 的地基照搬,内容不照搬)。
 *
 * 用法(sidecar 启动接线):
 *   import { runMigrations } from '../migrations'
 *   runMigrations(stateRoot)   // 同步、幂等、永不拖垮启动;详见 runner.ts
 */
export type { Migration, MigrationContext, MigrationResult } from './types'
export { MIGRATIONS } from './registry'
export { assertValidRegistry, currentSchemaVersion, runMigrations } from './runner'
export { migrationRecordPath, readAppliedVersion, writeAppliedVersion } from './versionStore'
