import { describe, expect, it } from 'bun:test'
import type { ServerMessage } from '../ws/events.js'
import {
  projectComputerUseApprovalForProductTask,
  projectServerMessageForProductTask,
} from '../product/taskEventProjection.js'

describe('product task event projection', () => {
  it('keeps safe non-activity task events while excluding Core internals', () => {
    const rawThinking = 'PRIVATE_THINKING_CHAIN'
    const rawToolInput = 'PRIVATE_TOOL_INPUT'
    const rawToolResult = 'PRIVATE_TOOL_RESULT'
    const rawPermissionDescription = 'PRIVATE_PERMISSION_DESCRIPTION'
    const rawComputerUsePath = '/private/Application.app'
    const messages: ServerMessage[] = [
      { type: 'connected', sessionId: 'core-session-secret' },
      { type: 'status', state: 'thinking', verb: 'PRIVATE_STATUS_VERB' },
      { type: 'thinking', text: rawThinking },
      { type: 'content_start', blockType: 'text' },
      {
        type: 'content_delta',
        text: '这是实际的流式回复。',
        toolInput: rawToolInput,
      },
      {
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'private-tool-use-id',
      },
      {
        type: 'tool_use_complete',
        toolName: 'Bash',
        toolUseId: 'private-tool-use-id',
        input: { command: rawToolInput },
      },
      {
        type: 'tool_result',
        toolUseId: 'private-tool-use-id',
        content: { stdout: rawToolResult },
        isError: false,
      },
      {
        type: 'permission_request',
        requestId: 'approval-1',
        toolName: 'Bash',
        input: { command: rawToolInput },
        description: rawPermissionDescription,
      },
      {
        type: 'computer_use_permission_request',
        requestId: 'approval-2',
        request: {
          requestId: 'approval-2',
          reason: 'PRIVATE_COMPUTER_USE_REASON',
          apps: [{
            requestedName: 'Private App',
            resolved: {
              bundleId: 'com.example.private',
              displayName: 'Private App',
            },
            isSentinel: false,
            alreadyGranted: false,
            proposedTier: 'full',
          }],
          requestedFlags: { clipboardRead: true },
          screenshotFiltering: 'none',
          willHide: [{ bundleId: 'com.example.private', displayName: rawComputerUsePath }],
        },
      },
      {
        type: 'system_notification',
        subtype: 'task_progress',
        message: 'PRIVATE_BACKGROUND_TASK_MESSAGE',
        data: { prompt: rawThinking },
      },
      {
        type: 'error',
        code: 'CLI_ERROR',
        message: 'PRIVATE_RUNTIME_ERROR',
        retryable: true,
      },
      {
        type: 'message_complete',
        usage: { input_tokens: 99_999, output_tokens: 12_345 },
      },
    ]

    const projected = messages.flatMap(projectServerMessageForProductTask)

    expect(projected).toEqual([
      { type: 'connected' },
      { type: 'status', state: 'working' },
      { type: 'status', state: 'working' },
      { type: 'assistant_text_start' },
      { type: 'assistant_text_delta', text: '这是实际的流式回复。' },
      {
        type: 'approval_required',
        requestId: 'approval-1',
        kind: 'action',
        action: {
          what: '运行一条受限命令',
          scope: '当前任务工作区之外的本机资源或网络边界',
          consequence: '命令可能修改文件、启动进程或访问外部服务。',
        },
      },
      {
        type: 'approval_required',
        requestId: 'approval-2',
        kind: 'computer_use',
        computerUse: {
          apps: [{ name: 'Private App', tier: 'full', alreadyAuthorized: false }],
          capabilities: ['clipboard_read'],
        },
      },
      { type: 'error', code: 'task_failed', retryable: true },
      { type: 'status', state: 'idle' },
      { type: 'turn_complete' },
    ])

    const serialized = JSON.stringify(projected)
    for (const secret of [
      'core-session-secret',
      rawThinking,
      rawToolInput,
      rawToolResult,
      rawPermissionDescription,
      rawComputerUsePath,
      'PRIVATE_COMPUTER_USE_REASON',
      'com.example.private',
      'PRIVATE_STATUS_VERB',
      'PRIVATE_RUNTIME_ERROR',
      '99999',
      '12345',
      'Bash',
      'private-tool-use-id',
    ]) {
      expect(serialized).not.toContain(secret)
    }
  })

  it('omits activity messages until the task-scoped rich projector handles them', () => {
    const projected = [
      {
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Bash',
        toolUseId: 'core-tool-PRIVATE',
      },
      { type: 'tool_use_complete', toolName: 'Bash', toolUseId: 'core-tool-PRIVATE' },
      { type: 'tool_result', toolUseId: 'core-tool-PRIVATE', content: 'PRIVATE_RESULT' },
      { type: 'system_notification', subtype: 'task_progress', message: 'PRIVATE_PROGRESS' },
      { type: 'team_created', teamName: 'private-team' },
      { type: 'team_deleted', teamName: 'private-team' },
      { type: 'task_update', taskId: 'private-task', status: 'completed' },
    ].flatMap(projectServerMessageForProductTask)

    expect(projected).toEqual([])
  })

  it('projects Computer Use as a narrow human-readable approval', () => {
    const privatePath = '/Users/private/.config/computer-use.json'
    const privateBundleId = 'com.example.private'
    const projected = projectComputerUseApprovalForProductTask({
      requestId: 'computer-use-3',
      reason: 'PRIVATE_MODEL_REASON',
      apps: [
        {
          requestedName: privateBundleId,
          resolved: {
            bundleId: privateBundleId,
            displayName: '球房记分牌',
          },
          isSentinel: true,
          alreadyGranted: true,
          proposedTier: 'read',
        },
        {
          requestedName: privatePath,
          isSentinel: false,
          alreadyGranted: false,
          proposedTier: 'full',
        },
      ],
      requestedFlags: {
        clipboardRead: true,
        clipboardWrite: true,
        systemKeyCombos: true,
      },
      screenshotFiltering: 'native',
      tccState: { accessibility: false, screenRecording: true },
      willHide: [{ bundleId: privateBundleId, displayName: privatePath }],
    })

    expect(projected).toEqual({
      apps: [
        { name: '球房记分牌', tier: 'read', alreadyAuthorized: true },
        { name: '请求的应用', tier: 'full', alreadyAuthorized: false },
      ],
      capabilities: ['clipboard_read', 'clipboard_write', 'system_key_combos'],
      systemPermissions: {
        accessibilityRequired: true,
        screenRecordingRequired: false,
      },
    })
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain(privatePath)
    expect(serialized).not.toContain(privateBundleId)
    expect(serialized).not.toContain('PRIVATE_MODEL_REASON')
    expect(serialized).not.toContain('native')
  })

  it('projects AskUserQuestion through a narrow question schema', () => {
    const projected = [{
      type: 'permission_request',
      requestId: 'ask-1',
      toolName: 'AskUserQuestion',
      input: {
        questions: [{
          question: '要先处理哪一项？',
          header: '需要确认',
          options: [
            { label: '整理台账', description: '先核对当天记录', privateValue: 'PRIVATE_OPTION_VALUE' },
            { label: '联系客户' },
          ],
          multiSelect: true,
          hiddenPrompt: 'PRIVATE_HIDDEN_PROMPT',
        }],
        runtimeConfig: 'PRIVATE_RUNTIME_CONFIG',
      },
      description: 'PRIVATE_PERMISSION_DESCRIPTION',
    }].flatMap(projectServerMessageForProductTask)

    expect(projected).toEqual([{
      type: 'approval_required',
      requestId: 'ask-1',
      kind: 'question',
      questions: [{
        question: '要先处理哪一项？',
        header: '需要确认',
        options: [
          { label: '整理台账', description: '先核对当天记录' },
          { label: '联系客户' },
        ],
        multiSelect: true,
      }],
    }])

    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('PRIVATE_OPTION_VALUE')
    expect(serialized).not.toContain('PRIVATE_HIDDEN_PROMPT')
    expect(serialized).not.toContain('PRIVATE_RUNTIME_CONFIG')
    expect(serialized).not.toContain('PRIVATE_PERMISSION_DESCRIPTION')
  })

  it('projects replayed attachment text without upload paths or source data', () => {
    const uploadPath = '/Users/private-user/.claude/uploads/core-session-secret/4bf1a3ef-3c4c-4d93-b35b-14719d05498e-ledger.pdf'
    const dataUrl = 'data:application/pdf;base64,PRIVATE_FILE_BYTES'

    const projected = [{
      type: 'user_message_replay',
      content: `@"${uploadPath}" 请核对附件 ${dataUrl}`,
      attachments: [{ type: 'file', name: 'ledger.pdf' }],
    }].flatMap(projectServerMessageForProductTask)

    expect(projected).toEqual([{
      type: 'user_text',
      text: '请核对附件',
      replayed: true,
      attachments: [{ type: 'file', name: 'ledger.pdf' }],
    }])

    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain(uploadPath)
    expect(serialized).not.toContain('core-session-secret')
    expect(serialized).not.toContain(dataUrl)
    expect(serialized).not.toContain('PRIVATE_FILE_BYTES')
  })

  it('maps safe business errors and ignores unlisted internal messages', () => {
    const projected = [
      {
        type: 'error',
        code: 'CLI_ERROR',
        message: 'PRIVATE_SIZE_ERROR',
        businessErrorCode: 'request_too_large',
      },
      {
        type: 'system_notification',
        subtype: 'runtime_config_changed',
        message: 'PRIVATE_MODEL_CONFIGURATION',
        data: { provider: 'PRIVATE_PROVIDER' },
      },
      { type: 'pong' },
      { type: 'session_title_updated', sessionId: 'private-session', title: '新的任务标题' },
    ].flatMap(projectServerMessageForProductTask)

    expect(projected).toEqual([
      { type: 'error', code: 'input_too_large', retryable: false },
      { type: 'title_updated', title: '新的任务标题' },
    ])
    const serialized = JSON.stringify(projected)
    expect(serialized).not.toContain('PRIVATE_SIZE_ERROR')
    expect(serialized).not.toContain('PRIVATE_MODEL_CONFIGURATION')
    expect(serialized).not.toContain('PRIVATE_PROVIDER')
    expect(serialized).not.toContain('private-session')
  })
})
