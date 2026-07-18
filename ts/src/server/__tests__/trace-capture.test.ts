import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import {
  captureResponseTraceSnapshot,
  clearTraceCaptureStateForTests,
  createTraceCallId,
  createTraceBodySnapshot,
  isTraceCaptureEnabled,
  readTraceCaptureSettings,
  readResponseTraceSnapshot,
  shouldCaptureApiTrace,
  traceCaptureService,
  updateTraceCaptureSettings,
} from '../services/traceCaptureService.js'
import { createDumpPromptsFetch } from '../../services/api/dumpPrompts.js'

let tmpDir: string
let originalConfigDir: string | undefined
let originalTraceApiCalls: string | undefined
let originalEntrypoint: string | undefined

async function waitForTrace(
  sessionId: string,
  predicate: (trace: Awaited<ReturnType<typeof traceCaptureService.getSessionTrace>>) => boolean,
) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const trace = await traceCaptureService.getSessionTrace(sessionId)
    if (predicate(trace)) return trace
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  return traceCaptureService.getSessionTrace(sessionId)
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'trace-capture-'))
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  originalTraceApiCalls = process.env.BB_TRACE_API_CALLS
  originalEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT
  process.env.CLAUDE_CONFIG_DIR = tmpDir
  delete process.env.BB_TRACE_API_CALLS
  delete process.env.CLAUDE_CODE_ENTRYPOINT
  clearTraceCaptureStateForTests()
  await updateTraceCaptureSettings({ enabled: true })
})

afterEach(async () => {
  clearTraceCaptureStateForTests()
  if (originalConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  }
  if (originalTraceApiCalls === undefined) {
    delete process.env.BB_TRACE_API_CALLS
  } else {
    process.env.BB_TRACE_API_CALLS = originalTraceApiCalls
  }
  if (originalEntrypoint === undefined) {
    delete process.env.CLAUDE_CODE_ENTRYPOINT
  } else {
    process.env.CLAUDE_CODE_ENTRYPOINT = originalEntrypoint
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('trace capture service', () => {
  test('defaults to disabled for missing, malformed, and incomplete managed settings', async () => {
    const settingsPath = path.join(tmpDir, 'billiardbuddy', 'settings.json')
    await fs.rm(settingsPath, { force: true })

    expect((await readTraceCaptureSettings()).enabled).toBe(false)
    expect(isTraceCaptureEnabled()).toBe(false)
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    expect(shouldCaptureApiTrace()).toBe(false)

    await fs.mkdir(path.dirname(settingsPath), { recursive: true })
    await fs.writeFile(settingsPath, '{ malformed json', 'utf-8')
    expect((await readTraceCaptureSettings()).enabled).toBe(false)
    expect(isTraceCaptureEnabled()).toBe(false)

    await fs.writeFile(settingsPath, JSON.stringify({ unrelatedSetting: true }), 'utf-8')
    expect((await readTraceCaptureSettings()).enabled).toBe(false)
    expect(isTraceCaptureEnabled()).toBe(false)

    await fs.writeFile(settingsPath, JSON.stringify({ traceCapture: {} }), 'utf-8')
    expect((await readTraceCaptureSettings()).enabled).toBe(false)

    await fs.writeFile(settingsPath, JSON.stringify({ traceCapture: { enabled: 'true' } }), 'utf-8')
    expect((await readTraceCaptureSettings()).enabled).toBe(false)
  })

  test('honors explicit managed trace capture settings', async () => {
    await updateTraceCaptureSettings({ enabled: false })
    expect((await readTraceCaptureSettings()).enabled).toBe(false)
    expect(isTraceCaptureEnabled()).toBe(false)

    await updateTraceCaptureSettings({ enabled: true })
    expect((await readTraceCaptureSettings()).enabled).toBe(true)
    expect(isTraceCaptureEnabled()).toBe(true)
    process.env.CLAUDE_CODE_ENTRYPOINT = 'claude-desktop'
    expect(shouldCaptureApiTrace()).toBe(true)
  })

  test('lets BB_TRACE_API_CALLS override managed trace capture settings', async () => {
    await updateTraceCaptureSettings({ enabled: false })
    process.env.BB_TRACE_API_CALLS = '1'
    expect(isTraceCaptureEnabled()).toBe(true)
    expect(shouldCaptureApiTrace()).toBe(true)

    await updateTraceCaptureSettings({ enabled: true })
    process.env.BB_TRACE_API_CALLS = 'false'
    expect(isTraceCaptureEnabled()).toBe(false)
    expect(shouldCaptureApiTrace()).toBe(false)
  })

  test('stores session scoped API calls with redacted headers and capped bodies', async () => {
    const body = {
      model: 'deepseek-v4-pro',
      api_key: 'sk-body-secret',
      messages: [
        { role: 'user', content: 'explain the failed provider response' },
      ],
      padding: 'x'.repeat(250_000),
    }

    await traceCaptureService.recordCall({
      sessionId: 'session-trace-1',
      source: 'proxy',
      querySource: 'repl_main_thread',
      provider: {
        id: 'provider-deepseek',
        name: 'DeepSeek',
        format: 'openai_chat',
      },
      model: 'deepseek-v4-pro',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.047Z',
      durationMs: 47,
      request: {
        method: 'POST',
        url: 'https://api.deepseek.com/v1/chat/completions',
        headers: {
          Authorization: 'Bearer sk-header-secret',
          'Content-Type': 'application/json',
        },
        body,
      },
      response: {
        status: 200,
        headers: {
          'x-request-id': 'req-742',
        },
        body: {
          id: 'chatcmpl-742',
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 31, completion_tokens: 7 },
        },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-trace-1')

    expect(trace.summary.apiCalls).toBe(1)
    expect(trace.summary.failedCalls).toBe(0)
    expect(trace.summary.totalDurationMs).toBe(47)
    expect(trace.summary.totalInputTokens).toBe(31)
    expect(trace.summary.totalOutputTokens).toBe(7)
    expect(trace.summary.models).toEqual([{ model: 'deepseek-v4-pro', calls: 1 }])
    expect(trace.calls[0].request.headers.Authorization).toBe('[redacted]')
    expect(trace.calls[0].request.body.preview).toContain('explain the failed provider response')
    expect(trace.calls[0].request.body.preview).not.toContain('sk-body-secret')
    expect(trace.calls[0].request.body.preview.length).toBe(240_000)
    expect(trace.calls[0].request.body.bytes).toBeGreaterThan(240_000)
    expect(trace.calls[0].request.body.truncated).toBe(true)
    expect(trace.calls[0].response.body.preview).toContain('chatcmpl-742')
    expect(trace.calls[0].usage).toEqual({ inputTokens: 31, outputTokens: 7 })
  })

  test('builds stable body snapshots without throwing on non-json input', () => {
    const snapshot = createTraceBodySnapshot('plain text response', { maxPreviewChars: 20 })

    expect(snapshot.contentType).toBe('text')
    expect(snapshot.preview).toBe('plain text response')
    expect(snapshot.truncated).toBe(false)
    expect(snapshot.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  test('redacts secret token keys while preserving token-count fields', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-redact-boundary',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.050Z',
      durationMs: 50,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: {
          model: 'claude-fable-5',
          max_tokens: 4096,
          access_token: 'super-secret-value',
          refresh_token: 'another-secret-value',
        },
      },
      response: {
        status: 200,
        body: {
          id: 'msg-redact-boundary',
          usage: { input_tokens: 12, output_tokens: 34 },
        },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-redact-boundary')
    const requestPreview = trace.calls[0].request.body.preview

    expect(requestPreview).toContain('"max_tokens": 4096')
    expect(requestPreview).not.toContain('super-secret-value')
    expect(requestPreview).not.toContain('another-secret-value')
    expect(trace.calls[0].response?.body.preview).toContain('"input_tokens": 12')
    expect(trace.calls[0].usage).toEqual({ inputTokens: 12, outputTokens: 34 })
  })

  test('redacts raw base64 out of anthropic image blocks while keeping size metadata', () => {
    const base64Payload = Buffer.from('identifiable-anthropic-image-fixture').toString('base64')
    const snapshot = createTraceBodySnapshot({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: base64Payload },
    })

    expect(snapshot.preview).not.toContain(base64Payload)
    const parsed = JSON.parse(snapshot.preview) as {
      type: string
      source: { media_type: string; data: string; bytes: number; sha256: string; redacted: string }
    }
    expect(parsed.source.media_type).toBe('image/png')
    expect(parsed.source.bytes).toBe(Buffer.from(base64Payload, 'base64').length)
    expect(parsed.source.redacted).toBe('image-base64')
    expect(parsed.source.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(parsed.source.data).not.toContain(base64Payload)
  })

  test('redacts nested image blocks inside tool_result content while preserving sibling text', () => {
    const base64Payload = Buffer.from('identifiable-tool-result-image-fixture').toString('base64')
    const snapshot = createTraceBodySnapshot({
      type: 'tool_result',
      tool_use_id: 'toolu_read_1',
      content: [
        { type: 'text', text: 'screenshot.png (image/png)' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64Payload } },
      ],
    })

    expect(snapshot.preview).toContain('screenshot.png (image/png)')
    expect(snapshot.preview).not.toContain(base64Payload)
    const parsed = JSON.parse(snapshot.preview) as {
      content: Array<{ type: string; text?: string; source?: { media_type: string; data: string } }>
    }
    expect(parsed.content[0].text).toBe('screenshot.png (image/png)')
    expect(parsed.content[1].source?.media_type).toBe('image/png')
    expect(parsed.content[1].source?.data).not.toContain(base64Payload)
  })

  test('redacts base64 payloads out of openai image_url data URIs while keeping media type', () => {
    const base64Payload = Buffer.from('identifiable-openai-image-fixture').toString('base64')
    const snapshot = createTraceBodySnapshot({
      type: 'image_url',
      image_url: { url: `data:image/jpeg;base64,${base64Payload}` },
    })

    expect(snapshot.preview).not.toContain(base64Payload)
    const parsed = JSON.parse(snapshot.preview) as {
      image_url: { url: string; media_type: string; bytes: number; redacted: string }
    }
    expect(parsed.image_url.media_type).toBe('image/jpeg')
    expect(parsed.image_url.redacted).toBe('image-base64')
    expect(parsed.image_url.url).not.toContain(base64Payload)
  })

  test('redacts small image payloads that sit far below the preview truncation threshold', () => {
    const base64Payload = Buffer.from('tiny').toString('base64')
    const snapshot = createTraceBodySnapshot({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: base64Payload },
    })

    expect(snapshot.truncated).toBe(false)
    expect(snapshot.preview).not.toContain(base64Payload)
    expect(snapshot.preview).toContain('"redacted": "image-base64"')
  })

  test('redacts image data URIs embedded in plain-text (non-JSON) trace bodies', () => {
    const base64Payload = Buffer.from('identifiable-plain-text-image-fixture').toString('base64')
    const rawText = `event: content_block_delta\ndata: inline image data:image/png;base64,${base64Payload} end`
    const snapshot = createTraceBodySnapshot(rawText)

    expect(snapshot.contentType).toBe('text')
    expect(snapshot.preview).not.toContain(base64Payload)
    expect(snapshot.preview).toContain('base64 redacted media=image/png')
  })

  test('leaves plain text, tool_call, and reasoning fields unchanged by image redaction', () => {
    const snapshot = createTraceBodySnapshot({
      messages: [
        { role: 'user', content: 'hello there, no images here' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'plain answer text' },
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } },
            { type: 'thinking', thinking: 'reasoning about the answer' },
          ],
        },
      ],
    })

    expect(snapshot.preview).toContain('hello there, no images here')
    expect(snapshot.preview).toContain('plain answer text')
    expect(snapshot.preview).toContain('"command": "ls"')
    expect(snapshot.preview).toContain('reasoning about the answer')
    expect(snapshot.preview).not.toContain('redacted')
  })

  test('still redacts bearer tokens alongside image blocks in the same body (no regression)', () => {
    const base64Payload = Buffer.from('identifiable-bearer-combo-fixture').toString('base64')
    const snapshot = createTraceBodySnapshot({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: base64Payload },
      note: 'Authorization: Bearer sk-super-secret-token-value',
    })

    expect(snapshot.preview).not.toContain(base64Payload)
    expect(snapshot.preview).not.toContain('sk-super-secret-token-value')
    expect(snapshot.preview).toContain('Bearer [redacted]')
  })

  test('captures streamed response bodies up to 1MB before truncating', async () => {
    const chunk = 'a'.repeat(64 * 1024)
    const makeResponse = (chunkCount: number) => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let index = 0; index < chunkCount; index++) {
            controller.enqueue(new TextEncoder().encode(chunk))
          }
          controller.close()
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    )

    const midSized = await readResponseTraceSnapshot(makeResponse(6))
    expect(midSized.bytes).toBe(6 * 64 * 1024)
    expect(midSized.sha256).toBe(createHash('sha256').update(chunk.repeat(6)).digest('hex'))
    expect(midSized.preview.length).toBe(240_000)
    expect(midSized.truncated).toBe(true)

    const oversized = await readResponseTraceSnapshot(makeResponse(17))
    expect(oversized.bytes).toBe(1024 * 1024)
    expect(oversized.truncated).toBe(true)
  })

  test('extracts per-call usage from non-streaming anthropic JSON responses', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-usage-json',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:01.000Z',
      durationMs: 1000,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: { model: 'claude-fable-5', messages: [{ role: 'user', content: 'usage me' }] },
      },
      response: {
        status: 200,
        body: {
          id: 'msg-usage-json',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 1200,
            output_tokens: 350,
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 45,
          },
        },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-usage-json')

    expect(trace.calls[0].usage).toEqual({
      inputTokens: 1200,
      outputTokens: 350,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: 45,
    })
    expect(trace.summary.totalInputTokens).toBe(1200)
    expect(trace.summary.totalOutputTokens).toBe(350)
  })

  test('extracts per-call usage from streaming SSE previews by merging message_start and message_delta', async () => {
    const sseBody = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_stream","model":"claude-fable-5","usage":{"input_tokens":2500,"output_tokens":2,"cache_read_input_tokens":1800,"cache_creation_input_tokens":90}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":640}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
    ].join('\n')

    await traceCaptureService.recordCall({
      sessionId: 'session-usage-sse',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:02.000Z',
      durationMs: 2000,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: { model: 'claude-fable-5', stream: true },
      },
      response: {
        status: 200,
        body: sseBody,
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-usage-sse')

    expect(trace.calls[0].usage).toEqual({
      inputTokens: 2500,
      outputTokens: 640,
      cacheReadInputTokens: 1800,
      cacheCreationInputTokens: 90,
    })
    expect(trace.summary.totalInputTokens).toBe(2500)
    expect(trace.summary.totalOutputTokens).toBe(640)
  })

  test('extracts per-call usage from the anthropic side of proxy response wrappers', async () => {
    await traceCaptureService.recordCall({
      sessionId: 'session-usage-proxy',
      source: 'proxy',
      model: 'deepseek-v4-pro',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:01.500Z',
      durationMs: 1500,
      request: {
        method: 'POST',
        url: 'https://api.deepseek.com/v1/chat/completions',
        body: {
          anthropic: { model: 'deepseek-v4-pro' },
          upstream: { model: 'deepseek-chat' },
        },
      },
      response: {
        status: 200,
        body: {
          upstream: { usage: { prompt_tokens: 999, completion_tokens: 111 } },
          anthropic: {
            id: 'msg-proxy-usage',
            usage: {
              input_tokens: 77,
              output_tokens: 33,
              cache_read_input_tokens: 5,
              cache_creation_input_tokens: 0,
            },
          },
        },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-usage-proxy')

    expect(trace.calls[0].usage).toEqual({
      inputTokens: 77,
      outputTokens: 33,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 0,
    })
    expect(trace.summary.totalInputTokens).toBe(77)
    expect(trace.summary.totalOutputTokens).toBe(33)
  })

  test('omits usage when the response preview is missing, truncated or unparsable', async () => {
    await traceCaptureService.recordCall({
      id: 'call-usage-truncated',
      sessionId: 'session-usage-missing',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:01.000Z',
      durationMs: 1000,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: { model: 'claude-fable-5' },
      },
      response: {
        status: 200,
        bodySnapshot: createTraceBodySnapshot(
          { id: 'msg-truncated', usage: { input_tokens: 100, output_tokens: 50 } },
          { maxPreviewChars: 24 },
        ),
      },
    })
    await traceCaptureService.recordCall({
      id: 'call-usage-pending',
      sessionId: 'session-usage-missing',
      source: 'anthropic',
      model: 'claude-fable-5',
      status: 'pending',
      startedAt: '2026-06-09T08:00:02.000Z',
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: { model: 'claude-fable-5' },
      },
    })
    await traceCaptureService.recordCall({
      id: 'call-usage-absent',
      sessionId: 'session-usage-missing',
      source: 'anthropic',
      model: 'claude-fable-5',
      startedAt: '2026-06-09T08:00:03.000Z',
      completedAt: '2026-06-09T08:00:04.000Z',
      durationMs: 1000,
      request: {
        method: 'POST',
        url: 'https://api.anthropic.com/v1/messages',
        body: { model: 'claude-fable-5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-usage-missing')

    expect(trace.calls).toHaveLength(3)
    expect(trace.calls[0].response?.body.truncated).toBe(true)
    for (const call of trace.calls) {
      expect(call.usage).toBeUndefined()
    }
    expect(trace.summary.totalInputTokens).toBe(0)
    expect(trace.summary.totalOutputTokens).toBe(0)
  })

  test('skips malformed trace jsonl entries when reading a session', async () => {
    const traceDir = path.join(tmpDir, 'billiardbuddy', 'traces')
    await fs.mkdir(traceDir, { recursive: true })
    await fs.writeFile(path.join(traceDir, 'session-corrupt.jsonl'), [
      'not-json',
      'null',
      '{}',
      JSON.stringify({
        type: 'event',
        event: {
          id: 'event-valid',
          sessionId: 'session-corrupt',
          timestamp: '2026-06-09T08:00:00.001Z',
          phase: 'api_call_started',
          severity: 'info',
        },
      }),
      JSON.stringify({
        type: 'call',
        record: {
          id: 'call-valid',
          sessionId: 'session-corrupt',
          source: 'proxy',
          status: 'ok',
          startedAt: '2026-06-09T08:00:00.000Z',
          completedAt: '2026-06-09T08:00:00.020Z',
          durationMs: 20,
          request: {
            method: 'POST',
            url: 'https://api.example.test/v1/chat/completions',
            headers: {},
            body: createTraceBodySnapshot({ model: 'gpt-5.5' }),
          },
          response: {
            status: 200,
            headers: {},
            body: createTraceBodySnapshot({ ok: true }),
          },
        },
      }),
    ].join('\n'))

    const trace = await traceCaptureService.getSessionTrace('session-corrupt')

    expect(trace.calls.map((call) => call.id)).toEqual(['call-valid'])
    expect(trace.events.map((event) => event.id)).toEqual(['event-valid'])
    expect(trace.summary.apiCalls).toBe(1)
  })

  test('upserts pending calls and preserves lifecycle events', async () => {
    const callId = createTraceCallId()
    await traceCaptureService.recordCall({
      id: callId,
      sessionId: 'session-trace-upsert',
      source: 'anthropic',
      model: 'gpt-5.5',
      status: 'pending',
      startedAt: '2026-06-09T08:00:00.000Z',
      request: {
        method: 'POST',
        url: 'https://sub2api.example.test/v1/messages',
        body: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'pending' }] },
      },
    })
    await traceCaptureService.recordEvent({
      sessionId: 'session-trace-upsert',
      callId,
      phase: 'api_call_started',
      source: 'anthropic',
      model: 'gpt-5.5',
    })
    await traceCaptureService.recordCall({
      id: callId,
      sessionId: 'session-trace-upsert',
      source: 'anthropic',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.120Z',
      durationMs: 120,
      request: {
        method: 'POST',
        url: 'https://sub2api.example.test/v1/messages',
        body: { model: 'gpt-5.5', messages: [{ role: 'user', content: 'pending' }] },
      },
      response: {
        status: 200,
        body: { id: 'msg-upsert' },
      },
    })

    const trace = await traceCaptureService.getSessionTrace('session-trace-upsert')

    expect(trace.summary.apiCalls).toBe(1)
    expect(trace.calls).toHaveLength(1)
    expect(trace.calls[0].id).toBe(callId)
    expect(trace.calls[0].status).toBe('ok')
    expect(trace.events).toHaveLength(1)
    expect(trace.events[0]).toMatchObject({
      phase: 'api_call_started',
      callId,
      source: 'anthropic',
    })
  })

  test('respects managed trace capture settings before writing new records', async () => {
    await updateTraceCaptureSettings({ enabled: false })

    const result = await traceCaptureService.recordCall({
      sessionId: 'session-trace-disabled',
      source: 'proxy',
      model: 'gpt-5.5',
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
    })
    const trace = await traceCaptureService.getSessionTrace('session-trace-disabled')
    const settingsFile = JSON.parse(await fs.readFile(path.join(tmpDir, 'billiardbuddy', 'settings.json'), 'utf-8')) as {
      traceCapture?: { enabled?: boolean }
    }

    expect(result).toBeNull()
    expect(trace.summary.apiCalls).toBe(0)
    expect(settingsFile.traceCapture?.enabled).toBe(false)
  })

  test('captures direct Anthropic-compatible provider calls from desktop fetch override', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.BB_TRACE_API_CALLS
    const originalProviderId = process.env.BB_TRACE_PROVIDER_ID
    const originalProviderName = process.env.BB_TRACE_PROVIDER_NAME
    const originalProviderFormat = process.env.BB_TRACE_PROVIDER_FORMAT
    process.env.BB_TRACE_API_CALLS = '1'
    process.env.BB_TRACE_PROVIDER_ID = 'provider-sub2api'
    process.env.BB_TRACE_PROVIDER_NAME = 'Sub2API-ChatGPT'
    process.env.BB_TRACE_PROVIDER_FORMAT = 'anthropic'
    try {
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ id: 'msg-direct-trace', content: [{ type: 'text', text: 'ok' }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-direct', {
        traceSessionId: 'session-direct-provider',
        querySource: 'test_query',
      })
      await traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'trace me' }] }),
      })

      const trace = await waitForTrace(
        'session-direct-provider',
        (snapshot) => Boolean(snapshot.calls[0]?.response) && snapshot.events.length >= 2,
      )
      expect(trace.summary.apiCalls).toBe(1)
      expect(trace.calls[0]).toMatchObject({
        source: 'anthropic',
        model: 'gpt-5.5',
        querySource: 'test_query',
        provider: {
          id: 'provider-sub2api',
          name: 'Sub2API-ChatGPT',
          format: 'anthropic',
        },
      })
      expect(trace.calls[0].request.body.preview).toContain('trace me')
      expect(trace.calls[0].response.body.preview).toContain('msg-direct-trace')
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_completed'])
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.BB_TRACE_API_CALLS
      else process.env.BB_TRACE_API_CALLS = originalTraceEnv
      if (originalProviderId === undefined) delete process.env.BB_TRACE_PROVIDER_ID
      else process.env.BB_TRACE_PROVIDER_ID = originalProviderId
      if (originalProviderName === undefined) delete process.env.BB_TRACE_PROVIDER_NAME
      else process.env.BB_TRACE_PROVIDER_NAME = originalProviderName
      if (originalProviderFormat === undefined) delete process.env.BB_TRACE_PROVIDER_FORMAT
      else process.env.BB_TRACE_PROVIDER_FORMAT = originalProviderFormat
    }
  })

  test('captures direct provider headers when fetch input is a Request', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.BB_TRACE_API_CALLS
    process.env.BB_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ id: 'msg-request-input', content: [{ type: 'text', text: 'ok' }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-direct-request-input', {
        traceSessionId: 'session-direct-request-input',
        querySource: 'test_query',
      })
      const requestInput = new Request('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer sk-direct-header-secret',
          'Content-Type': 'application/json',
        },
      })

      await traceFetch(requestInput, {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'request input' }] }),
      })

      const trace = await waitForTrace(
        'session-direct-request-input',
        (snapshot) => Boolean(snapshot.calls[0]?.response) && snapshot.events.length >= 2,
      )
      expect(trace.summary.apiCalls).toBe(1)
      expect(trace.calls[0].request.headers.authorization).toBe('[redacted]')
      expect(trace.calls[0].request.headers['content-type']).toBe('application/json')
      expect(trace.calls[0].request.body.preview).toContain('request input')
      expect(trace.calls[0].response.body.preview).toContain('msg-request-input')
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.BB_TRACE_API_CALLS
      else process.env.BB_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('captures direct provider fetch failures without changing thrown behavior', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.BB_TRACE_API_CALLS
    process.env.BB_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async () => {
        throw new Error('network down for trace')
      }) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-direct-fail', {
        traceSessionId: 'session-direct-provider-fail',
        querySource: 'test_query',
      })
      await expect(traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'trace failure' }] }),
      })).rejects.toThrow('network down for trace')

      const trace = await waitForTrace(
        'session-direct-provider-fail',
        (snapshot) => Boolean(snapshot.calls[0]?.error) && snapshot.events.length >= 2,
      )
      expect(trace.summary.apiCalls).toBe(1)
      expect(trace.summary.failedCalls).toBe(1)
      expect(trace.calls[0]).toMatchObject({
        source: 'anthropic',
        model: 'gpt-5.5',
        status: 'error',
        error: {
          name: 'Error',
          message: 'network down for trace',
        },
      })
      expect(trace.calls[0].request.body.preview).toContain('trace failure')
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_failed'])
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.BB_TRACE_API_CALLS
      else process.env.BB_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('passes session id to local provider proxy without duplicating client-side trace', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.BB_TRACE_API_CALLS
    let seenHeader: string | null = null
    process.env.BB_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        seenHeader = new Headers(init?.headers).get('x-claude-code-session-id')
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      }) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-proxy', {
        traceSessionId: 'session-local-proxy',
        querySource: 'test_query',
      })
      await traceFetch('http://127.0.0.1:3456/proxy/providers/provider-1/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'proxy trace' }] }),
      })

      expect(seenHeader).toBe('session-local-proxy')
      const trace = await traceCaptureService.getSessionTrace('session-local-proxy')
      expect(trace.summary.apiCalls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.BB_TRACE_API_CALLS
      else process.env.BB_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('records an aborted error call when the request is aborted mid-stream', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.BB_TRACE_API_CALLS
    process.env.BB_TRACE_API_CALLS = '1'
    try {
      // A stream that sends one chunk then goes silent forever, like the
      // wedged upstream in #766. The mock ignores the abort signal, so the
      // trace capture must end the read itself.
      globalThis.fetch = (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"message_start"}\n\n'))
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }) as typeof fetch

      const abortController = new AbortController()
      const traceFetch = createDumpPromptsFetch('agent-direct-abort', {
        traceSessionId: 'session-direct-abort',
        querySource: 'test_query',
      })
      await traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'abort me' }] }),
        signal: abortController.signal,
      })

      // Let the capture loop start reading, then abort like the stream idle
      // watchdog (stream.controller.abort()) or SDK client timeout would.
      await new Promise((resolve) => setTimeout(resolve, 20))
      abortController.abort(new Error('Stream idle timeout: no chunks received for 240s'))

      const trace = await waitForTrace(
        'session-direct-abort',
        (snapshot) => snapshot.calls[0]?.status === 'error'
          && snapshot.events.some((event) => event.phase === 'api_call_aborted'),
      )
      expect(trace.summary.apiCalls).toBe(1)
      expect(trace.summary.failedCalls).toBe(1)
      expect(trace.calls[0]).toMatchObject({
        source: 'anthropic',
        model: 'gpt-5.5',
        status: 'error',
        metadata: { phase: 'api_call_aborted', aborted: true },
      })
      expect(trace.calls[0].error?.message).toContain('Stream idle timeout')
      expect(typeof trace.calls[0].durationMs).toBe('number')
      expect(trace.calls[0].response?.status).toBe(200)
      expect(trace.calls[0].response?.body.preview).toContain('message_start')
      expect(trace.calls[0].response?.body.truncated).toBe(true)
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_aborted'])
      expect(trace.events.at(-1)?.severity).toBe('error')
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.BB_TRACE_API_CALLS
      else process.env.BB_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('synthesizes an AbortError when the abort signal carries no reason', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.BB_TRACE_API_CALLS
    process.env.BB_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async () => {
        const stream = new ReadableStream<Uint8Array>({
          start() {
            // No chunks at all: headers arrived, body never produces bytes.
          },
        })
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        })
      }) as typeof fetch

      const abortController = new AbortController()
      const traceFetch = createDumpPromptsFetch('agent-direct-abort-bare', {
        traceSessionId: 'session-direct-abort-bare',
        querySource: 'test_query',
      })
      await traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'abort bare' }] }),
        signal: abortController.signal,
      })
      await new Promise((resolve) => setTimeout(resolve, 20))
      abortController.abort()

      const trace = await waitForTrace(
        'session-direct-abort-bare',
        (snapshot) => snapshot.calls[0]?.status === 'error',
      )
      expect(trace.calls[0].status).toBe('error')
      expect(trace.calls[0].error?.name).toBe('AbortError')
      expect(trace.calls[0].metadata).toMatchObject({ phase: 'api_call_aborted', aborted: true })
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.BB_TRACE_API_CALLS
      else process.env.BB_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('keeps a completed call ok when the signal aborts after the response finished', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.BB_TRACE_API_CALLS
    process.env.BB_TRACE_API_CALLS = '1'
    try {
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ id: 'msg-late-abort', content: [{ type: 'text', text: 'ok' }] }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )) as typeof fetch

      const abortController = new AbortController()
      const traceFetch = createDumpPromptsFetch('agent-late-abort', {
        traceSessionId: 'session-late-abort',
        querySource: 'test_query',
      })
      await traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'late abort' }] }),
        signal: abortController.signal,
      })

      const completed = await waitForTrace(
        'session-late-abort',
        (snapshot) => snapshot.events.some((event) => event.phase === 'api_call_completed'),
      )
      expect(completed.calls[0].status).not.toBe('error')

      // Aborting after completion (e.g. the user cancels the next tool step)
      // must not rewrite the finished call into an error.
      abortController.abort()
      await new Promise((resolve) => setTimeout(resolve, 50))
      const trace = await traceCaptureService.getSessionTrace('session-late-abort')
      expect(trace.calls).toHaveLength(1)
      expect(trace.calls[0].status).not.toBe('error')
      expect(trace.calls[0].error).toBeUndefined()
      expect(trace.summary.failedCalls).toBe(0)
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_completed'])
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.BB_TRACE_API_CALLS
      else process.env.BB_TRACE_API_CALLS = originalTraceEnv
    }
  })

  test('marks fetch rejections from an aborted signal with abort metadata', async () => {
    const originalFetch = globalThis.fetch
    const originalTraceEnv = process.env.BB_TRACE_API_CALLS
    process.env.BB_TRACE_API_CALLS = '1'
    try {
      const abortController = new AbortController()
      globalThis.fetch = (async () => {
        // Mirror undici: reject with an AbortError once the signal aborts
        // before headers arrive (SDK client timeout during prefill).
        abortController.abort()
        const error = new Error('This operation was aborted')
        error.name = 'AbortError'
        throw error
      }) as typeof fetch

      const traceFetch = createDumpPromptsFetch('agent-fetch-abort', {
        traceSessionId: 'session-fetch-abort',
        querySource: 'test_query',
      })
      await expect(traceFetch('https://sub2api.example.test/v1/messages', {
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-5.5', messages: [{ role: 'user', content: 'pre-headers abort' }] }),
        signal: abortController.signal,
      })).rejects.toThrow('This operation was aborted')

      const trace = await waitForTrace(
        'session-fetch-abort',
        (snapshot) => snapshot.calls[0]?.status === 'error'
          && snapshot.events.some((event) => event.phase === 'api_call_failed'),
      )
      expect(trace.calls[0]).toMatchObject({
        status: 'error',
        error: { name: 'AbortError' },
        metadata: { phase: 'api_call_failed', aborted: true },
      })
      expect(trace.events.map((event) => event.phase)).toEqual(['api_call_started', 'api_call_failed'])
    } finally {
      globalThis.fetch = originalFetch
      if (originalTraceEnv === undefined) delete process.env.BB_TRACE_API_CALLS
      else process.env.BB_TRACE_API_CALLS = originalTraceEnv
    }
  })
})

describe('captureResponseTraceSnapshot', () => {
  test('returns the full body without abort involvement', async () => {
    const response = new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })
    const capture = await captureResponseTraceSnapshot(response, { signal: new AbortController().signal })
    expect(capture.aborted).toBe(false)
    expect(capture.snapshot.preview).toContain('"ok"')
    expect(capture.snapshot.truncated).toBe(false)
  })

  test('finishes with partial data when aborted mid-stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial sse data'))
      },
    })
    const response = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })

    const controller = new AbortController()
    const capturePromise = captureResponseTraceSnapshot(response, { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort(new Error('client timeout'))

    const capture = await capturePromise
    expect(capture.aborted).toBe(true)
    expect((capture.abortReason as Error).message).toBe('client timeout')
    expect(capture.snapshot.preview).toContain('partial sse data')
    expect(capture.snapshot.truncated).toBe(true)
  })

  test('force-finishes after the grace period when cancel cannot wake a hung read', async () => {
    const encoder = new TextEncoder()
    let reads = 0
    let cancelled = false
    const fakeReader = {
      read() {
        reads += 1
        if (reads === 1) {
          return Promise.resolve({ done: false, value: encoder.encode('stuck partial body') })
        }
        // Hangs forever even after cancel(): models a runtime where
        // reader.cancel() does not settle a pending read.
        return new Promise(() => {})
      },
      cancel() {
        cancelled = true
        return Promise.resolve()
      },
      releaseLock() {},
    }
    const fakeResponse = {
      headers: new Headers({ 'content-type': 'text/event-stream' }),
      body: { getReader: () => fakeReader },
    } as unknown as Response

    const controller = new AbortController()
    const capturePromise = captureResponseTraceSnapshot(fakeResponse, {
      signal: controller.signal,
      abortGraceMs: 20,
    })
    await new Promise((resolve) => setTimeout(resolve, 10))
    controller.abort()

    const capture = await capturePromise
    expect(cancelled).toBe(true)
    expect(capture.aborted).toBe(true)
    expect(capture.snapshot.preview).toContain('stuck partial body')
    expect(capture.snapshot.truncated).toBe(true)
  })

  test('treats an already-aborted signal as an immediate abort', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // Never produces data.
      },
    })
    const response = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    })
    const controller = new AbortController()
    controller.abort()

    const capture = await captureResponseTraceSnapshot(response, {
      signal: controller.signal,
      abortGraceMs: 50,
    })
    expect(capture.aborted).toBe(true)
    expect(capture.snapshot.preview).toBe('')
  })
})

describe('trace read cache', () => {
  function buildTraceCallLine(id: string, sessionId = 'session-cache-hit', payload = 'ok'): string {
    return `${JSON.stringify({
      type: 'call',
      record: {
        id,
        sessionId,
        source: 'proxy',
        status: 'ok',
        startedAt: '2026-06-09T08:00:00.000Z',
        completedAt: '2026-06-09T08:00:00.020Z',
        durationMs: 20,
        request: {
          method: 'POST',
          url: 'https://api.example.test/v1/chat/completions',
          headers: {},
          body: createTraceBodySnapshot({ model: 'gpt-5.5', payload }),
        },
        response: {
          status: 200,
          headers: {},
          body: createTraceBodySnapshot({ ok: true }),
        },
      },
    })}\n`
  }

  test('serves cached entries while file mtime and size are unchanged', async () => {
    const traceDir = path.join(tmpDir, 'billiardbuddy', 'traces')
    const filePath = path.join(traceDir, 'session-cache-hit.jsonl')
    await fs.mkdir(traceDir, { recursive: true })

    const lineA = buildTraceCallLine('call-aaa')
    const lineB = buildTraceCallLine('call-bbb')
    expect(Buffer.byteLength(lineA)).toBe(Buffer.byteLength(lineB))

    const initialTime = new Date('2026-06-09T08:00:00.000Z')
    await fs.writeFile(filePath, lineA)
    await fs.utimes(filePath, initialTime, initialTime)

    const first = await traceCaptureService.getSessionTrace('session-cache-hit')
    expect(first.calls.map((call) => call.id)).toEqual(['call-aaa'])

    // Same size + restored mtime: the cached parse result must be reused.
    await fs.writeFile(filePath, lineB)
    await fs.utimes(filePath, initialTime, initialTime)

    const second = await traceCaptureService.getSessionTrace('session-cache-hit')
    expect(second.calls.map((call) => call.id)).toEqual(['call-aaa'])

    const laterTime = new Date('2026-06-09T08:00:05.000Z')
    await fs.utimes(filePath, laterTime, laterTime)

    const third = await traceCaptureService.getSessionTrace('session-cache-hit')
    expect(third.calls.map((call) => call.id)).toEqual(['call-bbb'])
  })

  test('stores trimmed records in the list cache and keeps full records for detail reads', async () => {
    const traceDir = path.join(tmpDir, 'billiardbuddy', 'traces')
    const filePath = path.join(traceDir, 'session-cache-list.jsonl')
    await fs.mkdir(traceDir, { recursive: true })
    await fs.writeFile(filePath, buildTraceCallLine('call-list-cache', 'session-cache-list', 'x'.repeat(10_000)))

    const list = await traceCaptureService.listSessionTraces({ sessionIds: ['session-cache-list'] })
    expect(list.traces).toHaveLength(1)

    const trace = await traceCaptureService.getSessionTrace('session-cache-list')
    const detail = await traceCaptureService.getSessionTraceCall('session-cache-list', 'call-list-cache')

    expect(trace.calls[0].request.body.preview.length).toBeGreaterThan(2048)
    expect(detail?.request.body.preview.length).toBeGreaterThan(2048)
  })

  test('invalidates the cache when new entries are appended in process', async () => {
    await traceCaptureService.recordCall({
      id: 'call-cache-1',
      sessionId: 'session-cache-append',
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:00.000Z',
      completedAt: '2026-06-09T08:00:00.010Z',
      durationMs: 10,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const first = await traceCaptureService.getSessionTrace('session-cache-append')
    expect(first.calls.map((call) => call.id)).toEqual(['call-cache-1'])

    await traceCaptureService.recordCall({
      id: 'call-cache-2',
      sessionId: 'session-cache-append',
      source: 'proxy',
      model: 'gpt-5.5',
      startedAt: '2026-06-09T08:00:01.000Z',
      completedAt: '2026-06-09T08:00:01.010Z',
      durationMs: 10,
      request: {
        method: 'POST',
        url: 'https://api.example.test/v1/messages',
        body: { model: 'gpt-5.5' },
      },
      response: {
        status: 200,
        body: { ok: true },
      },
    })

    const second = await traceCaptureService.getSessionTrace('session-cache-append')
    expect(second.calls.map((call) => call.id)).toEqual(['call-cache-1', 'call-cache-2'])
  })
})
