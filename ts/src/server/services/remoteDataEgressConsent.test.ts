import { expect, test } from 'bun:test'
import { REMOTE_DATA_EGRESS_POLICY_REVISION } from '../../../shared/product/dataEgress.js'
import { RemoteDataEgressConsentService } from './remoteDataEgressConsent.js'

function memorySettings() {
  let value: Record<string, unknown> = { unrelated: 'kept' }
  return {
    getUserSettings: async () => value,
    mutateUserSettings: async (mutator: (current: Record<string, unknown>) => Record<string, unknown>) => {
      value = mutator(value)
    },
    read: () => value,
  }
}

test('managed remote consent is installation-bound, durable and revocable', async () => {
  const settings = memorySettings()
  let tick = 0
  const service = new RemoteDataEgressConsentService(
    settings,
    'installation-001',
    () => new Date(`2026-07-24T00:00:0${tick++}.000Z`),
  )

  expect(await service.status()).toMatchObject({ available: true, active: false })
  const granted = await service.grant({
    policy_revision: REMOTE_DATA_EGRESS_POLICY_REVISION,
    acknowledged: true,
  })
  expect(granted.active).toBe(true)
  expect(granted.receipt?.receipt_id).toMatch(/^[a-f0-9]{64}$/)
  expect(granted.receipt?.capabilities).toEqual([
    'TextReasoning', 'VisualEvidence', 'SpeechTranscription',
  ])
  expect(settings.read().unrelated).toBe('kept')

  const revoked = await service.revoke()
  expect(revoked.active).toBe(false)
  const persisted = settings.read().billiardBuddyRemoteDataEgressConsent as { receipts: Array<{ revoked_at: string | null }> }
  expect(persisted.receipts).toHaveLength(1)
  expect(persisted.receipts[0]?.revoked_at).toBe('2026-07-24T00:00:01.000Z')
})

test('tampered or cross-installation receipts never authorize egress', async () => {
  const settings = memorySettings()
  const first = new RemoteDataEgressConsentService(settings, 'installation-001')
  await first.grant({ policy_revision: REMOTE_DATA_EGRESS_POLICY_REVISION, acknowledged: true })
  expect(await first.activeReceipt()).not.toBeNull()
  expect(await new RemoteDataEgressConsentService(settings, 'installation-002').activeReceipt()).toBeNull()

  const stored = settings.read().billiardBuddyRemoteDataEgressConsent as { receipts: Array<Record<string, unknown>> }
  stored.receipts[0]!.receipt_id = '0'.repeat(64)
  expect(await first.activeReceipt()).toBeNull()
})

test('missing installation identity cannot mint a consent receipt', async () => {
  const service = new RemoteDataEgressConsentService(memorySettings(), '')
  expect(await service.status()).toMatchObject({ available: false, active: false })
  await expect(service.grant({
    policy_revision: REMOTE_DATA_EGRESS_POLICY_REVISION,
    acknowledged: true,
  })).rejects.toThrow('INSTALLATION_IDENTITY_UNAVAILABLE')
})
