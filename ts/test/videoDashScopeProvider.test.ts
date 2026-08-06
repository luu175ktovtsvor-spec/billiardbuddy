import { expect, test } from 'bun:test'
import { captionTranslationRelayResultSchema, createVideoRelayOperationRequestSchema } from '../../video-media-relay/contracts/relayApi.ts'
import { DashScopeVideoProvider } from '../../video-media-relay/providers/dashscope.ts'

const hash = `sha256:${'a'.repeat(64)}`
const identity = { owner: 'installation:test' }

function captionTranslationRequest() {
  return {
    local_operation_id: 'task_caption_translation_0001',
    consent_revision_id: 'consent_caption_translation_0001',
    consent_scope_hash: hash,
    remote_consent_claim: 'aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb',
    local_budget_reservation_id: 'budget_caption_translation_0001',
    request_hash: hash,
    capability: 'media_reasoning' as const,
    application_role: 'caption_translation' as const,
    input: {
      object_refs: [],
      facts_basis_hash: hash,
      evidence: [{
        id: 'caption_cue_translation_0001',
        kind: 'transcript' as const,
        text: '第一句字幕',
        source_range_id: 'segment_caption_translation_0001',
        confidence: 0.95,
      }],
      language: 'en',
      output_schema_version: 1 as const,
    },
  }
}

test('DashScope video provider pins Qwen planning and 768-dimensional embedding snapshots', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const provider = new DashScopeVideoProvider({ apiKey: 'key', now: () => new Date('2026-08-03T00:00:00.000Z'), fetchImpl: async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; calls.push({ url: String(url), body })
    if (String(url).endsWith('/embeddings')) return Response.json({ data: [{ embedding: Array.from({ length: 768 }, () => 0.25) }], usage: { total_tokens: 3, total_fee: 0.000003 } })
    return Response.json({ choices: [{ message: { content: JSON.stringify({ brief: { content_type: '片段' }, scenes: [] }) } }], usage: { total_tokens: 5, total_fee: 0.000005 } })
  } })
  const embedding = await provider.execute({ local_operation_id: 'task_12345678', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'document', items: [{ id: 'fact_12345678', text: '球桌边库' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }, identity)
  expect(embedding.receipt).toMatchObject({ model_snapshot: 'text-embedding-v4', region: 'cn-beijing' })
  expect((embedding.result as { vectors: Array<{ vector: number[] }> }).vectors[0]?.vector).toHaveLength(768)
  const plan = await provider.execute({ local_operation_id: 'task_87654321', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_87654321', request_hash: hash, capability: 'media_reasoning', application_role: 'planning', input: { object_refs: [], sources: [{ id: 'source_12345678', name: '开球素材', fingerprint: hash, duration_ms: 10_000, width: 1920, height: 1080, fps: 30, rotation: 0, has_audio: true }], facts_basis_hash: hash, user_goal: '做一个清晰的开球短片', analysis_gaps: ['需要人工确认结尾'], evidence: [
    { id: 'fact_12345678', kind: 'transcript', source_id: 'source_12345678', in_ms: 100, out_ms: 900, text: '开球', confidence: 0.9 },
    { id: 'creation_brief_12345678', kind: 'delivery_intent', text: JSON.stringify({ use_case: 'sports_highlight', distribution: 'vertical_short', pace: 'fast', story_structure: 'highlight_reel', selection_focus: 'action', creative_direction: { narrative_voice: 'confident', emotional_arc: 'energy', audio_mode: 'preserve_source', voiceover_persona: 'none', caption_strategy: 'minimal_emphasis', keep_natural_pauses: true, human_notes: '保留现场声音' } }) },
  ], language: 'zh', output_schema_version: 1 } }, identity)
  expect(plan.receipt).toMatchObject({ model_snapshot: 'qwen3.6-flash', prompt_version: 'video-planning-v2' })
  expect(calls.map(call => call.url)).toEqual(['https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'])
  expect(calls[1]?.body).toMatchObject({ model: 'qwen3.6-flash', temperature: 0 })
  const planningMessages = calls[1]?.body.messages as Array<{ role: string; content: string }>
  expect(planningMessages[0]?.content).toContain('面向普通创作者')
  expect(planningMessages[0]?.content).toContain('delivery_intent')
  expect(planningMessages[0]?.content).toContain('story_structure')
  expect(planningMessages[0]?.content).toContain('creative_direction')
  expect(planningMessages[0]?.content).toContain('Scene 是最终剪辑装配')
  expect(planningMessages[0]?.content).toContain('不能虚构 source_id')
  const planningInput = JSON.parse(planningMessages[1]!.content) as { task: string; sources: Array<{ id: string }>; user_goal: string; analysis_gaps: string[]; evidence: Array<{ id: string; kind: string; source_id?: string; in_ms?: number; out_ms?: number }> }
  expect(planningInput.task).toBe('evidence_grounded_video_planning')
  expect(planningInput.sources).toContainEqual(expect.objectContaining({ id: 'source_12345678' }))
  expect(planningInput.user_goal).toBe('做一个清晰的开球短片')
  expect(planningInput.analysis_gaps).toEqual(['需要人工确认结尾'])
  expect(planningInput.evidence).toContainEqual(expect.objectContaining({ id: 'fact_12345678', source_id: 'source_12345678', in_ms: 100, out_ms: 900 }))
  expect(planningInput.evidence).toContainEqual(expect.objectContaining({ id: 'creation_brief_12345678', kind: 'delivery_intent' }))
})

test('字幕翻译 Relay 契约只接受文本 Cue，并用专门提示和严格结果 envelope', async () => {
  const request = captionTranslationRequest()
  expect(createVideoRelayOperationRequestSchema.safeParse(request).success).toBe(true)
  expect(createVideoRelayOperationRequestSchema.safeParse({
    ...request,
    input: { ...request.input, object_refs: ['object_translation_0001'] },
  }).success).toBe(false)
  expect(createVideoRelayOperationRequestSchema.safeParse({
    ...request,
    input: { ...request.input, evidence: [{ ...request.input.evidence[0]!, kind: 'visual_fact' }] },
  }).success).toBe(false)
  expect(captionTranslationRelayResultSchema.safeParse({
    kind: 'planning',
    plan: { scenes: [] },
  }).success).toBe(false)
  expect(captionTranslationRelayResultSchema.safeParse({
    kind: 'caption_translation',
    translations: [{ cue_id: request.input.evidence[0]!.id, text: 'First subtitle' }],
    plan: { scenes: [] },
  }).success).toBe(false)

  let capturedBody: Record<string, unknown> | undefined
  const provider = new DashScopeVideoProvider({
    apiKey: 'key',
    now: () => new Date('2026-08-03T00:00:00.000Z'),
    fetchImpl: async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
      return Response.json({ choices: [{ message: { content: JSON.stringify({
        kind: 'caption_translation',
        translations: [{ cue_id: request.input.evidence[0]!.id, text: 'First subtitle' }],
      }) } }], usage: { total_tokens: 7, total_fee: 0.000007 } })
    },
  })
  const translated = await provider.execute(request, identity)
  expect(translated).toMatchObject({
    state: 'succeeded',
    receipt: { prompt_version: 'caption-translation-v1' },
    result: {
      kind: 'caption_translation',
      translations: [{ cue_id: request.input.evidence[0]!.id, text: 'First subtitle' }],
    },
  })
  const messages = capturedBody?.messages as Array<{ role: string; content: string }>
  expect(messages[0]?.content).toContain('字幕翻译器')
  expect(messages[0]?.content).toContain('不得返回 plan')
  expect(JSON.parse(messages[1]!.content)).toEqual({
    task: 'caption_translation',
    target_language: 'en',
    facts_basis_hash: hash,
    output_schema_version: 1,
    cues: [{ cue_id: request.input.evidence[0]!.id, text: '第一句字幕', source_range_id: 'segment_caption_translation_0001' }],
  })

  const planningEnvelope = new DashScopeVideoProvider({
    apiKey: 'key',
    fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ kind: 'planning', plan: { scenes: [] } }) } }] }),
  })
  await expect(planningEnvelope.execute(request, identity)).rejects.toMatchObject({
    status: 502,
    code: 'caption_translation_result_invalid',
  })
})

test('DashScope receipt uses upstream usage and immutable uploaded-object bytes', async () => {
  let body: Record<string, unknown> | undefined
  const provider = new DashScopeVideoProvider({ apiKey: 'key', now: () => new Date('2026-08-03T00:00:00.000Z'), fetchImpl: async (_url, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return Response.json({
    choices: [{ message: { content: JSON.stringify({ summary: '球杆击球', confidence: 0.9, warnings: [] }) } }],
    usage: { input_tokens: 12, output_tokens: 8, total_fee: 0.000123, proxy_seconds: 1.25 },
    })
  } })
  const result = await provider.execute({ local_operation_id: 'task_12345678', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'visual_evidence', application_role: 'shot_evidence', input: { object_refs: ['object_12345678'], evidence_window_id: 'window_12345678', facts_basis_hash: hash, language: 'zh', output_schema_version: 1 } }, identity, { object_urls: ['https://oss.example.test/frame.jpg'], object_byte_sizes: [4096] })
  expect(result.receipt.usage).toMatchObject({ requests: 1, total_tokens: 20, input_bytes: expect.any(Number), visual_frames: 1, proxy_seconds: 1.25, estimated_amount_micros: 123 })
  expect(body).toMatchObject({ model: 'qwen3-vl-flash', max_tokens: 512 })
  expect(result.receipt.upstream_receipt_hash).toMatch(/^sha256:/)
})

test('DashScope 不会把缺失的上游价格折叠为零费用回执', async () => {
  const request = {
    local_operation_id: 'task_price_receipt_0001',
    consent_revision_id: 'consent_price_receipt_0001',
    consent_scope_hash: hash,
    local_budget_reservation_id: 'budget_price_receipt_0001',
    request_hash: hash,
    capability: 'semantic_embedding' as const,
    application_role: 'search_index' as const,
    input: {
      embedding_role: 'document' as const,
      items: [{ id: 'fact_price_receipt_0001', text: '价格回执' }],
      model: 'text-embedding-v4' as const,
      dimension: 768 as const,
      instruction_version: 'v1',
    },
  }
  const missingPrice = new DashScopeVideoProvider({
    apiKey: 'key',
    fetchImpl: async () => Response.json({
      data: [{ embedding: Array.from({ length: 768 }, () => 0.25) }],
      usage: { total_tokens: 3 },
    }),
  })
  await expect(missingPrice.execute(request, identity)).rejects.toMatchObject({
    status: 503,
    code: 'provider_usage_amount_missing',
  })

  // A provider-reported zero is distinct from an omitted price and remains a
  // verifiable free/promotional invocation.
  const reportedZero = new DashScopeVideoProvider({
    apiKey: 'key',
    fetchImpl: async () => Response.json({
      data: [{ embedding: Array.from({ length: 768 }, () => 0.25) }],
      usage: { total_tokens: 3, total_fee: 0 },
    }),
  })
  await expect(reportedZero.execute(request, identity)).resolves.toMatchObject({
    state: 'succeeded',
    receipt: { usage: { estimated_amount_micros: 0 } },
  })
})

test('DashScope Fun-ASR long task submits once and polls a persisted task id', async () => {
  const calls: string[] = []
  let transcriptionRequest: RequestInit | undefined
  const provider = new DashScopeVideoProvider({ apiKey: 'key', now: () => new Date('2026-08-03T00:00:00.000Z'), fetchImpl: async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`)
    if (init?.method === 'POST') return Response.json({ output: { task_id: 'task-remote-1' } })
    if (String(url).startsWith('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/')) { transcriptionRequest = init; return Response.json({ transcripts: [{ text: '长文件转写', sentences: [{ text: '长文件转写', begin_time: 0, end_time: 1000, words: [{ text: '长', begin_time: 0, end_time: 300 }] }] }] }) }
    return Response.json({ output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/transcript.json' }] }, usage: { total_fee: 0.000008 } })
  } })
  const input = { local_operation_id: 'task_12345678', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'speech_transcription' as const, application_role: 'asr' as const, input: { mode: 'long_async' as const, audio_object_ref: 'object_12345678', source_offset: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, hotwords: ['开球'], speaker_diarization: true, sentence_timestamps: true as const, word_timestamps: true as const } }
  const accepted: Array<{ provider_task_id: string; receipt_id: string }> = []
  const submitted = await provider.execute(input, identity, { object_urls: ['https://oss.example.test/audio'] }, {
    onAccepted: async value => { accepted.push({ provider_task_id: value.provider_task_id, receipt_id: value.receipt.id }) },
  })
  expect(submitted).toMatchObject({ state: 'submitted', provider_task_id: 'task-remote-1' })
  expect(accepted).toEqual([{ provider_task_id: 'task-remote-1', receipt_id: submitted.receipt.id }])
  const complete = await provider.poll(input, submitted.provider_task_id!, identity, { object_urls: [], object_byte_sizes: [8192] })
  expect(complete).toMatchObject({ state: 'succeeded', result: { kind: 'asr', text: '长文件转写' } })
  expect(complete.receipt.usage.asr_seconds).toBe(1)
  expect(complete.receipt.usage.input_bytes).toBeGreaterThanOrEqual(8192)
  expect(transcriptionRequest?.redirect).toBe('error')
  expect(calls).toEqual(['POST https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription', 'GET https://dashscope.aliyuncs.com/api/v1/tasks/task-remote-1', 'GET https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/transcript.json'])
})

test('DashScope long ASR cancellation requires an explicit cancelled task status', async () => {
  const calls: string[] = []
  let taskStatus = 'CANCELED'
  const provider = new DashScopeVideoProvider({ apiKey: 'key', now: () => new Date('2026-08-03T00:00:00.000Z'), fetchImpl: async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`)
    if (String(url).endsWith('/cancel')) return Response.json({ request_id: 'request-cancel-1' })
    return Response.json({ output: { task_id: 'task-remote-cancel', task_status: taskStatus } })
  } })
  await expect(provider.cancel('task-remote-cancel')).resolves.toEqual({ cancelled: true })
  expect(calls).toEqual([
    'POST https://dashscope.aliyuncs.com/api/v1/tasks/task-remote-cancel/cancel',
    'GET https://dashscope.aliyuncs.com/api/v1/tasks/task-remote-cancel',
  ])

  taskStatus = 'RUNNING'
  await expect(provider.cancel('task-remote-running')).resolves.toBeUndefined()
  expect(calls.slice(-2)).toEqual([
    'POST https://dashscope.aliyuncs.com/api/v1/tasks/task-remote-running/cancel',
    'GET https://dashscope.aliyuncs.com/api/v1/tasks/task-remote-running',
  ])
})

test('DashScope polling preserves Provider-cancelled as its own terminal state', async () => {
  const provider = new DashScopeVideoProvider({ apiKey: 'key', now: () => new Date('2026-08-03T00:00:00.000Z'), fetchImpl: async () => Response.json({ output: { task_id: 'task-remote-cancelled', task_status: 'CANCELLED' }, usage: { total_fee: 0 } }) })
  const input = { local_operation_id: 'task_cancelled_asr', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'speech_transcription' as const, application_role: 'asr' as const, input: { mode: 'long_async' as const, audio_object_ref: 'object_12345678', source_offset: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, speaker_diarization: false, sentence_timestamps: true as const, word_timestamps: true as const } }
  await expect(provider.poll(input, 'task-remote-cancelled', identity)).resolves.toMatchObject({ state: 'cancelled', safe_error_code: 'asr_task_cancelled' })
})

test('DashScope 长 ASR 终态缺少 Provider 价格时拒绝伪造失败回执', async () => {
  const provider = new DashScopeVideoProvider({
    apiKey: 'key',
    fetchImpl: async () => Response.json({ output: { task_id: 'task-remote-missing-price', task_status: 'FAILED' }, usage: { total_tokens: 2 } }),
  })
  const input = { local_operation_id: 'task_missing_price_asr', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'speech_transcription' as const, application_role: 'asr' as const, input: { mode: 'long_async' as const, audio_object_ref: 'object_12345678', source_offset: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, speaker_diarization: false, sentence_timestamps: true as const, word_timestamps: true as const } }
  await expect(provider.poll(input, 'task-remote-missing-price', identity)).rejects.toMatchObject({ status: 503, code: 'provider_usage_amount_missing' })
})

test('DashScope polling keeps an unconfirmed task-query rejection retryable', async () => {
  const provider = new DashScopeVideoProvider({ apiKey: 'key', now: () => new Date('2026-08-03T00:00:00.000Z'), fetchImpl: async () => Response.json({ code: 'Throttled' }, { status: 429 }) })
  const input = { local_operation_id: 'task_retryable_asr', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'speech_transcription' as const, application_role: 'asr' as const, input: { mode: 'long_async' as const, audio_object_ref: 'object_12345678', source_offset: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, speaker_diarization: false, sentence_timestamps: true as const, word_timestamps: true as const } }
  await expect(provider.poll(input, 'task-remote-retryable', identity)).rejects.toMatchObject({ status: 503, code: 'provider_poll_rejected' })
})
