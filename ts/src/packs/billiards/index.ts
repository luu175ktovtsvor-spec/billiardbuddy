// 台球运营领域包 · 策展知识装配层
//
// 把 hardSpecs / knowledge 装成会话知识摘要和按需知识检索。
// 领域层只提供事实与来源,不接管通用 Agent 的任务规划、工具权限或输出流程。

import { HARD_SPECS, findHardSpecs, formatHardSpec } from './hardSpecs'
import { KNOWLEDGE, DOMAIN_META, findKnowledge, type BilliardsDomain } from './knowledge'
import { ALLOWED_TERMS, PLATFORM_TERMS, BANNED_TERMS } from './termWhitelist'

export * from './hardSpecs'
export * from './knowledge'
export * from './termWhitelist'
export * from './guardrails'

const DOMAIN_ORDER: BilliardsDomain[] = ['strategy', 'marketing', 'customer-ops', 'talent-mgmt', 'data-analysis']

/** 挂载时注入的知识目录。详细条目通过只读检索工具按需展开。 */
export function renderSessionStartContext(): string {
  const lines: string[] = []
  lines.push('<domain_context id="billiards" source="enabled_pack">')
  lines.push('当前会话加载了台球运营知识库。它只提供领域事实和来源,不改变通用 Agent 的任务规划、工具权限或回答方式。')
  lines.push('以下是知识目录。需要具体做法或数字时调用 billiards_knowledge_search 检索原始知识条目;知识库没有的内容不要归因给知识库。门店自己的价格、地址、排班、合同和活动信息必须来自用户输入或门店资料。')
  lines.push('知识库中的参考值不能直接写成本店活动规则。最终方案或对外文案依赖的折扣、价格、免费时长、活动时间、预算、人数或承诺尚未确认时,先询问用户并停在提问处。')
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

  lines.push('</domain_context>')
  return lines.join('\n')
}

/** 按查询展开相关知识条目和硬数字,不附加任务流程。 */
export function renderKnowledgeMatches(query: string): string {
  const lines: string[] = []
  const specs = findHardSpecs(query)
  const knows = findKnowledge(query, 8)

  if (knows.length) {
    lines.push('相关台球运营知识库内容(带内部来源位置):')
    for (const e of knows) {
      lines.push(`  - ${e.title} [知识库来源 ${e.src.line}/第${e.src.page}页]`)
      for (const point of e.points) lines.push(`    - ${point}`)
    }
  }
  if (specs.length) {
    lines.push('相关硬数字(以 hardSpecs 单一源为准):')
    for (const s of specs) lines.push(`  - ${formatHardSpec(s)}`)
  }
  if (!knows.length && !specs.length) {
    lines.push('知识库没有直接匹配的条目。')
  }
  lines.push('【使用边界】以上内容是方法和参考资料,不是当前门店已经确认的规则。参考数字只作为明确标注的参考选项;不得自行补出折扣、价格、免费时长、活动时间、奖金、人数或门店承诺。最终方案或对外文案需要这些事实时,先向用户补齐，并在本轮停在提问处。本轮最终回复只做简短提问，不编号、不嵌套，不复述本工具里的具体方法、选项或参考数字。')
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
