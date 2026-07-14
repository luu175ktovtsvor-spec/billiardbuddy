// 台球运营领域包 · 策展知识装配层
//
// 把 hardSpecs / termWhitelist / knowledge 装成:
//   - renderSessionStartContext():挂载时注入的策展摘要(精炼骨架 + 两条真底线 + 白名单/禁词/脱敏纪律)。
//   - renderOpsBriefing(scenario, facts):billiards_ops_checklist 工具按场景带出相关硬数字/知识/禁词提醒。
// 设计口径(架构=大厂标准 B):注入"精炼核心",细节让模型据 skeleton 自延伸,深度检索留给后续 RAG。

import { HARD_SPECS, findHardSpecs, formatHardSpec } from './hardSpecs'
import { KNOWLEDGE, DOMAIN_META, SAFETY_FLOORS, findKnowledge, type BilliardsDomain } from './knowledge'
import { ALLOWED_TERMS, PLATFORM_TERMS, BANNED_TERMS } from './termWhitelist'

export * from './hardSpecs'
export * from './knowledge'
export * from './termWhitelist'
export * from './guardrails'

const DOMAIN_ORDER: BilliardsDomain[] = ['strategy', 'marketing', 'customer-ops', 'talent-mgmt', 'data-analysis']

/** 挂载时注入的策展摘要(sessionStartContext)。PPT-only、带出处、控制体量。 */
export function renderSessionStartContext(): string {
  const lines: string[] = []
  lines.push('<domain_context id="billiards" source="enabled_pack">')
  lines.push('当前会话挂载了台球运营专家。你仍是通用本机 coding agent,但遇到球房经营、活动、客户、助教、赛事、团购、短视频、海报等需求时,按下方台球运营知识库策展的真实经营语境落地。')
  lines.push('知识铁律:以下内容来自台球运营知识库,带内部来源位置可回溯;知识库没有的别编。关键经营数字以 hardSpecs 单一源为准(共 16 条,billiards_ops_checklist 会按场景带出)。')
  lines.push('')

  lines.push('【5 域知识骨架】')
  for (const domain of DOMAIN_ORDER) {
    const meta = DOMAIN_META[domain]
    const entries = KNOWLEDGE.filter(e => e.domain === domain)
    lines.push(`# ${meta.name}(${domain}):${meta.blurb}`)
    for (const e of entries) {
      lines.push(`  - ${e.title} [知识库来源 ${e.src.line}/第${e.src.page}页]${e.hardSpecRefs?.length ? ` (硬数字#${e.hardSpecRefs.join('#')})` : ''}`)
    }
  }
  lines.push('')

  lines.push('【两条真底线(台球运营知识库明确收录,始终守,独立于安全红线之外的领域落点)】')
  for (const floor of SAFETY_FLOORS) {
    lines.push(`  - ${floor.title}:${floor.text} [知识库来源 ${floor.src.line}/第${floor.src.page}页]`)
  }
  lines.push('')

  lines.push('【表达纪律(白名单/禁词/脱敏)】')
  lines.push('  - 内行词照用不消毒:' + ALLOWED_TERMS.slice(0, 16).map(t => t.term).join('、') + ' 等(美女人设/异性情绪价值/擦边引流/交友软件获客/红包/追分/助教免费体验是台球运营知识库收录的真实打法,别当红线误杀)。')
  lines.push('  - 平台/渠道/器材通用名照写不脱敏:' + PLATFORM_TERMS.map(p => p.term).join('、') + '。')
  lines.push('  - 真底线禁词(命中即改写):' + BANNED_TERMS.map(b => b.label).join(' / ') + ';各自的改写方向见工具输出。')
  lines.push('  - 第三方专名脱敏:台球运营知识库素材里的真实门店/连锁/人名/城市/机构案例名一律不搬进输出,只搬逻辑(用"某店/某城市"占位)。')
  lines.push('  - 不编造:助教姓名/年龄/身高/价格/照片、客户历史、门店变化等未知信息用占位符,不瞎编;本店价格/套餐/地址/排班/合同/活动时间等事实必须来自用户输入或 search_store_docs 来源。')
  lines.push('')

  lines.push('渐进披露:需专门流程时先 list_commands 查本包命令(/billiards:daily-ops、/billiards:content-plan),或 billiards_ops_checklist 按场景做经营/内容核对并带出相关硬数字与禁词提醒。生图/视频/剪辑只是同工作台的扩展能力;任务本质是改代码/改文件时先走 coding agent 主路径。')
  lines.push('</domain_context>')
  return lines.join('\n')
}

/** billiards_ops_checklist 工具的知识增强:按场景带出相关硬数字 + 知识条目 + 禁词提醒。 */
export function renderOpsBriefing(scenario: string, facts: string[]): string {
  const lines: string[] = []
  const specs = findHardSpecs(scenario)
  const knows = findKnowledge(scenario, 5)

  if (knows.length) {
    lines.push('相关台球运营知识库内容(带内部来源位置):')
    for (const e of knows) lines.push(`  - ${e.title} [知识库来源 ${e.src.line}/第${e.src.page}页]:${e.points[0]}`)
  }
  if (specs.length) {
    lines.push('相关硬数字(以 hardSpecs 单一源为准):')
    for (const s of specs) lines.push(`  - ${formatHardSpec(s)}`)
  }
  lines.push('表达纪律:内行词照用、平台/渠道/器材名照写;禁真底线禁词(性交易/虚假承诺/免费助教/门店坐庄抽成/假号刷评);第三方门店/人名/城市专名脱敏;本店事实不编造。')
  if (!knows.length && !specs.length) {
    lines.push('(本场景未直接命中策展知识/硬数字,按 5 域骨架自行判断,涉及本店事实先核对来源。)')
  }
  return lines.join('\n')
}

/** 统计口径(供报告/测试断言覆盖度)。 */
export function billiardsPackStats() {
  const byDomain: Record<string, number> = {}
  for (const e of KNOWLEDGE) byDomain[e.domain] = (byDomain[e.domain] ?? 0) + 1
  return {
    knowledgeEntries: KNOWLEDGE.length,
    hardSpecs: HARD_SPECS.length,
    allowedTerms: ALLOWED_TERMS.length,
    platformTerms: PLATFORM_TERMS.length,
    bannedTerms: BANNED_TERMS.length,
    byDomain,
  }
}
