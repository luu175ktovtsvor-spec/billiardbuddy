import { expect, test } from 'bun:test'
import {
  scanBannedTerms,
  scanSanitizedProperNouns,
  heuristicFabricatedStoreNames,
  isWhitelisted,
  guardText,
  SANITIZED_PROPER_NOUNS,
} from './guardrails'
import { KNOWLEDGE, SAFETY_FLOORS } from './knowledge'
import { HARD_SPECS } from './hardSpecs'
import { ALLOWED_TERMS, PLATFORM_TERMS, BANNED_TERMS } from './termWhitelist'
import { renderSessionStartContext, renderOpsBriefing, billiardsPackStats } from './index'
import { billiardsPack } from './pack'

// ── 1. 禁词命中=红 ────────────────────────────────────────────────
test('禁词命中=红:性交易/虚假承诺/免费助教/门店坐庄/假号刷评', () => {
  expect(scanBannedTerms('助教可以包夜出台').length).toBeGreaterThan(0)
  expect(scanBannedTerms('包赢全城最低价').length).toBeGreaterThan(0)
  expect(scanBannedTerms('我们提供免费助教陪练').length).toBeGreaterThan(0)
  expect(scanBannedTerms('门店当庄抽水定盘口').length).toBeGreaterThan(0)
  expect(scanBannedTerms('找水军买好评刷单').length).toBeGreaterThan(0)
  expect(guardText('包夜出台').ok).toBe(false)
})

// ── 2. 白名单词 / PPT 平台渠道器材名不误杀 ───────────────────────
test('白名单不误杀:内行词 + 平台/渠道/器材 + PPT 真实打法', () => {
  const text = '今天美女助教到店,走颜值/暧昧感路线;美团大众点评团购上新,抖音发擦边引流短视频,助教走探探/陌陌/Soul/积目获客,乔氏球台开追分局,发个红包'
  expect(scanBannedTerms(text)).toEqual([])
  expect(scanSanitizedProperNouns(text)).toEqual([])
  expect(guardText(text).ok).toBe(true)
  for (const p of ['美团', '大众点评', '抖音', '快手', '小红书', '探探', '陌陌', 'Soul', '积目', '乔氏', 'BOSS直聘']) {
    expect(isWhitelisted(p)).toBe(true)
  }
  // 平台带后缀也认
  expect(isWhitelisted('抖音本地推')).toBe(true)
  expect(isWhitelisted('抖音矩阵')).toBe(true)
})

test('PPT 促销词"助教免费体验"不被"免费助教定位"禁词误杀', () => {
  expect(scanBannedTerms('助教免费体验是拉新促销手段')).toEqual([])
  expect(scanBannedTerms('免费助教').length).toBeGreaterThan(0)
})

test('PPT"刷团购/养评"不被"假号刷评"禁词误杀', () => {
  expect(scanBannedTerms('助教小组轮流买券刷团购评分,养评按平台规则')).toEqual([])
  expect(scanBannedTerms('买好评找水军').length).toBeGreaterThan(0)
})

// ── 3. 凭空第三方专名=红 ──────────────────────────────────────────
test('第三方专名=红:PPT 底本里须脱敏的门店/机构/城市/人名不许泄漏', () => {
  expect(scanSanitizedProperNouns('我们对标鼎冠台球的打法').length).toBeGreaterThan(0)
  expect(scanSanitizedProperNouns('参考徐州某连锁经验').length).toBeGreaterThan(0)
  expect(scanSanitizedProperNouns('FUNENG 付能课程里说').length).toBeGreaterThan(0)
  expect(guardText('学鼎冠').ok).toBe(false)
})

test('凭空新造店名启发式=二级信号(不并进 ok,但能提示)', () => {
  const suspects = heuristicFabricatedStoreNames('隔壁星辰台球俱乐部生意好')
  expect(suspects.length).toBeGreaterThan(0)
  expect(suspects.some(s => s.includes('星辰台球俱乐部'))).toBe(true)
  // 泛指/定位类前缀不误报
  expect(heuristicFabricatedStoreNames('社区球房和商业台球俱乐部定位不同')).toEqual([])
  expect(heuristicFabricatedStoreNames('本店台球会所')).toEqual([])
  // 裸"台球/球房"不触发(避免误伤"打台球")
  expect(heuristicFabricatedStoreNames('周末来打台球吧')).toEqual([])
  // guardText 默认不含启发式,includeHeuristic 才附带
  expect(guardText('星辰台球俱乐部').suspectStoreNames).toBeUndefined()
  expect(guardText('星辰台球俱乐部', { includeHeuristic: true }).suspectStoreNames).toContain('星辰台球俱乐部')
})

// ── 4. 策展知识库自身 PPT-only 清白 ──────────────────────────────
test('知识库/白名单/硬数字/注入文案里无泄漏的第三方专名', () => {
  const corpus = [
    ...KNOWLEDGE.flatMap(e => [e.title, ...e.points]),
    ...SAFETY_FLOORS.flatMap(f => [f.title, f.text]),
    ...HARD_SPECS.flatMap(s => [s.rule, s.quote, s.note ?? '']),
    ...ALLOWED_TERMS.map(t => `${t.term} ${t.usage}`),
    ...PLATFORM_TERMS.map(p => p.term),
    ...BANNED_TERMS.flatMap(b => [b.label, b.reason, b.redirect]),
    renderSessionStartContext(),
    renderOpsBriefing('团购定价活动', ['黄金档台费 68 元']),
  ].join('\n')
  expect(scanSanitizedProperNouns(corpus)).toEqual([])
})

test('策展知识库无 PPT 之外的凭空店名(店名启发式清白)', () => {
  const corpus = KNOWLEDGE.flatMap(e => [e.title, ...e.points]).join('\n')
  expect(heuristicFabricatedStoreNames(corpus)).toEqual([])
})

// ── 5. 覆盖度/结构完整性 ─────────────────────────────────────────
test('五域知识齐、硬数字 16 条、每条带 PPT 出处', () => {
  const stats = billiardsPackStats()
  expect(stats.hardSpecs).toBe(16)
  expect(stats.knowledgeEntries).toBeGreaterThanOrEqual(25)
  for (const d of ['marketing', 'customer-ops', 'talent-mgmt', 'strategy', 'data-analysis']) {
    expect(stats.byDomain[d]).toBeGreaterThan(0)
  }
  // 每条硬数字带 PPT 行号+页码
  for (const s of HARD_SPECS) {
    expect(s.ppt.line.length).toBeGreaterThan(0)
    expect(s.ppt.page.length).toBeGreaterThan(0)
  }
  // 每条知识带 PPT 出处
  for (const e of KNOWLEDGE) {
    expect(e.src.line.length).toBeGreaterThan(0)
    expect(e.src.page.length).toBeGreaterThan(0)
  }
  // 硬数字 id 连续 1..16
  expect(HARD_SPECS.map(s => s.id)).toEqual(Array.from({ length: 16 }, (_, i) => i + 1))
  expect(SANITIZED_PROPER_NOUNS.length).toBeGreaterThan(10)
})

test('注入文案含五域骨架、两条真底线、白名单纪律', () => {
  const ctx = renderSessionStartContext()
  expect(ctx).toContain('<domain_context id="billiards"')
  expect(ctx).toContain('5 域知识骨架')
  expect(ctx).toContain('两条真底线')
  expect(ctx).toContain('助教守自爱')
  expect(ctx).toContain('门店只控金额')
  expect(ctx).toContain('擦边引流')
  expect(ctx).toContain('美团')
})

test('模型运行时统一使用台球运营知识库口径,不披露第三方材料名或 PPT 载体', () => {
  const commandPrompt = billiardsPack.commands?.find(command => command.name === '台球')?.prompt ?? ''
  const runtimeText = [
    renderSessionStartContext(),
    renderOpsBriefing('团购定价活动', []),
    commandPrompt,
  ].join('\n')
  expect(runtimeText).toContain('台球运营知识库')
  expect(runtimeText).not.toContain('台球赋能')
  expect(runtimeText).not.toContain('PPT')
})
