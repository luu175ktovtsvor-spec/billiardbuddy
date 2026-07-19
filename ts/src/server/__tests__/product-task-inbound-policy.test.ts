import { describe, expect, it } from 'bun:test'
import { parseProductTaskInboundMessage } from '../product/taskInboundPolicy.js'

describe('product task websocket inbound policy', () => {
  it('allows only bounded plain-text task messages and task-local controls', () => {
    expect(parseProductTaskInboundMessage({
      type: 'user_message',
      content: '  整理本周球房活动安排  ',
    })).toEqual({
      type: 'user_message',
      content: '整理本周球房活动安排',
    })
    expect(parseProductTaskInboundMessage({ type: 'stop_generation' })).toEqual({ type: 'stop_generation' })
    expect(parseProductTaskInboundMessage({ type: 'ping' })).toEqual({ type: 'ping' })
  })

  it('rejects Core runtime, permission, and attachment envelopes without blocking task text', () => {
    expect(parseProductTaskInboundMessage({
      type: 'user_message',
      content: '/skill ball-hall-daily-review 今天的营业数据',
    })).toEqual({
      type: 'user_message',
      content: '/skill ball-hall-daily-review 今天的营业数据',
    })

    for (const payload of [
      { type: 'set_permission_mode', mode: 'bypassPermissions' },
      { type: 'set_runtime_config', providerId: 'private-provider', modelId: 'private-model' },
      { type: 'prewarm_session' },
      {
        type: 'permission_response',
        requestId: 'permission-1',
        allowed: true,
        rule: 'Bash(*)',
        updatedInput: { command: 'PRIVATE_COMMAND' },
        permissionUpdates: [{ type: 'addRules' }],
      },
      {
        type: 'user_message',
        content: '查看附件',
        attachments: [{ type: 'file', path: '/private/file.txt' }],
      },
      { type: 'stop_generation', force: true },
      { type: 'ping', sessionId: 'other-session' },
    ]) {
      expect(parseProductTaskInboundMessage(payload)).toBeNull()
    }
  })
})
