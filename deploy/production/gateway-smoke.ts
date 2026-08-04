import { randomUUID } from 'node:crypto'

const base = (process.env.GATEWAY_SMOKE_BASE_URL ?? 'https://zzyppz.cn/gw').replace(/\/+$/, '')
const token = process.env.GATEWAY_SMOKE_ACCESS_TOKEN?.trim()
const confirmation = process.env.GATEWAY_SMOKE_CONFIRMATION
if (!token || token.length < 16) throw new Error('GATEWAY_SMOKE_ACCESS_TOKEN is required and is never persisted by this smoke tool')
if (confirmation !== 'ONE_BILLED_TEXT_RESPONSE') throw new Error('GATEWAY_SMOKE_CONFIRMATION must be ONE_BILLED_TEXT_RESPONSE')
if (process.env.GATEWAY_SMOKE_MAX_TASKS !== '1') throw new Error('GATEWAY_SMOKE_MAX_TASKS must be exactly 1')
if (new URL(base).protocol !== 'https:') throw new Error('GATEWAY_SMOKE_BASE_URL must use HTTPS')

const protocol = 'bb-provider-gateway/1.0'
const auth = () => ({ Authorization: `Bearer ${token}`, 'X-BB-Provider-Protocol': protocol })

async function readBytesBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Gateway smoke response exceeded its byte limit')
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('Gateway smoke response exceeded its byte limit')
      chunks.push(value)
    }
  } finally {
    if (total > maxBytes) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength }
  return result
}

const modelsResponse = await fetch(`${base}/v1/models`, { headers: auth(), signal: AbortSignal.timeout(30_000) })
if (!modelsResponse.ok) throw new Error(`Gateway model catalog failed with ${modelsResponse.status}`)
const modelsBytes = await readBytesBounded(modelsResponse, 128 * 1024)
let modelIds: string[]
try {
  const catalog = JSON.parse(new TextDecoder().decode(modelsBytes)) as { data?: Array<{ id?: unknown }> }
  modelIds = (catalog.data ?? []).map(item => item.id).filter((id): id is string => typeof id === 'string')
} catch { throw new Error('Gateway model catalog returned invalid JSON') }
if (!modelIds.includes('deepseek-v4-flash') || !modelIds.includes('deepseek-v4-pro')) {
  throw new Error('Gateway model catalog omitted a registered DeepSeek model')
}

const operationId = `gateway_smoke_${randomUUID().replaceAll('-', '')}`
const body = JSON.stringify({
  model: 'deepseek-v4-flash',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with exactly BB_OK.' }] }],
  stream: true,
  max_output_tokens: 32,
})
const responseHeaders = {
  ...auth(),
  'Content-Type': 'application/json',
  'X-BB-Operation-ID': operationId,
}

type ResultBinding = { operation: string; capability: string; fingerprint: string }
async function runResponse(): Promise<{ bytes: Uint8Array; binding: ResultBinding }> {
  const response = await fetch(`${base}/v1/responses`, {
    method: 'POST', headers: responseHeaders, body, signal: AbortSignal.timeout(180_000),
  })
  if (!response.ok) {
    await readBytesBounded(response, 256 * 1024).catch(() => new Uint8Array())
    throw new Error(`Gateway Responses smoke failed with ${response.status}`)
  }
  const binding = {
    operation: response.headers.get('X-BB-Result-Operation') ?? '',
    capability: response.headers.get('X-BB-Result-Capability') ?? '',
    fingerprint: response.headers.get('X-BB-Result-Fingerprint') ?? '',
  }
  if (binding.operation !== operationId || binding.capability !== 'TextReasoning' || !/^[a-f0-9]{64}$/.test(binding.fingerprint)) {
    throw new Error('Gateway Responses smoke omitted its durable result binding')
  }
  const bytes = await readBytesBounded(response, 2 * 1024 * 1024)
  const stream = new TextDecoder().decode(bytes)
  if (!stream.includes('response.completed') && !stream.includes('[DONE]')) throw new Error('Gateway Responses stream did not complete')
  if (!stream.includes('BB_OK')) throw new Error('Gateway Responses smoke did not contain the requested deterministic marker')
  return { bytes, binding }
}

const first = await runResponse()
const replay = await runResponse()
if (Buffer.compare(Buffer.from(first.bytes), Buffer.from(replay.bytes)) !== 0) throw new Error('Gateway idempotent replay changed the durable response')

const acknowledgement = await fetch(`${base}/v1/operations/ack`, {
  method: 'POST',
  headers: {
    ...auth(),
    'X-BB-Result-Operation': first.binding.operation,
    'X-BB-Result-Capability': first.binding.capability,
    'X-BB-Result-Fingerprint': first.binding.fingerprint,
  },
  signal: AbortSignal.timeout(30_000),
})
if (acknowledgement.status !== 204) throw new Error(`Gateway result acknowledgement failed with ${acknowledgement.status}`)
console.log(`GATEWAY_SMOKE_OK operation=${operationId} models=${modelIds.join(',')}`)
