/**
 * Tests for ConversationService and WebSocket chat integration
 *
 * ConversationService 管理 CLI 子进程的生命周期。
 * WebSocket 集成测试验证消息从客户端经过服务端到达 CLI 的完整流转。
 */

import { describe, it, expect, beforeAll, afterAll, spyOn } from 'bun:test'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { ConversationService, ConversationStartupError, conversationService } from '../services/conversationService.js'
import { SessionService, sessionService } from '../services/sessionService.js'
import { ProviderService } from '../services/providerService.js'
import { SettingsService } from '../services/settingsService.js'
import { getSlashCommands } from '../ws/handler.js'

async function setDefaultPermissionModeForIntegrationTests(mode: string): Promise<void> {
  await new SettingsService().setPermissionMode(mode)
}

async function rmWithRetry(targetPath: string): Promise<void> {
  const attempts = process.platform === 'win32' ? 5 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true })
      return
    } catch (error) {
      if (
        attempt === attempts - 1 ||
        !['EBUSY', 'EPERM', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code || '')
      ) {
        throw error
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)))
    }
  }
}

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

  it('should block startup after a session is deleted during prewarm', async () => {
    const svc = new ConversationService()
    const sid = crypto.randomUUID()

    svc.markSessionDeleted(sid)

    try {
      await svc.startSession(sid, process.cwd(), 'ws://127.0.0.1:1/sdk/test')
      throw new Error('expected startSession to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(ConversationStartupError)
      expect((error as ConversationStartupError).code).toBe('SESSION_DELETED')
    }
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

  it('should send set_permission_mode requests to active sessions', () => {
    const svc = new ConversationService()
    const sent: unknown[] = []

    ;(svc as any).sessions.set('session-2', {
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

    const result = svc.setPermissionMode('session-2', 'acceptEdits')

    expect(result).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: 'control_request',
      request: {
        subtype: 'set_permission_mode',
        mode: 'acceptEdits',
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

  it('should reconstruct usage and metadata from a persisted transcript', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousAnthropicApiKey = process.env.ANTHROPIC_API_KEY
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.ANTHROPIC_API_KEY = 'test-key'

    try {
      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-04-27T12:00:00.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'mock-model',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 1234,
            output_tokens: 56,
            cache_read_input_tokens: 7,
            cache_creation_input_tokens: 8,
            server_tool_use: { web_search_requests: 1 },
          },
        },
      }) + '\n')

      const metadata = await svc.getTranscriptMetadata(sessionId)
      const usage = await svc.getTranscriptUsage(sessionId)

      expect(metadata).toMatchObject({
        cwd: workDir,
        version: '999.0.0-test',
        model: 'mock-model',
      })
      expect(usage).toMatchObject({
        source: 'transcript',
        totalInputTokens: 1234,
        totalOutputTokens: 56,
        totalCacheReadInputTokens: 7,
        totalCacheCreationInputTokens: 8,
        totalWebSearchRequests: 1,
      })
      expect(usage?.models[0]?.model).toBe('mock-model')
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      if (previousAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY
      } else {
        process.env.ANTHROPIC_API_KEY = previousAnthropicApiKey
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should reconstruct Sonnet 4.6 transcript usage before CLI config is initialized', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-sonnet-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-sonnet-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'

    try {
      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-04-27T12:00:00.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const usage = await svc.getTranscriptUsage(sessionId)
      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)

      expect(usage?.models[0]?.model).toBe('claude-sonnet-4-6')
      expect(usage?.models[0]?.contextWindow).toBe(200_000)
      expect(contextEstimate?.model).toBe('claude-sonnet-4-6')
      expect(contextEstimate?.totalTokens).toBe(120)
      expect(contextEstimate?.rawMaxTokens).toBe(200_000)
      expect(contextEstimate?.categories.some((category) => category.name === 'Output tokens' && category.tokens === 20)).toBe(true)
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should use active provider model context windows for transcript estimates', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousModelContextWindows = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-provider-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-provider-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS

    try {
      const providerService = new ProviderService()
      const provider = await providerService.addProvider({
        presetId: 'minimax',
        name: 'MiniMax',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://api.minimaxi.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'MiniMax-M3',
          haiku: 'MiniMax-M3',
          sonnet: 'MiniMax-M3',
          opus: 'MiniMax-M3',
        },
        modelContextWindows: {
          'MiniMax-M3': 1_000_000,
        },
      })
      await providerService.activateProvider(provider.id)

      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-04-27T12:00:00.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'MiniMax-M3',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)

      expect(contextEstimate?.model).toBe('MiniMax-M3')
      expect(contextEstimate?.rawMaxTokens).toBe(1_000_000)
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      if (previousModelContextWindows === undefined) {
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
      } else {
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = previousModelContextWindows
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should prefer the persisted runtime model when provider responses use aliased model names', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousModelContextWindows = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-runtime-model-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-runtime-model-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS

    try {
      const providerService = new ProviderService()
      const provider = await providerService.addProvider({
        presetId: 'custom',
        name: 'Aliased Runtime Provider',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-main',
          haiku: 'provider-fast',
          sonnet: 'provider-sonnet',
          opus: 'provider-opus',
        },
        modelContextWindows: {
          'provider-main': 200_000,
          'provider-fast': 64_000,
        },
      })
      await providerService.activateProvider(provider.id)

      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      await svc.appendSessionMetadata(sessionId, {
        workDir,
        runtimeProviderId: provider.id,
        runtimeModelId: 'provider-fast',
      })
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-06-15T12:00:00.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'provider-returned-fast-alias',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)
      const usage = await svc.getTranscriptUsage(sessionId)

      expect(contextEstimate?.model).toBe('provider-returned-fast-alias')
      expect(contextEstimate?.rawMaxTokens).toBe(64_000)
      expect(usage?.models[0]?.contextWindow).toBe(64_000)
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      if (previousModelContextWindows === undefined) {
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
      } else {
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = previousModelContextWindows
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should keep transcript usage context windows tied to runtime metadata order', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousModelContextWindows = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-runtime-switch-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-runtime-switch-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS

    try {
      const providerService = new ProviderService()
      const provider = await providerService.addProvider({
        presetId: 'custom',
        name: 'Runtime Switch Provider',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'provider-big',
          haiku: 'provider-fast',
          sonnet: 'provider-big',
          opus: 'provider-big',
        },
        modelContextWindows: {
          'provider-big': 1_000_000,
          'provider-fast': 64_000,
        },
      })
      await providerService.activateProvider(provider.id)

      const svc = new SessionService()
      const { sessionId, workDir: sessionWorkDir } = await svc.createSession(workDir)
      await svc.appendSessionMetadata(sessionId, {
        workDir: sessionWorkDir,
        runtimeProviderId: provider.id,
        runtimeModelId: 'provider-fast',
      })
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()
      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-06-15T12:00:00.000Z',
        cwd: sessionWorkDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'provider-returned-fast-alias',
          content: [{ type: 'text', text: 'fast' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')
      await svc.appendSessionMetadata(sessionId, {
        workDir: sessionWorkDir,
        runtimeProviderId: provider.id,
        runtimeModelId: 'provider-big',
      })
      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-06-15T12:01:00.000Z',
        cwd: sessionWorkDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'provider-returned-big-alias',
          content: [{ type: 'text', text: 'big' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const usage = await svc.getTranscriptUsage(sessionId)
      const windows = new Map(usage?.models.map((model) => [model.model, model.contextWindow]))

      expect(windows.get('provider-returned-fast-alias')).toBe(64_000)
      expect(windows.get('provider-returned-big-alias')).toBe(1_000_000)
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      if (previousModelContextWindows === undefined) {
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
      } else {
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = previousModelContextWindows
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should infer a unique saved provider context window for sessions missing runtime metadata', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousModelContextWindows = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-provider-infer-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-provider-infer-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS

    try {
      const providerService = new ProviderService()
      await providerService.addProvider({
        presetId: 'custom',
        name: 'Xiaomi MiMo',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://token-plan-sgp.xiaomimimo.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'mimo-v2.5-pro[1m]',
          haiku: 'mimo-v2.5-pro[1m]',
          sonnet: 'mimo-v2.5-pro[1m]',
          opus: 'mimo-v2.5-pro[1m]',
        },
        modelContextWindows: {
          'mimo-v2.5-pro[1m]': 1_000_000,
        },
      })
      const activeProvider = await providerService.addProvider({
        presetId: 'custom',
        name: 'Active DeepSeek',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://api.deepseek.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'deepseek-v4-pro',
          haiku: 'deepseek-v4-flash',
          sonnet: 'deepseek-v4-pro',
          opus: 'deepseek-v4-pro',
        },
        modelContextWindows: {
          'deepseek-v4-pro': 1_000_000,
        },
      })
      await providerService.activateProvider(activeProvider.id)

      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-06-15T12:00:00.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'mimo-v2.5-pro',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)

      expect(contextEstimate?.model).toBe('mimo-v2.5-pro')
      expect(contextEstimate?.rawMaxTokens).toBe(1_000_000)
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      if (previousModelContextWindows === undefined) {
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
      } else {
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = previousModelContextWindows
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should not infer saved provider context windows for unrelated response model names', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousModelContextWindows = process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-provider-unrelated-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-provider-unrelated-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS

    try {
      const providerService = new ProviderService()
      await providerService.addProvider({
        presetId: 'custom',
        name: 'Only Saved Provider',
        apiKey: 'provider-key',
        authStrategy: 'auth_token',
        baseUrl: 'https://api.example.com/anthropic',
        apiFormat: 'anthropic',
        models: {
          main: 'configured-provider-main',
          haiku: 'configured-provider-main',
          sonnet: 'configured-provider-main',
          opus: 'configured-provider-main',
        },
        modelContextWindows: {
          'configured-provider-main': 1_000_000,
        },
      })

      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-06-15T12:00:00.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'unrelated-response-model',
          content: [{ type: 'text', text: 'hello' }],
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
        },
      }) + '\n')

      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)

      expect(contextEstimate?.model).toBe('unrelated-response-model')
      expect(contextEstimate?.rawMaxTokens).toBe(200_000)
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      if (previousModelContextWindows === undefined) {
        delete process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS
      } else {
        process.env.CLAUDE_CODE_MODEL_CONTEXT_WINDOWS = previousModelContextWindows
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })

  it('should not report transcript context as full for low-trust media usage spikes', async () => {
    const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
    const previousNodeEnv = process.env.NODE_ENV
    const previousUseBedrock = process.env.CLAUDE_CODE_USE_BEDROCK
    const tmpConfigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-transcript-media-'))
    const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-workdir-media-'))
    process.env.CLAUDE_CONFIG_DIR = tmpConfigDir
    process.env.NODE_ENV = 'development'
    process.env.CLAUDE_CODE_USE_BEDROCK = '1'

    try {
      const svc = new SessionService()
      const { sessionId } = await svc.createSession(workDir)
      const found = await svc.findSessionFile(sessionId)
      expect(found).not.toBeNull()

      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'user',
        uuid: crypto.randomUUID(),
        timestamp: '2026-04-27T12:00:00.000Z',
        cwd: workDir,
        message: {
          role: 'user',
          content: [{
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: 'a'.repeat(1024),
            },
          }],
        },
      }) + '\n')
      await fs.appendFile(found!.filePath, JSON.stringify({
        type: 'assistant',
        uuid: crypto.randomUUID(),
        timestamp: '2026-04-27T12:00:01.000Z',
        cwd: workDir,
        version: '999.0.0-test',
        message: {
          role: 'assistant',
          model: 'claude-sonnet-4-6',
          content: [{ type: 'text', text: 'ok' }],
          usage: {
            input_tokens: 1_000_000,
            output_tokens: 10,
          },
        },
      }) + '\n')

      const contextEstimate = await svc.getTranscriptContextEstimate(sessionId)

      expect(contextEstimate?.rawMaxTokens).toBe(200_000)
      expect(contextEstimate?.totalTokens).toBeLessThan(200_000)
      expect(contextEstimate?.percentage).toBeLessThan(100)
      expect(contextEstimate?.categories[0]?.name).toBe('Estimated context')
    } finally {
      if (previousConfigDir === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = previousConfigDir
      }
      if (previousNodeEnv === undefined) {
        delete process.env.NODE_ENV
      } else {
        process.env.NODE_ENV = previousNodeEnv
      }
      if (previousUseBedrock === undefined) {
        delete process.env.CLAUDE_CODE_USE_BEDROCK
      } else {
        process.env.CLAUDE_CODE_USE_BEDROCK = previousUseBedrock
      }
      await fs.rm(tmpConfigDir, { recursive: true, force: true })
      await fs.rm(workDir, { recursive: true, force: true })
    }
  })
})
