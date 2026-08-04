import { expect, test } from 'bun:test'
import { DashScopeVideoProvider } from '../../video-media-relay/providers/dashscope.ts'

const hash = `sha256:${'a'.repeat(64)}`
const identity = { owner: 'installation:test' }

test('DashScope video provider pins Qwen planning and 768-dimensional embedding snapshots', async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = []
  const provider = new DashScopeVideoProvider({ apiKey: 'key', now: () => new Date('2026-08-03T00:00:00.000Z'), fetchImpl: async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>; calls.push({ url: String(url), body })
    if (String(url).endsWith('/embeddings')) return Response.json({ data: [{ embedding: Array.from({ length: 768 }, () => 0.25) }], usage: { total_tokens: 3 } })
    return Response.json({ choices: [{ message: { content: JSON.stringify({ brief: { content_type: '片段' }, scenes: [] }) } }], usage: { total_tokens: 5 } })
  } })
  const embedding = await provider.execute({ local_operation_id: 'task_12345678', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'semantic_embedding', application_role: 'search_index', input: { embedding_role: 'document', items: [{ id: 'fact_12345678', text: '球桌边库' }], model: 'text-embedding-v4', dimension: 768, instruction_version: 'v1' } }, identity)
  expect(embedding.receipt).toMatchObject({ model_snapshot: 'text-embedding-v4', region: 'cn-beijing' })
  expect((embedding.result as { vectors: Array<{ vector: number[] }> }).vectors[0]?.vector).toHaveLength(768)
  const plan = await provider.execute({ local_operation_id: 'task_87654321', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_87654321', request_hash: hash, capability: 'media_reasoning', application_role: 'planning', input: { object_refs: [], facts_basis_hash: hash, evidence: [{ id: 'fact_12345678', kind: 'transcript', text: '开球', confidence: 0.9 }], language: 'zh', output_schema_version: 1 } }, identity)
  expect(plan.receipt.model_snapshot).toBe('qwen3.6-flash')
  expect(calls.map(call => call.url)).toEqual(['https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings', 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'])
  expect(calls[1]?.body).toMatchObject({ model: 'qwen3.6-flash', temperature: 0 })
})

test('DashScope receipt uses upstream usage and immutable uploaded-object bytes', async () => {
  const provider = new DashScopeVideoProvider({ apiKey: 'key', now: () => new Date('2026-08-03T00:00:00.000Z'), fetchImpl: async () => Response.json({
    choices: [{ message: { content: JSON.stringify({ summary: '球杆击球', confidence: 0.9, warnings: [] }) } }],
    usage: { input_tokens: 12, output_tokens: 8, total_fee: 0.000123, proxy_seconds: 1.25 },
  }) })
  const result = await provider.execute({ local_operation_id: 'task_12345678', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'visual_evidence', application_role: 'shot_evidence', input: { object_refs: ['object_12345678'], evidence_window_id: 'window_12345678', facts_basis_hash: hash, language: 'zh', output_schema_version: 1 } }, identity, { object_urls: ['https://oss.example.test/frame.jpg'], object_byte_sizes: [4096] })
  expect(result.receipt.usage).toMatchObject({ requests: 1, total_tokens: 20, input_bytes: expect.any(Number), visual_frames: 1, proxy_seconds: 1.25, estimated_amount_micros: 123 })
  expect(result.receipt.upstream_receipt_hash).toMatch(/^sha256:/)
})

test('DashScope Fun-ASR long task submits once and polls a persisted task id', async () => {
  const calls: string[] = []
  const provider = new DashScopeVideoProvider({ apiKey: 'key', now: () => new Date('2026-08-03T00:00:00.000Z'), fetchImpl: async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`)
    if (init?.method === 'POST') return Response.json({ output: { task_id: 'task-remote-1' } })
    if (String(url).startsWith('https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/')) return Response.json({ transcripts: [{ text: '长文件转写', sentences: [{ text: '长文件转写', begin_time: 0, end_time: 1000, words: [{ text: '长', begin_time: 0, end_time: 300 }] }] }] })
    return Response.json({ output: { task_status: 'SUCCEEDED', results: [{ transcription_url: 'https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/transcript.json' }] } })
  } })
  const input = { local_operation_id: 'task_12345678', consent_revision_id: 'consent_12345678', consent_scope_hash: hash, local_budget_reservation_id: 'budget_12345678', request_hash: hash, capability: 'speech_transcription' as const, application_role: 'asr' as const, input: { mode: 'long_async' as const, audio_object_ref: 'object_12345678', source_offset: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, hotwords: ['开球'], speaker_diarization: true, sentence_timestamps: true as const, word_timestamps: true as const } }
  const submitted = await provider.execute(input, identity, { object_urls: ['https://oss.example.test/audio'] })
  expect(submitted).toMatchObject({ state: 'submitted', provider_task_id: 'task-remote-1' })
  const complete = await provider.poll(input, submitted.provider_task_id!, identity, { object_urls: [], object_byte_sizes: [8192] })
  expect(complete).toMatchObject({ state: 'succeeded', result: { kind: 'asr', text: '长文件转写' } })
  expect(complete.receipt.usage.asr_seconds).toBe(1)
  expect(complete.receipt.usage.input_bytes).toBeGreaterThanOrEqual(8192)
  expect(calls).toEqual(['POST https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription', 'GET https://dashscope.aliyuncs.com/api/v1/tasks/task-remote-1', 'GET https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/transcript.json'])
})
