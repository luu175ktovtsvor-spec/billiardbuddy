import { describe, expect, test } from 'bun:test'
import { agentEventSchema } from './agent-events'
import { parseClientMessage, parseServerMessage } from './agent-websocket'
import { DESKTOP_IPC } from './desktop-host'

describe('Agent 共享事件契约', () => {
  test('接受后端和 renderer 共用的工具进度事件', () => {
    expect(agentEventSchema.parse({
      type: 'tool_progress',
      tool: 'run_command',
      id: 'call-1',
      chunk: 'working',
      stream: 'stdout',
    })).toEqual({
      type: 'tool_progress',
      tool: 'run_command',
      id: 'call-1',
      chunk: 'working',
      stream: 'stdout',
    })
  })

  test('拒绝字段形状错误的事件', () => {
    expect(() => agentEventSchema.parse({ type: 'usage_update', total_tokens: '12' })).toThrow()
  })
})

describe('Agent WebSocket 共享契约', () => {
  test('兼容旧客户端省略 type 的 run 消息', () => {
    expect(parseClientMessage({ message: '你好', conversationId: 'c1' })).toMatchObject({
      type: 'run',
      message: '你好',
      conversationId: 'c1',
    })
  })

  test('入站兼容旧权限别名，但规范权限 Schema 不接受旧值', () => {
    expect(parseClientMessage({ type: 'run', message: '继续', permissionMode: 'full' })).toMatchObject({
      permissionMode: 'full',
    })
    expect(parseClientMessage({
      type: 'approve',
      tool: 'run_command',
      token: 'signed-token',
      permission_mode: 'auto_files',
    })).toMatchObject({ permission_mode: 'auto_files' })
  })

  test('审批领域包字段保留缺失与显式空数组两种状态', () => {
    const omitted = parseClientMessage({
      type: 'approve',
      tool: 'run_command',
      token: 'signed-token',
    })
    const disabled = parseClientMessage({
      type: 'approve',
      tool: 'run_command',
      token: 'signed-token',
      enabled_packs: [],
    })

    expect('enabled_packs' in omitted).toBe(false)
    expect(disabled).toMatchObject({ enabled_packs: [] })
    expect(() => parseClientMessage({
      type: 'approve',
      tool: 'run_command',
      token: 'signed-token',
      enabled_packs: [1],
    })).toThrow()
  })

  test('拒绝未知客户端消息和缺少审批令牌的消息', () => {
    expect(() => parseClientMessage({ type: 'unknown' })).toThrow()
    expect(() => parseClientMessage({ type: 'approve', tool: 'write_file', args: {} })).toThrow()
  })

  test('解析带 ISO 时间的服务端事件信封', () => {
    expect(parseServerMessage({
      type: 'event',
      seq: 3,
      ts: '2026-07-12T10:00:00.000Z',
      event: { type: 'done' },
    })).toMatchObject({ type: 'event', seq: 3, event: { type: 'done' } })
  })

  test('回放事件允许用户原始消息', () => {
    expect(parseServerMessage({
      type: 'event',
      seq: 1,
      ts: '2026-07-12T10:00:00.000Z',
      event: { type: 'user_prompt', text: '帮我检查项目' },
      replay: true,
    })).toMatchObject({ event: { type: 'user_prompt', text: '帮我检查项目' } })
  })

  test('接受同一 WS 上的资产进度广播', () => {
    expect(parseServerMessage({
      type: 'asset_progress',
      id: 'ffmpeg',
      status: 'ready',
      progress: 100,
      tier: 1,
      ts: 1,
    }).type).toBe('asset_progress')
  })
})

test('Electron IPC 通道名唯一', () => {
  const channels = Object.values(DESKTOP_IPC)
  expect(new Set(channels).size).toBe(channels.length)
})
