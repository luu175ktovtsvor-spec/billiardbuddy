import { expect, test } from 'bun:test'
import { FallbackModel } from './FallbackModel'
import type { AssistantStep, Model, ModelStepInput } from '../types/model'

function scriptedModel(handler: (input: ModelStepInput) => Promise<AssistantStep> | AssistantStep): Model {
  return { step: async input => handler(input) }
}

test('FallbackModel switches to the next provider and prepends visible notices', async () => {
  let primaryCalls = 0
  let fallbackCalls = 0
  const events: string[] = []
  const model = new FallbackModel([
    {
      label: 'Saved Provider',
      onFailure: () => events.push('primary-failure'),
      model: scriptedModel(() => {
        primaryCalls += 1
        throw new Error('HTTP 401 Bearer sk-primary api_key=primary-secret')
      }),
    },
    {
      label: '环境变量:fallback-model',
      onSuccess: () => events.push('fallback-success'),
      model: scriptedModel(() => {
        fallbackCalls += 1
        return { kind: 'final', text: 'ok', notices: ['备用出口返回非流式 JSON,已接回。'] }
      }),
    },
  ])

  const step = await model.step({ messages: [], tools: [] })

  expect(step).toMatchObject({ kind: 'final', text: 'ok' })
  expect(primaryCalls).toBe(1)
  expect(fallbackCalls).toBe(1)
  expect(step.notices?.[0]).toContain('模型出口「Saved Provider」请求失败')
  expect(step.notices?.[0]).toContain('Bearer [redacted]')
  expect(step.notices?.[0]).toContain('api_key=[redacted]')
  expect(step.notices?.[1]).toBe('已切换到备用模型出口「环境变量:fallback-model」继续。')
  expect(step.notices?.[2]).toBe('备用出口返回非流式 JSON,已接回。')
  expect(JSON.stringify(step)).not.toContain('primary-secret')
  expect(JSON.stringify(step)).not.toContain('sk-primary')
  expect(events).toEqual(['primary-failure', 'fallback-success'])

  await model.step({ messages: [], tools: [] })
  expect(primaryCalls).toBe(1)
  expect(fallbackCalls).toBe(2)
  expect(events).toEqual(['primary-failure', 'fallback-success', 'fallback-success'])
})

test('FallbackModel reports every failed provider with redacted secrets', async () => {
  const model = new FallbackModel([
    { label: 'A', model: scriptedModel(() => { throw new Error('Bearer sk-a') }) },
    { label: 'B', model: scriptedModel(() => { throw new Error('api-key:sk-b') }) },
  ])

  try {
    await model.step({ messages: [], tools: [] })
    throw new Error('expected fallback failure')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    expect(message).toContain('所有模型出口都失败')
    expect(message).toContain('Bearer [redacted]')
    expect(message).toContain('api-key:[redacted]')
    expect(message).not.toContain('sk-a')
    expect(message).not.toContain('sk-b')
  }
})
