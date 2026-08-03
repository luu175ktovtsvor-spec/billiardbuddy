import { expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { productGatewayTarget } from '../src/server/product/productGatewayRuntime.js'
import {
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
} from '../shared/product/providerGateway.js'

type ImageTaskResponse = {
  task_id?: unknown
  status?: unknown
  reused?: unknown
}

const CONFIRMATION = 'ONE_BILLED_IMAGE_TASK'
const permittedStatuses = new Set(['queued', 'running', 'succeeded', 'failed', 'cancelled'])

function requireSmokeConfiguration(): { baseUrl: string; token: string; timeoutMs: number } {
  if (process.env.BILLIARDBUDDY_IMAGE_PROVIDER_SMOKE !== '1') {
    throw new Error('Set BILLIARDBUDDY_IMAGE_PROVIDER_SMOKE=1 to permit the real image protocol smoke')
  }
  if (process.env.BILLIARDBUDDY_IMAGE_PROVIDER_SMOKE_CONFIRMATION !== CONFIRMATION) {
    throw new Error(`Set BILLIARDBUDDY_IMAGE_PROVIDER_SMOKE_CONFIRMATION=${CONFIRMATION} to acknowledge one billable task`)
  }
  if (process.env.BILLIARDBUDDY_IMAGE_PROVIDER_SMOKE_MAX_TASKS !== '1') {
    throw new Error('BILLIARDBUDDY_IMAGE_PROVIDER_SMOKE_MAX_TASKS must be exactly 1')
  }
  const timeoutMs = Number(process.env.BILLIARDBUDDY_IMAGE_PROVIDER_SMOKE_TIMEOUT_MS ?? '30000')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5_000 || timeoutMs > 60_000) {
    throw new Error('BILLIARDBUDDY_IMAGE_PROVIDER_SMOKE_TIMEOUT_MS must be an integer between 5000 and 60000')
  }
  const target = productGatewayTarget()
  if (!target) throw new Error('BB_GATEWAY_URL and BB_GATEWAY_TOKEN must name the approved Gateway before a smoke can run')
  return { ...target, timeoutMs }
}

async function parseImageTask(response: Response): Promise<ImageTaskResponse> {
  return await response.json().catch(() => ({})) as ImageTaskResponse
}

function assertTask(body: ImageTaskResponse): asserts body is ImageTaskResponse & { task_id: string; status: string } {
  expect(typeof body.task_id).toBe('string')
  expect(typeof body.status).toBe('string')
  expect(permittedStatuses.has(body.status as string)).toBeTrue()
}

/**
 * This suite is intentionally isolated from `bun run test`.  It only creates
 * one billable logical operation after an explicit acknowledgement, retains
 * the exact Idempotency-Key for a duplicate protocol replay, uses one bounded
 * status poll, then cancels an unfinished task.  It never ACKs or downloads a
 * result because the Sidecar owns that durable handoff.
 */
test('explicit budget-controlled image Provider smoke validates submit, idempotency replay and bounded status/cancel protocol', async () => {
  const target = requireSmokeConfiguration()
  const idempotencyKey = `bb-image-provider-smoke-${randomUUID().replaceAll('-', '')}`
  const body = JSON.stringify({
    mode: 'generate',
    model: 'gpt-image-2',
    prompt: 'BilliardBuddy protocol smoke: a neutral gray square, no text, no logo, no people.',
    n: 1,
    size: '1024x1024',
  })
  const headers = {
    Authorization: `Bearer ${target.token}`,
    'Content-Type': 'application/json',
    'Idempotency-Key': idempotencyKey,
    [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
  }
  const deadline = AbortSignal.timeout(target.timeoutMs)
  let taskId: string | undefined
  let terminal = false
  try {
    const submitted = await fetch(`${target.baseUrl}/v1/images/tasks`, {
      method: 'POST',
      headers,
      body,
      signal: deadline,
    })
    expect(submitted.status).toBe(202)
    const first = await parseImageTask(submitted)
    assertTask(first)
    taskId = first.task_id

    // A replay of the same logical task must not authorize a second paid task.
    const replay = await fetch(`${target.baseUrl}/v1/images/tasks`, {
      method: 'POST',
      headers,
      body,
      signal: deadline,
    })
    expect(replay.status).toBe(202)
    const replayed = await parseImageTask(replay)
    assertTask(replayed)
    expect(replayed.task_id).toBe(taskId)

    const polled = await fetch(`${target.baseUrl}/v1/images/tasks/${encodeURIComponent(taskId)}?metadata_only=1`, {
      headers: {
        Authorization: `Bearer ${target.token}`,
        [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
      },
      signal: deadline,
    })
    expect(polled.status).toBe(200)
    const status = await parseImageTask(polled)
    assertTask(status)
    expect(status.task_id).toBe(taskId)
    terminal = status.status === 'succeeded' || status.status === 'failed' || status.status === 'cancelled'
  } finally {
    if (taskId && !terminal) {
      const cancelled = await fetch(`${target.baseUrl}/v1/images/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.token}`,
          [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
        },
        signal: AbortSignal.timeout(Math.min(15_000, target.timeoutMs)),
      })
      expect(cancelled.status).toBe(200)
      const result = await parseImageTask(cancelled)
      assertTask(result)
      expect(result.status).toBe('cancelled')
    }
  }
})
