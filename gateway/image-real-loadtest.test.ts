import { describe, expect, test } from 'bun:test'
import {
  clientIdForTask,
  createImageLoadtestPlan,
  parseLoadTarget,
  runImageLoadtest,
  type ImageLoadtestOptions,
} from './image-real-loadtest'

function options(overrides: Partial<ImageLoadtestOptions> = {}): ImageLoadtestOptions {
  return {
    baseUrl: 'http://127.0.0.1:8799',
    targetOrigin: 'http://127.0.0.1:8799',
    token: 'test-token',
    users: 1,
    windows: 1,
    total: 1,
    mode: 'terminal',
    size: '1024x1024',
    submitConcurrency: 1,
    submitTimeoutMs: 1_000,
    terminalTimeoutMs: 1_000,
    pollFloorMs: 250,
    pollRequestTimeoutMs: 1_000,
    ...overrides,
  }
}

describe('image real-loadtest safety guards', () => {
  test('requires explicit batch acknowledgement and accepts the 100-user × 10-window target', () => {
    expect(() => createImageLoadtestPlan(100, 10, false)).toThrow('confirm-billable-batch')
    expect(createImageLoadtestPlan(100, 10, true)).toEqual({ users: 100, windows: 10, total: 1_000 })
    expect(clientIdForTask(0, 2)).toBe(clientIdForTask(2, 2))
    expect(clientIdForTask(0, 2)).not.toBe(clientIdForTask(1, 2))
  })

  test('permits HTTP only for loopback and rejects URL-embedded credentials or tokens', () => {
    expect(parseLoadTarget('https://gateway.example/gw')).toMatchObject({
      baseUrl: 'https://gateway.example/gw',
      targetOrigin: 'https://gateway.example',
    })
    expect(() => parseLoadTarget('http://39.106.214.21/gw')).toThrow('requires HTTPS')
    expect(() => parseLoadTarget('https://token@gateway.example/gw')).toThrow('must not include credentials')
    expect(() => parseLoadTarget('https://gateway.example/gw?token=secret')).toThrow('must not include credentials')
  })

  test('uses compact metadata polling and requires a persisted output for success', async () => {
    const calls: Array<{ url: string; headers: Headers }> = []
    const events: Array<Record<string, unknown>> = []
    const summary = await runImageLoadtest(options(), {
      fetchImpl: async (input, init) => {
        const url = String(input)
        calls.push({ url, headers: new Headers(init?.headers) })
        if (url.endsWith('/v1/images/tasks')) return Response.json({ task_id: 'task_1' }, { status: 202 })
        if (url.includes('?metadata_only=1')) {
          return Response.json({
            status: 'succeeded',
            metadata_only: true,
            result_available: true,
            output_count: 1,
          })
        }
        throw new Error('unexpected request')
      },
      onEvent: event => events.push(event),
    })
    expect(summary).toMatchObject({ requested: 1, accepted: 1, succeeded: 1, exitCode: 0 })
    expect(calls[1]?.url).toContain('?metadata_only=1')
    expect(calls.every(call => call.headers.get('X-BB-Installation-ID') === 'image-loadtest-user-000')).toBe(true)
    expect(calls.every(call => call.headers.get('X-BB-Provider-Protocol') === 'bb-provider-gateway/1.0')).toBe(true)
    expect(calls.every(call => call.headers.get('X-BB-Data-Egress-Consent') === null)).toBe(true)
    expect(JSON.stringify(events)).not.toContain('test-token')

    const missingOutputCalls: string[] = []
    const missingOutput = await runImageLoadtest(options(), {
      fetchImpl: async (input) => {
        const url = String(input)
        missingOutputCalls.push(url)
        if (url.endsWith('/v1/images/tasks')) return Response.json({ task_id: 'task_2' }, { status: 202 })
        if (url.endsWith('/cancel')) return Response.json({ status: 'succeeded' }, { status: 409 })
        return Response.json({ status: 'succeeded', metadata_only: true, result_available: false, output_count: 0 })
      },
      onEvent: () => {},
    })
    expect(missingOutput).toMatchObject({ succeeded: 0, cleanupAttempted: 1, exitCode: 1 })
    expect(missingOutputCalls.some(url => url.endsWith('/cancel'))).toBe(true)
  })

  test('cleans up accepted tasks after a partial submit and recognizes relay cancelled state', async () => {
    let submits = 0
    const calls: Array<{ url: string; headers: Headers }> = []
    const summary = await runImageLoadtest(options({ windows: 2, total: 2 }), {
      fetchImpl: async (input, init) => {
        const url = String(input)
        calls.push({ url, headers: new Headers(init?.headers) })
        if (url.endsWith('/v1/images/tasks')) {
          submits += 1
          return submits === 1
            ? Response.json({ task_id: 'task-accepted' }, { status: 202 })
            : Response.json({ error: 'queue full' }, { status: 429 })
        }
        if (url.endsWith('/cancel')) return Response.json({ status: 'cancelled' })
        if (url.includes('?metadata_only=1')) {
          return Response.json({ status: 'cancelled', metadata_only: true, result_available: false, output_count: 0 })
        }
        throw new Error('unexpected request')
      },
      onEvent: () => {},
    })
    expect(summary).toMatchObject({ requested: 2, accepted: 1, succeeded: 0, cleanupAttempted: 1, exitCode: 1 })
    expect(calls.some(call => call.url.endsWith('/cancel'))).toBe(true)
    const submitClientIds = calls
      .filter(call => call.url.endsWith('/v1/images/tasks'))
      .map(call => call.headers.get('X-BB-Installation-ID'))
    expect(submitClientIds).toEqual(['image-loadtest-user-000', 'image-loadtest-user-000'])
  })

  test('admission mode reports a full burst only after every accepted task confirms cancellation', async () => {
    const calls: string[] = []
    const events: Array<Record<string, unknown>> = []
    const summary = await runImageLoadtest(options({ mode: 'admission', users: 2, windows: 2, total: 4, submitConcurrency: 4 }), {
      fetchImpl: async input => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/v1/images/tasks')) return Response.json({ task_id: `task-${calls.length}` }, { status: 202 })
        if (url.endsWith('/cancel')) return Response.json({ status: 'cancelled' })
        throw new Error('admission mode must not poll image output')
      },
      onEvent: event => events.push(event),
    })
    expect(summary).toMatchObject({
      mode: 'admission',
      requested: 4,
      accepted: 4,
      succeeded: 4,
      failed: 0,
      cleanupAttempted: 4,
      cleanupConfirmed: 4,
      cleanupFailed: 0,
      exitCode: 0,
    })
    expect(calls.filter(url => url.endsWith('/v1/images/tasks'))).toHaveLength(4)
    expect(calls.filter(url => url.endsWith('/cancel'))).toHaveLength(4)
    expect(calls.some(url => url.includes('metadata_only=1'))).toBe(false)
    expect(events.find(event => event.event === 'image_loadtest_admission_cleanup')).toMatchObject({ attempted: 4, confirmed: 4, failed: 0 })
  })

  test('admission mode fails when an accepted task cancellation does not confirm cancelled state', async () => {
    let submitted = 0
    let cancelled = 0
    const events: Array<Record<string, unknown>> = []
    const summary = await runImageLoadtest(options({ mode: 'admission', windows: 2, total: 2, submitConcurrency: 2 }), {
      fetchImpl: async input => {
        const url = String(input)
        if (url.endsWith('/v1/images/tasks')) {
          submitted += 1
          return Response.json({ task_id: `task-${submitted}` }, { status: 202 })
        }
        if (url.endsWith('/cancel')) {
          cancelled += 1
          return Response.json({ status: cancelled === 1 ? 'cancelled' : 'queued' })
        }
        throw new Error('admission mode must not poll image output')
      },
      onEvent: event => events.push(event),
    })

    expect(summary).toMatchObject({
      mode: 'admission',
      requested: 2,
      accepted: 2,
      cleanupAttempted: 2,
      cleanupConfirmed: 1,
      cleanupFailed: 1,
      exitCode: 1,
    })
    expect(events.find(event => event.event === 'image_loadtest_admission_cleanup')).toMatchObject({
      attempted: 2,
      confirmed: 1,
      failed: 1,
      failureKinds: { cancel_not_confirmed: 1 },
    })
  })

  test('reports p50 and p95 submit latency in the summary and admission events', async () => {
    const events: Array<Record<string, unknown>> = []
    const durations = [10, 20, 30]
    let clock = 0
    let submitted = 0
    const summary = await runImageLoadtest(options({ mode: 'admission', windows: 3, total: 3 }), {
      now: () => clock,
      fetchImpl: async input => {
        const url = String(input)
        if (url.endsWith('/v1/images/tasks')) {
          clock += durations[submitted]!
          submitted += 1
          return Response.json({ task_id: `task-${submitted}` }, { status: 202 })
        }
        if (url.endsWith('/cancel')) return Response.json({ status: 'cancelled' })
        throw new Error('admission mode must not poll image output')
      },
      onEvent: event => events.push(event),
    })

    expect(summary.submitMs).toEqual({ p50: 20, p95: 30 })
    expect(events.find(event => event.event === 'image_loadtest_submitted')).toMatchObject({
      submitMs: { p50: 20, p95: 30 },
    })
    expect(events.find(event => event.event === 'image_loadtest_admission')).toMatchObject({
      submitMs: { p50: 20, p95: 30 },
    })
  })
})
