import { describe, expect, test } from 'bun:test'
import { classifyCompletionJson, generatedPng, hasCompletionJson, isVisualCapacityDrained, parseImagesPerRequest, parseLoadTarget, parsePhases, parseThinkingMode, validatePng } from './vision-real-loadtest'

describe('vision real-loadtest safety guards', () => {
  test('maps the 100 x 10 visual envelope from high to low so failures reveal a lower ceiling', () => {
    expect(parsePhases(undefined, 1_000)).toEqual([1_000, 800, 600, 400, 200, 100, 64, 36, 24, 12, 1])
    expect(parsePhases(undefined, 12)).toEqual([12, 1])
    expect(parsePhases('1,12,36', 100)).toEqual([36, 12, 1])
  })

  test('does not call a phase drained while retained ingress request bytes remain', () => {
    const permitsIdle = {
      capacity: {
        vision: { active: 0, queued: 0 },
        mimo: { active: 0, queued: 0 },
        deepseek: { active: 0, queued: 0 },
        ingress_body: { reservedBytes: 0, maxBytes: 1024 },
      },
    }
    expect(isVisualCapacityDrained(permitsIdle)).toBe(true)
    expect(isVisualCapacityDrained({
      ...permitsIdle,
      capacity: { ...permitsIdle.capacity, ingress_body: { reservedBytes: 1, maxBytes: 1024 } },
    })).toBe(false)
  })

  test('only accepts explicit documented thinking values', () => {
    expect(parseThinkingMode(undefined)).toBeUndefined()
    expect(parseThinkingMode('enabled')).toBe('enabled')
    expect(parseThinkingMode('disabled')).toBe('disabled')
    expect(() => parseThinkingMode('adaptive')).toThrow('--thinking must be enabled or disabled')
  })

  test('keeps a real visual request within the gateway image-count boundary', () => {
    expect(parseImagesPerRequest(undefined)).toBe(1)
    expect(parseImagesPerRequest('2')).toBe(2)
    expect(() => parseImagesPerRequest('0')).toThrow('--images-per-request must be a positive integer')
    expect(() => parseImagesPerRequest('9')).toThrow('--images-per-request must be at most 8')
  })

  test('allows HTTP only for a loopback target and rejects URL token-leak paths', () => {
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
    expect(() => parseLoadTarget('https://gateway.example/gw#token')).toThrow('must not include credentials')
    expect(() => parseLoadTarget('https://gateway.example/gw?')).toThrow('must not include credentials')
    expect(() => parseLoadTarget('https://gateway.example/gw#')).toThrow('must not include credentials')
  })

  test('generates valid distinct PNG bytes even after pixel color values would repeat', () => {
    const first = generatedPng(1)
    const wrapped = generatedPng(257)
    expect(validatePng(first).iendOffset).toBeGreaterThan(8)
    expect(validatePng(wrapped).iendOffset).toBeGreaterThan(8)
    expect(Buffer.from(first).equals(Buffer.from(wrapped))).toBe(false)
    expect(Buffer.from(first).includes(Buffer.from('qf-loadtest\0'))).toBe(true)
    const corrupt = first.slice()
    corrupt[20] = corrupt[20]! ^ 1
    expect(() => validatePng(corrupt)).toThrow('invalid PNG checksum')
  })

  test('requires an actual non-empty chat completion in a successful JSON response', () => {
    expect(hasCompletionJson({ choices: [{ message: { content: 'OK' } }] })).toBe(true)
    expect(hasCompletionJson({ choices: [{ message: { content: '   ' } }] })).toBe(false)
    expect(hasCompletionJson({ choices: [] })).toBe(false)
    expect(hasCompletionJson({ message: { content: 'OK' } })).toBe(false)
  })

  test('distinguishes thinking-only token truncation from a malformed completion without exposing text', () => {
    expect(classifyCompletionJson({ choices: [{ message: { content: 'OK' } }] })).toBe('completed')
    expect(classifyCompletionJson({
      choices: [{ finish_reason: 'length', message: { reasoning_content: 'internal reasoning' } }],
    })).toBe('reasoning_only_truncated')
    expect(classifyCompletionJson({
      choices: [{ finish_reason: 'stop', message: { reasoning_content: 'internal reasoning' } }],
    })).toBe('reasoning_only')
    expect(classifyCompletionJson({ choices: [{ message: { content: '' } }] })).toBe('invalid_completion')
  })
})
