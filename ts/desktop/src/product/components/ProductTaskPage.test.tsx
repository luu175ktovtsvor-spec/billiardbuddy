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
  attachMediaProject: vi.fn(),
  getMedia: vi.fn(),
  selectImage: vi.fn(),
  selectVideo: vi.fn(),
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
  IMAGE_WORKBENCH_TAB_ID: '__image_workbench__',
  PRODUCT_TASKS_TAB_ID: '__product_tasks__',
  VIDEO_STUDIO_TAB_ID: '__video_studio__',
  useTabStore: (selector: (state: Record<string, unknown>) => unknown) => selector({
    openTab: mocks.openTab,
    openProductTaskTab: mocks.openProductTaskTab,
  }),
}))

vi.mock('../../stores/mediaWorkbenchStore', () => ({
  useMediaWorkbenchStore: {
    getState: () => ({
      selectImage: mocks.selectImage,
      selectVideo: mocks.selectVideo,
    }),
  },
}))

vi.mock('../api/tasks', () => ({
  productTasksApi: {
    attachMediaProject: mocks.attachMediaProject,
    getMedia: mocks.getMedia,
  },
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
  mocks.getMedia.mockResolvedValue({ taskId: 'task-1', projects: [] })
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
  mocks.attachMediaProject.mockReset().mockResolvedValue({})
  mocks.selectImage.mockReset()
  mocks.selectVideo.mockReset()
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
  it('requires a user click before associating an Agent-prepared media draft and opening its workbench', async () => {
    mocks.runtime = {
      ...mocks.runtime,
      entries: [{
        id: 'thread_media_draft',
        type: 'media_draft',
        draft: { projectId: 'img_12345678', kind: 'image', state: 'draft' },
        createdAt: '2026-07-20T00:00:00.000Z',
      }],
    }

    render(<ProductTaskPage taskId="task-1" />)

    expect(screen.getByTestId('product-task-media-draft-image').textContent).toContain('已准备图片草稿')
    expect(screen.queryByText('img_12345678')).toBeNull()
    expect(mocks.attachMediaProject).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '关联到当前任务并打开工作台' }))

    await waitFor(() => {
      expect(mocks.attachMediaProject).toHaveBeenCalledWith('task-1', 'img_12345678')
    })
    expect(mocks.selectImage).toHaveBeenCalledWith('img_12345678')
    expect(mocks.openTab).toHaveBeenCalledWith('__image_workbench__', '生成图片', 'image-workbench')
    expect(useProductTaskWorkspaceStore.getState().byTaskId['task-1']).toMatchObject({
      mediaOpen: true,
      activePanel: 'media',
    })
  })

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

  it('quotes a persisted task entry into the composer without submitting it', () => {
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
    expect(mocks.sendMessage).not.toHaveBeenCalled()
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

  it('keeps the available Review panel usable while terminal remains disabled', () => {
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '审阅' }))
    expect(screen.getByTestId('product-task-review-dock').textContent).toContain('review:task-1')

    const terminal = screen.getByRole('button', { name: '终端' })
    expect(terminal).toBeDisabled()
    fireEvent.click(terminal)
    expect(screen.queryByTestId('product-task-terminal-dock')).toBeNull()
    expect(screen.getByTestId('product-task-review-dock')).toBeTruthy()
  })

  it('does not open Browser or Preview through disabled header controls', () => {
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

  it('closes the available review axis without creating a disabled terminal dock', () => {
    render(<ProductTaskPage taskId="task-1" />)

    fireEvent.click(screen.getByRole('button', { name: '审阅' }))
    fireEvent.click(screen.getByRole('button', { name: '关闭审阅' }))

    expect(screen.queryByTestId('product-task-dock-panel-review')).toBeNull()
    expect(screen.getByRole('button', { name: '终端' })).toBeDisabled()
    expect(screen.queryByTestId('product-task-terminal-dock')).toBeNull()
  })

  it('toggles only available review and media panels from header controls', () => {
    render(<ProductTaskPage taskId="task-1" />)

    const review = screen.getByRole('button', { name: '审阅' })
    const media = screen.getByRole('button', { name: '媒体' })
    expect(screen.getByRole('button', { name: '浏览器' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '预览' })).toBeDisabled()
    expect(screen.getByRole('button', { name: '终端' })).toBeDisabled()

    fireEvent.click(review)
    expect(review).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(review)
    expect(review).toHaveAttribute('aria-pressed', 'false')
    fireEvent.click(media)
    expect(media).toHaveAttribute('aria-pressed', 'true')
    fireEvent.click(media)
    expect(media).toHaveAttribute('aria-pressed', 'false')
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
  })
})
