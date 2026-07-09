// 内置领域包「发现」层 · 唯一的注册清单
//
// 这是通用加载器的"发现"入口:进程内可信领域包在这里逐个注册进注册表。
//   新增一个领域包 = 写一个 pack 模块(见 billiards/pack.ts)+ 在下面 BUILTIN_PACKS 加一行,
//   不改 registry / domainPacks 门面的任何逻辑——即"新增 pack = 注册一个模块",不改核心。
//
// 后期第三方/多领域包:从磁盘/marketplace 发现 manifest → 沙箱隔离装载 → 同样 registry.register(),
//   这份 builtin 清单只是"发现"的其中一路(内置路);骨架(发现→装载→启停)不变。

import { PackRegistry } from './registry'
import type { DomainPack } from './types'
import { billiardsPack } from './billiards/pack'

/** 内置领域包清单(注册顺序 = 列举顺序)。台球是第一个,不是唯一。 */
export const BUILTIN_PACKS: readonly DomainPack[] = [
  billiardsPack,
]

/** 把内置领域包全部注册进给定注册表(可复用于测试的独立注册表)。 */
export function registerBuiltinPacks(registry: PackRegistry): PackRegistry {
  for (const pack of BUILTIN_PACKS) registry.register(pack)
  return registry
}

let defaultRegistry: PackRegistry | undefined

/** 进程级默认注册表(懒建,注册内置领域包)。domainPacks 门面与 server 都走它。 */
export function getDefaultPackRegistry(): PackRegistry {
  if (!defaultRegistry) {
    defaultRegistry = registerBuiltinPacks(new PackRegistry())
  }
  return defaultRegistry
}

/** 仅供测试:重置默认注册表(下次 getDefaultPackRegistry 会重建内置清单)。 */
export function __resetDefaultPackRegistryForTests(): void {
  defaultRegistry = undefined
}
