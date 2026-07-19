/**
 * Tests for ConversationService and WebSocket chat integration
 *
 * ConversationService 管理 CLI 子进程的生命周期。
 * WebSocket 集成测试验证消息从客户端经过服务端到达 CLI 的完整流转。
 */

import { describe, it, expect } from 'bun:test'
import { ConversationService } from '../services/conversationService.js'

// ============================================================================
// ConversationService unit tests
// ============================================================================

describe('ConversationService', () => {
  it('should report no session for unknown ID', () => {
    const svc = new ConversationService()
    const sid = crypto.randomUUID()
    expect(svc.hasSession(sid)).toBe(false)
  })

  it('should track active sessions as empty initially', () => {
    const svc = new ConversationService()
    expect(svc.getActiveSessions()).toEqual([])
  })

  it('should return false when sending message to non-existent session', async () => {
    const svc = new ConversationService()
    const result = await svc.sendMessage('no-such-session', 'hello')
    expect(result).toBe(false)
  })

  it('should return false when responding to permission for non-existent session', () => {
    const svc = new ConversationService()
    const result = svc.respondToPermission('no-such-session', 'req-1', true)
    expect(result).toBe(false)
  })

  it('should not queue control requests before the SDK socket connects', async () => {
    const svc = new ConversationService()
    const sid = crypto.randomUUID()
    const sent: unknown[] = []
    const session: any = {
      proc: { kill() {}, exited: Promise.resolve(0) },
      outputCallbacks: [],
      workDir: process.cwd(),
      permissionMode: 'default',
      sdkToken: 'token',
      sdkSocket: null,
      pendingOutbound: [],
      startupPending: false,
      startupExitCode: null,
      stdoutLines: [],
      stderrLines: [],
      outputDrain: Promise.resolve(),
      sdkMessages: [],
      initMessage: null,
      pendingPermissionRequests: new Map(),
    }
    ;(svc as any).sessions.set(sid, session)

    const request = svc.requestControl(sid, { subtype: 'get_context_usage' }, 1_000)
    await new Promise((resolve) => setTimeout(resolve, 75))

    expect(session.pendingOutbound).toHaveLength(0)
    expect(sent).toHaveLength(0)

    session.sdkSocket = {
      send(data: string) {
        sent.push(JSON.parse(data))
      },
    }

    await new Promise((resolve) => setTimeout(resolve, 75))
    expect(session.pendingOutbound).toHaveLength(0)
    expect(sent).toHaveLength(1)

    const requestId = (sent[0] as any).request_id
    for (const callback of [...session.outputCallbacks]) {
      callback({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: requestId,
          response: { ok: true },
        },
      })
    }

    await expect(request).resolves.toEqual({ ok: true })
  })

  it('should forward suggested permission updates for allow-for-session decisions', () => {
    const svc = new ConversationService()
    const sent: unknown[] = []

    ;(svc as any).sessions.set('session-1', {
      proc: null,
      outputCallbacks: [],
      workDir: process.cwd(),
      sdkToken: 'token',
      sdkSocket: {
        send(data: string) {
          sent.push(JSON.parse(data))
        },
      },
      pendingOutbound: [],
      stderrLines: [],
      sdkMessages: [],
      pendingPermissionRequests: new Map([
        ['req-1', {
          toolName: 'Bash',
          input: { command: 'ls src' },
          permissionSuggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'ls src' }],
              behavior: 'allow',
              destination: 'localSettings',
            },
          ],
        }],
      ]),
    })

    const result = svc.respondToPermission('session-1', 'req-1', true, 'always')

    expect(result).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'control_response',
      response: {
        response: {
          behavior: 'allow',
          updatedPermissions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'ls src' }],
              behavior: 'allow',
              destination: 'session',
            },
          ],
        },
      },
    })
  })

  it('should forward explicit permission updates from desktop plan approval', () => {
    const svc = new ConversationService()
    const sent: unknown[] = []
    const permissionUpdates = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash', ruleContent: 'prompt: run tests' }],
        behavior: 'allow',
        destination: 'session',
      },
    ]

    ;(svc as any).sessions.set('session-1', {
      proc: null,
      outputCallbacks: [],
      workDir: process.cwd(),
      sdkToken: 'token',
      sdkSocket: {
        send(data: string) {
          sent.push(JSON.parse(data))
        },
      },
      pendingOutbound: [],
      stderrLines: [],
      sdkMessages: [],
      pendingPermissionRequests: new Map(),
    })

    const result = svc.respondToPermission(
      'session-1',
      'req-1',
      true,
      undefined,
      undefined,
      undefined,
      permissionUpdates,
    )

    expect(result).toBe(true)
    expect(sent[0]).toMatchObject({
      type: 'control_response',
      response: {
        response: {
          behavior: 'allow',
          updatedPermissions: permissionUpdates,
        },
      },
    })
  })

  it('should forward explicit denial feedback from desktop plan rejection', () => {
    const svc = new ConversationService()
    const sent: unknown[] = []

    ;(svc as any).sessions.set('session-1', {
      proc: null,
      outputCallbacks: [],
      workDir: process.cwd(),
      sdkToken: 'token',
      sdkSocket: {
        send(data: string) {
          sent.push(JSON.parse(data))
        },
      },
      pendingOutbound: [],
      stderrLines: [],
      sdkMessages: [],
      pendingPermissionRequests: new Map(),
    })

    const result = svc.respondToPermission(
      'session-1',
      'req-1',
      false,
      undefined,
      undefined,
      'Add rollback steps before implementation.',
    )

    expect(result).toBe(true)
    expect(sent[0]).toMatchObject({
      type: 'control_response',
      response: {
        response: {
          behavior: 'deny',
          message: 'Add rollback steps before implementation.',
        },
      },
    })
  })

  it('should not inject a desktop-specific ask override in default permission mode', () => {
    const svc = new ConversationService()
    expect((svc as any).getPermissionArgs('default', false)).toEqual([
      '--permission-mode',
      'default',
    ])
  })

  it('should pass disabled thinking to the CLI runtime args', () => {
    const svc = new ConversationService()
    expect((svc as any).getRuntimeArgs({
      model: 'deepseek-v4-pro',
      effort: 'medium',
      thinking: 'disabled',
    })).toEqual([
      '--model',
      'deepseek-v4-pro',
      '--effort',
      'medium',
      '--thinking',
      'disabled',
    ])
  })

  it('should pass enabled thinking to the CLI runtime args', () => {
    const svc = new ConversationService()
    expect((svc as any).getRuntimeArgs({
      thinking: 'enabled',
    })).toEqual([
      '--thinking',
      'enabled',
    ])
  })

  it('should send thinking token controls to active CLI sessions', () => {
    const svc = new ConversationService() as any
    const sent: string[] = []
    svc.sessions.set('session-thinking-control', {
      sdkSocket: { send: (data: string) => sent.push(data) },
      pendingOutbound: [],
    })

    expect(svc.setMaxThinkingTokens('session-thinking-control', 0)).toBe(true)
    expect(svc.setMaxThinkingTokens('session-thinking-control', null)).toBe(true)
    expect(svc.setMaxThinkingTokensForActiveSessions(0)).toBe(1)

    expect(sent.map((line) => JSON.parse(line).request)).toEqual([
      {
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: 0,
      },
      {
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: null,
      },
      {
        subtype: 'set_max_thinking_tokens',
        max_thinking_tokens: 0,
      },
    ])
  })

  it('should return false when sending interrupt to non-existent session', () => {
    const svc = new ConversationService()
    const result = svc.sendInterrupt('no-such-session')
    expect(result).toBe(false)
  })

  it('should not throw when stopping non-existent session', () => {
    const svc = new ConversationService()
    expect(() => svc.stopSession('no-such-session')).not.toThrow()
  })

  it('should not throw when registering callback for non-existent session', () => {
    const svc = new ConversationService()
    expect(() => svc.onOutput('no-such-session', () => {})).not.toThrow()
  })

  it('should ignore stale process exits after a session restarts', async () => {
    const svc = new ConversationService()
    const oldProc = { pid: 1 } as any
    const newProc = { pid: 2 } as any

    ;(svc as any).sessions.set('session-restart', {
      proc: newProc,
      outputCallbacks: [],
      workDir: process.cwd(),
      permissionMode: 'bypassPermissions',
      sdkToken: 'token',
      sdkSocket: null,
      pendingOutbound: [],
      stderrLines: [],
      sdkMessages: [],
      pendingPermissionRequests: new Map(),
    })

    await (svc as any).handleProcessExit('session-restart', oldProc, 143)
    expect(svc.hasSession('session-restart')).toBe(true)

    await (svc as any).handleProcessExit('session-restart', newProc, 0)
    expect(svc.hasSession('session-restart')).toBe(false)
  })

  it('should retain SDK init metadata after recent message trimming', () => {
    const svc = new ConversationService()

    ;(svc as any).sessions.set('session-init-retention', {
      proc: { pid: 1 },
      outputCallbacks: [],
      workDir: process.cwd(),
      permissionMode: 'default',
      sdkToken: 'token',
      sdkSocket: null,
      pendingOutbound: [],
      stderrLines: [],
      sdkMessages: [],
      initMessage: null,
      pendingPermissionRequests: new Map(),
    })

    ;(svc as any).handleSdkPayload('session-init-retention', JSON.stringify({
      type: 'system',
      subtype: 'init',
      model: 'mock-opus',
      claude_code_version: 'test-version',
      slash_commands: ['help', 'context'],
    }))

    for (let i = 0; i < 45; i++) {
      ;(svc as any).handleSdkPayload('session-init-retention', JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_delta', index: i },
      }))
    }

    expect(svc.getRecentSdkMessages('session-init-retention').some((message) => message.subtype === 'init')).toBe(false)
    expect(svc.getSessionInitMessage('session-init-retention')).toMatchObject({
      model: 'mock-opus',
      claude_code_version: 'test-version',
      slash_commands: ['help', 'context'],
    })
  })

  it('should expose live SDK permission requests for reconnecting clients', () => {
    const svc = new ConversationService()

    ;(svc as any).sessions.set('session-pending-permission', {
      proc: { pid: 1 },
      outputCallbacks: [],
      workDir: process.cwd(),
      permissionMode: 'default',
      sdkToken: 'token',
      sdkSocket: null,
      pendingOutbound: [],
      stderrLines: [],
      sdkMessages: [],
      initMessage: null,
      pendingPermissionRequests: new Map(),
    })

    ;(svc as any).handleSdkPayload('session-pending-permission', JSON.stringify({
      type: 'control_request',
      request_id: 'request-ask-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        tool_use_id: 'tool-ask-1',
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
    }))

    expect(svc.getPendingPermissionRequests('session-pending-permission')).toEqual([
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
  })
})
