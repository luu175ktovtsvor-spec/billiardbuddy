// ToolCallCard 实时输出渲染断言(P0 命令实时输出):运行中的 run_command 把逐块累加的 liveOutput
// 渲进对话流(不必开终端面板就能看命令在跑什么);命令完成后运行态实时框消失、改由点行展开看全文。
// 不依赖 DOM/RTL:用 renderToStaticMarkup 验初次渲染的 HTML(effect 不跑,不影响首帧结构断言)。
import { expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolCallCard } from './ToolCallCard'
import type { ChatBlock } from '../../stores/chatStore'

type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>
function render(block: ToolBlock): string {
  return renderToStaticMarkup((<ToolCallCard block={block} />) as ReactElement)
}

test('运行中的命令把实时输出(liveOutput)逐块渲进对话流', () => {
  const html = render({
    id: 't1',
    kind: 'tool',
    tool: 'run_command',
    input: { command: 'seq 1 3' },
    status: 'running',
    liveOutput: '行1\n行2\n行3',
    liveChars: 9,
  })
  // 真实输出文本可见(此前被前端丢弃、只显示「N 字」)
  expect(html).toContain('行1')
  expect(html).toContain('行3')
  // 运行态光标(实时框专属)在
  expect(html).toContain('qf-cursor')
  // 命令原文走等宽
  expect(html).toContain('var(--font-mono)')
})

test('命令完成后不再显示运行态实时框(默认折叠,点行才展开看全文)', () => {
  const html = render({
    id: 't2',
    kind: 'tool',
    tool: 'run_command',
    input: { command: 'seq 1 3' },
    status: 'ok',
    output: '行1\n行2\n行3',
    liveOutput: '行1\n行2\n行3',
  })
  // 完成态:运行专属实时框(含 qf-cursor)不再渲染;输出改由点击展开(默认折叠 → 文本不在首帧 DOM)
  expect(html).not.toContain('qf-cursor')
  expect(html).not.toContain('行2')
})

test('无实时输出的运行中命令不渲染空的实时框', () => {
  const html = render({
    id: 't3',
    kind: 'tool',
    tool: 'run_command',
    input: { command: 'sleep 5' },
    status: 'running',
  })
  // liveOutput 未到 → 不渲染实时框(不出现运行态光标)
  expect(html).not.toContain('qf-cursor')
})
