import { expect, test } from 'bun:test'
import type { Model } from '../types/model'
import { inspectPortraitResult } from './imageQC'

test('portrait QC keeps defects and identity consistency scoped to each candidate', async () => {
  const replies = [
    JSON.stringify({
      images: [
        { hands_ok: true, face_ok: true, limbs_ok: true, face_count: 1, over_beautified: false, realistic: true, unwanted_text: false },
        { hands_ok: false, face_ok: true, limbs_ok: true, face_count: 1, over_beautified: false, realistic: true, unwanted_text: false },
        { hands_ok: true, face_ok: true, limbs_ok: true, face_count: 1, over_beautified: false, realistic: true, unwanted_text: false },
      ],
    }),
    JSON.stringify({ images: [{ status: 'preserved' }, { status: 'preserved' }, { status: 'uncertain' }] }),
  ]
  const model: Model = {
    async step() {
      return { kind: 'final', text: replies.shift() ?? '{}' }
    },
  }
  const image = { base64: 'AA==', mediaType: 'image/png' as const, width: 1024, height: 1024 }
  const result = await inspectPortraitResult([image, image, image], { model, reference: image })

  expect(result.candidates).toHaveLength(3)
  expect(result.candidates[0]).toMatchObject({ status: 'passed', consistencyStatus: 'preserved', warnings: [] })
  expect(result.candidates[1]?.status).toBe('risk')
  expect(result.candidates[1]?.warnings.join('')).toContain('手部疑似异常')
  expect(result.candidates[2]?.status).toBe('risk')
  expect(result.candidates[2]?.consistencyStatus).toBe('uncertain')
})
