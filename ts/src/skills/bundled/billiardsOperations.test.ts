import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  clearBundledSkills,
  getBundledSkillDescriptors,
} from '../bundledSkills.js'
import { BILLIARDS_KNOWLEDGE_FILES } from './billiardsKnowledge.js'
import {
  BILLIARDS_OPERATIONS_SKILLS,
  registerBilliardsOperationsSkills,
} from './billiardsOperations.js'

describe('billiards operations skills', () => {
  beforeEach(() => {
    clearBundledSkills()
  })

  afterEach(() => {
    clearBundledSkills()
  })

  it('registers task-oriented skills with plain Chinese desktop names', () => {
    registerBilliardsOperationsSkills()
    registerBilliardsOperationsSkills()

    const descriptors = getBundledSkillDescriptors()
    expect(descriptors).toHaveLength(BILLIARDS_OPERATIONS_SKILLS.length)
    expect(descriptors.map(skill => skill.name)).toEqual([
      'venue-daily-review',
      'venue-campaign-planning',
      'customer-follow-up',
      'venue-inspection-followup',
      'staff-performance-coaching',
      'venue-staff-scheduling',
      'venue-content-production',
    ])
    expect(descriptors.map(skill => skill.displayName)).toEqual([
      '复盘今天经营',
      '策划门店活动',
      '跟进和维护客户',
      '巡店和整改',
      '带教和辅导员工',
      '安排门店排班',
      '制作门店内容',
    ])
    expect(descriptors.every(skill => skill.userInvocable)).toBe(true)
    expect(descriptors.every(skill => skill.allowedTools.includes('Read'))).toBe(true)
  })

  it('keeps detailed knowledge in progressive reference files', () => {
    expect(Object.keys(BILLIARDS_KNOWLEDGE_FILES)).toEqual([
      'references/README.md',
      'references/source-register.md',
      'references/operations.md',
      'references/store-playbooks.md',
      'references/planning-benchmarks.md',
    ])
    expect(BILLIARDS_KNOWLEDGE_FILES['references/README.md']).toContain(
      '不代表任何一家门店的现状',
    )
    expect(BILLIARDS_KNOWLEDGE_FILES['references/README.md']).toContain(
      '提纯原则',
    )
    expect(BILLIARDS_KNOWLEDGE_FILES['references/source-register.md']).toContain(
      '当前核验日期：2026-07-26',
    )
    expect(BILLIARDS_KNOWLEDGE_FILES['references/operations.md']).toContain(
      '明确客户与目标 → 设计真实产品 → 组织触达 → 保证交付',
    )
    expect(BILLIARDS_KNOWLEDGE_FILES['references/store-playbooks.md']).toContain(
      '选址与租赁核对',
    )
    expect(BILLIARDS_KNOWLEDGE_FILES['references/planning-benchmarks.md']).toContain(
      '不是 BilliardBuddy 的默认规则',
    )
    const runtimeKnowledge = Object.values(BILLIARDS_KNOWLEDGE_FILES).join('\n')
    expect(runtimeKnowledge).not.toContain('本地存档')
    expect(runtimeKnowledge).not.toContain('文本行号')
    expect(runtimeKnowledge).not.toMatch(/第\s*\d+\s*页/)
  })

  it('tells the Agent to hide technical choices and separate store facts', () => {
    registerBilliardsOperationsSkills()

    const descriptors = getBundledSkillDescriptors()
    for (const skill of descriptors) {
      expect(skill.content).toContain('由 Agent 在内部选择模型、工具、Skill、文件格式和技术实现')
      expect(skill.content).toContain('每项经营事实标明门店、来源和观察时间')
      expect(skill.content).toContain('references/README.md')
      expect(skill.content).toContain('一次任务只处理用户明确指定的一家门店')
      expect(skill.content).toContain('只有真实工具返回成功回执后')
    }
  })

  it('routes saved and media results through real product tools', () => {
    registerBilliardsOperationsSkills()
    const descriptors = getBundledSkillDescriptors()
    expect(descriptors.find(skill => skill.name === 'venue-staff-scheduling')?.allowedTools).toContain('Write')
    expect(descriptors.find(skill => skill.name === 'venue-content-production')?.allowedTools).toContain('MediaWorkbench')
    expect(descriptors.find(skill => skill.name === 'venue-campaign-planning')?.allowedTools).toContain('MediaWorkbench')
  })

  it('does not claim that campaign artwork exists before its workbench can run', () => {
    const campaign = BILLIARDS_OPERATIONS_SKILLS.find(
      skill => skill.name === 'venue-campaign-planning',
    )

    expect(campaign?.prompt).toContain('先确认“做海报和图片”工作台及其执行链真实可用')
    expect(campaign?.prompt).toContain('未接线或无法生成时，只交付图片 Brief')
    expect(campaign?.prompt).toContain('不把草稿或成品写成已生成')
  })
})
