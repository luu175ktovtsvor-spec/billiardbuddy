import type { Migration } from './types'

/**
 * 版本化迁移注册表(按 version 升序执行)。
 *
 * 现在**默认空** —— 这是有意的:cc 的具体迁移器几乎都是给它上游模型改名
 * (migrateSonnet1mToSonnet45 / migrateSonnet45ToSonnet46 / migrateFennecToOpus / migrateOpusToOpus1m …,
 * 见 cc `src/migrations/*` 与 main.tsx:326-353 的 runMigrations),对我们的产品完全不适用。
 * 我们照搬的是「版本化 + 启动按序执行 + 幂等 + 已应用版本持久化」这套**地基**,不照搬内容。
 *
 * 以后要迁移 settings / 数据 schema(改 `<stateRoot>/user-settings.json` 字段、重排会话索引结构等),
 * 就往这里加一条,version 取「当前最大 + 1」:
 *
 * ```ts
 * import { readFileSync, writeFileSync } from 'node:fs'
 * import { join } from 'node:path'
 * export const MIGRATIONS: readonly Migration[] = [
 *   {
 *     version: 1,
 *     id: 'user-settings-rename-foo-to-bar',
 *     run: ({ stateRoot }) => {
 *       const p = join(stateRoot, 'user-settings.json')
 *       let raw: Record<string, unknown>
 *       try { raw = JSON.parse(readFileSync(p, 'utf8')) } catch { return } // 缺文件 = 无事可迁,幂等返回
 *       if (!('foo' in raw) || 'bar' in raw) return                        // 已迁过 = 幂等返回
 *       raw.bar = raw.foo; delete raw.foo
 *       writeFileSync(p, `${JSON.stringify(raw, null, 2)}\n`)
 *     },
 *   },
 * ]
 * ```
 *
 * 铁律(runner 会在跑前校验、违反即抛,尽早暴露注册错误):
 * - `version` 必须唯一、递增、为 ≥1 的整数;
 * - `run` 必须幂等(重跑不改变最终结果)—— 因为部分失败/重启会导致同一条被再跑一次。
 */
export const MIGRATIONS: readonly Migration[] = []
