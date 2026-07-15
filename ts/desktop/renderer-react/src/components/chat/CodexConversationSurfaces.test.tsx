import { afterEach, expect, test } from 'bun:test'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useChatStore, type ChatBlock } from '../../stores/chatStore'
import { EditSummaryCard } from './EditSummaryCard'
import { SessionTaskBar, todoSummary } from './SessionTaskBar'

function render(element: ReactElement): string {
  return renderToStaticMarkup(element)
}

afterEach(() => {
  useChatStore.setState({ todos: [], todoBarExpanded: false })
})

test('待办清单使用 Codex 紧凑摘要，默认折叠且展开后显示编号', () => {
  expect(todoSummary([
    { status: 'done' },
    { status: 'in_progress' },
    { status: 'pending' },
  ])).toBe('已完成 1 个任务，共 3 个')
  expect(todoSummary([{ status: 'pending' }, { status: 'in_progress' }]))
    .toBe('已创建包含 2 个任务的待办事项清单')

  const empty = render(<SessionTaskBar />)
  expect(empty).toBe('')
})

test('文件修改摘要聚合同文件并默认只列出前三个文件', () => {
  const blocks: Array<Extract<ChatBlock, { kind: 'tool' }>> = [
    { id: 'edit-a-1', kind: 'tool', tool: 'edit_file', input: { file_path: 'src/a.ts', old_string: 'a\n', new_string: 'a\nb\n' }, status: 'ok' },
    { id: 'edit-a-2', kind: 'tool', tool: 'edit_file', input: { file_path: 'src/a.ts', old_string: 'b\n', new_string: 'b\nc\n' }, status: 'ok' },
    { id: 'edit-b', kind: 'tool', tool: 'edit_file', input: { file_path: 'src/b.ts', old_string: '', new_string: 'b\n' }, status: 'ok' },
    { id: 'edit-c', kind: 'tool', tool: 'edit_file', input: { file_path: 'src/c.ts', old_string: '', new_string: 'c\n' }, status: 'ok' },
    { id: 'edit-d', kind: 'tool', tool: 'edit_file', input: { file_path: 'src/d.ts', old_string: '', new_string: 'd\n' }, status: 'ok' },
  ]

  const html = render(<EditSummaryCard blocks={blocks} canUndo />)
  expect(html).toContain('已编辑 4 个文件')
  expect(html.match(/<button[^>]*>[\s\S]*?<span class="sr-only">src\/a\.ts<\/span>/g)?.length).toBe(1)
  expect(html).toContain('b.ts')
  expect(html).toContain('c.ts')
  expect(html).not.toContain('d.ts')
  expect(html).toContain('再显示 1 个文件')
  expect(html).toContain('撤销')
  expect(html).toContain('审核')
})
