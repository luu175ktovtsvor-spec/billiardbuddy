// 领域包注册表 · 通用「发现-装载-启停-版本」加载器
//
// 对齐 cc plugins 的「discover → load → enable」骨架,但领域包是进程内可信 TS 模块(带 sessionStartContext /
// 工具 / 知识 / 守卫),不是文件系统插件。所以这里的"发现"= builtin 注册列表(见 builtinPacks.ts),
// "装载"= register() 进表并建别名索引,"启停"= setEnabled()(停用的包不参与解析/列举),"版本"= pack.version。
//
// 关键性质:核心永远不 import 某个具体 pack;billiards 只是「第一个 register 进来的 pack」。
//   新增领域包 = 写一个 pack 模块 + 在 builtinPacks.ts 注册,一行,不改本加载器逻辑。
//   后期第三方/多领域包:从磁盘/marketplace 发现 manifest → 沙箱隔离装载 → 同样走 register();骨架不变。

import type { DomainPack } from './types'

/** 统一 pack 标识:去空白、小写、下划线/空格归一为连字符。id 与别名都过这层,解析大小写/写法无关。 */
export function normalizePackId(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-')
}

/** 注册表里一条记录:pack 本体 + 启停状态。 */
export interface RegisteredPack {
  pack: DomainPack
  /** 启停:false = 已注册但停用,不参与 resolve/list(仍可 listAll 看到)。 */
  enabled: boolean
}

export interface RegisterOptions {
  /** 注册即停用(默认启用)。 */
  enabled?: boolean
}

/**
 * 领域包注册表。发现/装载/启停/版本都经由它,核心不硬编码任何具体 pack。
 * 注册顺序即列举顺序(Map 保序);别名与 id 冲突时 id 优先。
 */
export class PackRegistry {
  /** key = normalizePackId(pack.id) → 记录;保序。 */
  private readonly records = new Map<string, RegisteredPack>()

  /** 装载一个领域包(同 id 覆盖,保持原插入位置的语义:后注册覆盖旧记录)。 */
  register(pack: DomainPack, opts: RegisterOptions = {}): this {
    const key = normalizePackId(pack.id)
    if (!key) throw new Error('domain pack 必须有非空 id')
    this.records.set(key, { pack, enabled: opts.enabled ?? true })
    return this
  }

  /** 卸载一个领域包(按 id 或别名);返回是否卸载成功。 */
  unregister(idOrAlias: string): boolean {
    const record = this.findRecord(idOrAlias)
    if (!record) return false
    return this.records.delete(normalizePackId(record.pack.id))
  }

  /** 启停一个领域包(按 id 或别名);返回是否命中。停用后不再被 resolve/list。 */
  setEnabled(idOrAlias: string, enabled: boolean): boolean {
    const record = this.findRecord(idOrAlias)
    if (!record) return false
    record.enabled = enabled
    return true
  }

  /** 是否已注册且已启用(按 id 或别名)。 */
  isEnabled(idOrAlias: string): boolean {
    return this.findRecord(idOrAlias)?.enabled === true
  }

  /** 是否已注册(不论启停)。 */
  has(idOrAlias: string): boolean {
    return this.findRecord(idOrAlias) !== undefined
  }

  /** 按 id 或别名解析,仅返回**已启用**的 pack(停用/未注册返回 undefined)。 */
  resolve(idOrAlias: string): DomainPack | undefined {
    const record = this.findRecord(idOrAlias)
    return record?.enabled ? record.pack : undefined
  }

  /** 所有**已启用**的领域包(注册顺序)。 */
  list(): DomainPack[] {
    const out: DomainPack[] = []
    for (const record of this.records.values()) if (record.enabled) out.push(record.pack)
    return out
  }

  /** 全部注册项含停用的(注册顺序),供管理面板列启停状态。 */
  listAll(): RegisteredPack[] {
    return [...this.records.values()]
  }

  /** 已注册的领域包数量(含停用)。 */
  get size(): number {
    return this.records.size
  }

  /** 按 id 或别名查记录(含停用);id 精确命中优先,再回退别名扫描。 */
  private findRecord(idOrAlias: string): RegisteredPack | undefined {
    const key = normalizePackId(idOrAlias)
    if (!key) return undefined
    const direct = this.records.get(key)
    if (direct) return direct
    for (const record of this.records.values()) {
      for (const alias of record.pack.aliases ?? []) {
        if (normalizePackId(alias) === key) return record
      }
    }
    return undefined
  }
}
