import { afterEach, beforeEach, expect, test } from 'bun:test'
import { wsManager } from '../api/websocket'
import type { ClientMessage } from '../types/chat'
import type { ServerMessage } from '../types/chat'
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

test('流式正文和步末 commentary 合并成一条阶段独白', () => {
  const originalOnMessage = wsManager.onMessage.bind(wsManager)
  const originalConnect = wsManager.connect.bind(wsManager)
  const originalIsConnected = wsManager.isConnected.bind(wsManager)
  let handler: ((message: ServerMessage) => void) | null = null
  wsManager.onMessage = (_conversationId, next) => { handler = next; return () => {} }
  wsManager.connect = () => {}
  wsManager.isConnected = () => false

  try {
    useChatStore.getState().startConversation('conv-commentary')
    const emit = (event: ServerMessage['event']) => handler?.({
      type: 'event',
      seq: 1,
      ts: '2026-07-15T00:00:00.000Z',
      event,
    })
    emit({ type: 'content_delta', channel: 'text', text: '我先看一下项目结构。' })
    emit({ type: 'commentary', text: '我先看一下项目结构。' })
    emit({ type: 'tool_call', tool: 'list_dir', input: { path: '.' } })

    const blocks = useChatStore.getState().blocks
    expect(blocks.filter(block => block.kind === 'assistant').map(block => block.kind === 'assistant' ? block.text : '')).toEqual([
      '我先看一下项目结构。',
    ])
    expect(blocks.at(-1)).toMatchObject({ kind: 'tool', tool: 'list_dir' })
  } finally {
    wsManager.onMessage = originalOnMessage
    wsManager.connect = originalConnect
    wsManager.isConnected = originalIsConnected
  }
})

test('工具收尾后 runVerb 回落成 working,不再误报"还在跑这个工具"', () => {
  const originalOnMessage = wsManager.onMessage.bind(wsManager)
  const originalConnect = wsManager.connect.bind(wsManager)
  const originalIsConnected = wsManager.isConnected.bind(wsManager)
  let handler: ((message: ServerMessage) => void) | null = null
  wsManager.onMessage = (_conversationId, next) => { handler = next; return () => {} }
  wsManager.connect = () => {}
  wsManager.isConnected = () => false

  try {
    useChatStore.getState().startConversation('conv-runverb')
    const emit = (event: ServerMessage['event']) => handler?.({
      type: 'event',
      seq: 1,
      ts: '2026-07-15T00:00:00.000Z',
      event,
    })
    emit({ type: 'tool_call', tool: 'read_file', input: { path: 'a.ts' } })
    expect(useChatStore.getState().runVerb).toBe('running')
    emit({ type: 'tool_result', tool: 'read_file', output: '内容', is_error: false })
    expect(useChatStore.getState().runVerb).toBe('working')
  } finally {
    wsManager.onMessage = originalOnMessage
    wsManager.connect = originalConnect
    wsManager.isConnected = originalIsConnected
  }
})

test('远程重连/降级横幅翻成中文,不把内核英文技术串直接怼给用户', () => {
  const originalOnMessage = wsManager.onMessage.bind(wsManager)
  const originalConnect = wsManager.connect.bind(wsManager)
  const originalIsConnected = wsManager.isConnected.bind(wsManager)
  let handler: ((message: ServerMessage) => void) | null = null
  wsManager.onMessage = (_conversationId, next) => { handler = next; return () => {} }
  wsManager.connect = () => {}
  wsManager.isConnected = () => false

  try {
    useChatStore.getState().startConversation('conv-fallback')
    const emit = (event: ServerMessage['event']) => handler?.({
      type: 'event',
      seq: 1,
      ts: '2026-07-15T00:00:00.000Z',
      event,
    })
    emit({ type: 'context_note', text: 'Remote API retry 2/3' })
    emit({ type: 'context_note', text: 'Remote streaming fallback: fetch failed' })

    const notes = useChatStore.getState().blocks.filter(block => block.kind === 'note')
    expect(notes).toHaveLength(2)
    expect(notes[0]).toMatchObject({ variant: 'api_retry', text: '正在重试连接(第 2/3 次)' })
    expect(notes[0]?.kind === 'note' && notes[0].text).not.toContain('Remote')
    expect(notes[1]).toMatchObject({ variant: 'streaming_fallback', text: '网络不稳定,已自动切换连接方式' })
    expect(notes[1]?.kind === 'note' && notes[1].text).not.toContain('fetch failed')
  } finally {
    wsManager.onMessage = originalOnMessage
    wsManager.connect = originalConnect
    wsManager.isConnected = originalIsConnected
  }
})
