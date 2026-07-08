import { expect, test } from 'bun:test'
import { addInvokedSkill, clearInvokedSkills, createInvokedSkillsMessage, getInvokedSkillsForScope, restoreInvokedSkillsFromMessages } from './invokedSkills'

test('invoked skills are scoped, formatted for compaction, and restored from messages', () => {
  clearInvokedSkills()
  try {
    addInvokedSkill('report', '/tmp/report/SKILL.md', 'Use report steps.', 'conv-a')
    addInvokedSkill('other', '/tmp/other/SKILL.md', 'Other scope.', 'conv-b')

    const msg = createInvokedSkillsMessage('conv-a')
    expect(msg).toBeTruthy()
    const text = msg?.content[0]
    expect(text?.type).toBe('text')
    if (text?.type !== 'text') throw new Error('expected text block')
    expect(text.text).toContain('<invoked_skills>')
    expect(text.text).toContain('name="report"')
    expect(text.text).toContain('Use report steps.')
    expect(text.text).not.toContain('Other scope.')

    clearInvokedSkills()
    expect(getInvokedSkillsForScope('conv-a')).toEqual([])
    expect(restoreInvokedSkillsFromMessages([msg!], 'conv-a')).toBe(1)
    expect(getInvokedSkillsForScope('conv-a')).toEqual([
      expect.objectContaining({
        skillName: 'report',
        skillPath: '/tmp/report/SKILL.md',
        content: 'Use report steps.',
        scopeId: 'conv-a',
      }),
    ])
  } finally {
    clearInvokedSkills()
  }
})
