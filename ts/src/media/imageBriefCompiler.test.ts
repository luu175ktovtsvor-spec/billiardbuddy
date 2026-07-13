import { expect, test } from 'bun:test'
import type { Model } from '../types/model'
import { compileImageBrief, ImageBriefCompiler } from './imageBriefCompiler'
import { compileProviderPrompt, compileSeedreamPrompt, routeImageBrief } from './imagePromptAdapters'

test('freeform requests can be model-enriched without changing deterministic business facts', async () => {
  const model: Model = {
    async step() {
      return {
        kind: 'final',
        text: JSON.stringify({
          visual_direction: { subject: '夏日音乐节抽象视觉', style: '现代拼贴', composition: '中心焦点，留出呼吸感' },
          understanding: '夏日音乐节抽象艺术海报，不添加文字',
        }),
      }
    },
  }
  const brief = await new ImageBriefCompiler().compileWithModel({ prompt: '夏日音乐节的抽象艺术海报，不要任何文字' }, model)

  expect(brief.compiler_version).toBe('image-brief-v1-model')
  expect(brief.visual_direction.style).toBe('现代拼贴')
  expect(brief.poster?.exact_copy).toEqual([])
})

test('model enrichment is discarded when it invents billiards context or business numbers', async () => {
  const model: Model = {
    async step() {
      return {
        kind: 'final',
        text: JSON.stringify({
          visual_direction: { subject: '台球房助教优惠海报' },
          understanding: '充值 39.9 元活动',
        }),
      }
    },
  }
  const brief = await new ImageBriefCompiler().compileWithModel({ prompt: '夏日音乐节抽象海报' }, model)

  expect(brief.compiler_version).toBe('image-brief-v1')
  expect(JSON.stringify(brief)).not.toContain('台球房助教')
  expect(JSON.stringify(brief)).not.toContain('39.9')
})

test('compiler keeps Chinese business facts in a provider-neutral brief', () => {
  const brief = compileImageBrief({
    prompt: '做一张周末双人畅打 39.9 元，6月15日，电话 13800138000 的朋友圈海报',
    ratio: '9:16',
  })
  expect(brief.scene).toBe('poster')
  expect(brief.poster?.price).toContain('39.9')
  expect(brief.poster?.phone).toContain('13800138000')
  expect(brief.understanding).toContain('39.9')
  expect(routeImageBrief(brief)).toBe('seedream_4_5')
})

test('compiler keeps a freeform poster free of prefilled operating context', () => {
  const brief = compileImageBrief({
    prompt: '做一张夏日晚间台球聚会海报，画面有朋友、球桌和门店灯光',
    sceneTemplateId: 'custom_poster',
    posterText: {
      title: '夏夜开杆',
      offer: '到店一起玩',
    },
  })

  expect(brief.poster?.template_id).toBe('custom_poster')
  expect(brief.poster?.exact_copy).toContain('夏夜开杆')
  expect(brief.poster?.exact_copy).toContain('到店一起玩')
  expect(brief.visual_direction.composition).not.toContain('经营目标')
  expect(compileProviderPrompt(brief, 'generate').prompt).not.toContain('经营目标')
})

test('poster categories are explicit shortcuts and never inferred from assistant wording', () => {
  const freeform = compileImageBrief({
    prompt: '做一张助教招聘海报，画面用我上传的照片，标题写「周末兼职」',
    scene: 'poster',
  })
  expect(freeform.poster?.template_id).toBe('custom_poster')
  expect(freeform.visual_direction.subject).toContain('助教招聘海报')
  expect(JSON.stringify(freeform)).not.toContain('运营逻辑')

  const explicit = compileImageBrief({
    prompt: '做一张招聘海报，具体内容按我填写的信息',
    scene: 'poster',
    sceneTemplateId: 'recruitment_role',
  })
  expect(explicit.poster?.template_id).toBe('recruitment_role')
  expect(explicit.understanding).toContain('招聘/岗位')
})

test('freeform poster does not inject billiards, store activity or unused business regions', () => {
  const brief = compileImageBrief({ prompt: '夏日音乐节的抽象艺术海报，不要任何文字' })
  const prompt = compileProviderPrompt(brief, 'generate').prompt

  expect(brief.poster?.template_id).toBe('custom_poster')
  expect(brief.poster?.reserved_regions).toEqual([])
  expect(brief.must_preserve).toEqual([])
  expect(brief.understanding).not.toContain('门店活动')
  expect(prompt).not.toContain('台球房')
  expect(prompt).not.toContain('门店活动')
  expect(brief.visual_direction.composition).not.toContain('价格')
  expect(brief.visual_direction.composition).not.toContain('二维码')
  expect(prompt).not.toContain('经营目标')
  expect(prompt).toContain('夏日音乐节的抽象艺术海报，不要任何文字')
})

test('poster controls reserve only facts and assets explicitly supplied by the user', () => {
  const brief = compileImageBrief({
    prompt: '海边音乐节海报',
    sceneTemplateId: 'custom_poster',
    posterText: { title: '夏日声浪', price: '39.9 元' },
  })

  expect(brief.poster?.reserved_regions).toEqual(['title', 'price'])
  expect(brief.must_preserve).toEqual(['用户明确提供的精确文字由确定性文字层排版'])
  expect(brief.visual_direction.composition).toContain('标题、价格')
  expect(brief.visual_direction.composition).not.toContain('Logo')
  expect(brief.visual_direction.composition).not.toContain('二维码')
})

test('a poster topic is not guessed to be exact title or CTA copy', () => {
  const brief = compileImageBrief({ prompt: '做一张海边音乐节海报，画面留出扫码区域但不要任何文字' })

  expect(brief.poster?.title).toBe('')
  expect(brief.poster?.cta).toBe('')
  expect(brief.poster?.exact_copy).toEqual([])
  expect(brief.poster?.reserved_regions).toEqual([])
})

test('poster reference images remain direct image conditions without unrelated brand instructions', () => {
  const brief = compileImageBrief({
    prompt: '参考这张图的构图，生成一张夏日音乐节海报',
    referenceAssets: [{ asset_id: 'poster_reference', role: 'style_reference' }],
  })
  const prompt = compileSeedreamPrompt(brief)

  expect(brief.reference_assets).toEqual([{ asset_id: 'poster_reference', role: 'style_reference' }])
  expect(prompt).toContain('以已上传参考图作为图像条件')
  expect(prompt).not.toContain('不重绘 Logo 或二维码')
})

test('GPT freeform poster has no portrait identity preserve block', () => {
  const userRequest = '电影感的音乐节海报，画面中有朋友一起跳舞，不要任何文字'
  const brief = compileImageBrief({ prompt: userRequest })
  const prompt = compileProviderPrompt(brief, 'generate').prompt

  expect(routeImageBrief(brief)).toBe('gpt_image_2')
  expect(prompt).not.toContain('Preserve:')
  expect(prompt).not.toContain('identity and natural details')
  expect(prompt).not.toContain('Do not add people')
  expect(prompt).toContain(userRequest)
  expect(prompt).toContain('visible text, gibberish, watermarks')
})

test('authorized everyday photo compilation keeps image roles and natural-photo boundary', () => {
  const brief = compileImageBrief({
    prompt: '用这张助教实拍照片优化得更好看，换成球房背景和黑色球服',
    scene: 'portrait',
    referenceAssets: [{ asset_id: 'asset_primary', role: 'identity_primary' }],
    portraitConsent: true,
  })
  expect(brief.portrait?.primary_reference_asset_id).toBe('asset_primary')
  expect(brief.portrait?.change.join(' ')).toContain('服装')
  expect(brief.portrait?.preserve.join(' ')).toContain('面部')
  expect(brief.portrait?.change.join(' ')).toContain('无明显 AI 感')
  expect(brief.visual_direction.style).toContain('无明显 AI 感')
  expect(brief.understanding).toContain('真人照片优化')
  expect(brief.output_use).toBe('photo')
  expect(routeImageBrief(brief, 'edit')).toBe('gpt_image_2')
  const prompt = compileProviderPrompt(brief, 'edit').prompt
  expect(prompt).toContain('Change only:')
  expect(prompt).toContain('Preserve:')
  expect(prompt).toContain('non-AI-looking')
  expect(prompt).toContain('authorized reference photos')
  expect(prompt).toContain('Do not change anything else.')
  const fallbackPrompt = compileSeedreamPrompt(brief, 'edit')
  expect(fallbackPrompt).toContain('已上传的已授权实拍照片作为图像条件')
  expect(fallbackPrompt).not.toContain('形象照')
  expect(fallbackPrompt).not.toContain('Logo')
  expect(fallbackPrompt).not.toContain('二维码')
})

test('background wording alone does not turn a poster into a portrait task', () => {
  const brief = compileImageBrief({ prompt: '做一张海报，把背景换成雨夜街道', sceneTemplateId: 'custom_poster' })
  expect(brief.scene).toBe('poster')
  expect(brief.reference_assets).toEqual([])
})

test('an identity reference lets an ordinary natural-photo request enter image-to-image portrait flow', () => {
  const brief = compileImageBrief({
    prompt: '调得自然好看一点，不要有明显 AI 感',
    referenceAssets: [{ asset_id: 'person_main', role: 'identity_primary' }],
    portraitAuthorizationConfirmed: true,
  })
  expect(brief.scene).toBe('portrait')
  expect(brief.portrait?.primary_reference_asset_id).toBe('person_main')
  expect(brief.visual_direction.subject).toContain('参考人物')
})
