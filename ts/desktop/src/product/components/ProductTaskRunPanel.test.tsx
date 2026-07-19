import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import {
  ProductTaskRunPanel,
  productTaskRunActivityRows,
} from './ProductTaskRunPanel'

describe('ProductTaskRunPanel', () => {
  it('renders a collapsed product-safe activity tree with progress', () => {
    const parentId = `activity_${'a'.repeat(32)}`
    const childId = `activity_${'b'.repeat(32)}`
    render(
      <ProductTaskRunPanel activities={[
        {
          id: parentId,
          kind: 'workspace',
          phase: 'running',
          summary: '正在整理任务计划',
        },
        {
          id: childId,
          parentId,
          kind: 'subtask',
          phase: 'running',
          summary: '正在协同处理事项',
          progress: { completed: 1, total: 2 },
        },
      ]} />,
    )

    const toggle = screen.getByRole('button', { name: /运行活动/ })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByLabelText('任务运行活动')).toBeNull()

    fireEvent.click(toggle)

    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByLabelText('任务运行活动').textContent).toContain('正在整理任务计划')
    expect(screen.getByLabelText('任务运行活动').textContent).toContain('正在协同处理事项')
    expect(screen.getByText('1/2')).toBeTruthy()
  })

  it('keeps malformed cyclic links visible without rendering a raw summary', () => {
    const firstId = `activity_${'c'.repeat(32)}`
    const secondId = `activity_${'d'.repeat(32)}`
    const rows = productTaskRunActivityRows([
      {
        id: firstId,
        parentId: secondId,
        kind: 'command',
        phase: 'running',
        summary: 'PRIVATE_TOOL_INPUT /Users/private/file',
      },
      {
        id: secondId,
        parentId: firstId,
        kind: 'tool',
        phase: 'completed',
        summary: '已完成任务处理',
      },
    ])
    expect(rows.map((row) => row.id)).toEqual([firstId, secondId])

    render(<ProductTaskRunPanel activities={rows} />)
    fireEvent.click(screen.getByRole('button', { name: /运行活动/ }))

    expect(screen.getByLabelText('任务运行活动').textContent).toContain('正在执行命令')
    expect(screen.getByLabelText('任务运行活动').textContent).not.toContain('PRIVATE_TOOL_INPUT')
    expect(screen.getByLabelText('任务运行活动').textContent).not.toContain('/Users/private/file')
  })
})
