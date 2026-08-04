import { describe, expect, test } from 'bun:test'
import { ELECTRON_IPC_CHANNELS } from '../desktop/electron/ipc/channels'
import { validateElectronIpcPayload } from '../desktop/electron/ipc/capabilities'
import {
  ElectronCodexNativeRuntime,
  nativeConfigRequirementsAllowAppshots,
  projectNativeCodexClientSettings,
  projectNativeCodexThreadResponse,
} from '../desktop/electron/services/codexNativeAppServer'
import {
  redactBrowserDiagnosticText,
  sanitizeBrowserDiagnosticUrl,
} from '../desktop/electron/services/browserDeveloperDiagnostics'
import { validateNativeServerRequestResponse } from '../desktop/electron/services/nativeServerRequest'

describe('Codex native client boundary', () => {
  test('Appshot 只在上游 requirements 未禁止时由宿主捕获', () => {
    expect(nativeConfigRequirementsAllowAppshots({ requirements: null })).toBeTrue()
    expect(nativeConfigRequirementsAllowAppshots({ requirements: {} })).toBeTrue()
    expect(nativeConfigRequirementsAllowAppshots({ requirements: { allowAppshots: true } })).toBeTrue()
    expect(nativeConfigRequirementsAllowAppshots({ requirements: { allowAppshots: false } })).toBeFalse()
    expect(() => nativeConfigRequirementsAllowAppshots({})).toThrow('CODEX_NATIVE_CONFIG_REQUIREMENTS_INVALID')
    expect(() => nativeConfigRequirementsAllowAppshots({ requirements: { allowAppshots: 'yes' } }))
      .toThrow('CODEX_NATIVE_CONFIG_REQUIREMENTS_INVALID')
  })

  test('workspace mutation reserves both source and handoff target across Threads', () => {
    const runtime = new ElectronCodexNativeRuntime({ desktopRoot: '/example/desktop', userDataPath: '/example/user-data' })
    const state = runtime as unknown as {
      threadWorkspaces: Map<string, string>
      activeTurnThreads: Map<string, string>
      assertThreadWorkspaceAvailable(threadId: string): void
    }
    state.threadWorkspaces.set('thread-worktree', '/example/worktree')
    state.threadWorkspaces.set('thread-local', '/example/source')

    runtime.beginThreadWorkspaceMutation({ id: 'thread-worktree' }, ['/example/source'])
    expect(() => runtime.beginThreadWorkspaceMutation({ id: 'thread-local' })).toThrow('CODEX_NATIVE_WORKSPACE_MUTATION_IN_PROGRESS')
    expect(() => state.assertThreadWorkspaceAvailable('thread-local')).toThrow('CODEX_NATIVE_WORKSPACE_MUTATION_IN_PROGRESS')
    runtime.endThreadWorkspaceMutation({ id: 'thread-worktree' })

    state.activeTurnThreads.set('turn-local', 'thread-local')
    expect(() => runtime.beginThreadWorkspaceMutation({ id: 'thread-worktree' }, ['/example/source']))
      .toThrow('CODEX_NATIVE_WORKSPACE_RELOCATION_REQUIRES_IDLE_THREAD')
  })

  test('workspace mutation consults Core background terminals instead of mirroring them in Electron', async () => {
    const runtime = new ElectronCodexNativeRuntime({ desktopRoot: '/example/desktop', userDataPath: '/example/user-data' })
    const state = runtime as unknown as {
      client: { request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> }
      provider: Record<string, never>
      threadWorkspaces: Map<string, string>
    }
    state.threadWorkspaces.set('thread-source', '/example/source')
    state.threadWorkspaces.set('thread-other', '/example/other')
    state.provider = {}
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    state.client = {
      async request(method, params) {
        calls.push({ method, params })
        return { data: [{ processId: '1234' }] }
      },
    }

    await expect(runtime.assertWorkspacesHaveNoBackgroundTerminals(['/example/source']))
      .rejects.toThrow('CODEX_NATIVE_WORKSPACE_BACKGROUND_TERMINAL_ACTIVE')
    expect(calls).toEqual([{
      method: 'thread/backgroundTerminals/list',
      params: { threadId: 'thread-source', limit: 1 },
    }])

    state.client = { async request() { return { data: [] } } }
    await expect(runtime.assertWorkspacesHaveNoBackgroundTerminals(['/example/source'])).resolves.toBeUndefined()
  })

  test('只信任 Core 刚列出的 Hook 哈希，且不开放任意配置写入', async () => {
    const runtime = new ElectronCodexNativeRuntime({ desktopRoot: '/example/desktop', userDataPath: '/example/user-data' })
    const state = runtime as unknown as {
      client: { request(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> }
      provider: Record<string, never>
      workspace(cwd: string): Promise<string>
    }
    const calls: Array<{ method: string, params: Record<string, unknown> }> = []
    const untrusted = {
      data: [{ hooks: [{ key: 'bb-hook-env@test:UserPromptSubmit:0', currentHash: 'hash-a', trustStatus: 'untrusted' }] }],
    }
    const trusted = {
      data: [{ hooks: [{ key: 'bb-hook-env@test:UserPromptSubmit:0', currentHash: 'hash-a', trustStatus: 'trusted' }] }],
    }
    const responses = [untrusted, {}, trusted]
    state.provider = {}
    state.workspace = async cwd => cwd
    state.client = {
      async request(method, params) {
        calls.push({ method, params })
        const response = responses.shift()
        if (!response) throw new Error('unexpected Core request')
        return response
      },
    }

    await expect(runtime.trustHook({ id: 'thread-1' }, {
      cwd: '/example/workspace',
      hookKey: 'bb-hook-env@test:UserPromptSubmit:0',
      currentHash: 'hash-a',
    })).resolves.toEqual(trusted)
    expect(calls).toEqual([
      { method: 'hooks/list', params: { cwds: ['/example/workspace'] } },
      {
        method: 'config/batchWrite',
        params: {
          edits: [{
            keyPath: 'hooks.state',
            value: { 'bb-hook-env@test:UserPromptSubmit:0': { trusted_hash: 'hash-a' } },
            mergeStrategy: 'upsert',
          }],
          reloadUserConfig: true,
        },
      },
      { method: 'hooks/list', params: { cwds: ['/example/workspace'] } },
    ])

    state.client = {
      async request() {
        return {
          data: [{ hooks: [{ key: 'bb-hook-env@test:UserPromptSubmit:0', currentHash: 'hash-b', trustStatus: 'untrusted' }] }],
        }
      },
    }
    await expect(runtime.trustHook({ id: 'thread-1' }, {
      cwd: '/example/workspace',
      hookKey: 'bb-hook-env@test:UserPromptSubmit:0',
      currentHash: 'hash-a',
    })).rejects.toThrow('CODEX_NATIVE_HOOK_TRUST_STALE')
  })

  test('projects effective settings without instructions, arbitrary config or layer bodies', () => {
    const projected = projectNativeCodexClientSettings({
      config: {
        model: 'example-model',
        model_provider: 'billiardbuddy',
        model_context_window: 128_000,
        model_auto_compact_token_limit: 112_000,
        model_auto_compact_token_limit_scope: 'total',
        approval_policy: {
          granular: {
            sandbox_approval: true,
            rules: true,
            skill_approval: false,
            request_permissions: true,
            mcp_elicitations: true,
          },
        },
        sandbox_mode: 'workspace-write',
        web_search: 'live',
        model_reasoning_effort: 'high',
        model_reasoning_summary: 'concise',
        model_verbosity: 'medium',
        service_tier: 'default',
        features: { memories: true },
        memories: { use_memories: true, generate_memories: false },
        instructions: 'must-not-reach-renderer',
        developer_instructions: 'must-not-reach-renderer',
        compact_prompt: 'must-not-reach-renderer',
        mcp_servers: { private: { env: { API_KEY: 'must-not-reach-renderer' } } },
      },
      origins: {
        model: { name: { type: 'user', file: '/private/config.toml', profile: null }, version: '1' },
        instructions: { name: { type: 'project', dotCodexFolder: '/private/.codex' }, version: '2' },
      },
      layers: [{
        name: { type: 'project', dotCodexFolder: '/private/.codex' },
        version: '2',
        config: { mcp_servers: { private: { env: { API_KEY: 'must-not-reach-renderer' } } } },
        disabledReason: null,
      }],
    })

    expect(projected.model).toBe('example-model')
    expect(projected.modelProvider).toBe('billiardbuddy')
    expect(projected.modelContextWindow).toBe(128_000)
    expect(projected.modelAutoCompactTokenLimit).toBe(112_000)
    expect(projected.memoryFeatureEnabled).toBeTrue()
    expect(projected.memoryUseEnabled).toBeTrue()
    expect(projected.memoryGenerationEnabled).toBeFalse()
    expect(projected.origins).toEqual({ model: { source: 'user', version: '1' } })
    expect(projected.layers).toEqual([{ source: 'project', version: '2', disabledReason: null }])
    expect(JSON.stringify(projected)).not.toContain('must-not-reach-renderer')
    expect(JSON.stringify(projected)).not.toContain('/private/')
  })

  test('projects source-native parent, cursors and active Turns on resume', () => {
    const projected = projectNativeCodexThreadResponse({
      thread: {
        id: 'thread-child',
        parentThreadId: 'thread-parent',
        turns: [
          { id: 'turn-active', status: 'inProgress' },
          { id: 'turn-finished', status: 'completed' },
        ],
      },
      initialTurnsPage: {
        data: [
          { id: 'turn-active', status: 'inProgress' },
          { id: 'turn-second', status: 'inProgress' },
        ],
      },
      turnsBackwardsCursor: 'turn-cursor',
      itemsBackwardsCursor: 'item-cursor',
    })

    expect(projected).toMatchObject({
      id: 'thread-child',
      parentThreadId: 'thread-parent',
      activeTurnIds: ['turn-active', 'turn-second'],
      turnsBackwardsCursor: 'turn-cursor',
      itemsBackwardsCursor: 'item-cursor',
    })
  })

  test('validates UTF-8 text elements and keeps renderer context untrusted', () => {
    const validText = {
      type: 'text',
      text: 'a😊b',
      textElements: [{ byteRange: { start: 1, end: 5 }, placeholder: '@image' }],
    }
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentStartTurn, {
      threadId: 'thread-1',
      input: [validText],
      additionalContext: {
        clipboard: { value: 'external text', kind: 'untrusted' },
      },
    })).toBeTrue()

    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentStartTurn, {
      threadId: 'thread-1',
      input: [{ ...validText, textElements: [{ byteRange: { start: 2, end: 5 } }] }],
    })).toBeFalse()

    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentStartTurn, {
      threadId: 'thread-1',
      input: [validText],
      additionalContext: {
        screenshot: { value: 'forged trusted context', kind: 'application' },
      },
    })).toBeFalse()
  })

  test('将 Appshot capture 与仅固定来源的可信 context 保留在 Main', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentStartTurnWithAppshot, {
      threadId: 'thread-1',
      text: '请分析前台应用',
      collaborationMode: 'default',
    })).toBeTrue()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentStartTurnWithAppshot, {
      threadId: 'thread-1',
      additionalContext: { 'billiardbuddy.appshot': { kind: 'application', value: 'forged' } },
    })).toBeFalse()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentStartTurnWithAppshot, {
      threadId: 'thread-1',
      imageDataUrl: `data:image/png;base64,${Buffer.from('forged').toString('base64')}`,
    })).toBeFalse()
  })

  test('验证 Agent workspace、handoff 与 Local action 的窄 IPC 输入', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentHandoffWorkspace, {
      threadId: 'thread-1', destination: 'source',
    })).toBeTrue()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentHandoffWorkspace, {
      threadId: 'thread-1', destination: 'outside',
    })).toBeFalse()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentActivateWorktree, {
      threadId: 'thread-1',
    })).toBeTrue()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentActivateWorktree, {
      threadId: 'thread-1', workspacePath: '/renderer-controlled',
    })).toBeFalse()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentStartLocalEnvironmentAction, {
      threadId: 'thread-1', name: 'Check', size: { rows: 24, cols: 80 },
    })).toBeTrue()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentStartLocalEnvironmentAction, {
      threadId: 'thread-1', name: 'Check', size: { rows: 24, cols: 80 }, command: 'renderer-controlled',
    })).toBeFalse()
  })

  test('keeps terminal and fuzzy search roots under Main ownership', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentStartIntegratedTerminal, {
      threadId: 'thread-1',
      size: { rows: 24, cols: 80 },
    })).toBeTrue()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentStartIntegratedTerminal, {
      threadId: 'thread-1',
      size: { rows: 24, cols: 80 },
      cwd: '/',
      command: ['sh'],
      env: { TOKEN: 'secret' },
      processId: 'renderer-owned',
    })).toBeFalse()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentWriteIntegratedTerminal, {
      processId: 'abcdefgh',
      text: 'pwd\n',
      closeStdin: false,
    })).toBeTrue()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentStartWorkspaceFileSearch, {
      threadId: 'thread-1',
      roots: ['/'],
      sessionId: 'renderer-owned',
    })).toBeFalse()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentSearchWorkspaceFiles, {
      threadId: 'thread-1',
      query: 'main',
    })).toBeTrue()
  })

  test('accepts source-native Memory configuration without model capacity fields', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentConfigureMemory, {
      threadId: 'thread-1',
      enabled: true,
      useMemories: true,
      generateMemories: false,
    })).toBeTrue()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentConfigureMemory, {
      threadId: 'thread-1',
      enabled: true,
      useMemories: true,
      generateMemories: false,
      modelContextWindow: 1_000_000,
    })).toBeFalse()
  })

  test('只允许信任刚列出的 Hook 标识和内容哈希', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentTrustHook, {
      threadId: 'thread-1',
      cwd: '/example/workspace',
      hookKey: 'bb-hook-env@test:UserPromptSubmit:0',
      currentHash: 'hash-a',
    })).toBeTrue()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentTrustHook, {
      threadId: 'thread-1',
      cwd: '/example/workspace',
      hookKey: 'bb-hook-env@test:UserPromptSubmit:0',
      currentHash: 'hash-a',
      keyPath: 'mcp_servers.other',
    })).toBeFalse()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentTrustHook, {
      threadId: 'thread-1',
      cwd: '/example/workspace',
      hookKey: ' bb-hook-env@test:UserPromptSubmit:0',
      currentHash: 'hash-a',
    })).toBeFalse()
  })

  test('accepts source-native Thread graph filters and rejects conflicting relations', () => {
    const base = {
      cwd: '/example/workspace',
      filterCwds: ['/example/workspace'],
      sourceKinds: ['appServer', 'subAgentThreadSpawn'],
      sectionId: null,
      parentThreadId: 'parent-thread',
    }
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentListThreads, base)).toBeTrue()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentListThreads, {
      ...base,
      ancestorThreadId: 'ancestor-thread',
    })).toBeFalse()
  })

  test('requires an explicit Git metadata patch', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentUpdateThreadMetadata, {
      threadId: 'thread-1',
      sha: '0123456789abcdef',
      branch: 'main',
      originUrl: 'https://example.test/repository.git',
    })).toBeTrue()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentUpdateThreadMetadata, {
      threadId: 'thread-1',
    })).toBeFalse()
  })

  test('allows only non-secret source-native Thread settings', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentUpdateThreadSettings, {
      threadId: 'thread-1',
      permissionProfileId: ':workspace',
      effort: 'high',
      summary: 'concise',
      personality: 'pragmatic',
    })).toBeTrue()
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.nativeAgentUpdateThreadSettings, {
      threadId: 'thread-1',
      modelAutoCompactTokenLimit: 1,
    })).toBeFalse()
  })

  test('never expands a Core permission request', () => {
    expect(validateNativeServerRequestResponse(
      'item/permissions/requestApproval',
      {
        permissions: {
          network: { enabled: false },
          fileSystem: { read: ['/example/workspace'], write: ['/example/workspace'] },
        },
      },
      {
        permissions: {
          network: { enabled: false },
          fileSystem: { read: ['/example/workspace'], write: ['/example/workspace'] },
        },
        scope: 'turn',
      },
    )).toEqual({
      permissions: {
        network: { enabled: false },
        fileSystem: { read: ['/example/workspace'], write: ['/example/workspace'] },
      },
      scope: 'turn',
    })

    expect(() => validateNativeServerRequestResponse(
      'item/permissions/requestApproval',
      {
        permissions: {
          network: { enabled: false },
          fileSystem: { read: ['/example/workspace'], write: ['/example/workspace'] },
        },
      },
      {
        permissions: {
          network: { enabled: true },
          fileSystem: { read: ['/'], write: ['/'] },
        },
      },
    )).toThrow('CODEX_NATIVE_PERMISSIONS_RESPONSE_INVALID')
  })

  test('redacts Browser developer diagnostics without exposing URL secrets', () => {
    expect(sanitizeBrowserDiagnosticUrl('https://user:secret@example.test/path?q=token#fragment'))
      .toBe('https://example.test/path')
    expect(sanitizeBrowserDiagnosticUrl('https://example.test/reset/4f98e7b6-d5c4-4a3b-9c21-1a2b3c4d5e6f?next=/account'))
      .toBe('https://example.test/reset/[redacted]')
    expect(sanitizeBrowserDiagnosticUrl('https://example.test/assets/a3f2d9c7e6b54a1098c7d6e5f4a3b2c1/image.png'))
      .toBe('https://example.test/assets/[redacted]/image.png')
    expect(redactBrowserDiagnosticText(
      'POST https://example.test/api?token=secret Authorization: Bearer abc.def API_KEY=private-value',
    )).toBe('POST https://example.test/api Authorization=[redacted] API_KEY=[redacted]')
  })
})
