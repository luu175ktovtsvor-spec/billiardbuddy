import { expect, test } from 'bun:test'
import type { StudioImage } from '../../api/studio'
import {
  chooseThreeCandidates,
  defaultReferenceRole,
  dimensionFromRatio,
  friendlyImageError,
  friendlyImageStage,
  imagePassesCandidateGate,
  imageReviewLines,
  normalizeColorInput,
  portraitCandidateHasHardRisk,
  posterBrandImageLayers,
  posterTextLayers,
  referenceRoleOptions,
  reviewFromRecord,
  sourceForEdit,
  sourceForUpscale,
  textAlignFrom,
  versionKindLabel,
} from './imageWorkbenchModel'

function studioImage(fields: Record<string, unknown>): StudioImage {
  return { generation_id: 'g1', poster_url: '/uploads/a.png', ...fields } as unknown as StudioImage
}

test('候选闸门：海报看硬闸标记，人像要求推荐且未漂移', () => {
  expect(imagePassesCandidateGate(studioImage({ poster_hard_gate_passed: true }), 'poster_text')).toBe(true)
  expect(imagePassesCandidateGate(studioImage({}), 'poster_text')).toBe(false)
  expect(imagePassesCandidateGate(studioImage({ portrait_quality_state: 'recommended', portrait_consistency_status: 'preserved' }), 'portrait')).toBe(true)
  expect(imagePassesCandidateGate(studioImage({ portrait_quality_state: 'recommended', portrait_consistency_status: 'drifted' }), 'portrait')).toBe(false)
})

test('人像硬风险：blocked/risk/漂移三种都算', () => {
  expect(portraitCandidateHasHardRisk(studioImage({ portrait_quality_state: 'blocked' }))).toBe(true)
  expect(portraitCandidateHasHardRisk(studioImage({ portrait_quality_state: 'risk' }))).toBe(true)
  expect(portraitCandidateHasHardRisk(studioImage({ portrait_consistency_status: 'drifted' }))).toBe(true)
  expect(portraitCandidateHasHardRisk(studioImage({ portrait_quality_state: 'recommended' }))).toBe(false)
})

test('挑三张：过闸的排前面，最多三张，不改原数组', () => {
  const pass = studioImage({ generation_id: 'p', poster_hard_gate_passed: true })
  const fail1 = studioImage({ generation_id: 'f1' })
  const fail2 = studioImage({ generation_id: 'f2' })
  const fail3 = studioImage({ generation_id: 'f3' })
  const input = [fail1, fail2, fail3, pass]
  const picked = chooseThreeCandidates(input, 'poster_text')
  expect(picked).toHaveLength(3)
  expect(picked[0]!.generation_id).toBe('p')
  expect(input[0]!.generation_id).toBe('f1')
})

test('比例转尺寸：长边 1365、短边不低于 512，坏输入回默认', () => {
  expect(dimensionFromRatio('16:9')).toEqual({ width: 1365, height: 768 })
  expect(dimensionFromRatio('9:16')).toEqual({ width: 768, height: 1365 })
  expect(dimensionFromRatio('2:5').width).toBe(546)
  expect(dimensionFromRatio('坏值')).toEqual({ width: 1024, height: 1365 })
})

test('海报固定文字层：空字段被过滤，文字去空格，居中白字', () => {
  const layers = posterTextLayers(1000, 1400, { title: ' 开业大酬宾 ', offer: '', price: '99 元', date: '', address: '', phone: '', cta: '' })
  expect(layers.map(layer => layer.text)).toEqual(['开业大酬宾', '99 元'])
  for (const layer of layers) {
    expect(layer.text_align).toBe('center')
    expect(layer.fill).toBe('#ffffff')
    expect(layer.x).toBe(100)
  }
})

test('品牌图层：logo 限宽 18%/高 12% 等比缩放，二维码贴右下角正方形', () => {
  const logo = { asset_id: 'logo1', kind: 'reference', url: '/uploads/logo.png', width: 400, height: 400, created_at: '' } as const
  const qr = { asset_id: 'qr1', kind: 'reference', url: '/uploads/qr.png', width: 300, height: 300, created_at: '' } as const
  const layers = posterBrandImageLayers(1000, 1000, logo, qr)
  expect(layers).toHaveLength(2)
  const [logoLayer, qrLayer] = layers
  expect(logoLayer!.type).toBe('logo')
  expect(logoLayer!.width).toBeLessThanOrEqual(180)
  expect(logoLayer!.height).toBeLessThanOrEqual(120)
  expect(qrLayer!.type).toBe('qrcode')
  expect(qrLayer!.width).toBe(qrLayer!.height)
  expect(qrLayer!.x + qrLayer!.width).toBeCloseTo(960)
  expect(posterBrandImageLayers(1000, 1000, null, null)).toEqual([])
})

test('编辑与超分请求：始终用版本的本地 URL 作为底图', () => {
  const version = { id: 'v1', image_url: '/uploads/v1.png', ratio: '3:4' } as never
  expect(sourceForEdit(version, '换背景', 'edit_content', 'standard')).toMatchObject({
    source_image_path: '/uploads/v1.png',
    description: '换背景',
    intent: 'edit_content',
    quality: 'standard',
  })
  expect(sourceForUpscale(version)).toEqual({ source_image_path: '/uploads/v1.png', scale: 4 })
})

test('评审解析：合法枚举收录、非法丢弃、风险信息合并', () => {
  const review = reviewFromRecord({
    poster_quality_state: 'risk',
    portrait_quality_state: '乱值',
    poster_hard_gate_passed: false,
    image_engine_warning: '引擎提醒',
    risk_messages: ['提醒A', 42, ''],
    input_fidelity_requested: 'high',
    input_fidelity_status: 'unsupported',
  })
  expect(review.poster_quality_state).toBe('risk')
  expect(review.portrait_quality_state).toBeUndefined()
  expect(review.poster_hard_gate_passed).toBe(false)
  expect(review.risk_messages).toEqual(['引擎提醒', '提醒A'])
  expect(review.input_fidelity).toEqual({ input_fidelity_requested: 'high', input_fidelity_status: 'unsupported' })
})

test('使用前检查文案：空评审无行，各状态翻成大白话', () => {
  expect(imageReviewLines(undefined)).toEqual([])
  const lines = imageReviewLines({
    portrait_user_confirmed: false,
    poster_quality_state: 'recommended',
    commercial_ready: true,
    risk_messages: ['海报硬闸未通过'],
  })
  expect(lines).toContain('画面检查：未发现明显问题')
  expect(lines).toContain('发布前仍需确认文字、价格和素材授权')
  expect(lines.some(line => line.includes('画面检查未通过'))).toBe(true)
  expect(lines.join('')).not.toMatch(/硬闸/)
})

test('阶段文案：内部阶段翻成用户语言，空值回退', () => {
  expect(friendlyImageStage(undefined, '正在生成图片…')).toBe('正在生成图片…')
  expect(friendlyImageStage('排队中', '兜底')).toBe('正在等待处理…')
  expect(friendlyImageStage('图片已生成，正在保存到本机作品库。', '兜底')).toBe('正在保存图片…')
  expect(friendlyImageStage('超分处理', '兜底')).toBe('正在生成高清图片…')
})

test('错误文案：网关/端点类内部字眼不外露', () => {
  expect(friendlyImageError(new Error('provider timeout'), '生成失败')).toBe('处理超时，请重试')
  expect(friendlyImageError(new Error('gateway 网关 500'), '生成失败')).toBe('生成失败，请稍后重试')
  expect(friendlyImageError(new Error('已取消'), '生成失败')).toBe('已取消')
  expect(friendlyImageError(new Error('换个描述再试试'), '生成失败')).toBe('换个描述再试试')
  expect(friendlyImageError({}, '生成失败')).toBe('生成失败')
})

test('小工具：颜色归一、对齐归一、版本名、参考图角色', () => {
  expect(normalizeColorInput('#0A84FF')).toBe('#0A84FF')
  expect(normalizeColorInput('red')).toBe('#ffffff')
  expect(textAlignFrom('left')).toBe('left')
  expect(textAlignFrom('bogus')).toBe('center')
  expect(versionKindLabel('inpaint')).toBe('局部修改')
  expect(defaultReferenceRole('portrait', 0)).toBe('identity_primary')
  expect(defaultReferenceRole('portrait', 1)).toBe('identity_supporting')
  expect(defaultReferenceRole('poster_text', 0)).toBe('environment_reference')
  expect(referenceRoleOptions('portrait')).toHaveLength(2)
  expect(referenceRoleOptions('poster_text')).toHaveLength(5)
})
