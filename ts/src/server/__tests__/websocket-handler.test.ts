import { afterEach, describe, expect, it, mock, spyOn } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import {
  __markActiveTurnForTests,
  __resetWebSocketHandlerStateForTests,
  getActiveSessionIds,
  handleWebSocket,
  resolveProductThinkingMode,
  sendToSession,
  translateCliMessage,
  type WebSocketData,
} from '../ws/handler.js'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import { computerUseApprovalService } from '../services/computerUseApprovalService.js'

function makeClientSocket(
  sessionId: string,
  channel: WebSocketData['channel'] = 'product',
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

describe('product deep-thinking startup policy', () => {
  it('defaults managed DeepSeek task processes to thinking enabled and persists an explicit off choice', () => {
    expect(resolveProductThinkingMode({}, 'qf-gateway', 'deepseek-v4-flash')).toBe('enabled')
    expect(resolveProductThinkingMode(
      { alwaysThinkingEnabled: false },
      'qf-gateway',
      'deepseek-v4-flash',
    )).toBe('enabled')
    expect(resolveProductThinkingMode(
      { deepThinkingEnabled: false },
      'qf-gateway',
      'deepseek-v4-flash',
    )).toBe('disabled')
  })

  it('keeps MiMo and non-managed providers out of the product Deep Thinking toggle', () => {
    expect(resolveProductThinkingMode(
      { deepThinkingEnabled: true },
      'qf-gateway',
      'mimo-v2.5',
    )).toBe('disabled')
    expect(resolveProductThinkingMode(
      { deepThinkingEnabled: true },
      'manual-provider',
      'deepseek-v4-flash',
    )).toBeUndefined()
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
    const completion = [
      { type: 'status', state: 'idle' },
      { type: 'turn_complete' },
    ]
    expect(firstEvents.filter((event) => event.type === 'turn_complete').length).toBe(1)
    expect(secondEvents.filter((event) => event.type === 'turn_complete').length).toBe(1)
    expect(firstEvents.slice(-2)).toEqual(completion)
    expect(secondEvents.slice(-2)).toEqual(completion)
  })

  it('persists CLI permission broadcasts without emitting a raw product event', async () => {
    const sessionId = `permission-broadcast-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId)
    const callbacks: Array<(cliMsg: any) => void> = []
    const recordPermissionMode = spyOn(conversationService, 'recordSessionPermissionMode')
      .mockReturnValue(true)
    const appendMetadata = spyOn(sessionService, 'appendSessionMetadata')
      .mockResolvedValue(undefined)

    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'getSessionPermissionMode').mockReturnValue('plan')
    spyOn(conversationService, 'getSessionWorkDir').mockReturnValue('/workspace')
    spyOn(conversationService, 'onOutput').mockImplementation((_id, callback) => {
      callbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    handleWebSocket.open(ws)
    expect(callbacks).toHaveLength(1)

    callbacks[0]!({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode: 'bypassPermissions',
    })
    await Promise.resolve()

    expect(recordPermissionMode).toHaveBeenCalledWith(sessionId, 'bypassPermissions')
    expect(appendMetadata).toHaveBeenCalledWith(sessionId, {
      workDir: '/workspace',
      permissionMode: 'bypassPermissions',
    })

    const events = ws.sent.map((payload) => JSON.parse(payload))
    expect(events).toEqual([
      { type: 'connected' },
      { type: 'run_snapshot', state: 'idle', activities: [] },
    ])
  })

  it('replays pending approvals as product-safe questions when a task reconnects', () => {
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
      type: 'approval_required',
      requestId: 'request-ask-1',
      kind: 'question',
      questions: [{
        header: 'Scope',
        question: 'Which scope?',
        options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }],
      }],
    })
    expect(JSON.stringify(ws.sent)).not.toContain('tool-ask-1')
    expect(JSON.stringify(ws.sent)).not.toContain('Answer questions?')
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
        code: 'task_failed',
        retryable: false,
      },
      {
        type: 'error',
        code: 'task_failed',
        retryable: false,
      },
    ])
    expect(JSON.stringify(messages)).not.toContain(privatePayload)
  })

  it('rejects retired raw transcript commands before they reach transcript handling', async () => {
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
      code: 'attachment_ingest_unavailable',
      retryable: false,
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
    expect(events).toHaveLength(5)
    expect(events[0]).toEqual({ type: 'connected' })
    expect(events[1]).toEqual({ type: 'run_snapshot', state: 'idle', activities: [] })
    expect(events[2]).toEqual({ type: 'status', state: 'working' })
    expect(events[3]).toMatchObject({
      id: expect.stringMatching(/^activity_[a-f0-9]{32}$/),
      kind: 'command',
      phase: 'running',
      summary: '正在处理任务操作',
    })
    expect(events[4]).toMatchObject({
      id: events[3].id,
      kind: 'command',
      phase: 'completed',
      summary: '已完成任务操作',
    })
    const serialized = JSON.stringify(events)
    expect(serialized).not.toContain(sessionId)
    expect(serialized).not.toContain(privateThinking)
    expect(serialized).not.toContain(privateToolInput)
    expect(serialized).not.toContain(privateToolResult)
    expect(serialized).not.toContain('Bash')
    expect(serialized).not.toContain('private-tool-id')
  })

  it('hydrates a reconnected product task from the latest safe run snapshot', () => {
    const sessionId = `product-run-reconnect-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId, 'product')
    const reconnected = makeClientSocket(sessionId, 'product')
    const callbacks: Array<(cliMsg: any) => void> = []
    const privateToolUseId = 'PRIVATE_RECONNECT_TOOL'
    const privatePath = '/Users/private/reconnect-output.txt'

    spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_id, callback) => {
      callbacks.push(callback)
    })
    const removeOutputCallback = spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    handleWebSocket.open(first)
    sendToSession(sessionId, { type: 'status', state: 'thinking' })
    handleWebSocket.close(first, 1006, 'renderer reconnecting')

    // The product run is still active, so its one Core-output callback stays
    // alive and continues to update the safe registry while no window exists.
    expect(removeOutputCallback).not.toHaveBeenCalled()
    expect(callbacks).toHaveLength(1)
    callbacks[0]!({
      type: 'assistant',
      message: {
        content: [{
          type: 'tool_use',
          id: privateToolUseId,
          name: 'Bash',
          input: { command: `cat ${privatePath}` },
        }],
      },
    })
    callbacks[0]!({
      type: 'user',
      message: {
        content: [{
          type: 'tool_result',
          tool_use_id: privateToolUseId,
          content: { path: privatePath, stdout: 'PRIVATE_RECONNECT_RESULT' },
          is_error: false,
        }],
      },
    })

    handleWebSocket.open(reconnected)
    const events = reconnected.sent.map((payload) => JSON.parse(payload))
    expect(events.slice(0, 2)).toEqual([
      { type: 'connected' },
      {
        type: 'run_snapshot',
        state: 'working',
        activities: [expect.objectContaining({
          id: expect.stringMatching(/^activity_[a-f0-9]{32}$/),
          kind: 'command',
          phase: 'completed',
          summary: '已完成任务操作',
        })],
      },
    ])
    const serialized = JSON.stringify(events)
    for (const privateValue of [sessionId, privateToolUseId, privatePath, 'PRIVATE_RECONNECT_RESULT', 'Bash']) {
      expect(serialized).not.toContain(privateValue)
    }
  })

  it('uses the opaque activity tree for product task sockets', () => {
    const productSessionId = `product-tree-${crypto.randomUUID()}`
    const productWs = makeClientSocket(productSessionId, 'product')
    const productTaskId = `task-${productSessionId}`
    const privateToolUseId = 'PRIVATE_TOOL_USE_ID'
    const privateParentToolUseId = 'PRIVATE_PARENT_TOOL_USE_ID'
    const privateTeamName = 'PRIVATE_TEAM_NAME'
    const privateTaskId = 'PRIVATE_BACKGROUND_TASK_ID'
    const privatePath = '/Users/private/task-output.txt'
    const privateMessage = `PRIVATE_MESSAGE ${privatePath}`

    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])
    handleWebSocket.open(productWs)

    expect(sendToSession(productSessionId, {
      type: 'content_start',
      blockType: 'tool_use',
      toolName: 'Bash',
      toolUseId: privateToolUseId,
      parentToolUseId: privateParentToolUseId,
    })).toBe(true)
    sendToSession(productSessionId, {
      type: 'tool_use_complete',
      toolName: 'Bash',
      toolUseId: privateToolUseId,
      parentToolUseId: privateParentToolUseId,
      input: { command: `cat ${privatePath}`, prompt: 'PRIVATE_PROMPT' },
    })
    sendToSession(productSessionId, {
      type: 'tool_result',
      toolUseId: privateToolUseId,
      parentToolUseId: privateParentToolUseId,
      content: { stdout: 'PRIVATE_TOOL_RESULT', path: privatePath },
      isError: false,
    })
    sendToSession(productSessionId, {
      type: 'team_update',
      teamName: privateTeamName,
      members: [
        { agentId: 'PRIVATE_AGENT_A', role: 'PRIVATE_ROLE', status: 'completed', currentTask: privatePath },
        { agentId: 'PRIVATE_AGENT_B', role: 'PRIVATE_ROLE', status: 'running', currentTask: privateMessage },
      ],
    })
    sendToSession(productSessionId, {
      type: 'system_notification',
      subtype: 'task_progress',
      message: privateMessage,
      data: {
        task_id: privateTaskId,
        tool_use_id: privateParentToolUseId,
        prompt: 'PRIVATE_PROMPT',
        output_file: privatePath,
      },
    })

    const productEvents = productWs.sent.map((payload) => JSON.parse(payload))
    expect(productEvents[0]).toEqual({ type: 'connected' })
    expect(productEvents[1]).toEqual({ type: 'run_snapshot', state: 'idle', activities: [] })
    const activities = productEvents.filter((event) => event.type === 'activity')
    expect(activities).toHaveLength(5)
    const [started, running, completed, team, backgroundTask] = activities
    const toolActivityId = started.id
    const toolParentId = started.parentId
    expect(toolActivityId).toMatch(/^activity_[a-f0-9]{32}$/)
    expect(toolParentId).toMatch(/^activity_[a-f0-9]{32}$/)
    expect(started).toMatchObject({
      kind: 'command',
      phase: 'started',
      summary: '正在处理任务操作',
    })
    expect(running).toMatchObject({
      id: toolActivityId,
      parentId: toolParentId,
      kind: 'command',
      phase: 'running',
      summary: '正在处理任务操作',
    })
    expect(completed).toMatchObject({
      id: toolActivityId,
      parentId: toolParentId,
      kind: 'command',
      phase: 'completed',
      summary: '已完成任务操作',
    })
    expect(team).toMatchObject({
      kind: 'subtask',
      phase: 'running',
      summary: '正在协同处理事项',
      progress: { completed: 1, total: 2 },
    })
    expect(backgroundTask).toMatchObject({
      kind: 'subtask',
      phase: 'running',
      summary: '正在协同处理事项',
      parentId: toolParentId,
    })

    const productSerialized = JSON.stringify(productEvents)
    for (const secret of [
      productSessionId,
      productTaskId,
      privateToolUseId,
      privateParentToolUseId,
      privateTeamName,
      privateTaskId,
      privatePath,
      privateMessage,
      'PRIVATE_PROMPT',
      'PRIVATE_TOOL_RESULT',
      'PRIVATE_AGENT_A',
      'PRIVATE_ROLE',
      'Bash',
    ]) {
      expect(productSerialized).not.toContain(secret)
    }

  })

  it('fails closed once when an AskUserQuestion cannot be represented safely', () => {
    const sessionId = `product-ask-fail-closed-${crypto.randomUUID()}`
    const first = makeClientSocket(sessionId, 'product')
    const second = makeClientSocket(sessionId, 'product')
    const callbacks: Array<(cliMsg: any) => void> = []
    const privateQuestion = '  /Users/test/private-scope  '
    const respondToPermission = spyOn(conversationService, 'respondToPermission')

    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation((_id, callback) => {
      callbacks.push(callback)
    })
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([])

    handleWebSocket.open(first)
    handleWebSocket.open(second)
    callbacks[0]!({
      type: 'control_request',
      request_id: 'ask-not-renderable',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: { questions: [{ question: privateQuestion }] },
      },
    })

    expect(respondToPermission).toHaveBeenCalledTimes(1)
    expect(respondToPermission).toHaveBeenCalledWith(sessionId, 'ask-not-renderable', false)
    for (const ws of [first, second]) {
      const events = ws.sent.map((payload) => JSON.parse(payload))
      expect(events).toEqual([
        { type: 'connected' },
        { type: 'run_snapshot', state: 'idle', activities: [] },
        { type: 'error', code: 'task_failed', retryable: false },
      ])
      expect(JSON.stringify(events)).not.toContain(privateQuestion)
    }
  })
})

describe('WebSocket handler product task inbound boundary', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  it('rejects Core-only product payload fields without invoking Core handlers', () => {
    const ws = makeClientSocket(`product-inbound-${crypto.randomUUID()}`, 'product')
    const respondToPermission = spyOn(conversationService, 'respondToPermission')
    const resolveProductTaskApproval = spyOn(computerUseApprovalService, 'resolveProductTaskApproval')
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
      {
        type: 'ask_user_question_response',
        requestId: 'ask-1',
        answers: ['整理台账'],
        updatedInput: { command: privateCommand },
      },
    ]) {
      handleWebSocket.message(ws, JSON.stringify(payload))
    }

    expect(respondToPermission).not.toHaveBeenCalled()
    expect(resolveProductTaskApproval).not.toHaveBeenCalled()
    expect(sendUserMessage).not.toHaveBeenCalled()

    const events = ws.sent.map((payload) => JSON.parse(payload))
    expect(events).toEqual([
      ...Array.from({ length: 5 }, () => ({ type: 'error', code: 'task_failed', retryable: false })),
      ...Array.from({ length: 2 }, () => ({ type: 'error', code: 'attachment_ingest_unavailable', retryable: false })),
      { type: 'error', code: 'task_failed', retryable: false },
    ])
    expect(JSON.stringify(events)).not.toContain(privateCommand)
    expect(JSON.stringify(events)).not.toContain('private-provider')
  })

  it('resolves product approvals only against matching server pending requests', () => {
    const sessionId = `product-approval-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'product')
    const privateToolInput = 'PRIVATE_TOOL_INPUT'
    const askInput = {
      questions: [{
        question: '先处理哪一项？',
        header: '优先级',
        options: [
          { label: '整理台账', description: '核对当天收入' },
          { label: '联系客户', description: '确认预约' },
        ],
      }],
      privateToolInput,
    }
    spyOn(conversationService, 'getPendingPermissionRequests').mockReturnValue([
      {
        requestId: 'action-allow',
        toolName: 'Bash',
        input: { command: privateToolInput },
      },
      {
        requestId: 'action-deny',
        toolName: 'Write',
        input: { file_path: privateToolInput },
      },
      {
        requestId: 'ask-1',
        toolName: 'AskUserQuestion',
        input: askInput,
      },
    ])
    const respondToPermission = spyOn(conversationService, 'respondToPermission')

    handleWebSocket.message(ws, JSON.stringify({
      type: 'permission_response',
      requestId: 'action-allow',
      allowed: true,
    }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'permission_response',
      requestId: 'action-deny',
      allowed: false,
    }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'permission_response',
      requestId: 'ask-1',
      allowed: true,
    }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'ask_user_question_response',
      requestId: 'action-allow',
      answers: ['整理台账'],
    }))
    handleWebSocket.message(ws, JSON.stringify({
      type: 'ask_user_question_response',
      requestId: 'ask-1',
      answers: ['  整理台账  '],
    }))

    expect(respondToPermission).toHaveBeenNthCalledWith(1, sessionId, 'action-allow', true)
    expect(respondToPermission).toHaveBeenNthCalledWith(2, sessionId, 'action-deny', false)
    expect(respondToPermission).toHaveBeenNthCalledWith(
      3,
      sessionId,
      'ask-1',
      true,
      undefined,
      {
        ...askInput,
        answers: { '先处理哪一项？': '整理台账' },
      },
    )

    const events = ws.sent.map((payload) => JSON.parse(payload))
    expect(events).toEqual(Array.from({ length: 2 }, () => ({
      type: 'error',
      code: 'task_failed',
      retryable: false,
    })))
    expect(JSON.stringify(events)).not.toContain(privateToolInput)
  })

  it('forwards only a one-shot product Computer Use decision to the pending-request service', () => {
    const sessionId = `product-computer-use-${crypto.randomUUID()}`
    const ws = makeClientSocket(sessionId, 'product')
    const resolveProductTaskApproval = spyOn(
      computerUseApprovalService,
      'resolveProductTaskApproval',
    ).mockReturnValue(true)

    handleWebSocket.message(ws, JSON.stringify({
      type: 'computer_use_permission_response',
      requestId: 'computer-use-1',
      allowed: true,
    }))

    expect(resolveProductTaskApproval).toHaveBeenCalledWith(
      sessionId,
      'computer-use-1',
      true,
    )

    resolveProductTaskApproval.mockReturnValue(false)
    handleWebSocket.message(ws, JSON.stringify({
      type: 'computer_use_permission_response',
      requestId: 'stale-computer-use',
      allowed: false,
    }))

    expect(ws.sent.map((payload) => JSON.parse(payload))).toEqual([{
      type: 'error',
      code: 'task_failed',
      retryable: false,
    }])
  })

  it('rejects retired raw attachments while preserving task-local stop and ping', async () => {
    const productSessionId = `product-safe-${crypto.randomUUID()}`
    const productWs = makeClientSocket(productSessionId, 'product')
    const sendMessage = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('固定任务标题')

    handleWebSocket.message(productWs, JSON.stringify({
      type: 'user_message',
      content: '  /goal 整理本周球房活动安排  ',
      attachments: [{
        type: 'image',
        name: 'table.png',
        mimeType: 'image/png',
        data: 'data:image/png;base64,aGVsbG8=',
      }],
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendMessage).not.toHaveBeenCalled()
    expect(productWs.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'error', code: 'attachment_ingest_unavailable', retryable: false,
    })

    productWs.sent.length = 0
    spyOn(conversationService, 'hasSession').mockReturnValue(false)
    handleWebSocket.message(productWs, JSON.stringify({ type: 'stop_generation' }))
    handleWebSocket.message(productWs, JSON.stringify({ type: 'ping' }))
    expect(productWs.sent.map((payload) => JSON.parse(payload))).toEqual([
      { type: 'status', state: 'idle' },
    ])

  })

  it('rejects every retired raw product text payload without exposing it', async () => {
    const ws = makeClientSocket(`product-command-${crypto.randomUUID()}`, 'product')
    const sendUserMessage = spyOn(conversationService, 'sendMessage').mockResolvedValue(true)
    const privateCommand = '/model private-model /Users/test/.claude/private-provider.json token=secret'

    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: privateCommand,
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendUserMessage).not.toHaveBeenCalled()
    const events = ws.sent.map((payload) => JSON.parse(payload))
    expect(events).toEqual([
      {
        type: 'error',
        code: 'attachment_ingest_unavailable',
        retryable: false,
      },
    ])
    expect(JSON.stringify(events)).not.toContain(privateCommand)
    expect(JSON.stringify(events)).not.toContain('private-provider')

    ws.sent.length = 0
    sendUserMessage.mockClear()
    spyOn(conversationService, 'hasSession').mockReturnValue(true)
    spyOn(conversationService, 'onOutput').mockImplementation(() => {})
    spyOn(conversationService, 'removeOutputCallback').mockImplementation(() => {})
    spyOn(sessionService, 'getCustomTitle').mockResolvedValue('普通任务')

    handleWebSocket.message(ws, JSON.stringify({
      type: 'user_message',
      content: '整理今天球房的营业数据，并列出待确认问题',
    }))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(sendUserMessage).not.toHaveBeenCalled()
    expect(ws.sent.map((payload) => JSON.parse(payload))).toContainEqual({
      type: 'error', code: 'attachment_ingest_unavailable', retryable: false,
    })
  })
})

describe('WebSocket handler SDK boundary', () => {
  afterEach(() => {
    __resetWebSocketHandlerStateForTests()
    mock.restore()
  })

  it('rejects an SDK socket without a valid session token', () => {
    const ws = makeClientSocket(`sdk-rejected-${crypto.randomUUID()}`, 'sdk')
    const authorize = spyOn(conversationService, 'authorizeSdkConnection').mockReturnValue(false)
    const attach = spyOn(conversationService, 'attachSdkConnection')

    handleWebSocket.open(ws)

    expect(authorize).toHaveBeenCalledWith(ws.data.sessionId, null)
    expect(attach).not.toHaveBeenCalled()
    expect(ws.close).toHaveBeenCalledWith(1008, 'Invalid SDK token')
  })

  it('keeps the authorized SDK transport internal while forwarding raw payloads', () => {
    const ws = makeClientSocket(`sdk-authorized-${crypto.randomUUID()}`, 'sdk')
    const authorize = spyOn(conversationService, 'authorizeSdkConnection').mockReturnValue(true)
    const attach = spyOn(conversationService, 'attachSdkConnection')
    const handleSdkPayload = spyOn(conversationService, 'handleSdkPayload')
    const detach = spyOn(conversationService, 'detachSdkConnection')

    handleWebSocket.open(ws)
    handleWebSocket.message(ws, 'raw-sdk-payload')
    handleWebSocket.close(ws, 1000, 'completed')

    expect(authorize).toHaveBeenCalledWith(ws.data.sessionId, null)
    expect(attach).toHaveBeenCalledWith(ws.data.sessionId, ws)
    expect(handleSdkPayload).toHaveBeenCalledWith(ws.data.sessionId, 'raw-sdk-payload')
    expect(detach).toHaveBeenCalledWith(ws.data.sessionId)
  })
})
