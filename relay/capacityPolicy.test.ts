import { describe, expect, test } from 'bun:test'

import { relayCapacityPolicyFromEnvironment } from './capacityPolicy'
import { validateRelayDeploymentEnvironment } from './validate-deployment-env'

describe('Relay capacity policy', () => {
  test('保留小规模图片 Relay 的现有资源准入默认值', () => {
    const policy = relayCapacityPolicyFromEnvironment({})

    expect(policy).toEqual({
      revision: 'relay-image-small-scale-v1',
      providers: {
        openai: { concurrency: 2, owner_concurrency: 1, requests_per_minute: 12, upstream_timeout_ms: 5 * 60_000 },
        seedream: { concurrency: 2, owner_concurrency: 1, requests_per_minute: 30, upstream_timeout_ms: 5 * 60_000 },
      },
      admission: {
        queue_max: 24,
        owner_task_max: 4,
        max_body_bytes: 32 * 1024 * 1024,
        pending_input_bytes_max: 64 * 1024 * 1024,
        active_input_bytes_max: 256 * 1024 * 1024,
      },
    })
  })

  test('兼容当前 Relay 环境变量并集中 RPM 与超时覆盖', () => {
    const policy = relayCapacityPolicyFromEnvironment({
      RELAY_CAPACITY_POLICY_REVISION: 'relay-image-small-scale-v2',
      RELAY_IMG_CONC: '8',
      RELAY_IMG_USER_CONC: '2',
      RELAY_SEEDREAM_CONC: '4',
      RELAY_SEEDREAM_USER_CONC: '3',
      RELAY_OPENAI_RPM: '30',
      RELAY_SEEDREAM_RPM: '40',
      RELAY_UPSTREAM_TIMEOUT_MS: '60000',
      RELAY_QUEUE_MAX: '80',
      RELAY_USER_MAX: '6',
      RELAY_MAX_BODY_BYTES: '1024',
      RELAY_PENDING_INPUT_BYTES_MAX: '2048',
      RELAY_ACTIVE_INPUT_BYTES_MAX: '4096',
    })

    expect(policy.revision).toBe('relay-image-small-scale-v2')
    expect(policy.providers.openai).toEqual({ concurrency: 8, owner_concurrency: 2, requests_per_minute: 30, upstream_timeout_ms: 60000 })
    expect(policy.providers.seedream).toEqual({ concurrency: 4, owner_concurrency: 3, requests_per_minute: 40, upstream_timeout_ms: 60000 })
    expect(policy.admission).toEqual({ queue_max: 80, owner_task_max: 6, max_body_bytes: 1024, pending_input_bytes_max: 2048, active_input_bytes_max: 4096 })
  })

  test('拒绝无效数值和相互冲突的资源边界', () => {
    expect(() => relayCapacityPolicyFromEnvironment({ RELAY_IMG_CONC: '1.5' }))
      .toThrow('RELAY_IMG_CONC')
    expect(() => relayCapacityPolicyFromEnvironment({ RELAY_IMG_CONC: '2', RELAY_IMG_USER_CONC: '3' }))
      .toThrow('openai owner concurrency')
    expect(() => relayCapacityPolicyFromEnvironment({ RELAY_QUEUE_MAX: '2', RELAY_USER_MAX: '3' }))
      .toThrow('RELAY_USER_MAX')
    expect(() => relayCapacityPolicyFromEnvironment({ RELAY_MAX_BODY_BYTES: '65', RELAY_PENDING_INPUT_BYTES_MAX: '64' }))
      .toThrow('RELAY_MAX_BODY_BYTES')
    expect(() => relayCapacityPolicyFromEnvironment({ RELAY_PENDING_INPUT_BYTES_MAX: '513', RELAY_ACTIVE_INPUT_BYTES_MAX: '512' }))
      .toThrow('RELAY_PENDING_INPUT_BYTES_MAX')
    expect(() => relayCapacityPolicyFromEnvironment({ RELAY_OPENAI_RPM: '121' }))
      .toThrow('RELAY_OPENAI_RPM')
    expect(() => relayCapacityPolicyFromEnvironment({ RELAY_UPSTREAM_TIMEOUT_MS: '999' }))
      .toThrow('RELAY_UPSTREAM_TIMEOUT_MS')
  })
})

describe('Image Relay deployment preflight', () => {
  test('在启动前统一校验持久化、凭据和容量策略', () => {
    const valid = {
      RELAY_DB: '/data/image-relay.db',
      RELAY_BLOB_DIR: '/data/blobs',
      RELAY_OPENAI_KEY: 'openai-key',
      RELAY_ARK_KEY: 'seedream-key',
      IMAGE_RELAY_GATEWAY_INTROSPECTION_BASE: 'http://gateway:8799',
      IMAGE_RELAY_GATEWAY_INTROSPECTION_TOKEN: 'i'.repeat(32),
      IMAGE_RELAY_PUBLIC_BASE: 'https://zzyppz.cn/image-generation',
      IMAGE_RELAY_RESULT_SIGNING_KEY: 's'.repeat(32),
    }
    expect(() => validateRelayDeploymentEnvironment(valid)).not.toThrow()
    expect(() => validateRelayDeploymentEnvironment({ ...valid, RELAY_DB: ':memory:' }))
      .toThrow('RELAY_DB')
    expect(() => validateRelayDeploymentEnvironment({ ...valid, RELAY_ARK_KEY: '' }))
      .toThrow('RELAY_ARK_KEY')
    expect(() => validateRelayDeploymentEnvironment({ ...valid, RELAY_QUEUE_MAX: '1000' }))
      .toThrow('RELAY_QUEUE_MAX')
  })
})
