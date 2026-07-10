import { describe, expect, test } from 'bun:test'
import {
  compactionThresholdFromTrigger,
  getModelCompactionTrigger,
  resolveModelCompactionThreshold,
} from './modelCompactionTriggers'

describe('getModelCompactionTrigger(per-model 登记查表)', () => {
  test('mimo-v2.5 已登记 = 700_000(绝对,owner 要精确 700K)', () => {
    expect(getModelCompactionTrigger('mimo-v2.5')).toBe(700_000)
  })

  test('大小写 / [1m] / :1m 归一后仍命中', () => {
    expect(getModelCompactionTrigger('MiMo-V2.5')).toBe(700_000)
    expect(getModelCompactionTrigger('mimo-v2.5[1m]')).toBe(700_000)
    expect(getModelCompactionTrigger('mimo-v2.5:1m')).toBe(700_000)
  })

  test('供应商前缀 / :tag 后缀兜底命中(与窗口登记同款匹配)', () => {
    expect(getModelCompactionTrigger('xiaomi/mimo-v2.5')).toBe(700_000)
    expect(getModelCompactionTrigger('some-provider:mimo-v2.5')).toBe(700_000)
  })

  test('未登记模型 / 空 → undefined(走 cc 默认公式)', () => {
    expect(getModelCompactionTrigger('glm-5.1')).toBeUndefined()
    expect(getModelCompactionTrigger('deepseek-chat')).toBeUndefined()
    expect(getModelCompactionTrigger(undefined)).toBeUndefined()
    expect(getModelCompactionTrigger('')).toBeUndefined()
  })
})

describe('compactionThresholdFromTrigger(比例/绝对两条分支)', () => {
  test('比例(0<v≤1)→ floor(有效窗口 × v)', () => {
    expect(compactionThresholdFromTrigger(0.7, 980_000)).toBe(686_000)
    expect(compactionThresholdFromTrigger(0.5, 180_000)).toBe(90_000)
    // v=1 视为比例(100%),封顶=有效窗口本身。
    expect(compactionThresholdFromTrigger(1, 980_000)).toBe(980_000)
  })

  test('绝对(v>1)→ floor(v),封顶有效窗口', () => {
    expect(compactionThresholdFromTrigger(700_000, 980_000)).toBe(700_000)
    // 绝对值超过有效窗口时被封顶,阈值不会反超窗口。
    expect(compactionThresholdFromTrigger(2_000_000, 980_000)).toBe(980_000)
    expect(compactionThresholdFromTrigger(167_000.9, 180_000)).toBe(167_000)
  })
})

describe('resolveModelCompactionThreshold(查表 + 解成绝对阈值)', () => {
  test('mimo-v2.5 + 有效窗口 980k → 绝对 700_000(未超 980k、不封顶)= 700k', () => {
    expect(resolveModelCompactionThreshold('mimo-v2.5', 980_000)).toBe(700_000)
  })

  test('未登记模型 → undefined(调用方回退 cc 公式)', () => {
    expect(resolveModelCompactionThreshold('glm-5.1', 180_000)).toBeUndefined()
    expect(resolveModelCompactionThreshold(undefined, 180_000)).toBeUndefined()
  })
})
