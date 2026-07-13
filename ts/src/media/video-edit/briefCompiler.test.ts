import { expect, test } from 'bun:test'
import { compileVideoBrief } from './briefCompiler'
import { videoSourceSchema } from '../../../shared/contracts/video-edit'

const source = videoSourceSchema.parse({
  id: 's1', file_uri: '/tmp/a.mp4', name: 'a.mp4', fingerprint: '12345678', role: 'talking_take', role_confidence: 0.8,
})

test('freeform video brief preserves only the user request and explicit copy', () => {
  const { brief } = compileVideoBrief({ user_request: '把这几段剪成自然一点的日常记录', exact_copy: ['周末见'] }, [source])
  expect(brief.content_type).toBe('freeform')
  expect(brief.exact_copy).toEqual(['周末见'])
  expect(JSON.stringify(brief)).not.toMatch(/PPT|台球逻辑|团购价格|门店卖点/)
})

test('optional content type changes coverage checks without injecting marketing facts', () => {
  const { brief, missingFacts, missingCoverage } = compileVideoBrief({
    user_request: '做一条这次真实活动的短视频',
    content_type: 'offer_conversion',
  }, [source])
  expect(brief.content_type).toBe('offer_conversion')
  expect(brief.exact_copy).toEqual([])
  expect(missingFacts[0]).toContain('尚未由用户确认')
  expect(missingCoverage).toContain('proof')
})

test('same input produces a deterministic provider-neutral brief for Agent and workbench', () => {
  const input = { user_request: '讲清楚一个击球技巧', ratio: '9:16' as const }
  const agentBrief = compileVideoBrief(input, [source]).brief
  const workbenchBrief = compileVideoBrief(input, [source]).brief
  expect(agentBrief).toEqual(workbenchBrief)
  expect(agentBrief.preferred_view).toBe('talking')
  expect(agentBrief.content_type).toBe('coach_tutorial')
})
