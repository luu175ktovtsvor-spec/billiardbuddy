import { describe, expect, test } from 'bun:test'
import { ELECTRON_IPC_CHANNELS } from '../desktop/electron/ipc/channels'
import { validateElectronIpcPayload } from '../desktop/electron/ipc/capabilities'
import { projectNativeCodexClientSettings } from '../desktop/electron/services/codexNativeAppServer'
import {
  redactBrowserDiagnosticText,
  sanitizeBrowserDiagnosticUrl,
} from '../desktop/electron/services/browserDeveloperDiagnostics'
import { validateNativeServerRequestResponse } from '../desktop/electron/services/nativeServerRequest'

describe('Codex native client boundary', () => {
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
    expect(projected.origins).toEqual({ model: { source: 'user', version: '1' } })
    expect(projected.layers).toEqual([{ source: 'project', version: '2', disabledReason: null }])
    expect(JSON.stringify(projected)).not.toContain('must-not-reach-renderer')
    expect(JSON.stringify(projected)).not.toContain('/private/')
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
