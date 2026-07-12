import { expect, test } from 'bun:test'
import { compileImageBrief } from './imageBriefCompiler'
import { compileProviderPrompt, routeImageBrief } from './imagePromptAdapters'

test('compiler keeps Chinese business facts in a provider-neutral brief', () => {
  const brief = compileImageBrief({
    prompt: '做一张周末双人畅打 39.9 元，6月15日，电话 13800138000 的朋友圈海报',
    ratio: '9:16',
  })
  expect(brief.scene).toBe('poster')
  expect(brief.poster?.price).toContain('39.9')
  expect(brief.poster?.phone).toContain('13800138000')
  expect(brief.understanding).toContain('周末')
  expect(routeImageBrief(brief)).toBe('seedream_4_5')
})

test('portrait compilation keeps image roles and change/preserve boundary', () => {
  const brief = compileImageBrief({
    prompt: '用这张照片做专业助教形象照，换成球房背景和黑色球服',
    scene: 'portrait',
    referenceAssets: [{ asset_id: 'asset_primary', role: 'identity_primary' }],
    portraitConsent: true,
  })
  expect(brief.portrait?.primary_reference_asset_id).toBe('asset_primary')
  expect(brief.portrait?.change.join(' ')).toContain('服装')
  expect(brief.portrait?.preserve.join(' ')).toContain('面部')
  expect(routeImageBrief(brief, 'edit')).toBe('gpt_image_2')
  const prompt = compileProviderPrompt(brief, 'edit').prompt
  expect(prompt).toContain('Change only:')
  expect(prompt).toContain('Preserve:')
  expect(prompt).toContain('Do not change anything else.')
})
