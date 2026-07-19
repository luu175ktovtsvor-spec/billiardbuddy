import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getReviewStatus: vi.fn(),
  getReviewTree: vi.fn(),
  getReviewFile: vi.fn(),
  getReviewDiff: vi.fn(),
}))

vi.mock('../api/tasks', () => ({
  productTasksApi: apiMocks,
}))

import { ProductTaskReviewDock } from './ProductTaskReviewDock'

beforeEach(() => {
  apiMocks.getReviewStatus.mockReset().mockResolvedValue({
    taskId: 'task-1',
    state: 'ready',
    repository: { name: '球房助手', branch: 'dev', isGitRepository: true },
    changedFiles: [{ path: 'src/main.ts', status: 'modified', additions: 3, deletions: 1 }],
  })
  apiMocks.getReviewTree.mockReset().mockImplementation(async (_taskId: string, path?: string) => ({
    taskId: 'task-1',
    state: 'ok',
    path: path ?? '',
    entries: path === 'src'
      ? [{ name: 'main.ts', path: 'src/main.ts', isDirectory: false }]
      : [{ name: 'src', path: 'src', isDirectory: true }],
  }))
  apiMocks.getReviewFile.mockReset().mockResolvedValue({
    taskId: 'task-1',
    state: 'ok',
    path: 'src/main.ts',
    previewType: 'text',
    content: 'export const ready = true',
    language: 'typescript',
    size: 24,
  })
  apiMocks.getReviewDiff.mockReset().mockResolvedValue({
    taskId: 'task-1',
    state: 'ok',
    path: 'src/main.ts',
    diff: '+export const ready = true',
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('ProductTaskReviewDock', () => {
  it('loads task-scoped status and tree, then reads the selected file and diff', async () => {
    render(<ProductTaskReviewDock taskId="task-1" onClose={vi.fn()} />)

    await screen.findByText('球房助手 · dev')
    expect(apiMocks.getReviewStatus).toHaveBeenCalledWith('task-1')
    expect(apiMocks.getReviewTree).toHaveBeenCalledWith('task-1', '')
    expect(screen.getByText('src/main.ts')).toBeTruthy()

    fireEvent.click(screen.getByText('src/main.ts'))

    await screen.findByText('export const ready = true')
    expect(apiMocks.getReviewFile).toHaveBeenCalledWith('task-1', 'src/main.ts')
    expect(apiMocks.getReviewDiff).toHaveBeenCalledWith('task-1', 'src/main.ts')
    expect(screen.getByText('+export const ready = true')).toBeTruthy()
  })

  it('navigates the real task tree with relative paths only', async () => {
    render(<ProductTaskReviewDock taskId="task-1" onClose={vi.fn()} />)

    await screen.findByText('src')
    fireEvent.click(screen.getByText('src'))

    await waitFor(() => {
      expect(apiMocks.getReviewTree).toHaveBeenCalledWith('task-1', 'src')
    })
    expect(screen.getByText('main.ts')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '上一级' }))
    await waitFor(() => {
      expect(apiMocks.getReviewTree).toHaveBeenLastCalledWith('task-1', '')
    })
  })

  it('renders a bounded task video preview without a workspace URL or Core session reference', async () => {
    apiMocks.getReviewTree.mockResolvedValue({
      taskId: 'task-1',
      state: 'ok',
      path: '',
      entries: [{ name: 'replay.webm', path: 'assets/replay.webm', isDirectory: false }],
    })
    apiMocks.getReviewFile.mockResolvedValue({
      taskId: 'task-1',
      state: 'ok',
      path: 'assets/replay.webm',
      previewType: 'video',
      dataUrl: 'data:video/webm;base64,AAAA',
      mimeType: 'video/webm',
      language: 'video',
      size: 3,
    })
    apiMocks.getReviewDiff.mockResolvedValue({
      taskId: 'task-1',
      state: 'ok',
      path: 'assets/replay.webm',
    })

    render(<ProductTaskReviewDock taskId="task-1" onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('replay.webm'))

    const video = await screen.findByTestId('product-task-review-video')
    expect(video.getAttribute('src')).toBe('data:video/webm;base64,AAAA')
    expect(video.getAttribute('controls')).not.toBeNull()
    expect(screen.getByText('视频预览仅读取当前任务工作区内不超过 16 MB 的 MP4、WebM、Ogg 或 MOV 文件。')).toBeTruthy()
    expect(apiMocks.getReviewFile).toHaveBeenCalledWith('task-1', 'assets/replay.webm')
    expect(apiMocks.getReviewDiff).toHaveBeenCalledWith('task-1', 'assets/replay.webm')

    fireEvent.error(video)
    expect((await screen.findByRole('alert')).textContent).toBe('当前运行环境无法播放这个视频编码。')
  })

  it('identifies a video that exceeds the bounded preview limit', async () => {
    apiMocks.getReviewTree.mockResolvedValue({
      taskId: 'task-1',
      state: 'ok',
      path: '',
      entries: [{ name: 'long-replay.mp4', path: 'assets/long-replay.mp4', isDirectory: false }],
    })
    apiMocks.getReviewFile.mockResolvedValue({
      taskId: 'task-1',
      state: 'too_large',
      path: 'assets/long-replay.mp4',
      mimeType: 'video/mp4',
      language: 'video',
      size: 16 * 1024 * 1024 + 1,
    })
    apiMocks.getReviewDiff.mockResolvedValue({
      taskId: 'task-1',
      state: 'ok',
      path: 'assets/long-replay.mp4',
    })

    render(<ProductTaskReviewDock taskId="task-1" onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('long-replay.mp4'))

    expect(await screen.findByText('视频超过 16 MB 的安全预览限制，无法直接展示。')).toBeTruthy()
    expect(screen.queryByTestId('product-task-review-video')).toBeNull()
  })

  it('shows a controlled unavailable state instead of a workspace error payload', async () => {
    apiMocks.getReviewStatus.mockResolvedValueOnce({
      taskId: 'task-1',
      state: 'unavailable',
      repository: null,
      changedFiles: [],
    })

    render(<ProductTaskReviewDock taskId="task-1" onClose={vi.fn()} />)

    expect(await screen.findByText('当前任务暂时没有可用的审阅内容。')).toBeTruthy()
  })

  it('closes only its own review panel', async () => {
    const onClose = vi.fn()
    render(<ProductTaskReviewDock taskId="task-1" onClose={onClose} />)

    await screen.findByText('球房助手 · dev')
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))

    expect(onClose).toHaveBeenCalledOnce()
  })
})
