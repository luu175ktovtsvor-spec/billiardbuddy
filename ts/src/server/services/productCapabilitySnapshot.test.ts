import { expect, test } from 'bun:test'
import { ProductCapabilitySnapshotService } from './productCapabilitySnapshot'

const gateway = {
  features: {
    assistant: true,
    image_understanding: true,
    image_creation: true,
    voice_input: true,
  },
  usage: {
    TextReasoning: { remaining_percent: 72, exhausted: false },
    VisualEvidence: { remaining_percent: 0, exhausted: true },
    SpeechTranscription: { remaining_percent: 95, exhausted: false },
  },
  resets_at: '2026-07-27T00:00:00.000Z',
} as const

function service(overrides: ConstructorParameters<typeof ProductCapabilitySnapshotService>[0] = {}) {
  return new ProductCapabilitySnapshotService({
    gatewayConfigured: () => true,
    gatewayStatus: async () => gateway,
    consentStatus: async () => ({ available: true, active: true }),
    mediaToolchainStatus: async () => ({ ffmpeg: { available: true }, ffprobe: { available: true } }),
    browserStatus: () => ({ state: 'connected', connected_sessions: 1 }),
    scheduledRuns: async () => [{
      id: 'run-1', taskId: 'task-1', taskTitle: '日报', startedAt: '2026-07-26T10:00:00.000Z',
      occurrenceAt: '2026-07-26T10:00:00.000Z', trigger: 'schedule', status: 'running',
    }],
    now: () => new Date('2026-07-26T10:01:00.000Z'),
    ...overrides,
  })
}

test('aggregates actionable product capability states without technical gateway details', async () => {
  const snapshot = await service().snapshot()
  expect(snapshot).toEqual({
    schema_version: 1,
    observed_at: '2026-07-26T10:01:00.000Z',
    capabilities: [
      { id: 'assistant', state: 'available', quota: { remaining_percent: 72, resets_at: gateway.resets_at } },
      { id: 'image_understanding', state: 'degraded', reason_code: 'daily_quota_used', repair_action: 'wait_for_reset', quota: { remaining_percent: 0, resets_at: gateway.resets_at } },
      { id: 'image_creation', state: 'available' },
      { id: 'voice_input', state: 'available', quota: { remaining_percent: 95, resets_at: gateway.resets_at } },
      { id: 'video_editing', state: 'available' },
      { id: 'scheduled_tasks', state: 'running' },
      { id: 'recruiting_browser', state: 'running' },
    ],
  })
  expect(JSON.stringify(snapshot)).not.toMatch(/provider|model|api.?key|token|url|concurrency|queue/i)
})

test('reports setup, privacy and repair states from real dependency outcomes', async () => {
  const setup = await service({ gatewayConfigured: () => false }).snapshot()
  expect(setup.capabilities.slice(0, 4)).toEqual([
    'assistant', 'image_understanding', 'image_creation', 'voice_input',
  ].map(id => ({ id, state: 'configured', reason_code: 'installation_activation_required', repair_action: 'restart_app' })))

  const privacy = await service({ consentStatus: async () => ({ available: true, active: false }) }).snapshot()
  expect(privacy.capabilities.find(item => item.id === 'assistant')).toEqual({
    id: 'assistant', state: 'configured', reason_code: 'privacy_confirmation_required', repair_action: 'open_privacy',
  })
  expect(privacy.capabilities.find(item => item.id === 'image_creation')).toEqual({ id: 'image_creation', state: 'available' })
})

test('fails remote, media, scheduler and browser checks closed with accurate repair entries', async () => {
  const snapshot = await service({
    gatewayStatus: async () => { throw new Error('offline') },
    mediaToolchainStatus: async () => ({ ffmpeg: { available: false }, ffprobe: { available: true } }),
    browserStatus: () => ({ state: 'waiting_for_extension', connected_sessions: 0, reason: 'EXTENSION_NOT_CONNECTED' }),
    scheduledRuns: async () => { throw new Error('store unavailable') },
  }).snapshot()
  expect(snapshot.capabilities.find(item => item.id === 'assistant')).toMatchObject({ state: 'degraded', reason_code: 'service_unreachable', repair_action: 'retry' })
  expect(snapshot.capabilities.find(item => item.id === 'video_editing')).toMatchObject({ state: 'degraded', reason_code: 'media_tools_missing', repair_action: 'check_update' })
  expect(snapshot.capabilities.find(item => item.id === 'scheduled_tasks')).toMatchObject({ state: 'degraded', reason_code: 'service_unavailable', repair_action: 'retry' })
  expect(snapshot.capabilities.find(item => item.id === 'recruiting_browser')).toMatchObject({ state: 'configured', reason_code: 'browser_extension_disconnected', repair_action: 'install_recruiting_browser' })
})
