import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  clearBundledSkills,
  getBundledSkillExtractDir,
  getBundledSkillDescriptors,
  getBundledSkills,
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
      description: '把球房招聘目标整理成真实岗位、候选人分析、沟通草稿和可人工确认的跟进清单。',
      userInvocable: true,
    }))
    expect(descriptors[0]!.content).toContain('岗位名称与真实工作保持一致')
    expect(descriptors[0]!.content).toContain('准备动作、人工确认并读回结果')
    expect(descriptors[0]!.allowedTools).toContain('RecruitingBrowser')
  })

  it('prefers the formal BOSS tool without promising an unavailable channel', () => {
    registerBossRecruitingSkill()

    const content = getBundledSkillDescriptors()[0]!.content
    expect(content).toContain('使用当前正式执行通道')
    expect(content).toContain('BOSS 页面优先使用 ProductTask 正式提供的 RecruitingBrowser')
    expect(content).toContain('不能确认或执行')
    expect(content).toContain('不要把它说成已发布、已联系或已改变状态')
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

  it('keeps account credentials and irrelevant candidate data out of the workflow', () => {
    registerBossRecruitingSkill()

    const content = getBundledSkillDescriptors()[0]!.content
    expect(content).toContain('不要索取账号密码、验证码、Cookie、会话令牌或身份、生物识别信息')
    expect(content).toContain('不收集、复制或推断与岗位职责无直接关系的身份、家庭、健康、宗教、民族等个人信息')
    expect(BOSS_RECRUITING_FILES['references/execution-pattern.md']).toContain(
      '账号密码、验证码、Cookie、会话令牌、身份证号、人脸或其他生物识别信息',
    )
  })

  it('loads the same guarded instructions and references when the Skill is invoked', async () => {
    const macroTarget = globalThis as typeof globalThis & {
      MACRO?: { VERSION: string }
    }
    const previousMacro = macroTarget.MACRO
    if (!previousMacro) macroTarget.MACRO = { VERSION: 'boss-recruiting-test' }

    const skillDir = getBundledSkillExtractDir('boss-recruiting')
    await rm(skillDir, { recursive: true, force: true })

    try {
      registerBossRecruitingSkill()
      const command = getBundledSkills().find(candidate => candidate.name === 'boss-recruiting')
      expect(command?.type).toBe('prompt')
      if (!command || command.type !== 'prompt') {
        throw new Error('BOSS recruiting Skill was not registered as a prompt command')
      }

      const prompt = await command.getPromptForCommand('招一名球房教练', undefined as never)
      const firstBlock = prompt[0]
      expect(firstBlock?.type).toBe('text')
      if (firstBlock?.type !== 'text') {
        throw new Error('BOSS recruiting Skill did not return a text prompt')
      }

      expect(firstBlock.text).toStartWith(`Base directory for this skill: ${skillDir}`)
      expect(firstBlock.text).toContain('不把准备工作说成已完成的招聘动作')
      expect(await readFile(join(skillDir, 'references', 'execution-pattern.md'), 'utf-8')).toContain(
        '它只读取脱敏岗位证据和准备待确认动作',
      )
    } finally {
      await rm(skillDir, { recursive: true, force: true })
      if (previousMacro === undefined) delete macroTarget.MACRO
      else macroTarget.MACRO = previousMacro
    }
  })
})
