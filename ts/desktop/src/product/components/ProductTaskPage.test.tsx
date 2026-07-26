import '@testing-library/jest-dom'
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
      workspace_capability: { scope: { kind: 'workspace', workspace_id: 'workspace-1', generation: 1 }, workspace_revision: 1, availability: 'available', available: true },
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
    queuedInputs: [],
    activeActivity: null,
    pendingApproval: null,
    error: null,
    streamingEntryId: null,
  } as Record<string, unknown>,
  refresh: vi.fn(),
  archiveTask: vi.fn(),
  restoreTask: vi.fn(),
  mutateTaskDeletion: vi.fn(),
  recoverTaskRun: vi.fn(),
  pinTask: vi.fn(),
  unpinTask: vi.fn(),
  continueTask: vi.fn(),
  connectTask: vi.fn(),
  disconnectTask: vi.fn(),
  forgetRuntimeTask: vi.fn(),
  sendText: vi.fn(),
  sendMessage: vi.fn(),
  stopTask: vi.fn(),
  editQueuedInput: vi.fn(),
  deleteQueuedInput: vi.fn(),
  reorderQueuedInputs: vi.fn(),
  steerQueuedInput: vi.fn(),
  resumeQueue: vi.fn(),
  respondToApproval: vi.fn(),
  respondToQuestions: vi.fn(),
  refreshThread: vi.fn(),
  openTab: vi.fn(),
  openProductTaskTab: vi.fn(),
  closeTab: vi.fn(),
  createSideTask: vi.fn(),
  openSideTaskPanel: vi.fn(),
  forgetSideTasks: vi.fn(),
  listSkills: vi.fn(),
  listAgents: vi.fn(),
  previewWebview: false,
  terminal: false,
}))

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({ capabilities: { previewWebview: mocks.previewWebview, terminal: mocks.terminal } }),
}))

vi.mock('../stores/productTaskStore', () => ({
  useProductTaskStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    index: mocks.index,
    isLoading: mocks.isLoading,
    error: mocks.error,
    refresh: mocks.refresh,
    archiveTask: mocks.archiveTask,
    restoreTask: mocks.restoreTask,
    mutateTaskDeletion: mocks.mutateTaskDeletion,
    recoverTaskRun: mocks.recoverTaskRun,
    pinTask: mocks.pinTask,
    unpinTask: mocks.unpinTask,
    continueTask: mocks.continueTask,
    mutations: {},
  }),
}))

vi.mock('../stores/productTaskRuntimeStore', () => ({
  PRODUCT_TASK_SAFE_ERROR_LABEL: {
    task_network_unavailable: '当前无法连接模型服务，或响应流已中断，请检查网络后重试。',
    temporarily_unavailable: '服务暂时不可用，请稍后重试。',
  },
  canSendProductTaskMessage: (value: string, attachments: unknown[] = []) => (
    value.trim().length > 0 || attachments.length > 0
  ) && value.trim().length <= 32_000,
  useProductTaskRuntimeStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    tasks: { 'task-1': mocks.runtime },
    connectTask: mocks.connectTask,
    disconnectTask: mocks.disconnectTask,
    forgetTask: mocks.forgetRuntimeTask,
    sendText: mocks.sendText,
    sendMessage: mocks.sendMessage,
    stopTask: mocks.stopTask,
    editQueuedInput: mocks.editQueuedInput,
    deleteQueuedInput: mocks.deleteQueuedInput,
    reorderQueuedInputs: mocks.reorderQueuedInputs,
    steerQueuedInput: mocks.steerQueuedInput,
    resumeQueue: mocks.resumeQueue,
    respondToApproval: mocks.respondToApproval,
    respondToQuestions: mocks.respondToQuestions,
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
  PRODUCT_TASK_TAB_PREFIX: '__product_task__',
  useTabStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    openTab: mocks.openTab,
    openProductTaskTab: mocks.openProductTaskTab,
    closeTab: mocks.closeTab,
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
    forgetTask: mocks.forgetSideTasks,
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

vi.mock('./ProductTaskBrowserPreviewDock', () => ({
  buildProductTaskPreviewIntentText: (intent: { instruction: string }) => `preview-intent:${intent.instruction}`,
  ProductTaskBrowserPreviewDock: ({
    activeMode,
    onClose,
    onCapture,
    onSubmitSelection,
  }: {
    activeMode: 'browser' | 'preview' | null
    onClose: (mode: 'browser' | 'preview') => void
    onCapture: (capture: { mode: 'browser' | 'preview'; dataUrl: string }) => void
    onSubmitSelection: (intent: Record<string, unknown>) => Promise<boolean>
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
        <button
          type="button"
          onClick={() => void onSubmitSelection({
            selectionId: 'preview-selection-test',
            instruction: '把标题改成今日活动',
            selection: {
              pageUrl: 'http://127.0.0.1:5173/',
              element: {
                selector: '#title',
                nthPath: 'html>body>h1',
                tag: 'h1',
                classes: [],
                boundingBox: { x: 0, y: 0, w: 100, h: 40 },
                computedStyles: {},
              },
              screenshot: { dataUrl: 'data:image/png;base64,TkFUSVZF', kind: 'region' },
            },
          })}
        >
          模拟提交选取证据
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
import { useProductTaskWorkspaceStore } from '../stores/productTaskWorkspaceStore'

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
      workspace_capability: { scope: { kind: 'workspace', workspace_id: 'workspace-1', generation: 1 }, workspace_revision: 1, availability: 'available', available: true },
    }],
    total: 1,
    capabilities: { createTask: true },
  }
  mocks.isLoading = false
  mocks.error = null
  mocks.previewWebview = false
  mocks.terminal = false
  mocks.runtime = {
    connectionState: 'connected',
    historyStatus: 'ready',
    runState: 'idle',
    entries: [],
    queuedInputs: [],
    activeActivity: null,
    pendingApproval: null,
    approvalResponsePending: false,
    error: null,
    streamingEntryId: null,
    recoveryRequired: false,
  }
  mocks.refresh.mockReset().mockResolvedValue(undefined)
  mocks.archiveTask.mockReset().mockResolvedValue(undefined)
  mocks.restoreTask.mockReset().mockResolvedValue(undefined)
  mocks.mutateTaskDeletion.mockReset().mockImplementation(async (_taskId: string, phase: string) => {
    const [current] = (mocks.index as { tasks: Array<Record<string, unknown>> }).tasks
    const lifecycle = phase === 'begin' ? 'deleting' : phase === 'commit_purge' ? 'purge_committed' : phase === 'cancel' ? 'archived' : 'deleted'
    const next = { ...current, lifecycle, actions: lifecycle === 'archived' ? ['restore', 'continue'] : [] }
    mocks.index = { ...mocks.index, tasks: lifecycle === 'deleted' ? [] : [next] }
    return next
  })
  mocks.recoverTaskRun.mockReset().mockResolvedValue(undefined)
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
  mocks.forgetRuntimeTask.mockReset()
  mocks.sendText.mockReset().mockReturnValue(true)
  mocks.sendMessage.mockReset().mockReturnValue(true)
  mocks.stopTask.mockReset()
  mocks.editQueuedInput.mockReset().mockResolvedValue(true)
  mocks.deleteQueuedInput.mockReset().mockResolvedValue(true)
  mocks.reorderQueuedInputs.mockReset().mockResolvedValue(true)
  mocks.steerQueuedInput.mockReset().mockResolvedValue(true)
  mocks.resumeQueue.mockReset().mockResolvedValue(true)
  mocks.respondToApproval.mockReset().mockReturnValue(true)
  mocks.respondToQuestions.mockReset().mockReturnValue(true)
  mocks.refreshThread.mockReset().mockResolvedValue(undefined)
  mocks.closeTab.mockReset()
  mocks.forgetSideTasks.mockReset()
  mocks.openTab.mockReset()
  mocks.openProductTaskTab.mockReset()
  mocks.listSkills.mockReset().mockResolvedValue({ commands: [] })
  mocks.listAgents.mockReset().mockResolvedValue({ agents: [] })
  useProductTaskWorkspaceStore.setState(
    useProductTaskWorkspaceStore.getInitialState(),
    true,
  )
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
  useProductTaskWorkspaceStore.setState(
    useProductTaskWorkspaceStore.getInitialState(),
    true,
  )
  vi.clearAllMocks()
})

describe('ProductTaskPage', () => {
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

  it('sends a validated task message and clears the composer only after the durable submit accepts it', async () => {
    render(<ProductTaskPage taskId="task-1" />)
    const input = screen.getByLabelText('任务输入') as HTMLTextAreaElement

    fireEvent.change(input, { target: { value: '  /skill ball-hall-daily-review 整理今天订单  ' } })
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    expect(mocks.sendText).toHaveBeenCalledWith('task-1', '  /skill ball-hall-daily-review 整理今天订单  ')
    await waitFor(() => expect(input.value).toBe(''))
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
    await waitFor(() => expect(input.value).toBe(''))
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
    await waitFor(() => expect(screen.queryByText('球台.png')).toBeNull())
  })

  it('keeps the text and selected attachment when safe ingest rejects the submit', async () => {
    mocks.sendMessage.mockResolvedValue(false)
    render(<ProductTaskPage taskId="task-1" />)
    const input = screen.getByLabelText('任务输入') as HTMLTextAreaElement
    const picker = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { value: '核对这张图' } })
    fireEvent.change(picker, { target: { files: [new File(['a'], '球台.png', { type: 'image/png' })] } })

    await screen.findByText('球台.png')
    fireEvent.click(screen.getByRole('button', { name: '发送' }))

    await screen.findByText('暂时无法发送这条内容，请检查后重试。')
    expect(input.value).toBe('核对这张图')
    expect(screen.getByLabelText('待发送附件').textContent).toContain('球台.png')
  })

  it('keeps Browser capture unavailable while native transport is disabled', () => {
    render(<ProductTaskPage taskId="task-1" />)

    const browser = screen.getByRole('button', { name: '浏览器' })
    expect(browser).toBeDisabled()
    fireEvent.click(browser)

    expect(screen.queryByTestId('product-task-browser-preview-dock')).toBeNull()
    expect(screen.queryByRole('button', { name: '模拟原生截图' })).toBeNull()
    expect(mocks.sendMessage).not.toHaveBeenCalled()
  })

  it('submits only a narrow allow or deny response for an action approval', () => {
    mocks.runtime = {
      ...mocks.runtime,
      runState: 'awaiting_approval',
      pendingApproval: {
        requestId: 'permission-1',
        kind: 'action',
        action: {
          what: '运行一条受限命令',
          scope: '当前任务工作区之外的本机资源或网络边界',
          consequence: '命令可能修改文件、启动进程或访问外部服务。',
        },
      },
      approvalResponsePending: false,
    }
    render(<ProductTaskPage taskId="task-1" />)

    expect(screen.getByText('运行一条受限命令')).toBeInTheDocument()
    expect(screen.getByText('当前任务工作区之外的本机资源或网络边界')).toBeInTheDocument()
    expect(screen.getByText('命令可能修改文件、启动进程或访问外部服务。')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '允许本次操作' }))

    expect(mocks.respondToApproval).toHaveBeenCalledWith('task-1', true)
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
      target: 'new_worktree',
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

  it('keeps a quoted entry identity through the durable submit boundary', async () => {
    mocks.runtime = {
      ...mocks.runtime,
      entries: [{
        id: 'thread_0123456789abcdef0123',
        type: 'assistant_text',
        text: '第一行\n第二行',
        createdAt: '2026-07-19T00:00:00.000Z',
      }],
    }
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '引用' }))

    expect(screen.getByRole('textbox', { name: '任务输入' })).toHaveValue('> 第一行\n> 第二行\n\n')
    expect(screen.getByLabelText('待发送引用')).toHaveTextContent('引用 1')
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '发送' }))
    await waitFor(() => expect(mocks.sendText).toHaveBeenCalledWith('task-1', '> 第一行\n> 第二行\n\n', ['thread_0123456789abcdef0123']))
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
    expect(screen.queryByRole('button', { name: '引用' })).toBeNull()
  })

  it('keeps task actions available but disables native terminal opening', () => {
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '置顶' }))
    fireEvent.click(screen.getByRole('button', { name: '归档' }))
    const terminal = screen.getByRole('button', { name: '终端' })

    expect(mocks.pinTask).toHaveBeenCalledWith('task-1')
    expect(mocks.archiveTask).toHaveBeenCalledWith('task-1')
    expect(terminal).toBeDisabled()
    fireEvent.click(terminal)
    expect(screen.queryByTestId('product-task-terminal-dock')).toBeNull()
  })

  it('keeps stop, offers a follow-up queue, and hides archive during a live task run', async () => {
    mocks.runtime = {
      ...mocks.runtime,
      runState: 'working',
    }
    render(<ProductTaskPage taskId="task-1" />)

    expect(screen.getByRole('button', { name: '停止' })).not.toBeNull()
    expect(screen.getByRole('button', { name: '加入队列' })).not.toBeNull()
    expect(screen.queryByRole('button', { name: '归档' })).toBeNull()

    fireEvent.change(screen.getByRole('textbox', { name: '任务输入' }), { target: { value: '接着处理下一项' } })
    fireEvent.click(screen.getByRole('button', { name: '加入队列' }))
    await waitFor(() => expect(mocks.sendText).toHaveBeenCalledWith('task-1', '接着处理下一项'))
    fireEvent.click(screen.getByRole('button', { name: '停止' }))
    expect(mocks.stopTask).toHaveBeenCalledWith('task-1')
  })

  it('shows the durable paused queue and resumes it explicitly', () => {
    mocks.runtime = {
      ...mocks.runtime,
      runState: 'idle',
      queuedInputs: [{
        id: 'queue_123e4567-e89b-42d3-a456-426614174000',
        text: '检查刚才附上的图片',
        state: 'queued',
        createdAt: '2026-07-26T00:00:00.000Z',
        attachmentCount: 1,
      }],
    }
    render(<ProductTaskPage taskId="task-1" />)

    expect(screen.getByLabelText('待处理输入队列')).toHaveTextContent('检查刚才附上的图片')
    expect(screen.getByLabelText('待处理输入队列')).toHaveTextContent('1 个附件')
    fireEvent.click(screen.getByRole('button', { name: '继续队列' }))
    expect(mocks.resumeQueue).toHaveBeenCalledWith('task-1')
  })

  it('edits, reorders, deletes, and explicitly sends a live follow-up', async () => {
    mocks.runtime = {
      ...mocks.runtime,
      runState: 'working',
      queuedInputs: [{
        id: 'queue_123e4567-e89b-42d3-a456-426614174000', text: '第一条补充', state: 'queued', createdAt: '2026-07-26T00:00:00.000Z', attachmentCount: 0,
      }, {
        id: 'queue_123e4567-e89b-42d3-a456-426614174001', text: '第二条补充', state: 'queued', createdAt: '2026-07-26T00:00:01.000Z', attachmentCount: 0,
      }],
    }
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '编辑队列输入：第一条补充' }))
    fireEvent.change(screen.getByRole('textbox', { name: '编辑队列输入' }), { target: { value: '改后的第一条' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mocks.editQueuedInput).toHaveBeenCalledWith('task-1', 'queue_123e4567-e89b-42d3-a456-426614174000', '改后的第一条'))

    fireEvent.click(screen.getAllByRole('button', { name: '下移队列输入' })[0]!)
    await waitFor(() => expect(mocks.reorderQueuedInputs).toHaveBeenCalledWith('task-1', [
      'queue_123e4567-e89b-42d3-a456-426614174001',
      'queue_123e4567-e89b-42d3-a456-426614174000',
    ]))
    fireEvent.click(screen.getByRole('button', { name: '立即发送队列输入：第一条补充' }))
    await waitFor(() => expect(mocks.steerQueuedInput).toHaveBeenCalledWith('task-1', 'queue_123e4567-e89b-42d3-a456-426614174000'))
    fireEvent.click(screen.getByRole('button', { name: '删除队列输入：第二条补充' }))
    await waitFor(() => expect(mocks.deleteQueuedInput).toHaveBeenCalledWith('task-1', 'queue_123e4567-e89b-42d3-a456-426614174001'))
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

  it('requires two confirmations, then forgets every renderer projection after durable deletion', async () => {
    const [currentTask] = (mocks.index as { tasks: Array<Record<string, unknown>> }).tasks
    mocks.index = {
      ...mocks.index,
      tasks: [{ ...currentTask, lifecycle: 'archived', actions: ['restore', 'continue'] }],
    }
    useProductTaskWorkspaceStore.setState({ byTaskId: { 'task-1': {
      reviewOpen: false, runOpen: false, browserOpen: false, previewOpen: false, terminalOpen: false,
      activePanel: null, activeBrowserPreviewMode: null,
    } } })
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '删除任务' }))
    expect(screen.getByRole('dialog')).toHaveTextContent('工作区及其中的文件不会被删除')
    fireEvent.click(screen.getByRole('button', { name: '准备删除' }))
    await waitFor(() => expect(mocks.mutateTaskDeletion).toHaveBeenCalledWith('task-1', 'begin'))
    expect(await screen.findByRole('button', { name: '永久删除' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '永久删除' }))
    await waitFor(() => expect(mocks.mutateTaskDeletion.mock.calls.map((call) => call[1])).toEqual(['begin', 'commit_purge', 'retry']))
    expect(mocks.forgetRuntimeTask).toHaveBeenCalledWith('task-1')
    expect(mocks.forgetSideTasks).toHaveBeenCalledWith('task-1')
    expect(useProductTaskWorkspaceStore.getState().byTaskId).not.toHaveProperty('task-1')
    expect(mocks.openTab).toHaveBeenCalledWith('__product_tasks__', '任务中心', 'product-tasks')
    expect(mocks.closeTab).toHaveBeenCalledWith('__product_task__task-1')
  })

  it('shows durable crash recovery after reconnect and confirms the new execution generation', async () => {
    mocks.runtime = {
      ...mocks.runtime,
      runState: 'idle',
      recoveryRequired: true,
      error: { code: 'task_network_unavailable', retryable: true },
    }
    render(<ProductTaskPage taskId="task-1" />)
    expect(screen.getByRole('alert')).toHaveTextContent('当前无法连接模型服务')
    expect(screen.getByRole('alert')).toHaveTextContent('可能重复外部操作')
    fireEvent.click(screen.getByRole('button', { name: '恢复失败任务' }))
    await waitFor(() => expect(mocks.recoverTaskRun).toHaveBeenCalledWith('task-1'))
    expect(mocks.refreshThread).toHaveBeenCalledWith('task-1')
  })

  it('opens and closes a workspace-bound native terminal independently from Review', () => {
    mocks.terminal = true
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '审阅' }))
    expect(screen.getByTestId('product-task-review-dock').textContent).toContain('review:task-1')

    const terminal = screen.getByRole('button', { name: '终端' })
    expect(terminal).toBeEnabled()
    fireEvent.click(terminal)
    expect(screen.getByTestId('product-task-terminal-dock')).toHaveTextContent('/workspace/billiard')
    expect(screen.getByTestId('product-task-review-dock')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(screen.queryByTestId('product-task-terminal-dock')).toBeNull()
    expect(screen.getByTestId('product-task-review-dock')).toBeTruthy()
  })

  it('does not open Browser or Preview without native preview transport', () => {
    render(<ProductTaskPage taskId="task-1" />)

    const browser = screen.getByRole('button', { name: '浏览器' })
    const preview = screen.getByRole('button', { name: '预览' })
    expect(browser).toBeDisabled()
    expect(preview).toBeDisabled()
    fireEvent.click(browser)
    fireEvent.click(preview)

    expect(useProductTaskWorkspaceStore.getState().byTaskId).toEqual({})
    expect(screen.queryByTestId('product-task-browser-preview-dock')).toBeNull()
  })

  it('submits one native Preview selection as durable task evidence and opens the source Diff', async () => {
    mocks.previewWebview = true
    render(<ProductTaskPage taskId="task-1" />)

    const preview = screen.getByRole('button', { name: '预览' })
    expect(preview).toBeEnabled()
    fireEvent.click(preview)
    expect(screen.getByTestId('product-task-browser-preview-dock')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '模拟提交选取证据' }))

    await waitFor(() => {
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        'task-1',
        'preview-intent:把标题改成今日活动',
        [expect.objectContaining({
          type: 'image',
          name: '预览元素证据.png',
          mimeType: 'image/png',
        })],
      )
    })
    expect(screen.getByTestId('product-task-review-dock')).toBeInTheDocument()
    expect(screen.queryByTestId('product-task-browser-preview-dock')).toBeNull()
  })

  it('opens the native Browser result surface when the Electron preview transport is available', () => {
    mocks.previewWebview = true
    render(<ProductTaskPage taskId="task-1" />)

    const browser = screen.getByRole('button', { name: '浏览器' })
    expect(browser).toBeEnabled()
    fireEvent.click(browser)
    expect(screen.getByTestId('product-task-browser-preview-dock')).toBeInTheDocument()
    expect(useProductTaskWorkspaceStore.getState().byTaskId['task-1']).toMatchObject({
      browserOpen: true,
      activePanel: 'browser-preview',
      activeBrowserPreviewMode: 'browser',
    })
  })

  it('closes the available review axis without creating a disabled terminal dock', () => {
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '审阅' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭审阅' }))

    expect(screen.queryByTestId('product-task-dock-panel-review')).toBeNull()
    expect(screen.getByRole('button', { name: '终端' })).toBeDisabled()
    expect(screen.queryByTestId('product-task-terminal-dock')).toBeNull()
  })

  it('toggles only currently available workspace panels and has no media control', () => {
    render(<ProductTaskPage taskId="task-1" />)

    const review = screen.getByRole('button', { name: '审阅' })
    expect(screen.queryByRole('button', { name: '媒体' })).toBeNull()
    expect(screen.getByRole('button', { name: '浏览器' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '预览' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '终端' })).toBeDisabled()

    fireEvent.click(review)
    expect(review).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(review)
    expect(review).toHaveAttribute('aria-pressed', 'false')
    expect(useProductTaskWorkspaceStore.getState().byTaskId['task-1']).toMatchObject({
      browserOpen: false,
      previewOpen: false,
      terminalOpen: false,
    })
  })

  it('does not mount disabled native docks from header clicks or keyboard activation', () => {
    render(<ProductTaskPage taskId="task-1" />)

    for (const name of ['浏览器', '预览', '终端']) {
      const control = screen.getByRole('button', { name })
      expect(control).toBeDisabled()
      fireEvent.click(control)
      fireEvent.keyDown(control, { key: 'Enter' })
      fireEvent.keyDown(control, { key: ' ' })
    }

    expect(useProductTaskWorkspaceStore.getState().byTaskId).toEqual({})
    expect(screen.queryByTestId('product-task-browser-preview-dock')).toBeNull()
    expect(screen.queryByTestId('product-task-terminal-dock')).toBeNull()
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
    expect(mocks.forgetRuntimeTask).toHaveBeenCalledWith('missing-task')
    expect(mocks.forgetSideTasks).toHaveBeenCalledWith('missing-task')
    expect(mocks.closeTab).toHaveBeenCalledWith('__product_task__missing-task')
  })
})
