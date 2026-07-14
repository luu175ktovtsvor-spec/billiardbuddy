import { describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { ToolContext } from '../tools/Tool'
import type { SessionEventRecord, SessionStreamEvent } from './services/sessionService'
import { createAgentWebSocketHandler, type AgentWsData } from './websocketHandler'

function createHarness(options: { running?: boolean; interrupted?: boolean; pendingApproval?: boolean } = {}) {
  const sent: Array<Record<string, unknown>> = []
  const subscriptions: string[] = []
  const connections: string[] = []
  const disconnections: string[] = []
  const replayed: Array<{ conversationId: string; after: number }> = []
  const runBodies: Array<Record<string, unknown>> = []
  const pendingApprovalInputs: Array<Record<string, unknown>> = []
  let approvedToolRuns = 0
  const steerInboxes = new Map<string, string[]>()
  let interruptRequests = 0
  const interruptRequesters = new Map([['session-a', () => { interruptRequests++ }]])
  let seq = 0

  const ws = {
    data: { conversationId: 'session-a', after: 0 },
    send(data: string) {
      sent.push(JSON.parse(data) as Record<string, unknown>)
      return 1
    },
    subscribe(topic: string) {
      subscriptions.push(topic)
      return true
    },
  } as unknown as ServerWebSocket<AgentWsData>

  const handler = createAgentWebSocketHandler({
    assetTopic: 'asset-progress',
    turnConsumers: {
      onConnect: conversationId => connections.push(conversationId),
      onDisconnect: conversationId => disconnections.push(conversationId),
    },
    turns: {
      interrupt: () => options.interrupted ?? true,
      isRunning: () => options.running ?? true,
    },
    sessions: {
      async touch() {},
      async appendEvent(_conversationId: string, event: SessionStreamEvent): Promise<SessionEventRecord> {
        seq++
        return { seq, ts: '2026-07-13T00:00:00.000Z', event }
      },
    },
    steerInboxes,
    interruptRequesters,
    async replayEvents(_ws, conversationId, after) {
      replayed.push({ conversationId, after })
    },
    async runTurn(_ws, body) {
      runBodies.push(body)
    },
    async runApprovedTool() {
      approvedToolRuns++
      return { ok: true, tool: 'run_command' }
    },
    resolvePendingApproval(_conversationId, input) {
      pendingApprovalInputs.push(input)
      return options.pendingApproval ?? false
    },
    rejectTool(_tool: string, _args: unknown, _context: ToolContext) {},
  })

  return {
    handler,
    ws,
    sent,
    subscriptions,
    connections,
    disconnections,
    replayed,
    runBodies,
    pendingApprovalInputs,
    steerInboxes,
    get interruptRequests() { return interruptRequests },
    get approvedToolRuns() { return approvedToolRuns },
  }
}

async function flushAsyncMessages(): Promise<void> {
  await Bun.sleep(0)
}

describe('createAgentWebSocketHandler', () => {
  test('open/close tracks the consumer, subscribes assets and replays from the requested cursor', async () => {
    const harness = createHarness()
    harness.ws.data.after = 4

    await harness.handler.open?.(harness.ws)
    await flushAsyncMessages()
    await harness.handler.close?.(harness.ws, 1000, '')

    expect(harness.connections).toEqual(['session-a'])
    expect(harness.disconnections).toEqual(['session-a'])
    expect(harness.subscriptions).toEqual(['asset-progress'])
    expect(harness.replayed).toEqual([{ conversationId: 'session-a', after: 4 }])
    expect(harness.sent[0]).toEqual({ type: 'ready', conversationId: 'session-a' })
  })

  test('parses ping/run/replay through the shared client contract', async () => {
    const harness = createHarness()

    await harness.handler.message(harness.ws, JSON.stringify({ type: 'ping', ts: 42 }))
    await harness.handler.message(harness.ws, JSON.stringify({
      type: 'run',
      message: '继续',
      full_disk_access: true,
    }))
    await harness.handler.message(harness.ws, JSON.stringify({ type: 'replay', conversationId: 'session-b', after: 7 }))
    await flushAsyncMessages()

    expect(harness.sent).toContainEqual({ type: 'pong', ts: 42 })
    expect(harness.runBodies[0]).toMatchObject({ type: 'run', message: '继续', full_disk_access: true })
    expect(harness.replayed).toContainEqual({ conversationId: 'session-b', after: 7 })
    expect(harness.ws.data.conversationId).toBe('session-b')
  })

  test('rejects malformed input without dispatching a turn', async () => {
    const harness = createHarness()

    await harness.handler.message(harness.ws, '{bad json')
    await harness.handler.message(harness.ws, JSON.stringify({ type: 'run' }))
    await harness.handler.message(harness.ws, JSON.stringify({ type: 'run', message: '继续', full_disk_access: 'true' }))

    expect(harness.runBodies).toHaveLength(0)
    expect(harness.sent).toEqual([
      { type: 'error', error: 'invalid websocket message' },
      { type: 'error', error: 'invalid websocket message' },
      { type: 'error', error: 'invalid websocket message' },
    ])
  })

  test('interrupt persists the state and steer queues only while a turn is running', async () => {
    const harness = createHarness({ running: true, interrupted: true })

    await harness.handler.message(harness.ws, JSON.stringify({ type: 'interrupt' }))
    await harness.handler.message(harness.ws, JSON.stringify({ type: 'steer', message: ' 换个思路 ' }))
    await flushAsyncMessages()

    expect(harness.steerInboxes.get('session-a')).toEqual(['换个思路'])
    expect(harness.interruptRequests).toBe(1)
    expect(harness.sent).toContainEqual({ type: 'interrupt_result', conversationId: 'session-a', interrupted: true })
    expect(harness.sent).toContainEqual({ type: 'steer_result', conversationId: 'session-a', queued: 1, running: true })
    expect(harness.sent.filter(message => message.type === 'event').map(message => (message.event as SessionStreamEvent).type)).toEqual(['context_note', 'steering'])
  })

  test('steer reports an idle session without queueing', async () => {
    const harness = createHarness({ running: false })

    await harness.handler.message(harness.ws, JSON.stringify({ type: 'steer', message: '稍后继续' }))
    await flushAsyncMessages()

    expect(harness.steerInboxes.size).toBe(0)
    expect(harness.sent).toContainEqual({ type: 'steer_result', conversationId: 'session-a', queued: 0, running: false })
  })

  test('approve/reject resolve a live pending request without running the legacy detached executor', async () => {
    const harness = createHarness({ pendingApproval: true })

    await harness.handler.message(harness.ws, JSON.stringify({
      type: 'approve',
      tool: 'run_command',
      args: { command: 'echo ok' },
      token: 'signed-token',
      remember_approval: true,
    }))
    await harness.handler.message(harness.ws, JSON.stringify({
      type: 'reject',
      tool: 'write_file',
      args: { path: 'x.txt' },
    }))
    await flushAsyncMessages()

    expect(harness.pendingApprovalInputs).toEqual([
      { behavior: 'allow', tool: 'run_command', token: 'signed-token', remember: true },
      { behavior: 'deny', tool: 'write_file', message: '用户拒绝了本次工具调用。' },
    ])
    expect(harness.approvedToolRuns).toBe(0)
    expect(harness.sent).toContainEqual({ type: 'approve_result', ok: true, tool: 'run_command', resumed: true })
    expect(harness.sent).toContainEqual({ type: 'reject_result', ok: true })
  })
})
