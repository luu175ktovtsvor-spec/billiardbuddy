import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import {
  __markPrewarmPendingForTests,
  __markActiveTurnForTests,
  __registerPendingUserTurnForTests,
  __markPrewarmedForTests,
  __resetWebSocketHandlerStateForTests,
  closeSessionConnection,
  getActiveSessionIds,
  handleWebSocket,
  translateCliMessage,
  type WebSocketData,
} from '../ws/handler.js'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'

function makeClientSocket(
  sessionId: string,
  channel: WebSocketData['channel'] = 'client',
) {
  const sent: string[] = []
  return {
    data: {
      sessionId,
      ...(channel === 'product' ? { productTaskId: `task-${sessionId}` } : {}),
      connectedAt: Date.now(),
      channel,
      sdkToken: null,
      serverPort: 0,
      serverHost: '127.0.0.1',
    },
    send: mock((payload: string) => {
      sent.push(payload)
    }),
    close: mock(() => {}),
    sent,
  } as unknown as ServerWebSocket<WebSocketData> & { sent: string[] }
}

describe('translateCliMessage usage mapping', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  it('keeps cache token counts on result completion events', () => {
    const sessionId = `usage-${crypto.randomUUID()}`

    const messages = translateCliMessage({
      type: 'result',
      subtype: 'success',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_input_tokens: 3456,
        cache_creation_input_tokens: 789,
      },
    }, sessionId)

    expect(messages).toEqual([{
      type: 'message_complete',
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 3456,
        cache_creation_tokens: 789,
      },
    }])
  })
})

describe('WebSocket handler session isolation', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  it('ignores stale disconnects from an older socket for the same session', () => {
    const sessionId = `duplicate-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const clearCallbacks = spyOn(conversationService, 'clearOutputCallbacks')
    const cancelComputerUse = spyOn(computerUseApprovalService, 'cancelSession')

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    clearCallbacks.mockClear()
    cancelComputerUse.mockClear()

    handleWebSocket.close(first, 1000, 'stale tab closed')

    expect(getActiveSessionIds()).toContain(sessionId)
    expect(clearCallbacks).not.toHaveBeenCalled()
    expect(cancelComputerUse).not.toHaveBeenCalled()
  })

  it('translates one Core stream once and fans the resulting events to every client', () => {
    const sessionId = `fanout-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId)
    const second = makeClientSocket(sessionId)
    const callbacks: Array<(cliMsg: any) => void> = []

    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    const onOutput = spyOn(conversationService, 'onOutput').mockImplementation((_id, callback) => {
      callbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    handleWebSocket.open(first)
    handleWebSocket.open(second)

    expect(onOutput).toHaveBeenCalledTimes(1)
    expect(callbacks).toHaveLength(1)

    callbacks[0]!({
      type: 'result',
      subtype: 'success',
      usage: { input_tokens: 1, output_tokens: 2 },
    })

    const firstEvents = first.sent.map((payload) => JSON.parse(payload))
    const secondEvents = second.sent.map((payload) => JSON.parse(payload))
    const completion = {
      type: 'message_complete',
      usage: { input_tokens: 1, output_tokens: 2 },
    }
    expect(firstEvents.filter((event) => event.type === 'message_complete')).toEqual([completion])
    expect(secondEvents.filter((event) => event.type === 'message_complete')).toEqual([completion])
  })

  it('closes and removes an active client socket when a session is deleted', () => {
    const sessionId = `delete-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const clearCallbacks = spyOn(conversationService, 'clearOutputCallbacks')
    const cancelComputerUse = spyOn(computerUseApprovalService, 'cancelSession')

    handleWebSocket.open(ws)

    expect(closeSessionConnection(sessionId, 'session deleted')).toBe(true)

    expect(getActiveSessionIds()).not.toContain(sessionId)
    expect(ws.close).toHaveBeenCalledWith(1000, 'session deleted')
    expect(clearCallbacks).toHaveBeenCalledWith(sessionId)
    expect(cancelComputerUse).toHaveBeenCalledWith(sessionId)
  })

  it('replays pending permission requests when a client reconnects', () => {
    const sessionId = `permission-reconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([
      {
        requestId: 'request-ask-1',
        toolName: 'AskUserQuestion',
        toolUseId: 'tool-ask-1',
        input: {
          questions: [
            {
              header: 'Scope',
              question: 'Which scope?',
              options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
            },
          ],
        },
        description: 'Answer questions?',
      },
    ])

    handleWebSocket.open(ws)

    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'permission_request',
      requestId: 'request-ask-1',
      toolName: 'AskUserQuestion',
      toolUseId: 'tool-ask-1',
      input: {
        questions: [
          {
            header: 'Scope',
            question: 'Which scope?',
            options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
          },
        ],
      },
      description: 'Answer questions?',
    })
  })

  it('keeps disconnected sessions alive longer while user input is pending', () => {
    const sessionId = `permission-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([
      {
        requestId: 'request-ask-1',
        toolName: 'AskUserQuestion',
        toolUseId: 'tool-ask-1',
        input: { questions: [] },
      },
    ])

    handleWebSocket.open(ws)
    setTimeoutSpy.mockClear()

    handleWebSocket.close(ws, 1006, 'renderer reconnecting')

    expect(setTimeoutSpy).toHaveBeenCalled()
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBeGreaterThan(30_000)
  })

  it('does not forward prewarm startup status to a reconnecting client', async () => {
    const sessionId = `prewarm-reconnect-${crypto.randomUUID()}`
    const second = makeClientSocket(sessionId)
    let outputCallback: ((cliMsg: any) => void) | null = null

    __markPrewarmPendingForTests(sessionId)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getRecentSdkMessages').mockReturnValue([])
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, callback) => {
      outputCallback = callback
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {
      outputCallback = null
    })

    handleWebSocket.open(second)
    outputCallback?.({
      type: 'stream_event',
      event: { type: 'message_start' },
    })

    const secondMessages = second.sent.map((payload) => JSON.parse(payload))
    expect(secondMessages).not.toContainEqual({ type: 'status', state: 'thinking' })
  })

  it('keeps a running session alive on disconnect and cleans up only after the turn finishes (issue #764)', () => {
    const sessionId = `running-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout')
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    let turnCompleteCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, cb) => {
      turnCompleteCallback = cb
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    setTimeoutSpy.mockClear()

    // Last client disconnects while the turn is still running: no kill timer,
    // just a turn-completion watcher.
    handleWebSocket.close(ws, 1006, 'phone locked screen')
    expect(setTimeoutSpy).not.toHaveBeenCalled()
    expect(stopSession).not.toHaveBeenCalled()
    expect(turnCompleteCallback).not.toBeNull()

    // Turn finishes while still disconnected → now the idle grace timer starts.
    turnCompleteCallback?.({ type: 'result', subtype: 'success' })
    expect(setTimeoutSpy).toHaveBeenCalled()
    // Timer body still hasn't run, so the process is not killed yet.
    expect(stopSession).not.toHaveBeenCalled()
  })

  it('uses the fixed desktop disconnect grace period for an idle session', () => {
    const sessionId = `idle-disconnect-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    handleWebSocket.open(ws)
    setTimeoutSpy.mockClear()

    handleWebSocket.close(ws, 1006, 'tab closed')

    expect(setTimeoutSpy).toHaveBeenCalled()
    expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(30_000)
  })

  it('does not start the idle timer if the client reconnects before the turn finishes', () => {
    const sessionId = `reconnect-mid-turn-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const reconnected = makeClientSocket(sessionId)
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout')
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    spyOn(conversationService, 'hasSession').mockReturnValue(true)

    let turnCompleteCallback: ((cliMsg: any) => void) | null = null
    spyOn(conversationService, 'onOutput').mockImplementation((_sid, cb) => {
      turnCompleteCallback = cb
    })
    const removeOutputCallback = spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})

    handleWebSocket.open(ws)
    __markActiveTurnForTests(sessionId)
    handleWebSocket.close(ws, 1006, 'phone locked screen')
    expect(turnCompleteCallback).not.toBeNull()

    // Reconnect tears down the watcher before the turn completes.
    handleWebSocket.open(reconnected)
    expect(removeOutputCallback).toHaveBeenCalled()
    setTimeoutSpy.mockClear()

    // A late result must not schedule cleanup now that a client is back.
    turnCompleteCallback?.({ type: 'result', subtype: 'success' })
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })
})

describe('WebSocket handler product error projection', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  it('does not echo malformed or unknown client payloads back to the renderer', () => {
    const ws = makeClientSocket(`protocol-error-${crypto.randomUUID()}`)
    const privatePayload = '/Users/test/.claude/private-provider-config.json token=secret'

    handleWebSocket.message(ws, `{\"type\":\"${privatePayload}\"`)
    handleWebSocket.message(ws, JSON.stringify({ type: privatePayload }))

    const messages = ws.sent.map((payload) => JSON.parse(payload))
    expect(messages).toEqual([
      {
        type: 'error',
        code: 'PARSE_ERROR',
        message: 'The task could not be completed. Please try again.',
        retryable: false,
      },
      {
        type: 'error',
        code: 'UNKNOWN_TYPE',
        message: 'The task could not be completed. Please try again.',
        retryable: false,
      },
    ])
    expect(JSON.stringify(messages)).not.toContain(privatePayload)
  })

  it('does not expose transcript-clear failures over the renderer socket', async () => {
    const ws = makeClientSocket(`clear-error-${crypto.randomUUID()}`)
    const privateError = 'failed to clear /Users/test/.claude/private-transcript.json token=secret'
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/Users/test/project')
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    spyOn(conversationService, 'clearOutputCallbacks').mockImplementation(() => {})
    spyOn(sessionService, 'clearSessionTranscript').mockRejectedValue(new Error(privateError))

    handleWebSocket.message(ws, JSON.stringify({ type: 'user_message', content: '/clear' }))

    await new Promise((resolve) => setTimeout(resolve, 0))

    const messages = ws.sent.map((payload) => JSON.parse(payload))
    expect(messages).toContainEqual({
      type: 'error',
      code: 'SESSION_CLEAR_FAILED',
      message: 'The task could not be completed. Please try again.',
      retryable: true,
    })
    expect(JSON.stringify(messages)).not.toContain(privateError)
  })

  it('projects a product task socket without forwarding Core reasoning or tool payloads', () => {
    const sessionId = `product-stream-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'product')
    const callbacks: Array<(cliMsg: any) => void> = []
    const privateThinking = 'PRIVATE_THINKING_CHAIN'
    const privateToolInput = 'PRIVATE_TOOL_INPUT'
    const privateToolResult = 'PRIVATE_TOOL_RESULT'

    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_id, callback) => {
      callbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    handleWebSocket.open(ws)
    callbacks[0]!({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: privateThinking },
          { type: 'tool_use', id: 'private-tool-id', name: 'Bash', input: { command: privateToolInput } },
        ],
      },
    })
    callbacks[0]!({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: 'private-tool-id',
          content: privateToolResult,
          is_error: false,
        }],
      },
    })

    const events = ws.sent.map((payload) => JSON.parse(payload))
    expect(events).toEqual([
      { type: 'connected' },
      { type: 'status', state: 'working' },
      { type: 'activity', kind: 'command', phase: 'running' },
      { type: 'activity', kind: 'tool', phase: 'completed' },
    ])
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(sessionId)
    expect(serialized).not.toContain(privateThinking)
    expect(serialized).not.toContain(privateToolInput)
    expect(serialized).not.toContain(privateToolResult)
    expect(serialized).not.toContain('Bash')
    expect(serialized).not.toContain('private-tool-id')
  })
})

describe('WebSocket handler product task inbound boundary', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  it('rejects Core configuration and approval envelopes without invoking Core handlers', () => {
    const ws = makeClientSocket(`product-inbound-${crypto.randomUUID()}`, 'product')
    const respondToPermission = spyOn(conversationService, 'respondToPermission')
    const setPermissionMode = spyOn(conversationService, 'setPermissionMode')
    const resolveComputerUseApproval = spyOn(computerUseApprovalService, 'resolveApproval')
    const sendUserMessage = spyOn(conversationService, 'sendMessage')
    const privateCommand = 'PRIVATE_PERMISSION_COMMAND'

    for (const payload of [
      { type: 'set_permission_mode', mode: 'bypassPermissions' },
      { type: 'set_runtime_config', providerId: 'private-provider', modelId: 'private-model' },
      { type: 'prewarm_session' },
      {
        type: 'permission_response',
        requestId: 'permission-1',
        allowed: true,
        rule: 'Bash(*)',
        updatedInput: { command: privateCommand },
        permissionUpdates: [{ type: 'addRules' }],
      },
      {
        type: 'computer_use_permission_response',
        requestId: 'computer-1',
        response: { granted: [], denied: [], flags: { clipboardRead: true, clipboardWrite: false, systemKeyCombos: false } },
      },
      {
        type: 'user_message',
        content: '查看附件',
        attachments: [{ type: 'file', path: '/private/file.txt' }],
      },
      {
        type: 'user_message',
        content: '普通任务文字',
        updatedInput: { command: privateCommand },
      },
    ]) {
      handleWebSocket.message(ws, JSON.stringify(payload))
    }

    expect(respondToPermission).not.toHaveBeenCalled()
    expect(setPermissionMode).not.toHaveBeenCalled()
    expect(resolveComputerUseApproval).not.toHaveBeenCalled()
    expect(sendUserMessage).not.toHaveBeenCalled()

    const events = ws.sent.map((payload) => JSON.parse(payload))
    expect(events).toEqual(Array.from({ length: 7 }, () => ({
      type: 'error',
      code: 'task_failed',
      retryable: false,
    })))
    expect(JSON.stringify(events)).not.toContain(privateCommand)
    expect(JSON.stringify(events)).not.toContain('private-provider')
  })

  it('allows only plain product text, task-local stop, and ping while preserving Core client and sdk channels', async () => {
    const productSessionId = `product-safe-${crypto.randomUUID()}`
    const productWs = makeClientSocket(productSessionId, 'product')
    const sendMessage = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('固定任务标题')

    handleWebSocket.message(productWs, JSON.stringify({
      type: 'user_message',
      content: '  /skill ball-hall-daily-review 整理本周球房活动安排  ',
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMessage).toHaveBeenCalledWith(productSessionId, '/skill ball-hall-daily-review 整理本周球房活动安排', undefined)

    productWs.sent.length = 0
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    handleWebSocket.message(productWs, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(productWs, JSON.stringify({ type: 'ping' }))
    expect(productWs.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'status', state: 'idle' },
    ])

    const clientWs = makeClientSocket(`client-safe-${crypto.randomUUID()}`)
    const clientPermissionResponse = spyOn(conversationService, 'respondToPermission')
    handleWebSocket.message(clientWs, JSON.stringify({
      type: 'permission_response',
      requestId: 'core-permission-1',
      allowed: true,
      updatedInput: { coreOnly: true },
    }))
    expect(clientPermissionResponse).toHaveBeenCalledWith(
      clientWs.data.sessionId,
      'core-permission-1',
      true,
      undefined,
      { coreOnly: true },
      undefined,
      undefined,
    )

    const sdkWs = makeClientSocket(`sdk-safe-${crypto.randomUUID()}`, 'sdk')
    const handleSdkPayload = spyOn(conversationService, 'handleSdkPayload')
    handleWebSocket.message(sdkWs, 'raw-sdk-payload')
    expect(handleSdkPayload).toHaveBeenCalledWith(sdkWs.data.sessionId, 'raw-sdk-payload')
  })
})

describe('prewarm idle timer active-turn guard (issue #865 follow-up)', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  // Arm the prewarm idle timer the way markPrewarmed does, and return its fire
  // callback so a test can trigger it deterministically without waiting 5 min.
  function armPrewarmIdleTimer(sessionId: string): () => void {
    const setTimeoutSpy = spyOn(globalThis, 'setTimeout').mockImplementation(
      (() => 0) as unknown as typeof setTimeout,
    )
    __markPrewarmedForTests(sessionId)
    const fire = setTimeoutSpy.mock.calls.at(-1)?.[0] as (() => void) | undefined
    if (!fire) throw new Error('prewarm idle timer was not armed')
    return fire
  }

  it('does not kill a prewarmed session once a user turn is registered, even before messageSent flips (CLI-startup blind window)', () => {
    const sessionId = `prewarm-blind-window-${crypto.randomUUID()}`
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const fire = armPrewarmIdleTimer(sessionId)

    // The concurrent prewarm_session/user_message race: the turn is registered
    // (activeUserTurns has it) but messageSent is still false during CLI startup
    // when the idle timer fires. The old isSessionTurnActive guard was blind to
    // this window — the turn-registered guard must catch it.
    __registerPendingUserTurnForTests(sessionId)
    fire()

    expect(stopSession).not.toHaveBeenCalled()
  })

  it('does not kill a prewarmed session with a fully active (messageSent) turn', () => {
    const sessionId = `prewarm-active-turn-${crypto.randomUUID()}`
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const fire = armPrewarmIdleTimer(sessionId)

    __markActiveTurnForTests(sessionId)
    fire()

    expect(stopSession).not.toHaveBeenCalled()
  })

  it('still reclaims a truly idle prewarmed session with no turn and no clients', () => {
    const sessionId = `prewarm-truly-idle-${crypto.randomUUID()}`
    const stopSession = spyOn(conversationService, 'stopSession').mockImplementation(() => {})
    const fire = armPrewarmIdleTimer(sessionId)

    // No registered turn and no connected client → the reaper must still fire,
    // otherwise the timer's whole purpose (reclaiming idle prewarmed CLIs) is lost.
    fire()

    expect(stopSession).toHaveBeenCalledWith(sessionId)
  })
})
