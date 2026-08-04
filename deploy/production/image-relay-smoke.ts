import { createHash, randomUUID } from 'node:crypto'

const base = (process.env.IMAGE_RELAY_SMOKE_BASE_URL ?? 'https://zzyppz.cn/image-generation').replace(/\/+$/, '')
const token = process.env.IMAGE_RELAY_SMOKE_ACCESS_TOKEN?.trim()
const confirmation = process.env.IMAGE_RELAY_SMOKE_CONFIRMATION
const model = process.env.IMAGE_RELAY_SMOKE_MODEL?.trim() || 'gpt-image-2'
const taskLimit = process.env.IMAGE_RELAY_SMOKE_MAX_TASKS

if (!token || token.length < 16) throw new Error('IMAGE_RELAY_SMOKE_ACCESS_TOKEN is required and is never persisted by this smoke tool')
if (confirmation !== 'ONE_BILLED_IMAGE_TASK') throw new Error('IMAGE_RELAY_SMOKE_CONFIRMATION must be ONE_BILLED_IMAGE_TASK')
if (taskLimit !== '1') throw new Error('IMAGE_RELAY_SMOKE_MAX_TASKS must be exactly 1')
if (new URL(base).protocol !== 'https:') throw new Error('IMAGE_RELAY_SMOKE_BASE_URL must use HTTPS')
if (!/^[A-Za-z0-9._-]{1,120}$/.test(model)) throw new Error('IMAGE_RELAY_SMOKE_MODEL is invalid')

const protocolHeader = 'X-BB-Provider-Protocol'
const protocolVersion = 'bb-provider-gateway/1.0'
const handoffHeader = 'X-BB-Media-Result-Handoff'
const authHeaders = () => ({ Authorization: `Bearer ${token}`, [protocolHeader]: protocolVersion })
const sleep = async (milliseconds: number) => await new Promise(resolve => setTimeout(resolve, milliseconds))

type Task = {
  task_id?: string
  operation_id?: string
  status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'failed_unknown' | 'cancelled'
  reused?: boolean
  poll_after_seconds?: number
  result_urls?: string[]
  result_count?: number
  result_acknowledged?: boolean
  result_available?: boolean
  output_count?: number
  provider_receipt_hash?: string
}

async function readBytesBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > maxBytes) throw new Error('Image Relay smoke response exceeded its byte limit')
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error('Image Relay smoke response exceeded its byte limit')
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

async function readJson<T>(response: Response, maxBytes = 256 * 1024): Promise<T> {
  const bytes = await readBytesBounded(response, maxBytes)
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T } catch { throw new Error(`Image Relay returned invalid JSON (${response.status})`) }
}

async function requestTask(path: string, init: RequestInit = {}, maxBytes = 256 * 1024): Promise<Task> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: { ...authHeaders(), ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(30_000),
  })
  const body = await readJson<Task>(response, maxBytes)
  if (!response.ok) throw new Error(`Image Relay ${init.method ?? 'GET'} ${path} failed with ${response.status}`)
  return body
}

const idempotencyKey = `image_smoke_${randomUUID().replaceAll('-', '')}`
const taskBody = JSON.stringify({
  mode: 'generate',
  model,
  prompt: 'BilliardBuddy controlled deployment smoke: one neutral gray square, no text, no logo, no people.',
  n: 1,
  size: '1024x1024',
})
const submitHeaders = {
  ...authHeaders(),
  'Content-Type': 'application/json',
  'Idempotency-Key': idempotencyKey,
}

let taskId: string | undefined
let lastStatus: Task['status']
try {
  const submittedResponse = await fetch(`${base}/v1/images/tasks`, {
    method: 'POST', headers: submitHeaders, body: taskBody, signal: AbortSignal.timeout(30_000),
  })
  if (submittedResponse.status !== 202) throw new Error(`Image Relay submit failed with ${submittedResponse.status}`)
  const submitted = await readJson<Task>(submittedResponse)
  if (!submitted.task_id || !submitted.status) throw new Error('Image Relay submit omitted task identity')
  taskId = submitted.task_id
  lastStatus = submitted.status

  const replayResponse = await fetch(`${base}/v1/images/tasks`, {
    method: 'POST', headers: submitHeaders, body: taskBody, signal: AbortSignal.timeout(30_000),
  })
  if (replayResponse.status !== 202) throw new Error(`Image Relay idempotent replay failed with ${replayResponse.status}`)
  const replay = await readJson<Task>(replayResponse)
  if (replay.task_id !== taskId || replay.reused !== true) throw new Error('Image Relay replay created a second logical task')

  const deadline = Date.now() + 6 * 60_000
  let terminal: Task = replay
  while (Date.now() < deadline && ['queued', 'running'].includes(terminal.status ?? '')) {
    await sleep(Math.max(1_000, Math.min(10_000, (terminal.poll_after_seconds ?? 2) * 1_000)))
    terminal = await requestTask(`/v1/images/tasks/${encodeURIComponent(taskId)}?metadata_only=1`)
    lastStatus = terminal.status
  }
  if (terminal.status !== 'succeeded') throw new Error(`Image Relay task did not succeed (${terminal.status ?? 'unknown'})`)
  if (!terminal.provider_receipt_hash) throw new Error('Image Relay task omitted its provider receipt hash')

  const handoff = await requestTask(`/v1/images/tasks/${encodeURIComponent(taskId)}`, {
    headers: { [handoffHeader]: 'direct-v1' },
  })
  if (handoff.status !== 'succeeded' || handoff.result_count !== 1 || handoff.result_urls?.length !== 1) {
    throw new Error('Image Relay did not issue exactly one direct result grant')
  }
  const resultUrl = new URL(handoff.result_urls[0]!)
  if (resultUrl.protocol !== 'https:' || resultUrl.origin !== new URL(base).origin) throw new Error('Image Relay issued a result URL outside its approved origin')
  const resultResponse = await fetch(resultUrl, { headers: authHeaders(), signal: AbortSignal.timeout(120_000) })
  if (!resultResponse.ok) throw new Error(`Image Relay result download failed with ${resultResponse.status}`)
  const result = await readJson<{ status?: string; operation_id?: string; data?: Array<{ b64_json?: string }> }>(resultResponse, 48 * 1024 * 1024)
  const encoded = result.data?.[0]?.b64_json
  if (result.status !== 'succeeded' || result.operation_id !== taskId || !encoded || !/^[A-Za-z0-9+/=]+$/.test(encoded)) {
    throw new Error('Image Relay direct result has an invalid envelope')
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength < 64 || bytes.byteLength > 32 * 1024 * 1024) throw new Error('Image Relay direct result has an invalid byte size')
  const digest = createHash('sha256').update(bytes).digest('hex')

  const acknowledged = await requestTask(`/v1/images/tasks/${encodeURIComponent(taskId)}/ack`, { method: 'POST' })
  if (!acknowledged.result_acknowledged) throw new Error('Image Relay did not acknowledge the durable result')
  const afterAck = await requestTask(`/v1/images/tasks/${encodeURIComponent(taskId)}?metadata_only=1`)
  if (!afterAck.result_acknowledged || afterAck.result_available || (afterAck.output_count ?? 0) !== 0) {
    throw new Error('Image Relay retained result bytes after acknowledgement')
  }
  const retiredGrant = await fetch(resultUrl, { headers: authHeaders(), signal: AbortSignal.timeout(30_000) })
  if (retiredGrant.status !== 410) {
    await readBytesBounded(retiredGrant, 256 * 1024).catch(() => new Uint8Array())
    throw new Error(`Image Relay result grant remained readable after acknowledgement (${retiredGrant.status})`)
  }
  console.log(`IMAGE_RELAY_SMOKE_OK task=${taskId} receipt=${terminal.provider_receipt_hash} sha256=${digest}`)
} finally {
  if (taskId && lastStatus === 'queued') {
    const response = await fetch(`${base}/v1/images/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST', headers: authHeaders(), signal: AbortSignal.timeout(15_000),
    }).catch(() => undefined)
    if (response && ![200, 409].includes(response.status)) throw new Error(`Image Relay cleanup cancel failed with ${response.status}`)
  }
}
