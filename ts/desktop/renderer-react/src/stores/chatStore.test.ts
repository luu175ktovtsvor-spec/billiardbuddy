import { afterEach, beforeEach, expect, test } from 'bun:test'
import { wsManager } from '../api/websocket'
import type { ClientMessage } from '../types/chat'
import { useChatStore } from './chatStore'
import { useSettingsStore } from './settingsStore'

const originalSend = wsManager.send.bind(wsManager)

beforeEach(() => {
  useChatStore.setState({
    conversationId: 'conv-approve',
    blocks: [{
      id: 'approval-1',
      kind: 'approval',
      tool: 'run_command',
      args: { command: 'pwd' },
      token: 'signed-token',
      resolved: null,
    }],
  })
  useSettingsStore.setState({
    activeConvId: 'conv-approve',
    workspaceRoot: '/tmp/project',
    enabledPacks: [],
    enabledPacksByConv: { 'conv-approve': [] },
  })
})

afterEach(() => {
  wsManager.send = originalSend
})

test('审批续跑总带当前会话领域包,空数组表示明确关闭', () => {
  const sent: ClientMessage[] = []
  wsManager.send = (_conversationId, message) => { sent.push(message) }

  useChatStore.getState().approve('approval-1', false)

  expect(sent).toHaveLength(1)
  expect(sent[0]).toMatchObject({
    type: 'approve',
    conversationId: 'conv-approve',
    working_dir: '/tmp/project',
    enabled_packs: [],
  })
})
