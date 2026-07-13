import { expect, test } from 'bun:test'
import { compileImageBrief } from './imageBriefCompiler'
import { compileGptImagePrompt, compileSeedreamPrompt, routeImageBrief } from './imagePromptAdapters'

test('Seedream adapter emits a concise Chinese prompt after routing', () => {
  const brief = compileImageBrief({
    prompt: `做一张周末活动海报，主体是一张真实台球桌，画面清楚自然。${'不要堆砌空泛形容词。'.repeat(80)}`,
    scene: 'poster',
    ratio: '3:4',
    posterText: { title: '周末畅打', price: '39.9 元' },
  })

  expect(routeImageBrief(brief)).toBe('seedream_4_5')
  const prompt = compileSeedreamPrompt(brief)
  expect(Array.from(prompt).length).toBeLessThanOrEqual(300)
  expect(prompt).toContain('用途：海报视觉')
  expect(prompt).toContain('业务文字由固定图层排版')
  expect(prompt).toContain('避免：')
})

test('GPT Image adapter keeps structured English change and preserve sections without translating exact Chinese copy', () => {
  const brief = compileImageBrief({
    prompt: '把上传的随手拍调得自然好看，保留本人，不要有明显 AI 感',
    scene: 'portrait',
    portraitAuthorizationConfirmed: true,
    referenceAssets: [{ asset_id: 'subject_1', role: 'identity_primary' }],
  })
  const prompt = compileGptImagePrompt(brief, 'edit')

  expect(routeImageBrief(brief, 'edit')).toBe('gpt_image_2')
  expect(prompt).toContain('Change only:')
  expect(prompt).toContain('Preserve:')
  expect(prompt).toContain('Do not change anything else.')
  expect(prompt).toContain('Image 1: identity_primary')
})
