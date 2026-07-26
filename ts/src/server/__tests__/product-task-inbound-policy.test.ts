import { describe, expect, test } from 'bun:test'
import {
  buildProductTaskAskUserQuestionUpdatedInput,
  parseProductTaskInboundMessage,
} from '../product/taskInboundPolicy.js'

describe('ProductTask presentation-socket input policy', () => {
  test('accepts only bounded approval, question, stop, and ping actions', () => {
    expect(parseProductTaskInboundMessage({ type: 'permission_response', requestId: 'approval-1', allowed: true })).toEqual({ type: 'permission_response', requestId: 'approval-1', allowed: true })
    expect(parseProductTaskInboundMessage({ type: 'ask_user_question_response', requestId: 'question-1', answers: ['本周'] })).toEqual({ type: 'ask_user_question_response', requestId: 'question-1', answers: ['本周'] })
    expect(parseProductTaskInboundMessage({ type: 'stop_generation' })).toEqual({ type: 'stop_generation' })
    expect(parseProductTaskInboundMessage({ type: 'ping' })).toEqual({ type: 'ping' })
  })

  test('rejects raw submit, runtime mutation, malformed IDs, and oversized answers', () => {
    for (const payload of [
      { type: 'user_message', content: '绕过持久提交' },
      { type: 'user_message', attachments: [{ data: 'data:image/png;base64,AAAA' }] },
      { type: 'set_model', model: 'private' },
      { type: 'permission_response', requestId: '../approval', allowed: true },
      { type: 'permission_response', requestId: 'approval', allowed: 'yes' },
      { type: 'ask_user_question_response', requestId: 'question', answers: [] },
      { type: 'ask_user_question_response', requestId: 'question', answers: ['x'.repeat(4_001)] },
      { type: 'stop_generation', extra: true },
    ]) expect(parseProductTaskInboundMessage(payload)).toBeNull()
  })
})

describe('AskUserQuestion answer synthesis', () => {
  test('adds only ordered answers to the server-owned pending input', () => {
    const pending = {
      questions: [
        { question: '选择范围', header: '范围', options: [{ label: '本周' }, { label: '全部' }] },
        { question: '是否包含草稿' },
      ],
    }
    expect(buildProductTaskAskUserQuestionUpdatedInput(pending, ['本周', '否'])).toEqual({
      ...pending,
      answers: { '选择范围': '本周', '是否包含草稿': '否' },
    })
    expect(buildProductTaskAskUserQuestionUpdatedInput(pending, ['本周'])).toBeNull()
  })
})
