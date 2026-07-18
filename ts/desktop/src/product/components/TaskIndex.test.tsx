import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { TaskIndex } from './TaskIndex'
import type { ProductTaskIndexResponse, ProductTaskRecord } from '../domain/types'

function makeTask(overrides: Partial<ProductTaskRecord> = {}): ProductTaskRecord {
  return {
    id: 'task-1',
    projectId: 'project-1',
    workDir: '/workspace/billiard',
    title: '修复开球规则',
    coreSessionId: 'session-1',
    lifecycle: 'active',
    kind: 'main',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    worktreeState: 'planned',
    actions: ['rename', 'pin', 'continue', 'archive'],
    ...overrides,
  }
}

function makeIndex(task = makeTask()): ProductTaskIndexResponse {
  return {
    schemaVersion: 1,
    projects: [{
      id: 'project-1',
      title: 'BilliardBuddy',
      workDir: '/workspace/billiard',
      taskCount: 1,
      archivedTaskCount: 0,
      updatedAt: '2026-07-18T00:00:00.000Z',
    }],
    tasks: [task],
    total: 1,
    capabilities: { createTask: true },
  }
}

function renderIndex(index = makeIndex()) {
  const props = {
    index,
    isLoading: false,
    error: null,
    mutations: {},
    onRefresh: vi.fn(async () => undefined),
    onCreateTask: vi.fn(async () => undefined),
    onRenameTask: vi.fn(async () => undefined),
    onPinTask: vi.fn(async () => undefined),
    onUnpinTask: vi.fn(async () => undefined),
    onArchiveTask: vi.fn(async () => undefined),
    onRestoreTask: vi.fn(async () => undefined),
    onContinueTask: vi.fn(async () => undefined),
    onOpenTask: vi.fn(),
  }
  render(<TaskIndex {...props} />)
  return props
}

afterEach(cleanup)

describe('TaskIndex', () => {
  it('shows a task under its project with its real work directory and planned worktree state', () => {
    renderIndex()

    const project = screen.getByTestId('product-project-project-1')
    expect(project).toHaveTextContent('BilliardBuddy')
    expect(project).toHaveTextContent('/workspace/billiard')
    expect(project).toHaveTextContent('修复开球规则')
    expect(project).toHaveTextContent('工作目录：/workspace/billiard')
    expect(project).toHaveTextContent('工作树计划中')
  })

  it('only presents actions enabled by the backend task record', () => {
    renderIndex(makeIndex(makeTask({ actions: ['archive'] })))

    expect(screen.getByRole('button', { name: '归档' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重命名' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '置顶' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()
  })

  it('creates a task, opens its core session, and continues the selected task', async () => {
    const props = renderIndex()

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(screen.getByLabelText('任务标题（可选）'), { target: { value: '整理球台配置' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(props.onCreateTask).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
      title: '整理球台配置',
    }))

    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'task-1',
      coreSessionId: 'session-1',
    }))

    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(props.onContinueTask).toHaveBeenCalledWith('task-1', {}))
  })
})
