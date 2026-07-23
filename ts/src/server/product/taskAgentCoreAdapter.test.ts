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

  it('rejects a missing workspace cwd before Core send', async () => {
    const sendUserMessage = mock(async () => {})
    const adapter = new ProductTaskAgentCoreAdapter(makePort({ sendUserMessage, getSessionWorkDir: async () => undefined }), new ProductTaskRunProjection(), { requireWorkspaceCapability: async () => ({ canonical_root: '/workspace/bound' }) })
    const socket = makeSocket('private-core-session', 'public-task-id')
    await adapter.handleIncoming(socket, { type: 'user_message', content: 'hello' })
    expect(sendUserMessage).not.toHaveBeenCalled()
    expect(events(socket)).toEqual([expect.objectContaining({ code: 'task_failed' })])
  })

  it('rejects an old Core cwd from another workspace before Core send', async () => {
    const sendUserMessage = mock(async () => {})
    const adapter = new ProductTaskAgentCoreAdapter(makePort({ sendUserMessage, getSessionWorkDir: async () => '/workspace/old' }), new ProductTaskRunProjection(), { requireWorkspaceCapability: async () => ({ canonical_root: '/workspace/bound' }) })
    const socket = makeSocket('private-core-session', 'public-task-id')
    await adapter.handleIncoming(socket, { type: 'user_message', content: 'hello' })
    expect(sendUserMessage).not.toHaveBeenCalled()
    expect(events(socket)).toEqual([expect.objectContaining({ code: 'task_failed' })])
  })

  it('rejects even an available bound workspace before any Core call', async () => {
    const sendUserMessage = mock(async () => {})
    const adapter = new ProductTaskAgentCoreAdapter(
      makePort({ sendUserMessage, getSessionWorkDir: async () => '/workspace/task' }),
      new ProductTaskRunProjection(),
      { requireWorkspaceCapability: async () => ({ canonical_root: '/workspace/task' }) },
    )
    const socket = makeSocket('private-core-session', 'public-task-id')

    await adapter.handleIncoming(socket, { type: 'user_message', content: '整理本周球房活动安排' })

    expect(sendUserMessage).not.toHaveBeenCalled()
    expect(events(socket)).toEqual([expect.objectContaining({ code: 'task_failed', retryable: false })])
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
