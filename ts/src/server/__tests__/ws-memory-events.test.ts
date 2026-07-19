import { describe, expect, it } from 'bun:test'
import {
  createCurrentTurnLocalCommandForwarder,
  getSlashCommands,
  translateCliMessage,
} from '../ws/handler.js'
import { parseSlashCommand } from '../../utils/slashCommandParsing.js'

describe('WebSocket memory events', () => {
  it('forwards only safe business error state to the desktop client', () => {
    const rawProviderOutput = 'provider=private-gateway model=secret-model stderr=/Users/test/private.log'
    const messages = translateCliMessage({
      type: 'assistant',
      error: rawProviderOutput,
      isApiErrorMessage: true,
      businessErrorCode: 'image_unsupported',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: rawProviderOutput }],
      },
    }, 'session-1')

    expect(messages).toEqual([
      {
        type: 'error',
        message: 'The task could not be completed. Please try again.',
        code: 'CLI_ERROR',
        retryable: false,
        businessErrorCode: 'image_unsupported',
      },
    ])
    expect(JSON.stringify(messages)).not.toContain(rawProviderOutput)
  })

  it('keeps init metadata internal and does not forward the runtime model', () => {
    const sessionId = `init-private-${crypto.randomUUID()}`
    const privateModel = 'provider/private-model-at-/Users/test/.claude/config'
    const messages = translateCliMessage({
      type: 'system',
      subtype: 'init',
      model: privateModel,
      slash_commands: [{ name: 'help', description: 'Show help' }],
    }, sessionId)

    expect(messages).toEqual([])
    expect(JSON.stringify(messages)).not.toContain(privateModel)
    expect(getSlashCommands(sessionId)).toEqual([{ name: 'help' }])
  })

  it('replays slash-command breadcrumbs as readable user messages', () => {
    expect(translateCliMessage({
      type: 'user',
      isReplay: true,
      message: {
        role: 'user',
        content: [
          '<command-message>agent</command-message>',
          '<command-name>/agent</command-name>',
          '<command-args>Plan 222</command-args>',
        ].join('\n'),
      },
    }, 'session-1')).toEqual([
      { type: 'user_message_replay', content: '/agent Plan 222' },
    ])

    expect(translateCliMessage({
      type: 'user',
      isReplay: true,
      message: {
        role: 'user',
        content: [
          {
            type: 'text',
            text: [
              '<command-message>agent</command-message>',
              '<command-name>/agent</command-name>',
              '<command-args>Plan 222</command-args>',
            ].join('\n'),
          },
        ],
      },
    }, 'session-1')).toEqual([
      { type: 'user_message_replay', content: '/agent Plan 222' },
    ])

    expect(translateCliMessage({
      type: 'user',
      isReplay: true,
      message: {
        role: 'user',
        content: '<command-name>/agent</command-name> malformed breadcrumb',
      },
    }, 'session-1')).toEqual([])
  })

  it('forwards only a safe memory count to the desktop client', () => {
    const privatePath = '/Users/test/.claude/projects/example/memory/preferences.md'
    const privateMessage = 'PRIVATE_MEMORY_WS_MESSAGE'
    const messages = translateCliMessage(
      {
        type: 'system',
        subtype: 'memory_saved',
        writtenPaths: [
          privatePath,
          '/Users/test/.claude/projects/example/memory/team/MEMORY.md',
        ],
        teamCount: 1,
        verb: 'Saved',
        message: privateMessage,
      },
      'session-1',
    )

    expect(messages).toEqual([
      {
        type: 'system_notification',
        subtype: 'memory_saved',
        data: {
          writtenCount: 2,
        },
      },
    ])
    expect(JSON.stringify(messages)).not.toContain(privatePath)
    expect(JSON.stringify(messages)).not.toContain(privateMessage)
  })
})

describe('WebSocket AskUserQuestion events', () => {
  it('forwards structured AskUserQuestion answers from CLI toolUseResult metadata', () => {
    expect(translateCliMessage({
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'ask-1',
            content: 'User has answered your questions: "Pick one?"="A". You can now continue with the user\'s answers in mind.',
          },
        ],
      },
      toolUseResult: {
        questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
        answers: { 'Pick one?': 'A' },
      },
    }, 'session-1')).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'ask-1',
        content: {
          questions: [{ question: 'Pick one?', options: [{ label: 'A' }] }],
          answers: { 'Pick one?': 'A' },
        },
        isError: false,
        parentToolUseId: undefined,
      },
    ])
  })
})

describe('WebSocket queued user replay events', () => {
  it('forwards ordinary queued user replays to the desktop client', () => {
    expect(translateCliMessage({
      type: 'user',
      isReplay: true,
      message: {
        role: 'user',
        content: 'please adjust the current direction',
      },
    }, 'session-1')).toEqual([
      {
        type: 'user_message_replay',
        content: 'please adjust the current direction',
      },
    ])
  })

  it('does not turn replayed tool results into user text messages', () => {
    expect(translateCliMessage({
      type: 'user',
      isReplay: true,
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' },
        ],
      },
    }, 'session-1')).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'tool-1',
        content: 'ok',
        isError: false,
        parentToolUseId: undefined,
      },
    ])
  })
})

describe('WebSocket compact events', () => {
  it('forwards CLI compacting status to the desktop client', () => {
    expect(translateCliMessage({
      type: 'system',
      subtype: 'status',
      status: 'compacting',
    }, 'session-1')).toEqual([
      {
        type: 'status',
        state: 'compacting',
        verb: 'Compacting conversation',
      },
    ])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'status',
      status: null,
    }, 'session-1')).toEqual([
      {
        type: 'status',
        state: 'thinking',
        verb: 'Thinking',
      },
    ])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'status',
      status: 'warming',
    }, 'session-1')).toEqual([])
  })

  it('forwards CLI permission-mode broadcasts instead of dropping them as thinking', () => {
    // CLI 在退出 plan 模式后恢复权限时会广播一条 status:null + permissionMode
    // 的事件。它必须被翻译成 permission_mode_changed，而不是被 null→thinking
    // 兜底吞掉 —— 这正是桌面端选择器卡在"计划模式"的根因。
    expect(translateCliMessage({
      type: 'system',
      subtype: 'status',
      status: null,
      permissionMode: 'bypassPermissions',
    }, 'session-1')).toEqual([
      { type: 'permission_mode_changed', mode: 'bypassPermissions' },
    ])

    // 普通 thinking（无 permissionMode）仍走原路径，不受影响。
    expect(translateCliMessage({
      type: 'system',
      subtype: 'status',
      status: null,
    }, 'session-1')).toEqual([
      { type: 'status', state: 'thinking', verb: 'Thinking' },
    ])
  })

  it('forwards compact summaries as system notifications instead of user chat bubbles', () => {
    const summary = [
      'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.',
      '',
      'Built the compact UI and verified the WebSocket event path.',
    ].join('\n')

    expect(translateCliMessage({
      type: 'user',
      message: {
        role: 'user',
        content: summary,
      },
      isSynthetic: true,
    }, 'session-1')).toEqual([
      {
        type: 'system_notification',
        subtype: 'compact_summary',
        message: summary,
        data: { isSynthetic: true },
      },
    ])
  })

  it('suppresses compact local command output after the compact summary', () => {
    expect(translateCliMessage({
      type: 'user',
      message: {
        role: 'user',
        content: '<local-command-stdout>Compacted </local-command-stdout>',
      },
    }, 'session-1')).toEqual([])
  })
})

describe('WebSocket API retry events', () => {
  it('forwards CLI api_retry messages as safe retry status', () => {
    const rawRetryError = 'provider=private-gateway model=secret-model stderr=/Users/test/private.log'
    const messages = translateCliMessage({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      retry_delay_ms: 1500,
      error_status: 503,
      error: { message: rawRetryError, status: 503 },
    }, 'session-1')

    expect(messages).toEqual([
      {
        type: 'api_retry',
        code: 'API_RETRYING',
        retryable: true,
        attempt: 2,
        maxRetries: 10,
        retryDelayMs: 1500,
        errorStatus: 503,
      },
    ])
    expect(JSON.stringify(messages)).not.toContain(rawRetryError)
  })

  it('forwards CLI streaming_fallback messages with a recognized cause', () => {
    // 形状对齐 QueryEngine 的 SDK 输出：{type:'system', subtype:'streaming_fallback', cause, ...}
    expect(translateCliMessage({
      type: 'system',
      subtype: 'streaming_fallback',
      cause: 'watchdog',
      session_id: 'session-1',
      uuid: 'uuid-1',
    }, 'session-1')).toEqual([
      { type: 'streaming_fallback', cause: 'watchdog' },
    ])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'streaming_fallback',
      cause: '404_stream_creation',
    }, 'session-1')).toEqual([
      { type: 'streaming_fallback', cause: '404_stream_creation' },
    ])
  })

  it('normalizes unrecognized streaming_fallback causes to unknown instead of dropping the event', () => {
    // 新 CLI + 旧枚举：提示本身比成因重要，不能丢消息。
    expect(translateCliMessage({
      type: 'system',
      subtype: 'streaming_fallback',
      cause: 'some_future_cause',
    }, 'session-1')).toEqual([
      { type: 'streaming_fallback', cause: 'unknown' },
    ])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'streaming_fallback',
    }, 'session-1')).toEqual([
      { type: 'streaming_fallback', cause: 'unknown' },
    ])
  })
})

describe('WebSocket background task events', () => {
  it('forwards task start and progress as structured desktop notifications', () => {
    const started = {
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      description: 'Verify the todo app',
      task_type: 'local_agent',
      prompt: 'Run E2E checks',
    }

    expect(translateCliMessage(started, 'session-1')).toEqual([
      {
        type: 'system_notification',
        subtype: 'task_started',
        message: 'Verify the todo app',
        data: started,
      },
      {
        type: 'status',
        state: 'tool_executing',
        verb: 'Verify the todo app',
      },
    ])

    const progress = {
      type: 'system',
      subtype: 'task_progress',
      task_id: 'agent-task-1',
      tool_use_id: 'agent-tool-1',
      description: 'Verify the todo app',
      summary: 'Running Playwright checks',
      last_tool_name: 'Bash',
      usage: {
        total_tokens: 1200,
        tool_uses: 4,
        duration_ms: 45000,
      },
    }

    expect(translateCliMessage(progress, 'session-1')).toEqual([
      {
        type: 'system_notification',
        subtype: 'task_progress',
        message: 'Running Playwright checks',
        data: progress,
      },
      {
        type: 'status',
        state: 'tool_executing',
        verb: 'Running Playwright checks',
      },
    ])
  })
})

describe('WebSocket goal command events', () => {
  const goalStatusOutput = 'Goal set: ship the smoke test'

  const runGoalCommand = (sessionId: string, args: string, output: string, type: 'system' | 'user' = 'system') => {
    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command',
      content: [
        { text: '<command-name>/goal</command-name>' },
        { text: `<command-args>${args}</command-args>` },
      ],
    }, sessionId)).toEqual([])

    if (type === 'user') {
      return translateCliMessage({
        type: 'user',
        message: {
          content: [{
            type: 'text',
            text: `<local-command-stdout>${output}</local-command-stdout>`,
          }],
        },
      }, sessionId)
    }

    return translateCliMessage({
      type: 'system',
      subtype: 'local_command_output',
      content: `<local-command-stdout>${output}</local-command-stdout>`,
    }, sessionId)
  }

  it('turns confirmed /goal local command output into a desktop goal event', () => {
    const sessionId = `goal-event-${crypto.randomUUID()}`

    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/goal</command-name>\n<command-args>ship the smoke test</command-args>',
    }, sessionId)).toEqual([])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command',
      content: [
        '<local-command-stdout>',
        goalStatusOutput,
        '</local-command-stdout>',
      ].join('\n'),
    }, sessionId)).toEqual([
      {
        type: 'system_notification',
        subtype: 'goal_event',
        message: goalStatusOutput,
        data: {
          action: 'created',
          status: 'active',
          objective: 'ship the smoke test',
          message: goalStatusOutput,
        },
      },
    ])
  })

  it('classifies /goal clear and completion output for the desktop client', () => {
    expect(runGoalCommand(`goal-complete-${crypto.randomUUID()}`, 'complete', 'Goal marked complete.')).toEqual([
      expect.objectContaining({
        type: 'system_notification',
        subtype: 'goal_event',
        data: { action: 'completed', message: 'Goal marked complete.' },
      }),
    ])

    expect(runGoalCommand(`goal-clear-${crypto.randomUUID()}`, 'clear', 'Goal cleared: ship docs')).toEqual([
      expect.objectContaining({
        type: 'system_notification',
        subtype: 'goal_event',
        data: { action: 'cleared', message: 'Goal cleared: ship docs' },
      }),
    ])
  })

  it('classifies /goal continuation output as a visible goal status event', () => {
    const output = 'Goal continuing: finish release validation'

    expect(runGoalCommand(`goal-continue-${crypto.randomUUID()}`, 'ship docs', output)).toEqual([
      expect.objectContaining({
        type: 'system_notification',
        subtype: 'goal_event',
        message: output,
        data: {
          action: 'status',
          status: 'continuing',
          message: output,
        },
      }),
    ])
  })

  it('allows direct /goal local command output through the pre-turn mute gate', () => {
    const shouldForward = createCurrentTurnLocalCommandForwarder(
      parseSlashCommand('/goal ship the smoke test'),
    )

    expect(shouldForward({
      type: 'system',
      subtype: 'local_command_output',
      content: '<local-command-stdout>Goal set: ship the smoke test</local-command-stdout>',
    })).toBe(true)
  })

  it('keeps negative /goal command output visible as a goal message event', () => {
    expect(runGoalCommand(`goal-empty-${crypto.randomUUID()}`, '', 'No active goal.', 'user')).toEqual([
      {
        type: 'system_notification',
        subtype: 'goal_event',
        message: 'No active goal.',
        data: { action: 'message', message: 'No active goal.' },
      },
    ])
  })

  it('does not turn unrelated local command output into a goal event', () => {
    const sessionId = `goal-unrelated-${crypto.randomUUID()}`

    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/status</command-name>',
    }, sessionId)).toEqual([])

    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command_output',
      content: '<local-command-stdout>Goal: active</local-command-stdout>',
    }, sessionId)).toEqual([
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'Goal: active' },
    ])
  })

  it('allows the current slash command lifecycle through the pre-turn mute gate', () => {
    const shouldForward = createCurrentTurnLocalCommandForwarder(
      parseSlashCommand('/goal ship the smoke test'),
    )

    expect(shouldForward({
      type: 'system',
      subtype: 'init',
    })).toBe(false)
    expect(shouldForward({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/cost</command-name>\n<command-args></command-args>',
    })).toBe(false)
    expect(shouldForward({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/goal</command-name>\n<command-args>ship the smoke test</command-args>',
    })).toBe(true)
    expect(shouldForward({
      type: 'system',
      subtype: 'local_command',
      content: '<local-command-stdout>Goal set: ship the smoke test</local-command-stdout>',
    })).toBe(true)
    expect(shouldForward({
      type: 'system',
      subtype: 'local_command_output',
      content: 'late unrelated output',
    })).toBe(false)
  })

})

describe('WebSocket memory command events', () => {
  it('keeps /memory completion visible without forwarding a local memory path', () => {
    const sessionId = `memory-command-${crypto.randomUUID()}`
    const privatePath = '/Users/test/.claude/projects/example/memory/preferences.md'

    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/memory</command-name>',
    }, sessionId)).toEqual([])

    const messages = translateCliMessage({
      type: 'system',
      subtype: 'local_command_output',
      content: `<local-command-stdout>Opened memory file at ${privatePath}\n\n> Using $EDITOR="code".</local-command-stdout>`,
    }, sessionId)

    expect(messages).toEqual([
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'Memory editor opened.' },
    ])
    expect(JSON.stringify(messages)).not.toContain(privatePath)
  })

  it('sanitizes /memory output when the CLI reports it in a user message', () => {
    const sessionId = `memory-command-user-${crypto.randomUUID()}`
    const privatePath = '/Users/test/.claude/projects/example/memory/team/MEMORY.md'

    expect(translateCliMessage({
      type: 'system',
      subtype: 'local_command',
      content: '<command-name>/memory</command-name>',
    }, sessionId)).toEqual([])

    const messages = translateCliMessage({
      type: 'user',
      message: {
        content: [{
          type: 'text',
          text: `<local-command-stdout>Opened memory file at ${privatePath}</local-command-stdout>`,
        }],
      },
    }, sessionId)

    expect(messages).toEqual([
      { type: 'content_start', blockType: 'text' },
      { type: 'content_delta', text: 'Memory editor opened.' },
    ])
    expect(JSON.stringify(messages)).not.toContain(privatePath)
  })
})

describe('WebSocket stream event translation', () => {
  it('keeps subagent parent linkage when later stream events omit the parent id', () => {
    const sessionId = `subagent-parent-${crypto.randomUUID()}`

    expect(translateCliMessage({
      type: 'stream_event',
      parent_tool_use_id: 'agent-1',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'read-1', name: 'Read' },
      },
    }, sessionId)).toEqual([
      {
        type: 'content_start',
        blockType: 'tool_use',
        toolName: 'Read',
        toolUseId: 'read-1',
        parentToolUseId: 'agent-1',
      },
    ])

    expect(translateCliMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file_path":"src/App.tsx"}' },
      },
    }, sessionId)).toEqual([
      { type: 'content_delta', toolInput: '{"file_path":"src/App.tsx"}' },
    ])

    expect(translateCliMessage({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    }, sessionId)).toEqual([
      {
        type: 'tool_use_complete',
        toolName: 'Read',
        toolUseId: 'read-1',
        input: { file_path: 'src/App.tsx' },
        parentToolUseId: 'agent-1',
      },
    ])

    expect(translateCliMessage({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'read-1', content: 'ok' },
        ],
      },
    }, sessionId)).toEqual([
      {
        type: 'tool_result',
        toolUseId: 'read-1',
        content: 'ok',
        isError: false,
        parentToolUseId: 'agent-1',
      },
    ])
  })

  it('keeps DeepSeek-style thinking blocks in thinking state until text starts', () => {
    const sessionId = `deepseek-thinking-${crypto.randomUUID()}`

    expect(translateCliMessage({
      type: 'stream_event',
      event: { type: 'message_start' },
    }, sessionId)).toEqual([
      { type: 'status', state: 'thinking' },
    ])

    expect(translateCliMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      },
    }, sessionId)).toEqual([
      { type: 'status', state: 'thinking', verb: 'Thinking' },
    ])

    expect(translateCliMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'Let me think' },
      },
    }, sessionId)).toEqual([
      { type: 'thinking', text: 'Let me think' },
    ])

    expect(translateCliMessage({
      type: 'stream_event',
      event: { type: 'content_block_stop', index: 0 },
    }, sessionId)).toEqual([])

    expect(translateCliMessage({
      type: 'stream_event',
      event: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: '' },
      },
    }, sessionId)).toEqual([
      { type: 'content_start', blockType: 'text' },
    ])
  })
})
