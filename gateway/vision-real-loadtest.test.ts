import { describe, expect, test } from 'bun:test'
import { generatedPng, hasCompletionJson, parseLoadTarget, parsePhases, validatePng } from './vision-real-loadtest'

describe('vision real-loadtest safety guards', () => {
  test('uses a bounded staged default instead of immediately testing the full 100 x 5 burst', () => {
    expect(parsePhases(undefined, 500)).toEqual([1, 4, 8, 12, 24])
    expect(parsePhases(undefined, 12)).toEqual([1, 4, 8, 12])
    expect(parsePhases('1,12,36', 100)).toEqual([1, 12, 36])
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
})
