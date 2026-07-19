import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'

const mocks = vi.hoisted(() => ({
  listSkillCommands: vi.fn(),
  listAgents: vi.fn(),
  openDirectory: vi.fn(),
  openProductTaskWindow: vi.fn(),
  isDesktop: false,
  canOpenTaskWindow: false,
  copyText: vi.fn(),
}))

vi.mock('../api/taskCommands', () => ({
  productTaskCommandsApi: {
    listSkills: mocks.listSkillCommands,
    listAgents: mocks.listAgents,
  },
}))

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({
    isDesktop: mocks.isDesktop,
    capabilities: {
      dialogs: mocks.isDesktop,
      taskWindows: mocks.canOpenTaskWindow,
    },
    dialogs: { open: mocks.openDirectory },
    window: { openProductTask: mocks.openProductTaskWindow },
  }),
}))

vi.mock('../../components/chat/clipboard', () => ({
  copyTextToClipboard: mocks.copyText,
}))

import { TaskComposer, TaskIndex, type TaskIndexProps } from './TaskIndex'
import type { ProductTaskIndexResponse, ProductTaskRecord } from '../domain/types'
import { useSettingsStore } from '../../stores/settingsStore'
import type { ProductTaskSkillCommand } from '../api/taskCommands'

function makeTask(overrides: Partial<ProductTaskRecord> = {}): ProductTaskRecord {
  return {
    id: 'task-1',
    projectId: 'project-1',
    workDir: '/workspace/billiard',
    title: '修复开球规则',
    lifecycle: 'active',
    kind: 'main',
    createdAt: '2026-07-18T00:00:00.000Z',
    updatedAt: '2026-07-18T00:00:00.000Z',
    worktreeState: 'planned',
    actions: ['rename', 'pin', 'continue', 'archive'],
    ...overrides,
    directoryId: overrides.directoryId ?? 'directory-1',
  }
}

function makeIndex(task = makeTask()): ProductTaskIndexResponse {
  return {
    schemaVersion: 2,
    projects: [{
      id: 'project-1',
      title: 'BilliardBuddy',
      rootDir: '/workspace/billiard',
      createdAt: '2026-07-18T00:00:00.000Z',
      taskCount: 1,
      archivedTaskCount: 0,
      updatedAt: '2026-07-18T00:00:00.000Z',
    }],
    directories: [{
      id: 'directory-1',
      projectId: 'project-1',
      path: '/workspace/billiard',
      label: 'BilliardBuddy',
      createdAt: '2026-07-18T00:00:00.000Z',
      updatedAt: '2026-07-18T00:00:00.000Z',
    }],
    tasks: [task],
    total: 1,
    capabilities: { createTask: true },
  }
}

function makeSkill(overrides: Partial<ProductTaskSkillCommand> = {}): ProductTaskSkillCommand {
  return {
    runtimeName: 'venue-daily-review',
    displayName: '复盘今天经营',
    description: '把球房营业数据和当天情况整理成经营复盘。',
    ...overrides,
  }
}

function renderIndex(index = makeIndex(), overrides: Partial<TaskIndexProps> = {}) {
  const props: TaskIndexProps = {
    index,
    isLoading: false,
    error: null,
    mutations: {},
    onRefresh: vi.fn(async () => undefined),
    onRenameTask: vi.fn(async () => undefined),
    onPinTask: vi.fn(async () => undefined),
    onUnpinTask: vi.fn(async () => undefined),
    onArchiveTask: vi.fn(async () => undefined),
    onRestoreTask: vi.fn(async () => undefined),
    onContinueTask: vi.fn(async () => undefined),
    onRequestNewTask: vi.fn(),
    onOpenTask: vi.fn(),
    ...overrides,
  }
  render(<TaskIndex {...props} />)
  return props
}

function renderComposer(overrides: Partial<{
  initialWorkDir: string
}> = {}) {
  const onSubmit = vi.fn(async () => undefined)
  const onCancel = vi.fn()
  render(
    <TaskComposer
      projects={makeIndex().projects}
      directories={makeIndex().directories}
      initialWorkDir={overrides.initialWorkDir}
      isSubmitting={false}
      onCancel={onCancel}
      onSubmit={onSubmit}
    />,
  )
  return { onCancel, onSubmit }
}

beforeEach(() => {
  mocks.isDesktop = false
  mocks.canOpenTaskWindow = false
  mocks.listSkillCommands.mockResolvedValue({ commands: [] })
  mocks.listAgents.mockResolvedValue({ agents: [] })
  mocks.copyText.mockResolvedValue(true)
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
  vi.unstubAllGlobals()
  useSettingsStore.setState({ chatSendBehavior: 'enter' })
})

describe('TaskIndex', () => {
  it('renders only the safe task-list error supplied by the product store', () => {
    const rawError = 'DeepSeek provider rejected /private/.claude/settings.json token'
    renderIndex(makeIndex(), { error: '暂时无法读取任务，请稍后重试。' })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('暂时无法读取任务，请稍后重试。')
    expect(alert).not.toHaveTextContent(rawError)
  })

  it('shows a task under its project with its real work directory and planned worktree state', () => {
    renderIndex()

    const project = screen.getByTestId('product-project-project-1')
    expect(project).toHaveTextContent('BilliardBuddy')
    expect(project).toHaveTextContent('/workspace/billiard')
    expect(project).toHaveTextContent('修复开球规则')
    expect(project).toHaveTextContent('工作目录：/workspace/billiard')
    expect(project).toHaveTextContent('工作树计划中')
    expect(project).toHaveTextContent('未连接')
  })

  it('only presents actions enabled by the backend task record', () => {
    renderIndex(makeIndex(makeTask({ actions: ['archive'] })))

    expect(screen.getByRole('button', { name: '归档' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '继续' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '重命名' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '置顶' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()
  })

  it('keeps a pinned task project ahead of a newer unpinned project', () => {
    const pinnedTask = makeTask({
      id: 'task-pinned',
      projectId: 'project-pinned',
      directoryId: 'directory-pinned',
      title: '置顶任务',
      workDir: '/workspace/pinned',
      updatedAt: '2026-07-18T00:00:00.000Z',
      pinnedAt: '2026-07-18T00:01:00.000Z',
    })
    const newerTask = makeTask({
      id: 'task-newer',
      projectId: 'project-newer',
      directoryId: 'directory-newer',
      title: '较新任务',
      workDir: '/workspace/newer',
      updatedAt: '2026-07-19T00:00:00.000Z',
    })
    renderIndex({
      schemaVersion: 2,
      projects: [
        {
          id: 'project-newer',
          title: '较新项目',
          rootDir: '/workspace/newer',
          createdAt: '2026-07-19T00:00:00.000Z',
          taskCount: 1,
          archivedTaskCount: 0,
          updatedAt: newerTask.updatedAt,
        },
        {
          id: 'project-pinned',
          title: '置顶项目',
          rootDir: '/workspace/pinned',
          createdAt: '2026-07-18T00:00:00.000Z',
          taskCount: 1,
          archivedTaskCount: 0,
          updatedAt: pinnedTask.updatedAt,
        },
      ],
      directories: [
        {
          id: 'directory-newer',
          projectId: 'project-newer',
          path: '/workspace/newer',
          label: '较新项目',
          createdAt: '2026-07-19T00:00:00.000Z',
          updatedAt: newerTask.updatedAt,
        },
        {
          id: 'directory-pinned',
          projectId: 'project-pinned',
          path: '/workspace/pinned',
          label: '置顶项目',
          createdAt: '2026-07-18T00:00:00.000Z',
          updatedAt: pinnedTask.updatedAt,
        },
      ],
      tasks: [newerTask, pinnedTask],
      total: 2,
      capabilities: { createTask: true },
    })

    const groups = screen.getAllByTestId(/product-project-/)
    expect(groups[0]).toHaveTextContent('置顶项目')
    expect(groups[0]).toHaveTextContent('置顶任务')
    expect(groups[1]).toHaveTextContent('较新项目')
  })

  it('copies a bounded product task link alongside the real ID and Markdown details', async () => {
    renderIndex(makeIndex(makeTask({
      kind: 'continuation',
      worktreeState: 'materialized',
      parentTaskId: 'task-parent',
    })))

    fireEvent.click(screen.getByRole('button', { name: '复制链接' }))
    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith('billiardbuddy://task/task-1'))
    expect(screen.getByRole('button', { name: '已复制链接' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '复制 ID' }))
    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith('task-1'))
    expect(screen.getByRole('button', { name: '已复制 ID' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '复制 Markdown' }))
    const markdown = [
      '# 任务：修复开球规则',
      '',
      '- 任务 ID：`task-1`',
      '- 任务生命周期：进行中',
      '- 运行状态：未连接',
      '- 工作目录：`/workspace/billiard`',
      '- 工作树：独立工作树已启用',
      '- 类型：继续任务',
    ].join('\n')
    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith(markdown))
    expect(markdown).not.toMatch(/https?:\/\//)
    expect(markdown).not.toContain('turn-42')
    expect(screen.getByRole('button', { name: '已复制 Markdown' })).toBeInTheDocument()
  })

  it('keeps the Agent run state separate from the task lifecycle and worktree', () => {
    renderIndex(makeIndex(makeTask({ worktreeState: 'planned' })), {
      runtimeStatesBySessionId: { 'task-1': 'awaiting_approval' },
    })

    const task = screen.getByTestId('product-task-task-1')
    expect(task).toHaveTextContent('等待确认')
    expect(task).toHaveTextContent('工作树计划中')
    expect(screen.getByLabelText('运行状态：等待确认')).toBeInTheDocument()
  })

  it('keeps archive unavailable while a task is running or waiting for approval', () => {
    const { rerender } = render(
      <TaskIndex
        {...{
          index: makeIndex(makeTask({ actions: ['archive'] })),
          isLoading: false,
          error: null,
          mutations: {},
          onRefresh: vi.fn(async () => undefined),
          onRenameTask: vi.fn(async () => undefined),
          onPinTask: vi.fn(async () => undefined),
          onUnpinTask: vi.fn(async () => undefined),
          onArchiveTask: vi.fn(async () => undefined),
          onRestoreTask: vi.fn(async () => undefined),
          onContinueTask: vi.fn(async () => undefined),
          onRequestNewTask: vi.fn(),
          onOpenTask: vi.fn(),
          runtimeStatesBySessionId: { 'task-1': 'running' },
        } satisfies TaskIndexProps}
      />,
    )

    expect(screen.queryByRole('button', { name: '归档' })).toBeNull()

    rerender(
      <TaskIndex
        {...{
          index: makeIndex(makeTask({ actions: ['archive'] })),
          isLoading: false,
          error: null,
          mutations: {},
          onRefresh: vi.fn(async () => undefined),
          onRenameTask: vi.fn(async () => undefined),
          onPinTask: vi.fn(async () => undefined),
          onUnpinTask: vi.fn(async () => undefined),
          onArchiveTask: vi.fn(async () => undefined),
          onRestoreTask: vi.fn(async () => undefined),
          onContinueTask: vi.fn(async () => undefined),
          onRequestNewTask: vi.fn(),
          onOpenTask: vi.fn(),
          runtimeStatesBySessionId: { 'task-1': 'awaiting_approval' },
        } satisfies TaskIndexProps}
      />,
    )

    expect(screen.queryByRole('button', { name: '归档' })).toBeNull()
  })

  it('does not let an archived task lifecycle hide a live Agent run state', () => {
    renderIndex(makeIndex(makeTask({ lifecycle: 'archived', actions: ['restore'] })), {
      runtimeStatesBySessionId: { 'task-1': 'running' },
    })

    fireEvent.click(screen.getByRole('checkbox', { name: '显示已归档任务' }))

    const task = screen.getByTestId('product-task-task-1')
    expect(task).toHaveTextContent('已归档')
    expect(task).toHaveTextContent('运行中')
  })

  it('keeps archived-only indexes empty until the user chooses to reveal their restore action', () => {
    renderIndex(makeIndex(makeTask({ lifecycle: 'archived', actions: ['restore'] })))

    expect(screen.getByText('还没有可显示的任务。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '恢复' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('checkbox', { name: '显示已归档任务' }))
    expect(screen.getByRole('button', { name: '恢复' })).toBeInTheDocument()
  })

  it('routes creation to the dedicated page, then opens and continues the selected task', async () => {
    const props = renderIndex()

    fireEvent.click(screen.getByRole('button', { name: '新建任务' }))
    expect(props.onRequestNewTask).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: '打开' }))
    expect(props.onOpenTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'task-1',
    }))

    fireEvent.click(screen.getByRole('button', { name: '继续' }))
    await waitFor(() => expect(props.onContinueTask).toHaveBeenCalledWith('task-1', {
      target: 'current_workspace',
    }))

    fireEvent.click(screen.getByRole('button', { name: '新工作树继续' }))
    await waitFor(() => expect(props.onContinueTask).toHaveBeenCalledWith('task-1', {
      target: 'new_worktree',
    }))
  })

  it('keeps the single open action product-owned even when a legacy working directory is absent', () => {
    renderIndex(makeIndex(makeTask({ workDir: '' })))

    expect(screen.getByRole('button', { name: '打开' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开工作台' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '打开终端' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '新窗口打开' })).not.toBeInTheDocument()
  })

  it('opens a task in a real desktop task window only when the host advertises that capability', async () => {
    mocks.canOpenTaskWindow = true
    mocks.openProductTaskWindow.mockResolvedValue(undefined)
    renderIndex()

    fireEvent.click(screen.getByRole('button', { name: '新窗口打开' }))

    await waitFor(() => expect(mocks.openProductTaskWindow).toHaveBeenCalledWith('task-1'))
  })

  it('shows a safe error if opening the independent task window fails', async () => {
    mocks.canOpenTaskWindow = true
    mocks.openProductTaskWindow.mockRejectedValue(new Error('internal renderer path'))
    renderIndex()

    fireEvent.click(screen.getByRole('button', { name: '新窗口打开' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('暂时无法打开独立任务窗口，请稍后重试。')
    expect(screen.getByRole('alert')).not.toHaveTextContent('internal renderer path')
  })

  it('does not show the native folder chooser outside the desktop app', () => {
    renderComposer()

    expect(screen.queryByRole('button', { name: '选择文件夹' })).not.toBeInTheDocument()
  })

  it('writes the desktop native folder selection back to the work directory', async () => {
    mocks.isDesktop = true
    mocks.openDirectory.mockResolvedValue('/workspace/selected-project')
    renderComposer()

    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))

    await waitFor(() => expect(mocks.openDirectory).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      title: '选择任务工作目录',
    }))
    await waitFor(() => expect(screen.getByLabelText('工作目录')).toHaveValue('/workspace/selected-project'))
  })

  it('keeps form input and offers a retry when native folder selection fails', async () => {
    mocks.isDesktop = true
    mocks.openDirectory
      .mockRejectedValueOnce(new Error('private host dialog failure'))
      .mockResolvedValueOnce('/workspace/retried-project')
    renderComposer()

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/keep-manual-input' } })
    fireEvent.change(screen.getByLabelText('任务标题（可选）'), { target: { value: '保留的任务标题' } })
    fireEvent.change(screen.getByLabelText('初始目标（可选）'), { target: { value: '保留的初始目标' } })
    fireEvent.click(screen.getByRole('button', { name: '选择文件夹' }))

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('无法打开文件夹选择器，请重试或手动填写工作目录。')
    expect(alert).not.toHaveTextContent('private host dialog failure')
    expect(screen.getByLabelText('工作目录')).toHaveValue('/workspace/keep-manual-input')
    expect(screen.getByLabelText('任务标题（可选）')).toHaveValue('保留的任务标题')
    expect(screen.getByLabelText('初始目标（可选）')).toHaveValue('保留的初始目标')

    fireEvent.click(screen.getByRole('button', { name: '重试选择' }))

    await waitFor(() => expect(mocks.openDirectory).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByLabelText('工作目录')).toHaveValue('/workspace/retried-project'))
    expect(screen.getByLabelText('任务标题（可选）')).toHaveValue('保留的任务标题')
    expect(screen.getByLabelText('初始目标（可选）')).toHaveValue('保留的初始目标')
  })

  it('uses the requested work directory in the dedicated new-task composer', async () => {
    renderComposer({ initialWorkDir: '/workspace/billiard' })

    expect(screen.getByLabelText('工作目录')).toHaveValue('/workspace/billiard')
  })

  it('submits stable project and directory identities for registered paths, then drops them for a manual path', async () => {
    const { onSubmit } = renderComposer()

    fireEvent.change(screen.getByLabelText('选择项目'), { target: { value: 'project-1' } })
    fireEvent.change(screen.getByLabelText('选择项目目录'), { target: { value: 'directory-1' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      workDir: '/workspace/billiard',
      projectId: 'project-1',
      directoryId: 'directory-1',
      permissionMode: 'ask',
    }))

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/manual-path' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(onSubmit).toHaveBeenLastCalledWith({
      workDir: '/workspace/manual-path',
      permissionMode: 'ask',
    }))
  })

  it('keeps the optional initial goal out of the product task fields', async () => {
    const { onSubmit } = renderComposer()

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(screen.getByLabelText('任务标题（可选）'), { target: { value: '整理球台配置' } })
    fireEvent.change(screen.getByLabelText('初始目标（可选）'), { target: { value: '  请列出本周的训练安排  ' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
      title: '整理球台配置',
      permissionMode: 'ask',
    }, {
      text: '请列出本周的训练安排',
      attachments: [],
    }))
  })

  it('uses the configured Enter shortcut for the initial task goal', async () => {
    const { onSubmit } = renderComposer()
    const initialGoal = screen.getByLabelText('初始目标（可选）')

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(initialGoal, { target: { value: '整理球台配置' } })

    fireEvent.keyDown(initialGoal, { key: 'Enter', shiftKey: true })
    fireEvent.keyDown(initialGoal, { key: 'Enter', ctrlKey: true })
    fireEvent.keyDown(initialGoal, { key: 'Enter', metaKey: true })
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(initialGoal, { key: 'Enter' })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
      permissionMode: 'ask',
    }, {
      text: '整理球台配置',
      attachments: [],
    }))
  })

  it('uses Ctrl or Command Enter for the initial goal when that preference is selected', async () => {
    useSettingsStore.setState({ chatSendBehavior: 'modifierEnter' })
    const { onSubmit } = renderComposer()
    const initialGoal = screen.getByLabelText('初始目标（可选）')

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(initialGoal, { target: { value: '整理球台配置' } })

    fireEvent.keyDown(initialGoal, { key: 'Enter' })
    fireEvent.keyDown(initialGoal, { key: 'Enter', shiftKey: true })
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.keyDown(initialGoal, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))

    fireEvent.keyDown(initialGoal, { key: 'Enter', metaKey: true })
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2))
  })

  it('does not submit the initial goal while an IME composition is active', async () => {
    const { onSubmit } = renderComposer()
    const initialGoal = screen.getByLabelText('初始目标（可选）')

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(initialGoal, { target: { value: '整理球台配置' } })
    fireEvent.compositionStart(initialGoal)
    fireEvent.keyDown(initialGoal, { key: 'Enter' })
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.compositionEnd(initialGoal)
    fireEvent.keyDown(initialGoal, { key: 'Enter' })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1))
  })

  it('uses the existing browser picker for initial image attachments, lets the user remove them, and keeps refs out of the task payload', async () => {
    const { onSubmit } = renderComposer()
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, 'click')

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.click(screen.getByRole('button', { name: '添加初始附件' }))

    await waitFor(() => expect(pickerClick).toHaveBeenCalled())
    const fileInput = document.querySelector('input[type="file"]')
    expect(fileInput).not.toBeNull()

    const image = new File(['table-layout'], '球台布局.png', { type: 'image/png' })
    fireEvent.change(fileInput!, { target: { files: [image] } })

    expect(await screen.findByRole('button', { name: 'Remove 球台布局.png' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Remove 球台布局.png' }))
    expect(screen.queryByRole('button', { name: 'Remove 球台布局.png' })).not.toBeInTheDocument()

    fireEvent.change(fileInput!, { target: { files: [image] } })
    expect(await screen.findByRole('button', { name: 'Remove 球台布局.png' })).toBeInTheDocument()

    fireEvent.keyDown(screen.getByLabelText('初始目标（可选）'), { key: 'Enter' })

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
      permissionMode: 'ask',
    }, {
      text: '',
      attachments: [expect.objectContaining({
        type: 'image',
        name: '球台布局.png',
        mimeType: 'image/png',
        data: expect.stringMatching(/^data:image\/png;base64,/),
      })],
    }))
  })

  it('uses inline browser file data for initial attachments even in the desktop renderer', async () => {
    mocks.isDesktop = true
    const { onSubmit } = renderComposer()

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.click(screen.getByRole('button', { name: '添加初始附件' }))

    expect(mocks.openDirectory).not.toHaveBeenCalled()
    const fileInput = document.querySelector('input[type="file"]')
    const record = new File(['date,score\n2026-07-19,8'], '训练记录.csv', { type: 'text/csv' })
    fireEvent.change(fileInput!, { target: { files: [record] } })
    expect(await screen.findByRole('button', { name: 'Remove 训练记录.csv' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
      permissionMode: 'ask',
    }, {
      text: '',
      attachments: [expect.objectContaining({
        type: 'file',
        name: '训练记录.csv',
        mimeType: 'text/csv',
        data: expect.stringMatching(/^data:text\/csv;base64,/),
      })],
    }))
  })

  it('keeps task input and retries the same attachment after its browser read fails', async () => {
    class RetriableFileReader {
      static reads = 0
      result: string | null = null
      error: DOMException | null = null
      onload: ((event: Event) => void) | null = null
      onerror: ((event: Event) => void) | null = null

      readAsDataURL() {
        RetriableFileReader.reads += 1
        if (RetriableFileReader.reads === 1) {
          this.error = new DOMException('attachment storage denied')
          this.onerror?.(new Event('error'))
          return
        }

        this.result = 'data:text/plain;base64,dHJhaW5pbmc='
        this.onload?.(new Event('load'))
      }
    }

    vi.stubGlobal('FileReader', RetriableFileReader)
    renderComposer()

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/keep-attachment-input' } })
    fireEvent.change(screen.getByLabelText('任务标题（可选）'), { target: { value: '保留附件任务' } })
    fireEvent.change(screen.getByLabelText('初始目标（可选）'), { target: { value: '读取失败后继续保留' } })
    const fileInput = document.querySelector('input[type="file"]')
    const record = new File(['training'], '训练记录.txt', { type: 'text/plain' })
    fireEvent.change(fileInput!, { target: { files: [record] } })

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('无法读取所选附件，请重试或重新选择文件。')
    expect(alert).not.toHaveTextContent('attachment storage denied')
    expect(screen.getByLabelText('工作目录')).toHaveValue('/workspace/keep-attachment-input')
    expect(screen.getByLabelText('任务标题（可选）')).toHaveValue('保留附件任务')
    expect(screen.getByLabelText('初始目标（可选）')).toHaveValue('读取失败后继续保留')
    expect(screen.queryByRole('button', { name: 'Remove 训练记录.txt' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '重试读取' }))

    expect(await screen.findByRole('button', { name: 'Remove 训练记录.txt' })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows a bundled Skill in Chinese and submits only its runtime command', async () => {
    mocks.listSkillCommands.mockResolvedValue({
      commands: [makeSkill()],
    })
    const { onSubmit } = renderComposer()

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(screen.getByLabelText('初始目标（可选）'), { target: { value: '/复盘' } })

    await waitFor(() => expect(mocks.listSkillCommands).toHaveBeenCalledWith('/workspace/new-table'))
    const command = await screen.findByRole('button', { name: /\/复盘今天经营/ })
    expect(command).toHaveTextContent('把球房营业数据和当天情况整理成经营复盘。')
    expect(command).not.toHaveTextContent('venue-daily-review')
    fireEvent.click(command)

    expect(screen.getByLabelText('初始目标（可选）')).toHaveValue('/复盘今天经营 ')
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
      permissionMode: 'ask',
    }, {
      text: '/venue-daily-review',
      attachments: [],
    }))
  })

  it('keeps an external Skill selectable without exposing its private description', async () => {
    mocks.listSkillCommands.mockResolvedValue({
      commands: [{
        runtimeName: 'custom-report',
        displayName: 'custom-report',
        description: '当前环境提供的扩展命令。',
      }],
    })
    const { onSubmit } = renderComposer()

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(screen.getByLabelText('初始目标（可选）'), { target: { value: '/custom' } })

    const command = await screen.findByRole('button', { name: /\/custom-report/ })
    expect(command).toHaveTextContent('当前环境提供的扩展命令。')
    fireEvent.click(command)
    expect(screen.getByLabelText('初始目标（可选）')).toHaveValue('/custom-report ')

    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
      permissionMode: 'ask',
    }, {
      text: '/custom-report',
      attachments: [],
    }))
  })

  it('offers discovered agents in the initial task composer and sends their runtime command', async () => {
    mocks.listAgents.mockResolvedValue({
      agents: [{
        displayName: 'assistant-1',
        runtimeName: 'venue-analyst',
        description: '分析球房运营数据。',
        source: 'projectSettings',
      }],
    })
    const { onSubmit } = renderComposer()

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(screen.getByLabelText('初始目标（可选）'), { target: { value: '/agent' } })

    await waitFor(() => expect(mocks.listAgents).toHaveBeenCalledWith('/workspace/new-table'))
    fireEvent.click(await screen.findByRole('button', { name: /\/agent assistant-1/ }))

    expect(screen.getByLabelText('初始目标（可选）')).toHaveValue('/agent assistant-1 ')
    expect(screen.queryByText('分析球房运营数据。')).not.toBeInTheDocument()
    expect(screen.queryByText('projectSettings')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
      permissionMode: 'ask',
    }, {
      text: '/agent venue-analyst',
      attachments: [],
    }))
  })

  it('keeps Agent discovery usable when Skill command discovery is unavailable', async () => {
    mocks.listSkillCommands.mockRejectedValue(new Error('Skill discovery unavailable'))
    mocks.listAgents.mockResolvedValue({
      agents: [{
        displayName: 'assistant-1',
        runtimeName: 'venue-analyst',
      }],
    })
    renderComposer()

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(screen.getByLabelText('初始目标（可选）'), { target: { value: '/agent' } })

    expect(await screen.findByRole('button', { name: /\/agent assistant-1/ })).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('does not show a command choice while Skill command discovery is loading or unavailable', async () => {
    let rejectSkillCommands: (error: Error) => void = () => undefined
    mocks.listSkillCommands.mockImplementation(() => new Promise((_, reject) => {
      rejectSkillCommands = reject
    }))
    renderComposer()

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(screen.getByLabelText('初始目标（可选）'), { target: { value: '/' } })

    expect(await screen.findByRole('status')).toHaveTextContent('正在读取可用命令')
    expect(screen.queryByRole('button', { name: /\/复盘今天经营/ })).not.toBeInTheDocument()

    rejectSkillCommands(new Error('服务不可用'))

    expect(await screen.findByRole('alert')).toHaveTextContent('无法读取可用命令：暂时无法读取可用命令')
    expect(screen.queryByRole('button', { name: /\/复盘今天经营/ })).not.toBeInTheDocument()
  })

  it('starts with a safe product permission choice and forwards an explicit selection', async () => {
    const { onSubmit } = renderComposer()
    const permissionSelect = screen.getByLabelText('执行权限') as HTMLSelectElement

    expect(permissionSelect).toHaveValue('ask')
    expect(Array.from(permissionSelect.options).map((option) => option.value)).toEqual([
      'ask',
      'allow_edits',
      'plan_only',
    ])
    expect(screen.queryByRole('option', { name: /跳过权限/i })).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('工作目录'), { target: { value: '/workspace/new-table' } })
    fireEvent.change(permissionSelect, { target: { value: 'allow_edits' } })
    fireEvent.click(screen.getByRole('button', { name: '创建任务' }))

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith({
      workDir: '/workspace/new-table',
      permissionMode: 'allow_edits',
    }))
  })
})
