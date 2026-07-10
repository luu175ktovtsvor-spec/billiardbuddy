import { expect, test } from 'bun:test'
import { FallbackModel } from './FallbackModel'
import type { AssistantStep, Model, ModelStepDelta, ModelStepInput } from '../types/model'

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

// ── 行为对齐:跨供应商流式 fallback 不留孤儿/打字机重影(语义对齐 cc query.ts:906-926) ──

test('跨候选 fallback:失败候选流式一半再失败,其 delta 绝不转发,只放行中选候选的输出(无孤儿)', async () => {
  const seen: ModelStepDelta[] = []
  const model = new FallbackModel([
    {
      label: '主出口',
      model: scriptedModel(input => {
        // 主出口先流式吐半截正文(孤儿),再失败。
        input.onDelta?.({ channel: 'text', text: '孤儿半截' })
        input.onDelta?.({ channel: 'text', text: '·还没写完' })
        throw new Error('HTTP 503 upstream overloaded')
      }),
    },
    {
      label: '备用出口',
      model: scriptedModel(input => {
        input.onDelta?.({ channel: 'text', text: '正式' })
        input.onDelta?.({ channel: 'text', text: '答复' })
        return { kind: 'final', text: '正式答复' }
      }),
    },
  ])

  const step = await model.step({ messages: [], tools: [], onDelta: d => seen.push(d) })

  expect(step).toMatchObject({ kind: 'final', text: '正式答复' })
  const forwarded = seen.filter(d => d.channel === 'text').map(d => d.text)
  // 失败候选(孤儿)的任何 delta 都没转发到上游 onDelta。
  expect(forwarded).not.toContain('孤儿半截')
  expect(forwarded).not.toContain('·还没写完')
  expect(forwarded.join('')).not.toContain('孤儿')
  // 中选候选的流式增量按序放行(前端渲染路径与非 fallback 一致)。
  expect(forwarded).toEqual(['正式', '答复'])
})

test('跨候选 fallback 到 tool_calls 出口(无 final 覆盖):失败候选的 preamble delta 不残留成孤儿', async () => {
  const seen: ModelStepDelta[] = []
  const model = new FallbackModel([
    {
      label: '主出口',
      model: scriptedModel(input => {
        input.onDelta?.({ channel: 'text', text: '我来看下文件' })
        throw new Error('network reset')
      }),
    },
    {
      label: '备用出口',
      model: scriptedModel(input => {
        input.onDelta?.({ channel: 'text', text: '这就读文件' })
        return { kind: 'tool_calls', text: '这就读文件', calls: [{ id: 'c1', name: 'read_file', input: { path: 'a.ts' } }] }
      }),
    },
  ])

  const step = await model.step({ messages: [], tools: [], onDelta: d => seen.push(d) })

  expect(step.kind).toBe('tool_calls')
  const forwarded = seen.filter(d => d.channel === 'text').map(d => d.text)
  // tool_calls 分支前端不会有 final 覆盖,所以失败候选的 preamble 绝不能转发(否则永久重影)。
  expect(forwarded).toEqual(['这就读文件'])
  expect(forwarded.join('')).not.toContain('我来看下文件')
})

test('无 fallback:单候选成功时其流式 delta 正常放行(不误伤中选出口的打字机)', async () => {
  const seen: ModelStepDelta[] = []
  const model = new FallbackModel([
    {
      label: '唯一出口',
      model: scriptedModel(input => {
        input.onDelta?.({ channel: 'thinking', text: '想一下' })
        input.onDelta?.({ channel: 'text', text: '你好' })
        input.onDelta?.({ channel: 'text', text: ',在' })
        return { kind: 'final', text: '你好,在' }
      }),
    },
  ])

  const step = await model.step({ messages: [], tools: [], onDelta: d => seen.push(d) })

  expect(step).toMatchObject({ kind: 'final', text: '你好,在' })
  expect(seen).toEqual([
    { channel: 'thinking', text: '想一下' },
    { channel: 'text', text: '你好' },
    { channel: 'text', text: ',在' },
  ])
})

test('全候选失败:任何候选的流式 delta 都不转发(整轮判败,前端零孤儿)', async () => {
  const seen: ModelStepDelta[] = []
  const model = new FallbackModel([
    { label: 'A', model: scriptedModel(input => { input.onDelta?.({ channel: 'text', text: 'A半截' }); throw new Error('fail A') }) },
    { label: 'B', model: scriptedModel(input => { input.onDelta?.({ channel: 'text', text: 'B半截' }); throw new Error('fail B') }) },
  ])

  await expect(model.step({ messages: [], tools: [], onDelta: d => seen.push(d) })).rejects.toThrow('所有模型出口都失败')
  expect(seen).toEqual([])
})
