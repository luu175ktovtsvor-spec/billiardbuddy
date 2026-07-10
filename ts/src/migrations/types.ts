/**
 * 版本化 schema 迁移的类型契约(白标铁律:机制照抄 cc,内容不照抄)。
 *
 * cc 在 `src/migrations/*` 放一组 `migrateX(): void` 迁移器,启动时由 main.tsx 的
 * `runMigrations()` 按序跑一遍、再把 `migrationVersion` 记进全局配置(见 cc main.tsx:324-353)。
 * cc 那些具体迁移器几乎都是给它上游模型改名(migrateSonnet45ToSonnet46 / migrateFennecToOpus …),
 * 对我们完全不适用;但「版本号 + 按序执行 + 幂等 + 已应用版本持久化」这套**地基**要照搬。
 *
 * 这里把 cc 隐式的"一个整数版本 + 一堆各自幂等的迁移函数"显式成经典版本化迁移器:
 * 每条迁移带一个递增 version,注册进有序注册表,启动只跑 version > 已应用版本 的那些,
 * 已应用版本记进 stateRoot(而非全局配置,契合我们的文件式存储)。
 */

/** 迁移运行时上下文。settings/数据 schema 都在 stateRoot 这棵树下就地读写。 */
export interface MigrationContext {
  /** 状态/会话根目录(resolveStateRoot 的结果);迁移在此就地读写文件。 */
  readonly stateRoot: string
}

/**
 * 一条版本化迁移。
 * - `version`:递增、唯一、≥1 的整数;运行严格按此升序。
 * - `id`:稳定短标识,仅用于日志/结果记录(可读)。
 * - `run`:就地施加变更,**必须幂等**(可安全重跑而不改变最终结果)。同步(与 cc runMigrations 一致)。
 */
export interface Migration {
  readonly version: number
  readonly id: string
  run(ctx: MigrationContext): void
}

/** 一次 runMigrations 的结果(供接线处日志/测试断言;runMigrations 本身对运行期失败不抛)。 */
export interface MigrationResult {
  /** 运行前已应用的版本(无记录/坏文件 = 0 = 首启)。 */
  fromVersion: number
  /** 运行后已应用的版本(= 成功跑到的最高 version;一条没跑则 = fromVersion)。 */
  toVersion: number
  /** 本次实际执行成功的迁移 id(升序)。 */
  ran: string[]
  /** 若某条迁移抛错 / 版本落盘失败:停在它、不往后跑、不推进版本,记录于此(不抛)。 */
  error?: { id: string; version: number; message: string }
}
