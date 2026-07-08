import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeRemoteState } from './bridgeRemoteState'

test('BridgeRemoteState persists SDK events and pending permission requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-remote-state-'))
  try {
    const state = new BridgeRemoteState(root)
    const first = await state.ingestEvent('bridge:session_remote', {
      type: 'assistant',
      uuid: 'msg_1',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    })
    expect(first.event).toMatchObject({
      sessionId: 'session_remote',
      seq: 1,
      kind: 'sdk_message',
      type: 'assistant',
    })

    const permission = await state.ingestEvent('session_remote', {
      type: 'control_request',
      request_id: 'req_1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Write',
        tool_use_id: 'toolu_1',
        input: { file_path: '/repo/app.ts', content: 'hi' },
        permission_suggestions: [{ allow: true }],
        blocked_path: '/repo/app.ts',
        decision_reason: 'writes file',
        title: '写文件',
        display_name: 'Write',
        agent_id: 'agent_1',
        description: 'Remote tool wants to write a file',
      },
    })
    expect(permission.permission).toMatchObject({
      sessionId: 'session_remote',
      requestId: 'req_1',
      toolName: 'Write',
      toolUseId: 'toolu_1',
      input: { file_path: '/repo/app.ts', content: 'hi' },
      status: 'pending',
      blockedPath: '/repo/app.ts',
      decisionReason: 'writes file',
      title: '写文件',
      displayName: 'Write',
      agentId: 'agent_1',
    })

    const reloaded = new BridgeRemoteState(root)
    expect(await reloaded.listEvents('session_remote')).toEqual([
      expect.objectContaining({ seq: 1, type: 'assistant' }),
      expect.objectContaining({ seq: 2, type: 'control_request' }),
    ])
    expect(await reloaded.listPermissions('bridge:session_remote', 'pending')).toEqual([
      expect.objectContaining({ requestId: 'req_1', status: 'pending' }),
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('BridgeRemoteState records permission responses in an outbox', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-remote-response-'))
  try {
    const state = new BridgeRemoteState(root)
    await state.ingestEvent('session_remote', {
      type: 'control_request',
      request_id: 'req_allow',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Bash',
        tool_use_id: 'toolu_allow',
        input: { command: 'pwd' },
      },
    })

    const allowed = await state.respondToPermission('session_remote', 'req_allow', {
      behavior: 'allow',
      updatedInput: { command: 'pwd', timeout_ms: 1000 },
    })
    expect(allowed?.permission).toMatchObject({
      requestId: 'req_allow',
      status: 'allowed',
      response: { behavior: 'allow', updatedInput: { command: 'pwd', timeout_ms: 1000 } },
    })
    expect(allowed?.outbox).toMatchObject({
      sessionId: 'session_remote',
      requestId: 'req_allow',
      status: 'queued',
      payload: {
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: 'req_allow',
          response: { behavior: 'allow', updatedInput: { command: 'pwd', timeout_ms: 1000 } },
        },
      },
    })

    const queued = await state.listOutbox('bridge:session_remote', 'queued')
    expect(queued).toHaveLength(1)
    const sent = await state.markOutboxSent('session_remote', queued[0]!.id)
    expect(sent).toMatchObject({ status: 'sent', requestId: 'req_allow' })
    expect(await state.listOutbox('session_remote', 'queued')).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('BridgeRemoteState cancels pending permission requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-remote-cancel-'))
  try {
    const state = new BridgeRemoteState(root)
    await state.ingestEvent('session_remote', {
      type: 'control_request',
      request_id: 'req_cancel',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'Edit',
        tool_use_id: 'toolu_cancel',
        input: { file_path: 'a.ts' },
      },
    })
    const cancelled = await state.ingestEvent('session_remote', {
      type: 'control_cancel_request',
      request_id: 'req_cancel',
    })
    expect(cancelled.permission).toMatchObject({
      requestId: 'req_cancel',
      status: 'cancelled',
    })
    expect(await state.listPermissions('session_remote', 'pending')).toEqual([])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('BridgeRemoteState persists latest bridge worker credentials per session', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-remote-credentials-'))
  try {
    const state = new BridgeRemoteState(root)
    const first = await state.storeCredentials('bridge:cse_remote', {
      workerJwt: 'worker.jwt.1',
      apiBaseUrl: 'https://session-ingress.example/sdk/cse_remote',
      expiresIn: 3600,
      workerEpoch: 1,
    })
    expect(first).toMatchObject({
      sessionId: 'cse_remote',
      workerJwt: 'worker.jwt.1',
      apiBaseUrl: 'https://session-ingress.example/sdk/cse_remote',
      expiresIn: 3600,
      workerEpoch: 1,
    })
    expect(Date.parse(first.expiresAt)).toBeGreaterThan(Date.parse(first.fetchedAt))

    await state.storeCredentials('cse_remote', {
      workerJwt: 'worker.jwt.2',
      apiBaseUrl: 'https://session-ingress.example/sdk/cse_remote',
      expiresIn: 7200,
      workerEpoch: 2,
    })
    const reloaded = new BridgeRemoteState(root)
    expect(await reloaded.getCredentials('bridge:cse_remote')).toMatchObject({
      sessionId: 'cse_remote',
      workerJwt: 'worker.jwt.2',
      expiresIn: 7200,
      workerEpoch: 2,
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('BridgeRemoteState rejects unsafe identifiers and missing payload types', async () => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-remote-invalid-'))
  try {
    const state = new BridgeRemoteState(root)
    await expect(state.ingestEvent('session with spaces', { type: 'assistant' })).rejects.toThrow('unsupported')
    await expect(state.ingestEvent('session_ok', {})).rejects.toThrow('type is required')
    await expect(state.respondToPermission('session_ok', '', { behavior: 'deny', message: 'no' })).rejects.toThrow('requestId is required')
    await expect(state.storeCredentials('session_ok', {
      workerJwt: '',
      apiBaseUrl: 'https://session-ingress.example',
      expiresIn: 60,
      workerEpoch: 1,
    })).rejects.toThrow('workerJwt is required')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
