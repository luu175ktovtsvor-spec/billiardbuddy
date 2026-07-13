import { expect, test } from 'bun:test'
import { detectPortraitIntent } from './portraitGate'

test('a role mentioned in a poster does not turn a non-person reference into photo editing', () => {
  const intent = detectPortraitIntent({
    prompt: '做一张助教招聘海报，参考这张门店环境图的配色',
    hasInputImage: true,
    inputFaceDetected: false,
  })

  expect(intent.isPortrait).toBe(false)
  expect(intent.keywordHit).toBe(false)
})

test('an everyday photo-edit request still enters the authorized person-photo flow', () => {
  const intent = detectPortraitIntent({
    prompt: '把这张随手拍修得自然好看一点',
    hasInputImage: true,
    inputFaceDetected: null,
  })

  expect(intent.isPortrait).toBe(true)
  expect(intent.keywordHit).toBe(true)
})
