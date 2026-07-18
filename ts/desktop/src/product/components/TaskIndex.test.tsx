import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const mocks = vi.hoisted(() => ({
  listSkills: vi.fn(),
  openDirectory: vi.fn(),
  isDesktop: false,
}))

vi.mock('../../api/skills', () => ({
  skillsApi: {
    list: mocks.listSkills,
  },
}))

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({
    isDesktop: mocks.isDesktop,
    capabilities: { dialogs: mocks.isDesktop },
    dialogs: { open: mocks.openDirectory },
  }),
}))

import { TaskIndex } from './TaskIndex'
import type { ProductTaskIndexResponse, ProductTaskRecord } from '../domain/types'
import { useSettingsStore } from '../../stores/settingsStore'
import type { SkillMeta } from '../../types/skill'

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

function makeSkill(overrides: Partial<SkillMeta> = {}): SkillMeta {
  return {
    name: 'venue-daily-review',
    displayName: '复盘今天经营',
    description: '整理球房当天经营数据。',
    source: 'bundled',
    userInvocable: true,
    contentLength: 120,
    hasDirectory: true,
    ...overrides,
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

beforeEach(() => {
  mocks.isDesktop = false
  mocks.listSkills.mockResolvedValue({ skills: [] })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  useSettingsStore.setState({ permissionMode: 'default' })
})

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

  it('does not show the native folder chooser outside the desktop app', () => {
    renderIndex()

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    expect(screen.queryByRole('button', { name: '选择文件夹' })).not.toBeInTheDocument()
  })

  it('writes the desktop native folder selection back to the work directory', async () => {
    mocks.isDesktop = true
    mocks.openDirectory.mockResolvedValue('/workspace/selected-project')
    renderIndex()

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))

    await waitFor(() => expect(mocks.openDirectory).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: '选择任务工作目录',
    }))
    await waitFor(() => expect(screen.getByLabelText('工作目录')).toHaveValue('/workspace/selected-project'))
  })

  it('keeps the optional initial goal out of the product task fields', async () => {
    const props = renderIndex()

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(screen.getByLabelText('任务标题（可选）'), { target: { value: '整理球台配置' } })
    fireEvent.change(screen.getByLabelText('初始目标（可选）'), { target: { value: '  请列出本周的训练安排  ' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(props.onCreateTask).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
      title: '整理球台配置',
    }, '请列出本周的训练安排'))
  })

  it('inserts a real discoverable slash command and keeps it outside the product task payload', async () => {
    mocks.listSkills.mockResolvedValue({
      skills: [
        makeSkill(),
        makeSkill({
          name: 'internal-only',
          displayName: '内部命令',
          userInvocable: false,
        }),
      ],
    })
    const props = renderIndex()

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(screen.getByLabelText('初始目标（可选）'), { target: { value: '/venue' } })

    await waitFor(() => expect(mocks.listSkills).toHaveBeenCalledWith('/workspace/new-table'))
    fireEvent.click(await screen.findByRole('button', { name: /\/venue-daily-review/ }))

    expect(screen.getByLabelText('初始目标（可选）')).toHaveValue('/venue-daily-review ')
    expect(screen.queryByRole('button', { name: /\/internal-only/ })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(props.onCreateTask).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
    }, '/venue-daily-review'))
  })

  it('does not show a command choice while discovery is loading or unavailable', async () => {
    let rejectSkills: (error: Error) => void = () => undefined
    mocks.listSkills.mockImplementation(() => new Promise((_, reject) => {
      rejectSkills = reject
    }))
    renderIndex()

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(screen.getByLabelText('初始目标（可选）'), { target: { value: '/' } })

    expect(await screen.findByRole('status')).toHaveTextContent('正在读取可用命令')
    expect(screen.queryByRole('button', { name: /\/venue-daily-review/ })).not.toBeInTheDocument()

    rejectSkills(new Error('服务不可用'))

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取可用命令：服务不可用')
    expect(screen.queryByRole('button', { name: /\/venue-daily-review/ })).not.toBeInTheDocument()
  })

  it('uses the configured default permission mode for the new core session', async () => {
    useSettingsStore.setState({ permissionMode: 'plan' })
    const props = renderIndex()

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(props.onCreateTask).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
      permissionMode: 'plan',
    }))
  })
})
