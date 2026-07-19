import { describe, expect, it, mock } from 'bun:test'
import type { ServerMessage } from '../ws/events.js'
import {
  ProductTaskAgentCoreAdapter,
  type ProductTaskAgentCorePort,
  type ProductTaskSocket,
} from './taskAgentCoreAdapter.js'
import { ProductTaskRunProjection } from './taskRunProjection.js'

type TestSocket = ProductTaskSocket & { sent: string[] }

function makeSocket(sessionId = 'core-session', taskId = 'public-task'): TestSocket {
  const sent: string[] = []
  return {
    data: {
      sessionId,
      productTaskId: taskId,
      channel: 'product',
    },
    send: (payload) => {
      sent.push(payload)
    },
    sent,
  }
}

function makePort(
  overrides: Partial<ProductTaskAgentCorePort> = {},
): ProductTaskAgentCorePort {
  return {
    getSessionWorkDir: async () => undefined,
    sendUserMessage: mock(async () => {}),
    stopGeneration: mock(() => {}),
    getPendingPermission: () => undefined,
    respondToPermission: mock(() => {}),
    resolveComputerUseApproval: () => false,
    isDesktopClearCommand: () => false,
    createSafeError: (code, retryable) => ({
      type: 'error',
      code,
      retryable,
      message: 'The task could not be completed. Please try again.',
    }),
    ...overrides,
  }
}

function events(socket: TestSocket): unknown[] {
  return socket.sent.map((payload) => JSON.parse(payload))
}

describe('ProductTaskAgentCoreAdapter', () => {
  it('rejects Core-only payloads before they reach the injected Core port', async () => {
    const sendUserMessage = mock(async () => {})
    const port = makePort({ sendUserMessage })
    const adapter = new ProductTaskAgentCoreAdapter(port, new ProductTaskRunProjection())
    const socket = makeSocket()

    expect(adapter.attach(socket)).toBe(true)
    await adapter.handleIncoming(socket, {
      type: 'set_runtime_config',
      providerId: 'private-provider',
      modelId: 'private-model',
    })

    expect(sendUserMessage).not.toHaveBeenCalled()
    expect(events(socket)).toEqual([{
      type: 'error',
      code: 'task_failed',
      retryable: false,
    }])
  })

  it('starts a task run before handing accepted product text to the Core port', async () => {
    const sendUserMessage = mock(async () => {})
    const adapter = new ProductTaskAgentCoreAdapter(
      makePort({ sendUserMessage }),
      new ProductTaskRunProjection(),
    )
    const socket = makeSocket('private-core-session', 'public-task-id')
    const reconnected = makeSocket('private-core-session', 'public-task-id')

    expect(adapter.attach(socket)).toBe(true)
    await adapter.handleIncoming(socket, {
      type: 'user_message',
      content: '整理本周球房活动安排',
    })

    expect(sendUserMessage).toHaveBeenCalledWith(socket, {
      type: 'user_message',
      content: '整理本周球房活动安排',
    })

    expect(adapter.attach(reconnected)).toBe(true)
    adapter.sendCoreMessage(reconnected, { type: 'connected', sessionId: 'private-core-session' })
    adapter.sendRunSnapshot(reconnected)

    expect(events(reconnected)).toEqual([
      { type: 'connected' },
      { type: 'run_snapshot', state: 'working', activities: [] },
    ])
    expect(JSON.stringify(events(reconnected))).not.toContain('private-core-session')
  })

  it('rejects an unrenderable question once at the product boundary', () => {
    const respondToPermission = mock(() => {})
    const adapter = new ProductTaskAgentCoreAdapter(
      makePort({ respondToPermission }),
      new ProductTaskRunProjection(),
    )
    const first = makeSocket('core-session', 'public-task')
    const second = makeSocket('core-session', 'public-task')
    const question: ServerMessage = {
      type: 'permission_request',
      requestId: 'ask-not-renderable',
      toolName: 'AskUserQuestion',
      input: { questions: [{ question: '  private question  ' }] },
    }

    expect(adapter.attach(first)).toBe(true)
    expect(adapter.attach(second)).toBe(true)
    adapter.sendCoreMessage(first, question)
    adapter.sendCoreMessage(second, question)

    expect(respondToPermission).toHaveBeenCalledTimes(1)
    expect(respondToPermission).toHaveBeenCalledWith(
      'core-session',
      'ask-not-renderable',
      false,
    )
    for (const socket of [first, second]) {
      expect(events(socket)).toEqual([{
        type: 'error',
        code: 'task_failed',
        retryable: false,
      }])
    }
  })

})
