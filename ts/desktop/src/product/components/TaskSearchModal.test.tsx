import '@testing-library/jest-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ProductTaskIndexResponse, ProductTaskRecord } from '../domain/types'

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  openProductTaskTab: vi.fn(),
  index: null as unknown,
  isLoading: false,
  error: null as string | null,
}))

vi.mock('../stores/productTaskStore', () => ({
  useProductTaskStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    index: mocks.index,
    isLoading: mocks.isLoading,
    error: mocks.error,
    refresh: mocks.refresh,
  }),
}))

vi.mock('../../stores/tabStore', () => ({
  useTabStore: {
    getState: () => ({ openProductTaskTab: mocks.openProductTaskTab }),
  },
}))

const labels: Record<string, string> = {
  'search.global.trigger': '搜索任务',
  'search.global.placeholder': '搜索项目、任务或工作目录…',
  'search.global.recentTitle': '最近任务',
  'search.global.noResults': '没有找到匹配任务',
  'search.global.loading': '正在读取任务…',
  'search.global.error': '无法读取任务',
  'search.global.close': '关闭',
  'search.global.project': '项目',
  'search.global.workDir': '工作目录',
  'search.global.active': '进行中',
  'search.global.archived': '已归档',
  'search.global.unassignedProject': '未归属项目',
}

vi.mock('../../i18n', () => ({
  useTranslation: () => (key: string) => labels[key] ?? key,
}))

import { TaskSearchModal } from './TaskSearchModal'

function makeTask(overrides: Partial<ProductTaskRecord> = {}): ProductTaskRecord {
  return {
    id: 'task-1',
    projectId: 'project-a',
    workDir: '/workspace/alpha',
    title: '整理开球训练',
    lifecycle: 'active',
    kind: 'main',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T01:00:00.000Z',
    worktreeState: 'not_requested',
    actions: ['continue'],
    ...overrides,
    directoryId: overrides.directoryId ?? 'directory-a',
  }
}

function makeIndex(tasks: ProductTaskRecord[] = [
  makeTask(),
  makeTask({
    id: 'task-2',
    projectId: 'project-b',
    directoryId: 'directory-b',
    workDir: '/workspace/beta',
    title: '归档的球台维护计划',
    lifecycle: 'archived',
    updatedAt: '2026-07-19T02:00:00.000Z',
  }),
]): ProductTaskIndexResponse {
  return {
    schemaVersion: 2,
    projects: [
      {
        id: 'project-a',
        title: '甲店项目',
        rootDir: '/workspace/alpha',
        createdAt: '2026-07-19T00:00:00.000Z',
        taskCount: 1,
        archivedTaskCount: 0,
        updatedAt: '2026-07-19T01:00:00.000Z',
      },
      {
        id: 'project-b',
        title: '乙店项目',
        rootDir: '/workspace/beta',
        createdAt: '2026-07-19T00:00:00.000Z',
        taskCount: 0,
        archivedTaskCount: 1,
        updatedAt: '2026-07-19T02:00:00.000Z',
      },
    ],
    directories: [
      {
        id: 'directory-a',
        projectId: 'project-a',
        path: '/workspace/alpha',
        label: '甲店项目',
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T01:00:00.000Z',
      },
      {
        id: 'directory-b',
        projectId: 'project-b',
        path: '/workspace/beta',
        label: '乙店项目',
        createdAt: '2026-07-19T00:00:00.000Z',
        updatedAt: '2026-07-19T02:00:00.000Z',
      },
    ],
    tasks,
    total: tasks.length,
    capabilities: { createTask: true },
  }
}

beforeEach(() => {
  mocks.index = makeIndex()
  mocks.isLoading = false
  mocks.error = null
  mocks.refresh.mockReset()
  mocks.refresh.mockResolvedValue(undefined)
  mocks.openProductTaskTab.mockReset()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('TaskSearchModal', () => {
  it('does not fetch or render while closed', () => {
    render(<TaskSearchModal open={false} onClose={vi.fn()} />)

    expect(screen.queryByTestId('task-search-modal')).not.toBeInTheDocument()
    expect(mocks.refresh).not.toHaveBeenCalled()
  })

  it('refreshes product tasks when opened and shows recent task metadata', async () => {
    render(<TaskSearchModal open onClose={vi.fn()} />)

    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledOnce())
    expect(screen.getByText('最近任务')).toBeInTheDocument()
    expect(screen.getByText('整理开球训练')).toBeInTheDocument()
    expect(screen.getByText('归档的球台维护计划')).toBeInTheDocument()
    expect(screen.getByText('项目: 乙店项目')).toBeInTheDocument()
    expect(screen.getByText('工作目录: /workspace/beta')).toBeInTheDocument()
    expect(screen.getByText('已归档')).toBeInTheDocument()
  })

  it('keeps an older pinned task ahead of a newer unpinned task in recent search', () => {
    const pinnedTask = makeTask({
      id: 'task-pinned',
      title: '置顶任务',
      updatedAt: '2026-07-19T00:00:00.000Z',
      pinnedAt: '2026-07-19T00:01:00.000Z',
    })
    const newerTask = makeTask({
      id: 'task-newer',
      projectId: 'project-b',
      directoryId: 'directory-b',
      title: '较新任务',
      workDir: '/workspace/beta',
      updatedAt: '2026-07-19T02:00:00.000Z',
    })
    mocks.index = makeIndex([newerTask, pinnedTask])

    render(<TaskSearchModal open onClose={vi.fn()} />)

    expect(screen.getAllByRole('option')[0]).toHaveTextContent('置顶任务')
  })

  it('filters by product project and working-directory metadata without querying transcripts', () => {
    render(<TaskSearchModal open onClose={vi.fn()} />)

    const input = screen.getByRole('combobox', { name: '搜索项目、任务或工作目录…' })
    fireEvent.change(input, { target: { value: '乙店' } })

    expect(screen.getByText('归档的球台维护计划')).toBeInTheDocument()
    expect(screen.queryByText('整理开球训练')).not.toBeInTheDocument()

    fireEvent.change(input, { target: { value: '/workspace/alpha' } })
    expect(screen.getByText('整理开球训练')).toBeInTheDocument()
    expect(screen.queryByText('归档的球台维护计划')).not.toBeInTheDocument()
  })

  it('does not cap an explicit query at the recent-task limit', () => {
    const tasks = Array.from({ length: 10 }, (_, index) => makeTask({
      id: `task-${index}`,
      title: `共同任务 ${index}`,
      updatedAt: `2026-07-19T${String(index).padStart(2, '0')}:00:00.000Z`,
    }))
    mocks.index = makeIndex(tasks)

    render(<TaskSearchModal open onClose={vi.fn()} />)
    expect(screen.queryByText('共同任务 0')).not.toBeInTheDocument()

    fireEvent.change(screen.getByRole('combobox', { name: '搜索项目、任务或工作目录…' }), {
      target: { value: '共同任务' },
    })

    expect(screen.getByText('共同任务 9')).toBeInTheDocument()
    expect(screen.getByText('共同任务 0')).toBeInTheDocument()
  })

  it('opens the selected product task page and closes', () => {
    const onClose = vi.fn()
    render(<TaskSearchModal open onClose={onClose} />)

    fireEvent.click(screen.getByText('归档的球台维护计划'))

    expect(mocks.openProductTaskTab).toHaveBeenCalledWith('task-2', '归档的球台维护计划')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('navigates task results with the keyboard and opens the active task', () => {
    const onClose = vi.fn()
    render(<TaskSearchModal open onClose={onClose} />)

    const input = screen.getByRole('combobox', { name: '搜索项目、任务或工作目录…' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })

    expect(screen.getByRole('option', { name: /整理开球训练/ })).toHaveAttribute('aria-selected', 'true')
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.openProductTaskTab).toHaveBeenCalledWith('task-1', '整理开球训练')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('clamps the active task when a refresh shortens the result list', async () => {
    const onClose = vi.fn()
    const view = render(<TaskSearchModal open onClose={onClose} />)
    const input = screen.getByRole('combobox', { name: '搜索项目、任务或工作目录…' })

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    mocks.index = makeIndex([makeTask()])
    view.rerender(<TaskSearchModal open onClose={onClose} />)

    await waitFor(() => {
      expect(screen.getByRole('option', { name: /整理开球训练/ })).toHaveAttribute('aria-selected', 'true')
    })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(mocks.openProductTaskTab).toHaveBeenCalledWith('task-1', '整理开球训练')
    expect(onClose).toHaveBeenCalledOnce()
  })

  it('closes from Escape and a non-focusable backdrop', () => {
    const onClose = vi.fn()
    render(<TaskSearchModal open onClose={onClose} />)

    const input = screen.getByRole('combobox', { name: '搜索项目、任务或工作目录…' })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledOnce()

    const backdrop = screen.getByTestId('task-search-backdrop')
    expect(backdrop.tagName).toBe('DIV')
    expect(backdrop).toHaveAttribute('aria-hidden', 'true')
    fireEvent.click(backdrop)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it('keeps keyboard focus inside the dialog', () => {
    render(<TaskSearchModal open onClose={vi.fn()} />)

    const input = screen.getByRole('combobox', { name: '搜索项目、任务或工作目录…' })
    const options = screen.getAllByRole('option')
    const lastOption = options.at(-1)
    expect(lastOption).toBeDefined()

    act(() => {
      lastOption!.focus()
    })
    fireEvent.keyDown(lastOption!, { key: 'Tab' })
    expect(input).toHaveFocus()

    fireEvent.keyDown(input, { key: 'Tab', shiftKey: true })
    expect(lastOption).toHaveFocus()
  })

  it('shows product loading and error states without falling back to transcript search', () => {
    mocks.index = makeIndex([])
    mocks.isLoading = true
    const { rerender } = render(<TaskSearchModal open onClose={vi.fn()} />)

    expect(screen.getByText('正在读取任务…')).toBeInTheDocument()

    mocks.isLoading = false
    mocks.error = 'private backend failure'
    rerender(<TaskSearchModal open onClose={vi.fn()} />)
    expect(screen.getByText('无法读取任务')).toBeInTheDocument()
    expect(screen.queryByText('private backend failure')).not.toBeInTheDocument()
  })
})
