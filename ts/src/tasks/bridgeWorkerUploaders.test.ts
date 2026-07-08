import { expect, test } from 'bun:test'
import { BridgeSerialBatchUploader, BridgeWorkerStateUploader } from './bridgeWorkerUploaders'

test('BridgeSerialBatchUploader batches events and retries before flush resolves', async () => {
  const batches: number[][] = []
  let attempts = 0
  const uploader = new BridgeSerialBatchUploader<number>({
    maxBatchSize: 2,
    maxQueueSize: 10,
    send: async batch => {
      attempts++
      if (attempts === 1) throw new Error('temporary')
      batches.push(batch)
    },
    baseDelayMs: 1,
    maxDelayMs: 1,
    jitterMs: 0,
  })

  await uploader.enqueue([1, 2, 3])
  await uploader.flush()
  expect(batches).toEqual([[1, 2], [3]])
})

test('BridgeWorkerStateUploader coalesces metadata patches with last value wins', async () => {
  const sent: Record<string, unknown>[] = []
  let resolveFirst: (() => void) | undefined
  const firstBlocked = new Promise<void>(resolve => { resolveFirst = resolve })
  let calls = 0
  const uploader = new BridgeWorkerStateUploader({
    send: async body => {
      calls++
      if (calls === 1) await firstBlocked
      sent.push(body)
      return true
    },
    baseDelayMs: 1,
    maxDelayMs: 1,
    jitterMs: 0,
  })

  uploader.enqueue({ worker_status: 'running', external_metadata: { model: 'a' } })
  uploader.enqueue({ worker_status: 'requires_action', external_metadata: { pending_action: { request_id: 'req_1' } } })
  uploader.enqueue({ external_metadata: { model: 'b' } })
  resolveFirst?.()
  await uploader.flush()

  expect(sent).toEqual([
    { worker_status: 'running', external_metadata: { model: 'a' } },
    { worker_status: 'requires_action', external_metadata: { pending_action: { request_id: 'req_1' }, model: 'b' } },
  ])
})
