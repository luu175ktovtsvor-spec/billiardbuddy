import { expect, mock, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ChatBlock } from '../../stores/chatStore'

mock.module('dompurify', () => ({ default: { sanitize: (raw: string) => raw } }))

const { Block, groupBlocks, partitionTurnItems, splitTurns } = await import('./MessageList')
const { shouldShowInitialWaiting } = await import('./StreamingIndicator')
const { ThinkingBlock } = await import('./ThinkingBlock')
const { ToolCallGroup } = await import('./ToolCallGroup')

function render(element: ReactElement): string {
  return renderToStaticMarkup(element)
}

test('进行中的思考首帧展开，完成态首帧折叠', () => {
  const active = render(<ThinkingBlock content="正在核对源码证据" isActive />)
  expect(active).toContain('正在思考')
  expect(active).toContain('正在核对源码证据')
  expect(active).not.toContain('qf-cursor')

  const completed = render(<ThinkingBlock content="已经核对完源码证据" isActive={false} />)
  expect(completed).toContain('已完成思考')
  expect(completed).not.toContain('已经核对完源码证据')
})

test('工具活动组用思考状态接管组头，不在明细里重复暴露思考正文', () => {
  const blocks: ChatBlock[] = [
    { id: 'tool-1', kind: 'tool', tool: 'read_file', input: { file_path: '/tmp/a.ts' }, status: 'ok' },
    { id: 'thinking-1', kind: 'thinking', text: '不应在工具明细里重复出现', active: true },
  ]
  const html = render(<ToolCallGroup blocks={blocks} />)
  expect(html).toContain('正在思考')
  expect(html).not.toContain('不应在工具明细里重复出现')
})

test('最终回复与可折叠活动区分离，流式正文不渲染字符光标', () => {
  const blocks: ChatBlock[] = [
    { id: 'user-1', kind: 'user', text: '检查项目' },
    { id: 'thinking-1', kind: 'thinking', text: '先阅读文件', active: false },
    { id: 'tool-1', kind: 'tool', tool: 'read_file', input: { file_path: '/tmp/a.ts' }, status: 'ok' },
    { id: 'assistant-1', kind: 'assistant', text: '这是最终结论', streaming: true },
  ]
  const turn = splitTurns(groupBlocks(blocks)).find((entry) => entry.type === 'turn')
  expect(turn?.type).toBe('turn')
  if (turn?.type !== 'turn') throw new Error('没有生成回合')
  const partition = partitionTurnItems(turn.items)
  expect(partition.hasActivity).toBe(true)
  expect(partition.activityItems).toHaveLength(1)
  expect(partition.responseItems).toHaveLength(1)
  expect(partition.finalAssistant?.text).toBe('这是最终结论')

  const response = render(<Block block={{ id: 'assistant-stream', kind: 'assistant', text: '流式正文没有字符光标', streaming: true }} />)
  expect(response).not.toContain('qf-cursor')
})

test('尚无活动事件时只显示轻量等待分隔行，活动出现后由活动区接管', () => {
  expect(shouldShowInitialWaiting('running', [{ id: 'user-1', kind: 'user', text: '开始' }])).toBe(true)
  expect(shouldShowInitialWaiting('idle', [{ id: 'user-1', kind: 'user', text: '开始' }])).toBe(false)
  expect(shouldShowInitialWaiting('running', [
      { id: 'user-1', kind: 'user', text: '开始' },
      { id: 'thinking-1', kind: 'thinking', text: '分析中', active: true },
  ])).toBe(false)
})
