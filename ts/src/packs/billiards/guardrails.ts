// 台球运营领域包 · PPT-only 防编造守卫
//
// 三件事:
//   1. scanBannedTerms          —— 命中真底线禁词=红(性交易/虚假承诺/免费助教/门店坐庄/假号刷评)。
//   2. scanSanitizedProperNouns —— 命中"PPT 底本里须脱敏的第三方专名"=红(门店/人名/城市/机构案例名);黑名单精确、可靠。
//   3. isWhitelisted            —— 平台/渠道/器材通用名 + 内行词不误杀(它们不进黑名单)。
//
// 另配 heuristicFabricatedStoreNames:对"凭空新造"的店名(XX台球俱乐部)做严格后缀启发式,
//   作二级信号——默认不并进 guardText(避免上线误杀正常文案),测试与人工排查时按需调用。
//
// 局限:黑名单只能拦 PPT 底本出现过、须剥离的真实第三方名;店名启发式只覆盖明显店牌式写法。
//   真正的语义级防编造(RAG 检索 PPT 有据性、嵌入走 Node sidecar)列为后续未做项。

import { BANNED_TERMS, PLATFORM_TERM_SET, ALLOWED_TERM_SET, type BannedTerm } from './termWhitelist'

/**
 * PPT 底本里真实出现、但须脱敏剥离的第三方专名(机构/连锁/门店/人名/城市/案例名)。
 * 铁律:这些绝不能出现在领域包知识内容或对外输出里——只搬 PPT 逻辑,绝不搬这些专名。
 * (平台/渠道/器材通用名如美团/抖音/探探/乔氏不在此列,见 termWhitelist.PLATFORM_TERMS。)
 */
export const SANITIZED_PROPER_NOUNS: string[] = [
  // 机构 / 品牌 / 工具
  'FUNENG', '付能', '有球企管', '赛利星', '上上参谋',
  // 案例门店 / 连锁品牌名
  '鼎冠', '盘力', '百大台球', '莱克多尔', '天宫台球', '仙人台球', '康乔',
  '心碎乌托邦', '名爵', '橘子台球', '中翰国际', '幻影', '光辉岁月', '独牙', 'TT桌球',
  '金湃西海岸', '酷猫台球', '789台球', '2012台球',
  // 人名(理论出处杰克·特劳特/戴维·帕卡德不在此列,营销/引言可保留为出处)
  '丁俊辉', '老付',
  // 城市 / 地域(PPT 案例出处,知识内容不搬)
  '徐州', '盐城', '东台', '济南', '长治', '昆明', '南昌', '许昌', '佛山', '宣城',
  '青岛', '成都', '厦门', '新乡', '辉县', '淄博', '宁陵', '永康', '遵义', '嘉善', '平湖',
  // 活动 / 赠品专名
  '红牛',
]

const SANITIZED_LOWER = SANITIZED_PROPER_NOUNS.map(n => n.toLowerCase())

// 严格店名后缀:只认明显店牌式写法,裸"台球/球房"太泛不收(会误伤"打台球/社区球房")。
const STORE_NAME_HEURISTIC = /([一-龥A-Za-z0-9]{1,4})(台球俱乐部|台球会所|台球厅|台球城|桌球俱乐部|桌球会所|台球连锁)/g
// 泛指/定位类前缀,不算第三方专名。
const GENERIC_STORE_PREFIX = new Set([
  '社区', '商业', '竞技', '本店', '我们', '本', '该', '某', '同行', '竞对', '连锁',
  '这家', '那家', '一家', '每家', '门店', '大厅', '本地', '中式', '美式', '英式',
])
// 前缀里出现这些=贪婪跨词或泛指,不算凭空店名。
const PREFIX_STOPWORDS = ['球房', '俱乐部', '会所', '和', '或', '与', '及', '跟', '的', '是', '在', '有', '这', '那', '各', '家']

export interface BannedHit {
  label: string
  pattern: string
  category: BannedTerm['category']
  reason: string
  redirect: string
}

/** 扫真底线禁词。命中即返回(=红)。 */
export function scanBannedTerms(text: string): BannedHit[] {
  const hay = text.toLowerCase()
  const hits: BannedHit[] = []
  for (const banned of BANNED_TERMS) {
    for (const pattern of banned.patterns) {
      if (hay.includes(pattern.toLowerCase())) {
        hits.push({ label: banned.label, pattern, category: banned.category, reason: banned.reason, redirect: banned.redirect })
        break
      }
    }
  }
  return hits
}

/** 扫须脱敏的第三方专名(黑名单精确匹配)。命中即返回(=红)。 */
export function scanSanitizedProperNouns(text: string): string[] {
  const hay = text.toLowerCase()
  const hits: string[] = []
  const seen = new Set<string>()
  for (let i = 0; i < SANITIZED_LOWER.length; i++) {
    const key = SANITIZED_LOWER[i]!
    if (hay.includes(key) && !seen.has(key)) {
      seen.add(key)
      hits.push(SANITIZED_PROPER_NOUNS[i]!)
    }
  }
  return hits
}

/** 二级信号:严格店名后缀启发式,提示可能的凭空第三方店名(默认不并进 guardText)。 */
export function heuristicFabricatedStoreNames(text: string): string[] {
  const hits: string[] = []
  const seen = new Set<string>()
  let m: RegExpExecArray | null
  STORE_NAME_HEURISTIC.lastIndex = 0
  while ((m = STORE_NAME_HEURISTIC.exec(text)) !== null) {
    const prefix = m[1] ?? ''
    const full = m[0]
    if (!prefix || GENERIC_STORE_PREFIX.has(prefix)) continue
    if (PREFIX_STOPWORDS.some(w => prefix.includes(w))) continue
    if (isWhitelisted(full) || isWhitelisted(prefix)) continue
    const key = full.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    hits.push(full)
  }
  return hits
}

/** 是否白名单词(平台/渠道/器材通用名 或 内行词)——这些不该被当第三方专名误杀。 */
export function isWhitelisted(term: string): boolean {
  const t = term.trim().toLowerCase()
  if (!t) return false
  if (PLATFORM_TERM_SET.has(t) || ALLOWED_TERM_SET.has(t)) return true
  for (const p of PLATFORM_TERM_SET) if (t.includes(p)) return true
  return false
}

export interface GuardResult {
  ok: boolean
  banned: BannedHit[]
  properNouns: string[]
  /** 仅当 includeHeuristic 时填充,作参考不计入 ok。 */
  suspectStoreNames?: string[]
}

/**
 * 综合守卫:对一段文本给红/绿判定。
 * 默认判据 = 禁词 + 脱敏专名黑名单(可靠);店名启发式仅在 includeHeuristic 时附带返回、不计入 ok。
 */
export function guardText(text: string, opts?: { includeHeuristic?: boolean }): GuardResult {
  const banned = scanBannedTerms(text)
  const properNouns = scanSanitizedProperNouns(text)
  const result: GuardResult = { ok: banned.length === 0 && properNouns.length === 0, banned, properNouns }
  if (opts?.includeHeuristic) result.suspectStoreNames = heuristicFabricatedStoreNames(text)
  return result
}
