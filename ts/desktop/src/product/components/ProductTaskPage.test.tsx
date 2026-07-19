import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  index: {
    projects: [],
    tasks: [{
      id: 'task-1',
      projectId: 'project-1',
      workDir: '/workspace/billiard',
      title: '整理开球训练',
      lifecycle: 'active',
      kind: 'main',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
      worktreeState: 'not_requested',
      actions: ['pin', 'archive'],
    }],
    total: 1,
    capabilities: { createTask: true },
  } as Record<string, unknown>,
  isLoading: false,
  error: null as string | null,
  runtime: {
    connectionState: 'connected',
    historyStatus: 'ready',
    runState: 'idle',
    entries: [],
    activeActivity: null,
    pendingApproval: null,
    error: null,
    streamingEntryId: null,
  } as Record<string, unknown>,
  refresh: vi.fn(),
  archiveTask: vi.fn(),
  restoreTask: vi.fn(),
  pinTask: vi.fn(),
  unpinTask: vi.fn(),
  continueTask: vi.fn(),
  connectTask: vi.fn(),
  disconnectTask: vi.fn(),
  sendText: vi.fn(),
  sendMessage: vi.fn(),
  stopTask: vi.fn(),
  respondToApproval: vi.fn(),
  respondToQuestions: vi.fn(),
  respondToComputerUseApproval: vi.fn(),
  refreshThread: vi.fn(),
  openTab: vi.fn(),
  openProductTaskTab: vi.fn(),
  createSideTask: vi.fn(),
  openSideTaskPanel: vi.fn(),
  listSkills: vi.fn(),
  listAgents: vi.fn(),
}))

vi.mock('../stores/productTaskStore', () => ({
  useProductTaskStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    index: mocks.index,
    isLoading: mocks.isLoading,
    error: mocks.error,
    refresh: mocks.refresh,
    archiveTask: mocks.archiveTask,
    restoreTask: mocks.restoreTask,
    pinTask: mocks.pinTask,
    unpinTask: mocks.unpinTask,
    continueTask: mocks.continueTask,
    mutations: {},
  }),
}))

vi.mock('../stores/productTaskRuntimeStore', () => ({
  PRODUCT_TASK_SAFE_ERROR_LABEL: {
    temporarily_unavailable: '服务暂时不可用，请稍后重试。',
  },
  canSendProductTaskMessage: (value: string, attachments: unknown[] = []) => (
    value.trim().length > 0 || attachments.length > 0
  ) && value.trim().length <= 32_000,
  useProductTaskRuntimeStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    tasks: { 'task-1': mocks.runtime },
    connectTask: mocks.connectTask,
    disconnectTask: mocks.disconnectTask,
    sendText: mocks.sendText,
    sendMessage: mocks.sendMessage,
    stopTask: mocks.stopTask,
    respondToApproval: mocks.respondToApproval,
    respondToQuestions: mocks.respondToQuestions,
    respondToComputerUseApproval: mocks.respondToComputerUseApproval,
    refreshThread: mocks.refreshThread,
  }),
}))

vi.mock('../../stores/settingsStore', () => ({
  useSettingsStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    chatSendBehavior: 'enter',
  }),
}))

vi.mock('../../stores/tabStore', () => ({
  PRODUCT_TASKS_TAB_ID: '__product_tasks__',
  useTabStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    openTab: mocks.openTab,
    openProductTaskTab: mocks.openProductTaskTab,
  }),
}))

vi.mock('../api/taskCommands', () => ({
  productTaskCommandsApi: {
    listSkills: mocks.listSkills,
    listAgents: mocks.listAgents,
  },
}))

vi.mock('../stores/productSideTaskStore', () => ({
  productSideTaskMutationKey: (taskId: string, sideTaskId: string, action: string) => (
    `${taskId}:${sideTaskId}:${action}`
  ),
  useProductSideTaskStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    createSideTask: mocks.createSideTask,
    openSideTaskPanel: mocks.openSideTaskPanel,
    mutations: {},
  }),
}))

vi.mock('./ProductTaskTerminalDock', () => ({
  ProductTaskTerminalDock: ({ workDir, onClose }: { workDir: string; onClose?: () => void }) => (
    <div data-testid="product-task-terminal-runtime">
      {workDir}
      {onClose ? <button type="button" onClick={onClose}>关闭</button> : null}
    </div>
  ),
}))

vi.mock('../../components/markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}))

vi.mock('./ProductTaskReviewDock', () => ({
  ProductTaskReviewDock: ({ taskId, onClose }: { taskId: string; onClose: () => void }) => (
    <div data-testid="product-task-review-dock">review:{taskId}<button type="button" onClick={onClose}>关闭审阅</button></div>
  ),
}))

vi.mock('./ProductTaskMediaDock', () => ({
  ProductTaskMediaDock: ({ taskId, onClose }: { taskId: string; onClose: () => void }) => (
    <div data-testid="product-task-media-dock">media:{taskId}<button type="button" onClick={onClose}>关闭媒体</button></div>
  ),
}))

vi.mock('./ProductTaskBrowserPreviewDock', () => ({
  ProductTaskBrowserPreviewDock: ({
    activeMode,
    onClose,
    onCapture,
  }: {
    activeMode: 'browser' | 'preview' | null
    onClose: (mode: 'browser' | 'preview') => void
    onCapture: (capture: { mode: 'browser' | 'preview'; dataUrl: string }) => void
  }) => {
    const mode = activeMode ?? 'browser'
    const label = mode === 'browser' ? '浏览器' : '预览'
    return (
      <div data-testid="product-task-browser-preview-dock">
        <button type="button" aria-label={`关闭${label}`} onClick={() => onClose(mode)}>关闭</button>
        <button
          type="button"
          onClick={() => onCapture({ mode, dataUrl: 'data:image/png;base64,TkFUSVZF' })}
        >
          模拟原生截图
        </button>
      </div>
    )
  },
}))

vi.mock('./SideTaskPanel', () => ({
  SideTaskPanel: () => <div data-testid="side-task-panel-slot" />,
}))

vi.mock('./VoiceInputControl', () => ({
  VoiceInputControl: ({ onTranscript, disabled }: { onTranscript: (text: string) => void; disabled?: boolean }) => (
    <button type="button" disabled={disabled} onClick={() => onTranscript('语音补充的任务说明')}>模拟语音转写</button>
  ),
}))

import { ProductTaskPage } from './ProductTaskPage'
import { useProductTaskBrowserPreviewStore } from '../stores/productTaskBrowserPreviewStore'

beforeEach(() => {
  mocks.index = {
    projects: [],
    tasks: [{
      id: 'task-1',
      projectId: 'project-1',
      workDir: '/workspace/billiard',
      title: '整理开球训练',
      lifecycle: 'active',
      kind: 'main',
      createdAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
      worktreeState: 'not_requested',
      actions: ['pin', 'archive'],
    }],
    total: 1,
    capabilities: { createTask: true },
  }
  mocks.isLoading = false
  mocks.error = null
  mocks.runtime = {
    connectionState: 'connected',
    historyStatus: 'ready',
    runState: 'idle',
    entries: [],
    activeActivity: null,
    pendingApproval: null,
    approvalResponsePending: false,
    error: null,
    streamingEntryId: null,
  }
  mocks.refresh.mockReset().mockResolvedValue(undefined)
  mocks.archiveTask.mockReset().mockResolvedValue(undefined)
  mocks.restoreTask.mockReset().mockResolvedValue(undefined)
  mocks.pinTask.mockReset().mockResolvedValue(undefined)
  mocks.unpinTask.mockReset().mockResolvedValue(undefined)
  mocks.continueTask.mockReset().mockResolvedValue({
    id: 'task-continuation-1',
    projectId: 'project-1',
    workDir: '/workspace/billiard',
    title: '继续整理开球训练',
    lifecycle: 'active',
    kind: 'continuation',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    worktreeState: 'not_requested',
    actions: ['archive', 'continue'],
  })
  mocks.connectTask.mockReset().mockResolvedValue(undefined)
  mocks.disconnectTask.mockReset()
  mocks.sendText.mockReset().mockReturnValue(true)
  mocks.sendMessage.mockReset().mockReturnValue(true)
  mocks.stopTask.mockReset()
  mocks.respondToApproval.mockReset().mockReturnValue(true)
  mocks.respondToQuestions.mockReset().mockReturnValue(true)
  mocks.respondToComputerUseApproval.mockReset().mockReturnValue(true)
  mocks.refreshThread.mockReset().mockResolvedValue(undefined)
  mocks.openTab.mockReset()
  mocks.openProductTaskTab.mockReset()
  mocks.listSkills.mockReset().mockResolvedValue({ commands: [] })
  mocks.listAgents.mockReset().mockResolvedValue({ agents: [] })
  useProductTaskBrowserPreviewStore.setState({ byTaskId: {} })
  mocks.createSideTask.mockReset().mockResolvedValue({
    id: 'side-1',
    parentTaskId: 'task-1',
    taskId: 'task-side-1',
    title: '单独核对训练',
    status: 'open',
    createdAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
  })
  mocks.openSideTaskPanel.mockReset()
})

afterEach(() => {
  cleanup()
  useProductTaskBrowserPreviewStore.setState({ byTaskId: {} })
  vi.clearAllMocks()
})

describe('ProductTaskPage', () => {
  it('opens a task-scoped read-only media dock without replacing the task thread', () => {
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '媒体' }))

    expect(screen.getByTestId('product-task-dock-panel-media').getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('product-task-media-dock').textContent).toContain('media:task-1')
    expect(screen.getByRole('button', { name: '媒体' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('connects only through the product task runtime and renders safe thread content', () => {
    mocks.runtime = {
      ...mocks.runtime,
      entries: [
        {
          id: 'user-1',
          type: 'user_text',
          text: '整理本周训练',
          attachments: [{ type: 'file', name: '训练记录.csv' }],
          createdAt: '2026-07-19T00:00:00.000Z',
        },
        { id: 'assistant-1', type: 'assistant_text', text: '我会先梳理安排。', createdAt: '2026-07-19T00:00:01.000Z' },
        { id: 'activity-1', type: 'activity', kind: 'workspace', phase: 'completed', createdAt: '2026-07-19T00:00:02.000Z' },
      ],
    }

    const view = render(<ProductTaskPage taskId="task-1" />)

    expect(mocks.connectTask).toHaveBeenCalledWith('task-1')
    expect(screen.getByText('整理本周训练')).toBeTruthy()
    expect(screen.getByLabelText('已附加文件').textContent).toContain('训练记录.csv')
    expect(screen.getByText('我会先梳理安排。')).toBeTruthy()
    expect(screen.getByTestId('product-task-activity-workspace-completed').textContent).toContain('文件处理完成')

    view.unmount()
    expect(mocks.disconnectTask).toHaveBeenCalledWith('task-1')
  })

  it('sends a validated task message and clears the composer only after the real queue accepts it', () => {
    render(<ProductTaskPage taskId="task-1" />)
    const input = screen.getByLabelText('任务输入') as HTMLTextAreaElement

    fireEvent.change(input, { target: { value: '  /skill ball-hall-daily-review 整理今天订单  ' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(mocks.sendText).toHaveBeenCalledWith('task-1', '  /skill ball-hall-daily-review 整理今天订单  ')
    expect(input.value).toBe('')
  })

  it('shows bundled Skills in Chinese and sends their runtime command only after selection', async () => {
    mocks.listSkills.mockResolvedValue({
      commands: [{
        runtimeName: 'venue-daily-review',
        displayName: '复盘今天经营',
        description: '整理营业、客户和待跟进事项。',
      }],
    })
    mocks.listAgents.mockResolvedValue({ agents: [] })
    render(<ProductTaskPage taskId="task-1" />)
    const input = screen.getByLabelText('任务输入') as HTMLTextAreaElement

    fireEvent.change(input, { target: { value: '/' } })

    const command = await screen.findByRole('button', { name: /复盘今天经营/ })
    expect(mocks.listSkills).toHaveBeenCalledWith('/workspace/billiard')
    expect(mocks.listAgents).toHaveBeenCalledWith('/workspace/billiard')
    expect(command.textContent).toContain('/复盘今天经营')
    expect(command.textContent).toContain('整理营业、客户和待跟进事项。')
    expect(screen.queryByText('venue-daily-review')).toBeNull()

    fireEvent.click(command)
    expect(input.value).toBe('/复盘今天经营 ')

    fireEvent.change(input, { target: { value: '/复盘今天经营 整理今天订单' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(mocks.sendText).toHaveBeenCalledWith('task-1', '/venue-daily-review 整理今天订单')
  })

  it('appends a voice transcript to the product composer without sending it', () => {
    render(<ProductTaskPage taskId="task-1" />)
    const input = screen.getByLabelText('任务输入') as HTMLTextAreaElement

    fireEvent.change(input, { target: { value: '先确认球台情况' } })
    fireEvent.click(screen.getByRole('button', { name: '模拟语音转写' }))

    expect(input.value).toBe('先确认球台情况\n语音补充的任务说明')
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('does not clear an invalid task composer and reports the validation state', () => {
    render(<ProductTaskPage taskId="task-1" />)
    const input = screen.getByLabelText('任务输入') as HTMLTextAreaElement

    fireEvent.change(input, { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(input.value).toBe('   ')
    expect(screen.getByRole('alert').textContent).toContain('请输入任务内容，或添加不超过 4 个附件。')
  })

  it('reads a selected attachment into the narrow product message contract', async () => {
    render(<ProductTaskPage taskId="task-1" />)
    const file = new File(['a'], '球台.png', { type: 'image/png' })
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement

    fireEvent.change(picker, { target: { files: [file] } })

    await screen.findByText('球台.png')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(mocks.sendMessage).toHaveBeenCalledWith('task-1', '', [{
      type: 'image',
      name: '球台.png',
      mimeType: 'image/png',
      data: expect.stringMatching(/^data:image\/png;base64,/),
    }])
  })

  it('keeps a native Browser capture as a pending narrow attachment until the user sends it', () => {
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '浏览器' }))
    fireEvent.click(screen.getByRole('button', { name: '模拟原生截图' }))

    expect(screen.getByText('浏览器截图.png')).toBeTruthy()
    expect(mocks.sendText).not.toHaveBeenCalled()
    expect(mocks.sendMessage).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(mocks.sendMessage).toHaveBeenCalledWith('task-1', '', [{
      type: 'image',
      name: '浏览器截图.png',
      mimeType: 'image/png',
      data: 'data:image/png;base64,TkFUSVZF',
    }])
  })

  it('submits only a narrow allow or deny response for an action approval', () => {
    mocks.runtime = {
      ...mocks.runtime,
      runState: 'awaiting_approval',
      pendingApproval: { requestId: 'permission-1', kind: 'action' },
      approvalResponsePending: false,
    }
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '允许本次操作' }))

    expect(mocks.respondToApproval).toHaveBeenCalledWith('task-1', true)
  })

  it('renders the safe Computer Use details and sends only a one-shot decision', () => {
    mocks.runtime = {
      ...mocks.runtime,
      runState: 'awaiting_approval',
      pendingApproval: {
        requestId: 'computer-use-1',
        kind: 'computer_use',
        computerUse: {
          apps: [{ name: '台球厅管理', tier: 'click', alreadyAuthorized: false }],
          capabilities: ['clipboard_read', 'system_key_combos'],
          systemPermissions: {
            accessibilityRequired: true,
            screenRecordingRequired: false,
          },
        },
      },
      approvalResponsePending: false,
    }
    render(<ProductTaskPage taskId="task-1" />)

    const approval = screen.getByTestId('product-task-computer-use-approval')
    expect(approval.textContent).toContain('台球厅管理')
    expect(approval.textContent).toContain('点击操作')
    expect(approval.textContent).toContain('读取剪贴板')
    expect(approval.textContent).toContain('系统快捷键')
    expect(approval.textContent).toContain('辅助功能')
    expect(approval.textContent).toContain('允许本次不能绕过系统权限')

    fireEvent.click(screen.getByRole('button', { name: '允许本次 Computer Use' }))
    expect(mocks.respondToComputerUseApproval).toHaveBeenCalledWith('task-1', true)
  })

  it('submits projected question answers without a raw tool input envelope', () => {
    mocks.runtime = {
      ...mocks.runtime,
      runState: 'awaiting_approval',
      pendingApproval: {
        requestId: 'question-1',
        kind: 'question',
        questions: [{
          question: '本周活动采用哪个方案？',
          options: [{ label: '方案 A' }, { label: '方案 B' }],
        }],
      },
      approvalResponsePending: false,
    }
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '方案 B' }))
    fireEvent.click(screen.getByRole('button', { name: '提交回答' }))

    expect(mocks.respondToQuestions).toHaveBeenCalledWith('task-1', ['方案 B'])
  })

  it('branches and opens a side task only from opaque product thread entries', async () => {
    mocks.runtime = {
      ...mocks.runtime,
      entries: [{
        id: 'thread_0123456789abcdef0123',
        type: 'assistant_text',
        text: '可以从这里继续处理。',
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    }
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '从此处继续' }))
    await screen.findByText('可以从这里继续处理。')
    expect(mocks.continueTask).toHaveBeenCalledWith('task-1', {
      sourceEntryId: 'thread_0123456789abcdef0123',
      target: 'current_workspace',
    })
    expect(mocks.openProductTaskTab).toHaveBeenCalledWith(
      'task-continuation-1',
      '继续整理开球训练',
    )

    fireEvent.click(screen.getByRole('button', { name: '创建侧边任务' }))
    await waitFor(() => expect(mocks.createSideTask).toHaveBeenCalledWith('task-1', {
      sourceEntryId: 'thread_0123456789abcdef0123',
    }))
    expect(mocks.openSideTaskPanel).toHaveBeenCalledWith('task-1', 'side-1')
  })

  it('uses the detached task-window callbacks instead of a shared tab when supplied', async () => {
    mocks.runtime = {
      ...mocks.runtime,
      entries: [{
        id: 'thread_0123456789abcdef0123',
        type: 'assistant_text',
        text: '可以从这里继续处理。',
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    }
    const closeWindow = vi.fn()
    const openTask = vi.fn()
    render(<ProductTaskPage taskId="task-1" onReturnToTaskIndex={closeWindow} onOpenTask={openTask} />)

    fireEvent.click(screen.getByRole('button', { name: '关闭窗口' }))
    expect(closeWindow).toHaveBeenCalledOnce()

    fireEvent.click(screen.getByRole('button', { name: '从此处继续' }))
    await waitFor(() => expect(openTask).toHaveBeenCalledWith(expect.objectContaining({
      id: 'task-continuation-1',
    })))
    expect(mocks.openProductTaskTab).not.toHaveBeenCalled()
  })

  it('waits for a streaming entry to become persisted before offering task branches', () => {
    mocks.runtime = {
      ...mocks.runtime,
      streamingEntryId: 'thread_0123456789abcdef0123',
      entries: [{
        id: 'thread_0123456789abcdef0123',
        type: 'assistant_text',
        text: '正在整理训练建议…',
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    }
    render(<ProductTaskPage taskId="task-1" />)

    expect(screen.queryByRole('button', { name: '从此处继续' })).toBeNull()
    expect(screen.queryByRole('button', { name: '创建侧边任务' })).toBeNull()
  })

  it('uses task actions and closes the task-scoped terminal dock', () => {
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '置顶' }))
    fireEvent.click(screen.getByRole('button', { name: '归档' }))
    fireEvent.click(screen.getByRole('button', { name: '终端' }))

    expect(mocks.pinTask).toHaveBeenCalledWith('task-1')
    expect(mocks.archiveTask).toHaveBeenCalledWith('task-1')
    expect(screen.getByTestId('product-task-terminal-runtime').textContent).toContain('/workspace/billiard')

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByTestId('product-task-terminal-dock')).toBeNull()
  })

  it('keeps the stop control but hides archive during a live task run', () => {
    mocks.runtime = {
      ...mocks.runtime,
      runState: 'working',
    }
    render(<ProductTaskPage taskId="task-1" />)

    expect(screen.getByRole('button', { name: '停止' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: '归档' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(mocks.stopTask).toHaveBeenCalledWith('task-1')
  })

  it('hides archive while a task is waiting for approval', () => {
    mocks.runtime = {
      ...mocks.runtime,
      runState: 'awaiting_approval',
      pendingApproval: { requestId: 'approval-archive-guard', kind: 'action' },
    }
    render(<ProductTaskPage taskId="task-1" />)

    expect(screen.getByRole('button', { name: '停止' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: '归档' })).toBeNull()
  })

  it('only exposes page-header mutations declared by the current task action contract', () => {
    const [currentTask] = mocks.index.tasks as Array<Record<string, unknown>>
    mocks.index = {
      ...mocks.index,
      tasks: [{
        ...currentTask,
        lifecycle: 'archived',
        actions: ['restore', 'continue'],
      }],
    }
    render(<ProductTaskPage taskId="task-1" />)

    expect(screen.queryByRole('button', { name: '置顶' })).toBeNull()
    expect(screen.queryByRole('button', { name: '取消置顶' })).toBeNull()
    expect(screen.getByRole('button', { name: '恢复' })).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '恢复' }))

    expect(mocks.restoreTask).toHaveBeenCalledWith('task-1')
    expect(mocks.pinTask).not.toHaveBeenCalled()
    expect(mocks.unpinTask).not.toHaveBeenCalled()
  })

  it('keeps a right-side review panel open while opening a task-scoped terminal', () => {
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '审阅' }))
    expect(screen.getByTestId('product-task-dock-rail')).toBeTruthy()
    expect(screen.getByTestId('product-task-review-dock').textContent).toContain('review:task-1')

    fireEvent.click(screen.getByRole('button', { name: '终端' }))

    expect(screen.getByTestId('product-task-review-dock').textContent).toContain('review:task-1')
    const terminalDock = screen.getByTestId('product-task-terminal-dock')
    expect(terminalDock.parentElement).toBe(screen.getByTestId('product-task-page'))
    expect(screen.getByTestId('product-task-terminal-runtime').textContent).toContain('/workspace/billiard')
  })

  it('switches Browser and Preview in the right area without hiding the terminal', () => {
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '终端' }))
    fireEvent.click(screen.getByRole('button', { name: '浏览器' }))

    expect(screen.getByTestId('product-task-terminal-dock').getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('product-task-terminal-dock').classList.contains('hidden')).toBe(false)
    expect(screen.getByTestId('product-task-dock-panel-browser-preview').getAttribute('data-active')).toBe('true')
    expect(screen.getByRole('button', { name: '浏览器' }).getAttribute('aria-pressed')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '预览' }))

    expect(useProductTaskBrowserPreviewStore.getState().byTaskId['task-1']).toMatchObject({
      browserOpen: true,
      previewOpen: true,
      activeMode: 'preview',
    })
    expect(screen.getByRole('button', { name: '预览' }).getAttribute('aria-pressed')).toBe('true')
    expect(screen.getByTestId('product-task-terminal-dock').getAttribute('data-active')).toBe('true')
    expect(screen.getByTestId('product-task-terminal-dock').classList.contains('hidden')).toBe(false)
  })

  it('closes each panel axis without closing the other one', () => {
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '审阅' }))
    fireEvent.click(screen.getByRole('button', { name: '终端' }))

    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByTestId('product-task-terminal-dock')).toBeNull()
    expect(screen.getByTestId('product-task-dock-panel-review').getAttribute('data-active')).toBe('true')

    fireEvent.click(screen.getByRole('button', { name: '终端' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭审阅' }))
    expect(screen.queryByTestId('product-task-dock-panel-review')).toBeNull()
    expect(screen.getByTestId('product-task-terminal-dock')).toBeTruthy()
  })

  it('opens Browser and Preview only through the product task scoped panel store', () => {
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '浏览器' }))
    expect(useProductTaskBrowserPreviewStore.getState().byTaskId).toEqual({
      'task-1': {
        browserOpen: true,
        previewOpen: false,
        activeMode: 'browser',
      },
    })
    expect(screen.getByTestId('product-task-browser-preview-dock')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '预览' }))
    expect(useProductTaskBrowserPreviewStore.getState().byTaskId['task-1']).toEqual({
      browserOpen: true,
      previewOpen: true,
      activeMode: 'preview',
    })

    fireEvent.click(screen.getByRole('button', { name: '关闭预览' }))
    expect(useProductTaskBrowserPreviewStore.getState().byTaskId['task-1']).toEqual({
      browserOpen: true,
      previewOpen: false,
      activeMode: 'browser',
    })
  })

  it('uses a real stop action only while the task is running', () => {
    mocks.runtime = { ...mocks.runtime, runState: 'working' }
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '停止' }))

    expect(mocks.stopTask).toHaveBeenCalledWith('task-1')
  })

  it('returns to the task index when the requested task cannot be found', () => {
    mocks.index = { projects: [], tasks: [], total: 0, capabilities: { createTask: true } }
    render(<ProductTaskPage taskId="missing-task" />)

    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(mocks.connectTask).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '返回任务中心' }))
    expect(mocks.openTab).toHaveBeenCalledWith('__product_tasks__', '任务中心', 'product-tasks')
  })
})
