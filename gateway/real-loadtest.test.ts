import { describe, expect, test } from 'bun:test'
import {
  isSseContentType,
  isCapacityDrained,
  parseLoadTarget,
  parsePhases,
  parseThinkingMode,
  resolveLoadtestThinkingMode,
  sawReasoningInSse,
  shouldContinueAfterFailure,
  SseTerminalDetector,
} from './real-loadtest'

describe('real upstream loadtest thinking-mode guard', () => {
  test('defaults to a high-to-low 1000-window capacity search', () => {
    expect(parsePhases(undefined, 1_000)).toEqual([1_000, 800, 600, 400, 200, 100, 50, 20, 1])
    expect(parsePhases('100,1000,400', 1_000)).toEqual([1_000, 400, 100])
  })

  test('allows only the two documented DeepSeek thinking values', () => {
    expect(parseThinkingMode(undefined)).toBeUndefined()
    expect(parseThinkingMode('enabled')).toBe('enabled')
    expect(parseThinkingMode('disabled')).toBe('disabled')
    expect(() => parseThinkingMode('adaptive')).toThrow('--thinking must be enabled or disabled')
  })

  test('uses enabled thinking by default so the capacity run matches the desktop product path', () => {
    expect(resolveLoadtestThinkingMode(undefined)).toBe('enabled')
    expect(resolveLoadtestThinkingMode('disabled')).toBe('disabled')
  })

  test('requires the sampled pool to fully drain before a phase can be called complete', () => {
    expect(isCapacityDrained({ active: 0, queued: 0 })).toBe(true)
    expect(isCapacityDrained({ active: 1, queued: 0 })).toBe(false)
    expect(isCapacityDrained({ active: 0, queued: 1 })).toBe(false)
    expect(isCapacityDrained(null)).toBe(false)
  })

  test('lets an explicit safety stop win if legacy continuation is also supplied', () => {
    expect(shouldContinueAfterFailure([])).toBe(true)
    expect(shouldContinueAfterFailure(['--continue-after-failure'])).toBe(true)
    expect(shouldContinueAfterFailure(['--stop-after-failure'])).toBe(false)
    expect(shouldContinueAfterFailure(['--stop-after-failure', '--continue-after-failure'])).toBe(false)
  })

  test('counts only the reasoning protocol field and never parses or emits its value', () => {
    expect(sawReasoningInSse('data: {"choices":[{"delta":{"reasoning_content":"private"}}]}')).toBe(true)
    expect(sawReasoningInSse('data: {"choices":[{"delta":{"content":"OK"}}]}')).toBe(false)
  })

  test('keeps app tokens off plaintext external and URL-embedded targets', () => {
    expect(parseLoadTarget('https://gateway.example/private/gw')).toMatchObject({
      baseUrl: 'https://gateway.example/private/gw',
      targetOrigin: 'https://gateway.example',
    })
    expect(parseLoadTarget('http://127.0.0.1:8799')).toMatchObject({
      baseUrl: 'http://127.0.0.1:8799',
      targetOrigin: 'http://127.0.0.1:8799',
    })
    expect(() => parseLoadTarget('http://39.106.214.21/gw')).toThrow('requires HTTPS')
    expect(() => parseLoadTarget('https://token@gateway.example/gw')).toThrow('must not include credentials')
    expect(() => parseLoadTarget('https://gateway.example/gw?token=secret')).toThrow('must not include credentials')
    expect(() => parseLoadTarget('https://gateway.example/gw#token')).toThrow('must not include credentials')
  })

  test('requires a framed exact terminal SSE event and an SSE content type', () => {
    const exact = new SseTerminalDetector()
    exact.push('data: {"choices":[{"delta":{"content":"OK"}}]}\n\n')
    exact.push('data: [DO')
    exact.push('NE]\r\n\r\n')
    expect(exact.hasTerminalDone()).toBe(true)

    const embeddedMarker = new SseTerminalDetector()
    embeddedMarker.push('data: {"choices":[{"delta":{"content":"data: [DONE]"}}]}\n\n')
    expect(embeddedMarker.hasTerminalDone()).toBe(false)

    const noEventBoundary = new SseTerminalDetector()
    noEventBoundary.push('data: [DONE]')
    expect(noEventBoundary.hasTerminalDone()).toBe(false)

    const dataAfterDone = new SseTerminalDetector()
    dataAfterDone.push('data: [DONE]\n\ndata: {"choices":[]}\n\n')
    expect(dataAfterDone.hasTerminalDone()).toBe(false)

    expect(isSseContentType('Text/Event-Stream; charset=utf-8')).toBe(true)
    expect(isSseContentType('application/json')).toBe(false)
    expect(isSseContentType(null)).toBe(false)
  })
})
