import { describe, expect, it, vi } from 'vitest'
import { ELECTRON_EVENT_CHANNELS, ELECTRON_IPC_CHANNELS } from '../../../electron/ipc/channels'
import { createElectronHost } from './electronHost'

describe('electron desktop host', () => {
  it('wraps dialog, shell URL, and shell path calls in explicit IPC channels', async () => {
    const invoke = vi.fn().mockResolvedValue('/tmp/report.md')
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await host.shell.open('https://example.com')
    await host.shell.openPath('/tmp/report.md')
    await host.dialogs.open({ directory: true, multiple: false, title: 'Choose folder' })

    expect(invoke).toHaveBeenNthCalledWith(1, ELECTRON_IPC_CHANNELS.shellOpen, 'https://example.com')
    expect(invoke).toHaveBeenNthCalledWith(2, ELECTRON_IPC_CHANNELS.shellOpenPath, '/tmp/report.md')
    expect(invoke).toHaveBeenNthCalledWith(3, ELECTRON_IPC_CHANNELS.dialogOpen, {
      directory: true,
      multiple: false,
      title: 'Choose folder',
    })
  })

  it('routes clipboard reads and writes through narrow IPC channels', async () => {
    const invoke = vi.fn().mockResolvedValueOnce('from clipboard').mockResolvedValueOnce(undefined)
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await expect(host.clipboard.readText()).resolves.toBe('from clipboard')
    await host.clipboard.writeText('to clipboard')

    expect(invoke).toHaveBeenNthCalledWith(1, ELECTRON_IPC_CHANNELS.clipboardReadText, undefined)
    expect(invoke).toHaveBeenNthCalledWith(2, ELECTRON_IPC_CHANNELS.clipboardWriteText, 'to clipboard')
  })

  it('rejects invalid preload payloads before invoking Electron IPC', async () => {
    const invoke = vi.fn()
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await expect(host.shell.openPath({ path: '/tmp/report.md' } as unknown as string)).rejects.toThrow(
      'Invalid Electron IPC payload',
    )
    expect(invoke).not.toHaveBeenCalled()
  })

  it('advertises custom window chrome for the Electron frameless shell', () => {
    const host = createElectronHost({
      invoke: vi.fn(),
      subscribe: vi.fn(),
    })

    expect(host.capabilities.windowControls).toBe(true)
  })

  it('keeps the legacy window dragging IPC channel payload-free', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await host.window.startDragging()

    expect(invoke).toHaveBeenCalledWith(ELECTRON_IPC_CHANNELS.windowStartDragging, undefined)
  })

  it('opens a product task only through its narrow desktop window channel', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const host = createElectronHost({ invoke, subscribe: vi.fn() })

    await host.window.openProductTask('task_abc-123')

    expect(host.capabilities.taskWindows).toBe(true)
    expect(invoke).toHaveBeenCalledWith(
      ELECTRON_IPC_CHANNELS.windowOpenProductTask,
      'task_abc-123',
    )
  })

  it('keeps every terminal control bound to the same product task id', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const host = createElectronHost({ invoke, subscribe: vi.fn() })

    await host.terminal.spawn({ taskId: 'task-1', cwd: '/workspace/task-1', cols: 80, rows: 24 })
    await host.terminal.write('task-1', 7, 'pwd\r')
    await host.terminal.resize('task-1', 7, 100, 30)
    await host.terminal.kill('task-1', 7)

    expect(invoke).toHaveBeenNthCalledWith(1, ELECTRON_IPC_CHANNELS.terminalSpawn, {
      taskId: 'task-1', cwd: '/workspace/task-1', cols: 80, rows: 24,
    })
    expect(invoke).toHaveBeenNthCalledWith(2, ELECTRON_IPC_CHANNELS.terminalWrite, {
      taskId: 'task-1', sessionId: 7, data: 'pwd\r',
    })
    expect(invoke).toHaveBeenNthCalledWith(3, ELECTRON_IPC_CHANNELS.terminalResize, {
      taskId: 'task-1', sessionId: 7, cols: 100, rows: 30,
    })
    expect(invoke).toHaveBeenNthCalledWith(4, ELECTRON_IPC_CHANNELS.terminalKill, {
      taskId: 'task-1', sessionId: 7,
    })
  })

  it('routes preview zoom through the preview IPC channel', async () => {
    const invoke = vi.fn().mockResolvedValue(undefined)
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await host.preview.setZoom(0.8)

    expect(invoke).toHaveBeenCalledWith(ELECTRON_IPC_CHANNELS.previewSetZoom, 0.8)
  })

  it('sends only user-selected media inputs and never exposes the host capability', async () => {
    const invoke = vi.fn().mockResolvedValue({ task: { id: 'task_media01' } })
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await host.media.submitImageProject('img_project01', true)
    await host.media.startImageOperation('img_project01', {
      revision: 2,
      base_version_id: 'ver_base0001',
      kind: 'edit',
      instruction: '只调整背景色',
      confirm_unknown_retry: false,
    })
    await host.media.addVideoSource('vid_project01', '/tmp/source.mp4')
    await host.media.renderVideo({
      projectId: 'vid_project01',
      baseRevision: 4,
      timelineVersionId: 'timeline_0123456789abcdef01234567',
      outputPath: '/tmp/final.mp4',
    })
    await host.media.analyzeVideo({
      projectId: 'vid_project01',
      baseRevision: 4,
      userGoal: '剪成活动短片',
    })

    expect(invoke).toHaveBeenNthCalledWith(
      1,
      ELECTRON_IPC_CHANNELS.mediaSubmitImage,
      { projectId: 'img_project01', confirmUnknownRetry: true },
    )
    expect(invoke).toHaveBeenNthCalledWith(2, ELECTRON_IPC_CHANNELS.mediaStartImageOperation, {
      projectId: 'img_project01',
      input: {
        revision: 2,
        base_version_id: 'ver_base0001',
        kind: 'edit',
        instruction: '只调整背景色',
        confirm_unknown_retry: false,
      },
    })
    expect(invoke).toHaveBeenNthCalledWith(3, ELECTRON_IPC_CHANNELS.mediaAddVideoSource, {
      projectId: 'vid_project01',
      path: '/tmp/source.mp4',
    })
    expect(invoke).toHaveBeenNthCalledWith(4, ELECTRON_IPC_CHANNELS.mediaRenderVideo, {
      projectId: 'vid_project01',
      baseRevision: 4,
      timelineVersionId: 'timeline_0123456789abcdef01234567',
      outputPath: '/tmp/final.mp4',
    })
    expect(invoke).toHaveBeenNthCalledWith(5, ELECTRON_IPC_CHANNELS.mediaAnalyzeVideo, {
      projectId: 'vid_project01',
      baseRevision: 4,
      userGoal: '剪成活动短片',
    })
    expect(JSON.stringify(invoke.mock.calls)).not.toContain('capability')
  })

  it('keeps event subscriptions behind named event channels', async () => {
    const unlisten = vi.fn()
    const subscribe = vi.fn().mockResolvedValue(unlisten)
    const handler = vi.fn()
    const host = createElectronHost({
      invoke: vi.fn(),
      subscribe,
    })

    const stop = await host.window.onNativeMenuNavigate(handler)
    stop()

    expect(subscribe).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.nativeMenuNavigate, handler)
    expect(unlisten).toHaveBeenCalledTimes(1)
  })

  it('acknowledges handled notification actions through a diagnostics IPC channel', async () => {
    const invoke = vi.fn().mockResolvedValue(true)
    const payload = { target: { type: 'session', sessionId: 'session-1' } }
    const host = createElectronHost({
      invoke,
      subscribe: vi.fn(),
    })

    await expect(host.notifications.ackAction(payload)).resolves.toBe(true)

    expect(invoke).toHaveBeenCalledWith(ELECTRON_IPC_CHANNELS.notificationActionAck, payload)
  })

  it('wraps Electron update metadata with download/install methods', async () => {
    const unlisten = vi.fn()
    const invoke = vi.fn()
      .mockResolvedValueOnce({ version: '1.2.3', body: 'Fixes' })
      .mockResolvedValue(undefined)
    const subscribe = vi.fn().mockResolvedValue(unlisten)
    const onProgress = vi.fn()
    const host = createElectronHost({ invoke, subscribe })

    const update = await host.updates.check()
    await update?.download(onProgress)
    await update?.install()
    await update?.close()

    expect(update?.version).toBe('1.2.3')
    expect(subscribe).toHaveBeenCalledWith(ELECTRON_EVENT_CHANNELS.updateDownloadEvent, onProgress)
    expect(invoke).toHaveBeenNthCalledWith(1, ELECTRON_IPC_CHANNELS.updateCheck, undefined)
    expect(invoke).toHaveBeenNthCalledWith(2, ELECTRON_IPC_CHANNELS.updateDownload, undefined)
    expect(invoke).toHaveBeenNthCalledWith(3, ELECTRON_IPC_CHANNELS.updateInstall, undefined)
    expect(invoke).toHaveBeenNthCalledWith(4, ELECTRON_IPC_CHANNELS.updateCancelInstall, undefined)
    expect(unlisten).toHaveBeenCalledTimes(1)
  })
})
