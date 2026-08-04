import { expect, test } from 'bun:test'

import { createGatewayFetch, MemoryUsageStore } from './app.ts'
import { AuthAuthority } from './installationAuth.ts'
import type {
  CapacityPermit,
  CapacitySnapshot,
  GatewayCapacityBackend,
  GatewayCapacityBackendConfig,
  GatewayCapacityBackendFactory,
  GatewayCapacityPool,
  GatewayMimoReservations,
  GatewayRateLimiter,
  MimoLane,
} from './modelCapacity.ts'
import {
  createLocalGatewayCapacityBackend,
  FairCapacityScheduler,
  MimoReservationScheduler,
  ProviderRateLimiter,
} from './modelCapacity.ts'

function snapshot(active: number): CapacitySnapshot {
  return {
    active,
    queued: 0,
    maxConcurrent: 99,
    maxConcurrentPerUser: 99,
    maxConcurrentPerToken: 99,
    maxInflightPerUser: 99,
    queueMax: 99,
    oldestQueueMs: 0,
  }
}

function pool(active: number, onFence?: () => void): GatewayCapacityPool {
  return {
    acquire: async (): Promise<CapacityPermit> => ({
      async assertCurrent() { onFence?.() },
      release() {},
    }),
    snapshot: () => snapshot(active),
  }
}

function minimumBackendConfig(): GatewayCapacityBackendConfig {
  const capacity = {
    maxConcurrent: 1,
    maxConcurrentPerUser: 1,
    maxConcurrentPerToken: 1,
    queueMax: 0,
    maxInflightPerUser: 1,
  }
  const rate = { rpm: 1, queueMax: 0 }
  return {
    mimo: {
      scope: { kind: 'provider-account', account_key: 'gateway-mimo-account:test:v1', scope_key: 'gateway-mimo-account:test:v1' },
      reservations: {
        maxConcurrent: 2,
        mediaConcurrent: 1,
        visionConcurrent: 1,
        maxConcurrentPerUser: 1,
        maxConcurrentPerToken: 1,
        maxInflightPerUser: 1,
        mediaQueueMax: 0,
        visionQueueMax: 0,
        visionMaxConcurrentPerUser: 1,
        visionMaxInflightPerUser: 1,
      },
      rate,
    },
    deepseek: { scope: { kind: 'provider-account', account_key: 'gateway-deepseek-account:test:v1', scope_key: 'gateway-deepseek-account:test:v1' }, capacity, rate },
    qwen: { scope: { kind: 'provider-account', account_key: 'gateway-qwen-account:test:v1', scope_key: 'gateway-qwen-account:test:v1' }, capacity, rate },
    transcription: { scope: { kind: 'provider-account', account_key: 'gateway-funasr-account:test:v1', scope_key: 'gateway-funasr-account:test:v1' }, capacity, rate },
    bootstrap: { scope: { kind: 'bootstrap', scope_key: 'gateway-bootstrap' }, rate },
    ingress: { scope: { kind: 'ingress', scope_key: 'gateway-ingress' } },
  }
}

test('本地容量工厂一次性创建公平池、MiMo 原子预留和全部 Provider RPM 桶', () => {
  const backend = createLocalGatewayCapacityBackend(minimumBackendConfig())

  expect(backend.mimo).toBeInstanceOf(MimoReservationScheduler)
  expect(backend.deepseek).toBeInstanceOf(FairCapacityScheduler)
  expect(backend.qwen).toBeInstanceOf(FairCapacityScheduler)
  expect(backend.transcription).toBeInstanceOf(FairCapacityScheduler)
  expect(backend.rates.mimo).toBeInstanceOf(ProviderRateLimiter)
  expect(backend.rates.deepseek).toBeInstanceOf(ProviderRateLimiter)
  expect(backend.rates.qwen).toBeInstanceOf(ProviderRateLimiter)
  expect(backend.rates.transcription).toBeInstanceOf(ProviderRateLimiter)
  expect(backend.rates.bootstrap).toBeInstanceOf(ProviderRateLimiter)
})

test('Gateway 仅从容量策略构造可替换的整套容量后端，并在业务路径使用注入的 RPM 桶', async () => {
  let received: GatewayCapacityBackendConfig | undefined
  const rateCalls: string[] = []
  let deepseekFenceChecks = 0
  const rate = (name: string): GatewayRateLimiter => ({
    acquire: async () => { rateCalls.push(name) },
  })
  const mimoMedia = pool(42)
  const mimoVision = pool(43)
  const mimo: GatewayMimoReservations = {
    acquire: async (lane) => await (lane === 'media' ? mimoMedia : mimoVision).acquire('ignored', { maxWaitMs: 0 }),
    forLane: (lane: MimoLane) => lane === 'media' ? mimoMedia : mimoVision,
    snapshot: () => snapshot(44),
    laneSnapshot: lane => (lane === 'media' ? mimoMedia : mimoVision).snapshot(),
  }
  const backend: GatewayCapacityBackend = {
    mimo,
    deepseek: pool(41, () => { deepseekFenceChecks += 1 }),
    qwen: pool(45),
    transcription: pool(46),
    rates: {
      mimo: rate('mimo'),
      deepseek: rate('deepseek'),
      qwen: rate('qwen'),
      transcription: rate('transcription'),
      bootstrap: rate('bootstrap'),
    },
  }
  const factory: GatewayCapacityBackendFactory = {
    create(config) {
      received = config
      return backend
    },
  }
  const authority = new AuthAuthority({
    dbPath: ':memory:',
    signingKey: 'gateway-auth-signing-key-12345678901234567890',
  })
  const gateway = createGatewayFetch({
    env: {
      GW_CAPACITY_POLICY_REVISION: 'capacity-backend-test-v1',
      GW_DEEPSEEK_RPM: '17',
      GW_DEEPSEEK_CONC: '3',
      GW_DEEPSEEK_USER_CONC: '1',
      GW_DEEPSEEK_TOKEN_CONC: '2',
      GW_DEEPSEEK_INFLIGHT_PER_USER: '3',
      GW_DEEPSEEK_QUEUE_MAX: '4',
      GW_DEEPSEEK_ACCOUNT_REF: 'deepseek-prod-a',
      GW_DEEPSEEK_ACCOUNT_BINDING_REVISION: '2026-08-04',
      GW_MIMO_RPM: '11',
      GW_MIMO_CONC: '4',
      GW_MIMO_MEDIA_CONC: '2',
      GW_VISION_CONC: '2',
      GW_MIMO_ACCOUNT_REF: 'mimo-prod-a',
      GW_MIMO_ACCOUNT_BINDING_REVISION: '2026-08-04',
      GW_QWEN_ACCOUNT_REF: 'qwen-prod-a',
      GW_QWEN_ACCOUNT_BINDING_REVISION: '2026-08-04',
      GW_TRANSCRIBE_RPM: '5',
      GW_TRANSCRIBE_CONC: '2',
      GW_TRANSCRIBE_QUEUE_MAX: '3',
      GW_FUNASR_ACCOUNT_REF: 'funasr-prod-a',
      GW_FUNASR_ACCOUNT_BINDING_REVISION: '2026-08-04',
      GW_BOOTSTRAP_RPM: '9',
      BB_GATEWAY_MODEL: 'deepseek-v4-flash',
      GW_DEEPSEEK_KEY: 'deepseek-test-key',
      GW_DEEPSEEK_BASE: 'https://deepseek.example.test',
    },
    authority,
    usageStore: new MemoryUsageStore(),
    transcribeImpl: null,
    capacityBackendFactory: factory,
    fetchImpl: async () => new Response(
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1,"total_tokens":2}}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    ),
  })

  const bootstrap = await gateway(new Request('https://gateway.example.test/v1/auth/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ installation_id: 'capacity-backend-test-installation' }),
  }))
  expect(bootstrap.status).toBe(200)
  expect(rateCalls).toEqual(['bootstrap'])
  const tokens = await bootstrap.json() as { access_token: string }

  const health = await gateway(new Request('https://gateway.example.test/healthz', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  }))
  expect(health.status).toBe(200)
  const payload = await health.json() as { capacity: Record<string, CapacitySnapshot> }
  expect(payload.capacity.deepseek.active).toBe(41)
  expect(payload.capacity.mimo.active).toBe(44)
  expect(payload.capacity.mimo_media.active).toBe(42)
  expect(payload.capacity.qwen.active).toBe(45)
  expect(payload.capacity.transcription.active).toBe(46)
  const managed = await gateway(new Request('https://gateway.example.test/v1/responses', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      'Content-Type': 'application/json',
      'X-BB-Provider-Protocol': 'bb-provider-gateway/1.0',
      'X-BB-Operation-ID': 'capacity_backend_text_operation',
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'capacity fence' }] }],
      stream: true,
      max_output_tokens: 8,
    }),
  }))
  expect(managed.status).toBe(200)
  await managed.text()
  expect(rateCalls).toContain('deepseek')
  expect(deepseekFenceChecks).toBeGreaterThanOrEqual(1)
  expect(received).toMatchObject({
    mimo: {
      scope: { kind: 'provider-account', account_key: 'gateway-mimo-account:mimo-prod-a:2026-08-04' },
      reservations: { maxConcurrent: 4, mediaConcurrent: 2, visionConcurrent: 2 },
      rate: { rpm: 11, queueMax: 24 },
    },
    deepseek: {
      scope: { kind: 'provider-account', account_key: 'gateway-deepseek-account:deepseek-prod-a:2026-08-04' },
      capacity: { maxConcurrent: 3, maxConcurrentPerUser: 1, maxConcurrentPerToken: 2, maxInflightPerUser: 3, queueMax: 4 },
      rate: { rpm: 17, queueMax: 4 },
    },
    qwen: {
      scope: { kind: 'provider-account', account_key: 'gateway-qwen-account:qwen-prod-a:2026-08-04' },
    },
    transcription: {
      scope: { kind: 'provider-account', account_key: 'gateway-funasr-account:funasr-prod-a:2026-08-04' },
      capacity: { maxConcurrent: 2, queueMax: 3 },
      rate: { rpm: 5, queueMax: 3 },
    },
    bootstrap: { scope: { kind: 'bootstrap', scope_key: 'gateway-bootstrap' }, rate: { rpm: 9, queueMax: 0 } },
    ingress: { scope: { kind: 'ingress', scope_key: 'gateway-ingress' } },
  })
})
