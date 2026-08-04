import { describe, expect, test } from 'bun:test'
import { ProviderAdmissionError, ProviderAdmissionGate } from '../shared/kernel/providerAdmission.ts'

describe('ProviderAdmissionGate', () => {
  test('enforces global and owner active ceilings, then serves waiting owners fairly', async () => {
    const gate = new ProviderAdmissionGate({ maxActive: 1, maxActivePerOwner: 1, maxQueued: 4, maxQueuedPerOwner: 2, maxWaitMs: 1_000 })
    const firstA = await gate.acquire('owner-a')
    const secondA = gate.acquire('owner-a')
    const secondB = gate.acquire('owner-b')

    firstA.release()
    const nextB = await secondB
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 1, activeOwners: 1, queuedOwners: 1 })

    nextB.release()
    const nextA = await secondA
    nextA.release()
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0 })
  })

  test('keeps the queue bounded per owner and globally', async () => {
    const gate = new ProviderAdmissionGate({ maxActive: 1, maxActivePerOwner: 1, maxQueued: 2, maxQueuedPerOwner: 1, maxWaitMs: 1_000 })
    const active = await gate.acquire('owner-a')
    const waitingA = gate.acquire('owner-a')
    await expect(gate.acquire('owner-a')).rejects.toMatchObject({ code: 'ADMISSION_QUEUE_FULL', status: 429 })
    const waitingB = gate.acquire('owner-b')
    await expect(gate.acquire('owner-c')).rejects.toMatchObject({ code: 'ADMISSION_QUEUE_FULL', status: 429 })

    active.release()
    const permitB = await waitingB
    permitB.release()
    const permitA = await waitingA
    permitA.release()
  })

  test('removes cancelled work and reports a stable error type', async () => {
    const gate = new ProviderAdmissionGate({ maxActive: 1, maxActivePerOwner: 1, maxQueued: 2, maxWaitMs: 1_000 })
    const active = await gate.acquire('owner-a')
    const controller = new AbortController()
    const waiting = gate.acquire('owner-b', { signal: controller.signal })
    controller.abort()

    await expect(waiting).rejects.toBeInstanceOf(ProviderAdmissionError)
    await expect(waiting).rejects.toMatchObject({ code: 'ADMISSION_ABORTED', status: 499 })
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0, queuedOwners: 0 })
    active.release()
  })

  test('times out and closes queued work without affecting active permits', async () => {
    const gate = new ProviderAdmissionGate({ maxActive: 1, maxActivePerOwner: 1, maxQueued: 3, maxWaitMs: 10 })
    const active = await gate.acquire('owner-a')
    await expect(gate.acquire('owner-b')).rejects.toMatchObject({ code: 'ADMISSION_QUEUE_TIMEOUT', status: 429 })

    const waiting = gate.acquire('owner-b', { maxWaitMs: 1_000 })
    gate.close()
    await expect(waiting).rejects.toMatchObject({ code: 'ADMISSION_CLOSED', status: 503 })
    await expect(gate.acquire('owner-c')).rejects.toMatchObject({ code: 'ADMISSION_CLOSED', status: 503 })
    expect(gate.snapshot()).toMatchObject({ active: 1, queued: 0, closed: true })
    active.release()
    expect(gate.snapshot()).toMatchObject({ active: 0, queued: 0, closed: true })
  })
})
