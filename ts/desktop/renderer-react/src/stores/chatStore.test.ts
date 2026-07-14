import { afterEach, beforeEach, expect, test } from 'bun:test'
import { wsManager } from '../api/websocket'
import type { ClientMessage } from '../types/chat'
import { toolResultIsError } from '../types/events'
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
    status: 'idle',
  })
  useSettingsStore.setState({
    activeConvId: 'conv-approve',
    workspaceRoot: '/tmp/project',
    enabledPacks: [],
    enabledPacksByConv: { 'conv-approve': [] },
    defaultPermissionMode: 'default',
    permissionModeByConv: { 'conv-approve': 'default' },
  })
})

test('完全访问档在发起、批准和拒绝时都显式传到底层', () => {
  const sent: ClientMessage[] = []
  wsManager.send = (_conversationId, message) => { sent.push(message) }
  useSettingsStore.setState({
    defaultPermissionMode: 'bypassPermissions',
    permissionModeByConv: { 'conv-approve': 'bypassPermissions' },
  })

  useChatStore.getState().sendMessage('读取工作区外文件')
  useChatStore.getState().approve('approval-1', false)
  useChatStore.getState().reject('approval-1')

  expect(sent).toHaveLength(3)
  expect(sent.map(message => message.type)).toEqual(['run', 'approve', 'reject'])
  expect(sent.every(message => 'full_disk_access' in message && message.full_disk_access === true)).toBe(true)
  expect(sent.every(message => 'permissionMode' in message && message.permissionMode === 'bypassPermissions')).toBe(true)
})

test('接受修改档不会获得全盘访问', () => {
  const sent: ClientMessage[] = []
  wsManager.send = (_conversationId, message) => { sent.push(message) }
  useSettingsStore.setState({
    defaultPermissionMode: 'acceptEdits',
    permissionModeByConv: { 'conv-approve': 'acceptEdits' },
  })

  useChatStore.getState().sendMessage('修改项目内文件')

  expect(sent[0]).toMatchObject({
    type: 'run',
    permissionMode: 'acceptEdits',
    full_disk_access: false,
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

test('工具结果优先使用结构化错误位，成功文案提到 error/失败时不误判', () => {
  expect(toolResultIsError({ type: 'tool_result', tool: 'check', output: '0 errors，失败项为 0', is_error: false })).toBe(false)
  expect(toolResultIsError({ type: 'tool_result', tool: 'check', output: '普通输出', is_error: true })).toBe(true)
  expect(toolResultIsError({ type: 'tool_result', tool: 'legacy', output: '错误:命令不存在' })).toBe(true)
  expect(toolResultIsError({ type: 'tool_result', tool: 'legacy', output: '检查完成，失败项为 0' })).toBe(false)
})
