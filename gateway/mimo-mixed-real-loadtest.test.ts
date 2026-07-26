import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MEDIA_SLOTS,
  DEFAULT_VISION_SLOTS,
  isMiMoCapacityDrained,
  parseLoadTarget,
  parseMixedShape,
  uniquePngDataUrl,
} from './mimo-mixed-real-loadtest'

describe('controlled MiMo mixed real-loadtest guards', () => {
  test('defaults to the one bounded 48 media plus 16 visual reservation wave', () => {
    expect(parseMixedShape(undefined, undefined)).toEqual({
      mediaSlots: DEFAULT_MEDIA_SLOTS,
      visionSlots: DEFAULT_VISION_SLOTS,
      totalSlots: 64,
    })
    expect(parseMixedShape('40', '12')).toEqual({ mediaSlots: 40, visionSlots: 12, totalSlots: 52 })
    expect(() => parseMixedShape('49', '16')).toThrow('must not exceed 64')
    expect(() => parseMixedShape('48', '17')).toThrow('between 1 and 16')
  })

  test('keeps app tokens off plaintext external and URL-embedded targets', () => {
    expect(parseLoadTarget('https://gateway.example/gw')).toMatchObject({
      baseUrl: 'https://gateway.example/gw',
      targetOrigin: 'https://gateway.example',
    })
    expect(parseLoadTarget('http://127.0.0.1:8799')).toMatchObject({
      baseUrl: 'http://127.0.0.1:8799',
    })
    expect(() => parseLoadTarget('http://39.106.214.21/gw')).toThrow('requires HTTPS')
    expect(() => parseLoadTarget('https://token@gateway.example/gw')).toThrow('must not include credentials')
    expect(() => parseLoadTarget('https://gateway.example/gw?token=secret')).toThrow('must not include credentials')
  })

  test('generates valid distinct PNG data URLs for every bridge request', () => {
    const first = uniquePngDataUrl(100, 0)
    const next = uniquePngDataUrl(100, 1)
    expect(first.startsWith('data:image/png;base64,')).toBe(true)
    expect(next.startsWith('data:image/png;base64,')).toBe(true)
    expect(first).not.toBe(next)
  })

  test('requires every authenticated MiMo capacity view to explicitly drain before passing', () => {
    const drained = {
      capacity: {
        mimo: { active: 0, queued: 0 },
        mimo_media: { active: 0, queued: 0 },
        mimo_total: { active: 0, queued: 0 },
        vision: { active: 0, queued: 0 },
      },
    }
    expect(isMiMoCapacityDrained(drained)).toBe(true)
    expect(isMiMoCapacityDrained({
      ...drained,
      capacity: { ...drained.capacity, mimo_total: { active: 1, queued: 0 } },
    })).toBe(false)
    expect(isMiMoCapacityDrained({
      ...drained,
      capacity: { ...drained.capacity, vision: { active: 0, queued: 1 } },
    })).toBe(false)
    expect(isMiMoCapacityDrained({
      capacity: {
        mimo: { active: 0, queued: 0 },
        mimo_media: { active: 0, queued: 0 },
        mimo_total: { active: 0, queued: 0 },
      },
    })).toBe(false)
    expect(isMiMoCapacityDrained(null)).toBe(false)
  })

})
