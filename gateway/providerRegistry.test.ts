import { describe, expect, test } from 'bun:test'

import { MANAGED_MODEL_WORKLOADS } from '../ts/shared/product/providerContracts.ts'
import {
  MANAGED_MODEL_CATALOG,
  defaultManagedModelForWorkload,
  managedModelsForWorkload,
} from '../ts/shared/product/modelCatalog.ts'
import {
  PROVIDER_REGISTRY,
  buildProviderRegistryRuntimeEnv,
  imageAdviceRegistryEntry,
  mediaReasoningRegistryEntry,
  validateProviderRuntimeConfiguration,
  visualEvidenceRegistryEntry,
  workerTextReasoningEntry,
} from './providerRegistry.ts'

describe('provider model catalog', () => {
  test('每个 workload 只有一个默认模型且绑定执行运行时、容量池、额度桶和凭据槽', () => {
    for (const workload of MANAGED_MODEL_WORKLOADS) {
      const candidates = managedModelsForWorkload(workload)
      expect(candidates.length).toBeGreaterThan(0)
      const selected = defaultManagedModelForWorkload(workload)
      const bindings = selected.workload_bindings.filter(binding => binding.workload === workload)
      expect(bindings).toHaveLength(1)
      expect(bindings[0]?.default_for_workload).toBe(true)
      expect(typeof bindings[0]?.capacity_pool).toBe('string')
      expect(typeof bindings[0]?.quota_bucket).toBe('string')
      expect(typeof bindings[0]?.execution_runtime).toBe('string')
      expect(typeof bindings[0]?.credential_slot).toBe('string')
    }
  })

  test('图片建议、共享视觉和媒体推理使用不同 workload，不会互相替换协议', () => {
    expect(imageAdviceRegistryEntry()).toMatchObject({ model_id: 'qwen3-vl-flash', provider: 'qwen' })
    expect(visualEvidenceRegistryEntry()).toMatchObject({ model_id: 'mimo-v2.5', provider: 'mimo' })
    expect(mediaReasoningRegistryEntry()).toMatchObject({ model_id: 'mimo-v2.5', provider: 'mimo' })
    expect(defaultManagedModelForWorkload('video_visual_evidence')).toMatchObject({
      model_id: 'qwen3-vl-flash',
    })
  })

  test('DeepSeek 多模型目录允许一个 workload 下存在多个条目但只能有一个默认项', () => {
    const defaultEntry = workerTextReasoningEntry([
      {
        model_id: 'deepseek-primary',
        capabilities: ['TextReasoning'],
        text_reasoning_transport: 'responses',
        worker_env_source: { default_model: true },
        workload_bindings: [{ workload: 'managed_agent_text', default_for_workload: true }],
      },
      {
        model_id: 'deepseek-secondary',
        capabilities: ['TextReasoning'],
        text_reasoning_transport: 'responses',
        worker_env_source: {},
        workload_bindings: [{ workload: 'managed_agent_text' }],
      },
    ])
    expect(defaultEntry?.model_id).toBe('deepseek-primary')
  })

  test('目录是无密钥契约且运行时 hash 覆盖全部 workload 绑定', () => {
    const serialized = JSON.stringify(MANAGED_MODEL_CATALOG)
    expect(Object.isFrozen(MANAGED_MODEL_CATALOG)).toBeTrue()
    expect(MANAGED_MODEL_CATALOG.every(entry => Object.isFrozen(entry) && Object.isFrozen(entry.workload_bindings))).toBeTrue()
    expect(serialized).not.toContain('GW_DEEPSEEK_KEY')
    expect(serialized).not.toContain('GW_QWEN_KEY')
    expect(serialized).not.toContain('VIDEO_MEDIA_DASHSCOPE_API_KEY')
    expect(PROVIDER_REGISTRY.every(entry => entry.workload_bindings.length > 0)).toBeTrue()

    const runtime = buildProviderRegistryRuntimeEnv('deepseek-v4-flash')
    expect(validateProviderRuntimeConfiguration(runtime)).toBeUndefined()
  })
})
