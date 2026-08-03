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
