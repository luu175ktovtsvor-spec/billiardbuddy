import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  clearBundledSkills,
  getBundledSkillDescriptors,
} from '../bundledSkills.js'
import {
  BOSS_RECRUITING_FILES,
  registerBossRecruitingSkill,
} from './bossRecruiting.js'

describe('boss recruiting skill', () => {
  beforeEach(() => {
    clearBundledSkills()
  })

  afterEach(() => {
    clearBundledSkills()
  })

  it('registers a plain-language recruiting workflow', () => {
    registerBossRecruitingSkill()
    registerBossRecruitingSkill()

    const descriptors = getBundledSkillDescriptors()
    expect(descriptors).toHaveLength(1)
    expect(descriptors[0]).toEqual(expect.objectContaining({
      name: 'boss-recruiting',
      displayName: '招聘球房员工',
      userInvocable: true,
    }))
    expect(descriptors[0]!.content).toContain('岗位名称与真实工作保持一致')
    expect(descriptors[0]!.content).toContain('按批次确认并读回结果')
  })

  it('does not bind the workflow to browser automation', () => {
    registerBossRecruitingSkill()

    const content = getBundledSkillDescriptors()[0]!.content
    expect(content).toContain('让 Agent 自己选择执行方式')
    expect(content).toContain('Skill 不绑定具体工具')
    expect(content).toContain('运行已有脚本或为本次任务编写代码')
  })

  it('ships progressive references for execution and recruiting facts', () => {
    expect(Object.keys(BOSS_RECRUITING_FILES)).toEqual([
      'references/execution-pattern.md',
      'references/recruiting-worksheet.md',
    ])
    expect(BOSS_RECRUITING_FILES['references/execution-pattern.md']).toContain(
      'Skill 只规定业务目标、交互流程和完成证据',
    )
    expect(BOSS_RECRUITING_FILES['references/recruiting-worksheet.md']).toContain(
      '未知项保持待确认',
    )
  })
})
