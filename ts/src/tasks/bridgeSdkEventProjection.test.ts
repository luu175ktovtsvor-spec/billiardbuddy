import { expect, test } from 'bun:test'
import { projectBridgeSdkEvent } from './bridgeSdkEventProjection'

test('projectBridgeSdkEvent maps assistant content blocks to frontend agent events', () => {
  expect(projectBridgeSdkEvent({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: '分析远端仓库' },
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'app.ts' } },
        { type: 'text', text: '远端完成' },
      ],
    },
  })).toEqual([
    { type: 'thinking', text: '分析远端仓库' },
    { type: 'tool_call', tool: 'Read', input: { file_path: 'app.ts' } },
    { type: 'final', text: '远端完成' },
  ])
})

test('projectBridgeSdkEvent maps stream deltas, tool results and lifecycle messages', () => {
  expect(projectBridgeSdkEvent({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '流式片段' } },
  })).toEqual([{ type: 'thinking', text: '流式片段' }])

  expect(projectBridgeSdkEvent({
    type: 'stream_event',
    event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_2', name: 'Bash', input: { command: 'npm test' } } },
  })).toEqual([{ type: 'tool_call', tool: 'Bash', input: { command: 'npm test' } }])

  expect(projectBridgeSdkEvent({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: 'ok' }] },
  })).toEqual([{ type: 'tool_result', tool: 'remote_tool', output: 'ok' }])

  expect(projectBridgeSdkEvent({ type: 'system', subtype: 'status', status: 'compacting' })).toEqual([
    { type: 'context_note', text: 'Remote session compacting' },
  ])
  expect(projectBridgeSdkEvent({ type: 'result', subtype: 'success', result: 'done' })).toEqual([
    { type: 'final', text: 'done' },
  ])
})

test('projectBridgeSdkEvent ignores user text by default but can project history text', () => {
  const payload = { type: 'user', message: { content: '远端用户文本' } }
  expect(projectBridgeSdkEvent(payload)).toEqual([])
  expect(projectBridgeSdkEvent(payload, { includeUserText: true })).toEqual([
    { type: 'steering', content: '远端用户文本' },
  ])
})
