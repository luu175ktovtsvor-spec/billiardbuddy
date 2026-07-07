import { describe, expect, test } from 'bun:test'
import { buildStoreMemoryContext } from './storeMemoryContext'

describe('buildStoreMemoryContext', () => {
  test('按用户问题挑选相关门店记忆并生成模型上下文', () => {
    const ctx = buildStoreMemoryContext([
      {
        id: 'm1',
        content: '黄金档台费 68 元一小时,会员充值满 1000 送 120。',
        source: 'manual',
        confidence: 'high',
        type: 'pricing',
        created_at: '2026-07-01T00:00:00.000Z',
      },
      {
        id: 'm2',
        content: '员工排班:小王周五晚班。',
        source: 'manual',
        confidence: 'high',
        created_at: '2026-07-01T00:00:00.000Z',
      },
    ], '黄金档台费多少', { now: new Date('2026-07-07T00:00:00.000Z') })

    expect(ctx).toContain('<store_memory_context')
    expect(ctx).toContain('id="m1"')
    expect(ctx).toContain('68 元')
    expect(ctx).not.toContain('小王周五晚班')
  })

  test('跳过 pending,并只注入匹配当前 workingDir 的项目记忆', () => {
    const ctx = buildStoreMemoryContext([
      { id: 'pending', content: '会员卡秘密折扣', source: 'pending', created_at: '2026-07-01T00:00:00.000Z' },
      { id: 'other', content: '会员卡 A 项目规则', source: 'manual', scope: 'working_dir', working_dir: '/other', created_at: '2026-07-01T00:00:00.000Z' },
      { id: 'hit', content: '会员卡 B 项目规则', source: 'manual', scope: 'working_dir', working_dir: '/workspace', created_at: '2026-07-01T00:00:00.000Z' },
    ], '会员卡规则', { workingDir: '/workspace', now: new Date('2026-07-07T00:00:00.000Z') })

    expect(ctx).toContain('id="hit"')
    expect(ctx).not.toContain('id="pending"')
    expect(ctx).not.toContain('id="other"')
  })

  test('旧记忆带 age_warning,提醒易变事实需要核对', () => {
    const ctx = buildStoreMemoryContext([
      {
        id: 'old-price',
        content: '会员充值活动:充 1000 送 300。',
        source: 'manual',
        updated_at: '2026-05-01T00:00:00.000Z',
      },
    ], '会员充值活动', { now: new Date('2026-07-07T00:00:00.000Z') })

    expect(ctx).toContain('age_days="67"')
    expect(ctx).toContain('age_warning=')
    expect(ctx).toContain('请核对是否仍然有效')
  })
})
