import { describe, expect, it } from 'bun:test'
import {
  buildProductTaskAskUserQuestionUpdatedInput,
  parseProductTaskInboundMessage,
} from '../product/taskInboundPolicy.js'

describe('product task websocket inbound policy', () => {
  it('allows bounded task text, inline whitelisted attachments, and task-local controls', () => {
    expect(parseProductTaskInboundMessage({
      type: 'user_message',
      content: '  整理本周球房活动安排  ',
    })).toEqual({
      type: 'user_message',
      content: '整理本周球房活动安排',
    })

    expect(parseProductTaskInboundMessage({
      type: 'user_message',
      content: '',
      attachments: [{
        type: 'image',
        name: '  table.png  ',
        mimeType: 'image/png',
        data: 'data:image/png;base64,aGVsbG8=',
      }],
    })).toEqual({
      type: 'user_message',
      content: '',
      attachments: [{
        type: 'image',
        name: 'table.png',
        mimeType: 'image/png',
        data: 'data:image/png;base64,aGVsbG8=',
      }],
    })

    expect(parseProductTaskInboundMessage({
      type: 'user_message',
      content: '请核对附件中的台账。',
      attachments: [{
        type: 'file',
        name: 'daily-report.pdf',
        mimeType: 'application/pdf',
        data: 'data:application/pdf;base64,JVBERi0=',
      }],
    })).toEqual({
      type: 'user_message',
      content: '请核对附件中的台账。',
      attachments: [{
        type: 'file',
        name: 'daily-report.pdf',
        mimeType: 'application/pdf',
        data: 'data:application/pdf;base64,JVBERi0=',
      }],
    })

    expect(parseProductTaskInboundMessage({
      type: 'permission_response',
      requestId: 'approval-1',
      allowed: false,
    })).toEqual({
      type: 'permission_response',
      requestId: 'approval-1',
      allowed: false,
    })

    expect(parseProductTaskInboundMessage({
      type: 'ask_user_question_response',
      requestId: 'ask-1',
      answers: ['  先整理台账  ', '上午'],
    })).toEqual({
      type: 'ask_user_question_response',
      requestId: 'ask-1',
      answers: ['先整理台账', '上午'],
    })

    expect(parseProductTaskInboundMessage({
      type: 'computer_use_permission_response',
      requestId: 'computer-use-1',
      allowed: true,
    })).toEqual({
      type: 'computer_use_permission_response',
      requestId: 'computer-use-1',
      allowed: true,
    })

    expect(parseProductTaskInboundMessage({ type: 'stop_generation' })).toEqual({ type: 'stop_generation' })
    expect(parseProductTaskInboundMessage({ type: 'ping' })).toEqual({ type: 'ping' })
  })

  it('rejects Core-only fields, filesystem attachments, and malformed product actions', () => {
    expect(parseProductTaskInboundMessage({
      type: 'user_message',
      content: '/skill ball-hall-daily-review 今天的营业数据',
    })).toEqual({
      type: 'user_message',
      content: '/skill ball-hall-daily-review 今天的营业数据',
    })

    for (const payload of [
      { type: 'set_permission_mode', mode: 'bypassPermissions' },
      { type: 'set_runtime_config', providerId: 'private-provider', modelId: 'private-model' },
      { type: 'prewarm_session' },
      {
        type: 'permission_response',
        requestId: 'permission-1',
        allowed: true,
        rule: 'Bash(*)',
        updatedInput: { command: 'PRIVATE_COMMAND' },
        permissionUpdates: [{ type: 'addRules' }],
      },
      {
        type: 'computer_use_permission_response',
        requestId: 'computer-1',
        response: { granted: [], denied: [] },
      },
      {
        type: 'user_message',
        content: '查看附件',
        attachments: [{ type: 'file', path: '/private/file.txt' }],
      },
      {
        type: 'user_message',
        content: '',
        attachments: [{
          type: 'file',
          mimeType: 'application/pdf',
          data: 'data:text/plain;base64,aGVsbG8=',
        }],
      },
      {
        type: 'user_message',
        content: '',
      },
      { type: 'stop_generation', force: true },
      { type: 'ping', sessionId: 'other-session' },
      {
        type: 'ask_user_question_response',
        requestId: 'ask-1',
        answers: ['选项 A'],
        updatedInput: { questions: 'PRIVATE_TOOL_INPUT' },
      },
      {
        type: 'ask_user_question_response',
        requestId: 'ask-1',
        answers: { '问题': '选项 A' },
      },
    ]) {
      expect(parseProductTaskInboundMessage(payload)).toBeNull()
    }
  })

  it('builds AskUserQuestion updatedInput only from matching internal questions and safe answers', () => {
    const pendingInput = {
      questions: [{
        question: '先处理哪项？',
        header: '优先级',
        options: [
          { label: '整理台账', description: '核对当天收入' },
          { label: '联系客户', description: '确认预约' },
        ],
      }],
      privateCoreField: 'PRIVATE_CORE_INPUT',
    }

    expect(buildProductTaskAskUserQuestionUpdatedInput(
      pendingInput,
      ['  整理台账  '],
    )).toEqual({
      ...pendingInput,
      answers: { '先处理哪项？': '整理台账' },
    })

    expect(buildProductTaskAskUserQuestionUpdatedInput(pendingInput, [])).toBeNull()
    expect(buildProductTaskAskUserQuestionUpdatedInput({
      questions: [{ question: 'x'.repeat(1_001) }],
    }, ['答案'])).toBeNull()
  })
})
