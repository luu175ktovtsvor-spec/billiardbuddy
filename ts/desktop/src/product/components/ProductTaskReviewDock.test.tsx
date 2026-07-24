import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiMocks = vi.hoisted(() => ({
  getReviewStatus: vi.fn(),
  getReviewTree: vi.fn(),
  getReviewFile: vi.fn(),
  getReviewDiff: vi.fn(),
  getReviewComments: vi.fn(),
  createReviewComment: vi.fn(),
}))
const stableRevision = `rev_${'a'.repeat(32)}`
const stableFileRef = { fileId: 'file_aaaaaaaaaaaaaaaaaaaa', path: 'src/main.ts', revision: stableRevision }

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

vi.mock('../api/tasks', () => ({
  productTasksApi: apiMocks,
}))

import { ProductTaskReviewDock } from './ProductTaskReviewDock'
import { ProductApiError } from '../api/client'

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
    fileRef: stableFileRef,
    previewType: 'text',
    content: 'export const ready = true',
    language: 'typescript',
    size: 24,
  })
  apiMocks.getReviewDiff.mockReset().mockResolvedValue({
    taskId: 'task-1',
    state: 'ok',
    path: 'src/main.ts',
    fileRef: stableFileRef,
    diff: '@@ -1,1 +1,1 @@\n-export const ready = false\n+export const ready = true',
  })
  apiMocks.getReviewComments.mockReset().mockResolvedValue({
    taskId: 'task-1',
    fileRef: stableFileRef,
    comments: [],
  })
  apiMocks.createReviewComment.mockReset()
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
    expect(apiMocks.getReviewDiff).toHaveBeenCalledWith('task-1', 'src/main.ts', stableRevision)
    expect(apiMocks.getReviewComments).toHaveBeenCalledWith('task-1', stableFileRef)
    expect(screen.getByText('+export const ready = true')).toBeTruthy()
  })

  it('renders revision-scoped line comments and saves a new-side comment', async () => {
    apiMocks.getReviewComments.mockResolvedValue({
      taskId: 'task-1',
      fileRef: stableFileRef,
      comments: [{
        commentId: 'comment_existing',
        taskId: 'task-1',
        fileRef: stableFileRef,
        side: 'old',
        line: 1,
        body: '旧实现需要删除',
        createdAt: '2026-07-24T00:00:00.000Z',
      }],
    })
    apiMocks.createReviewComment.mockImplementation(async (_taskId: string, input: {
      body: string
      client_operation_id: string
    }) => ({
      outcome: 'accepted',
      authorityRevision: 8,
      comment: {
        commentId: 'comment_new',
        taskId: 'task-1',
        fileRef: stableFileRef,
        side: 'new',
        line: 1,
        body: input.body,
        createdAt: '2026-07-24T00:01:00.000Z',
      },
    }))

    render(<ProductTaskReviewDock taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('src/main.ts'))

    expect(await screen.findByText('旧实现需要删除')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '在新文件第 1 行添加批注' }))
    fireEvent.change(screen.getByRole('textbox', { name: '在新文件第 1 行添加批注' }), { target: { value: '这里需要补测试' } })
    fireEvent.click(screen.getByRole('button', { name: '保存批注' }))

    expect(await screen.findByText('这里需要补测试')).toBeTruthy()
    expect(apiMocks.createReviewComment).toHaveBeenCalledWith('task-1', {
      file_ref: { file_id: stableFileRef.fileId, path: stableFileRef.path, revision: stableFileRef.revision },
      side: 'new',
      line: 1,
      body: '这里需要补测试',
      client_operation_id: expect.any(String),
    })
  })

  it('retries an uncertain comment save with the same operation id', async () => {
    apiMocks.createReviewComment
      .mockRejectedValueOnce(new Error('request timeout'))
      .mockImplementationOnce(async (_taskId: string, input: { body: string }) => ({
        outcome: 'duplicate',
        authorityRevision: 8,
        comment: {
          commentId: 'comment_retry',
          taskId: 'task-1',
          fileRef: stableFileRef,
          side: 'new',
          line: 1,
          body: input.body,
          createdAt: '2026-07-24T00:01:00.000Z',
        },
      }))

    render(<ProductTaskReviewDock taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('src/main.ts'))
    await screen.findByRole('button', { name: '在新文件第 1 行添加批注' })
    fireEvent.click(screen.getByRole('button', { name: '在新文件第 1 行添加批注' }))
    fireEvent.change(screen.getByRole('textbox', { name: '在新文件第 1 行添加批注' }), { target: { value: '幂等重试' } })
    fireEvent.click(screen.getByRole('button', { name: '保存批注' }))

    fireEvent.click(await screen.findByRole('button', { name: '重试保存' }))
    expect(await screen.findByText('幂等重试')).toBeTruthy()
    const firstInput = apiMocks.createReviewComment.mock.calls[0]![1]
    const retryInput = apiMocks.createReviewComment.mock.calls[1]![1]
    expect(retryInput.client_operation_id).toBe(firstInput.client_operation_id)
    expect(retryInput).toEqual(firstInput)
  })

  it('shows a stale revision state when comments cannot attach to the loaded diff', async () => {
    apiMocks.getReviewComments.mockRejectedValueOnce(new ProductApiError(409, { error: 'AUTHORITY_CONFLICT' }))

    render(<ProductTaskReviewDock taskId="task-1" onClose={vi.fn()} />)
    fireEvent.click(await screen.findByText('src/main.ts'))

    expect(await screen.findByText('文件版本已变化，请重新读取后审阅批注。')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重新读取' })).toBeTruthy()
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

  it('keeps the latest directory when an earlier tree request returns late', async () => {
    const firstTree = deferred<Record<string, unknown>>()
    apiMocks.getReviewTree.mockImplementation((_taskId: string, path?: string) => {
      if (path === 'src') return firstTree.promise
      if (path === 'docs') {
        return Promise.resolve({
          taskId: 'task-1',
          state: 'ok',
          path,
          entries: [{ name: 'notes.md', path: 'docs/notes.md', isDirectory: false }],
        })
      }
      return Promise.resolve({
        taskId: 'task-1',
        state: 'ok',
        path: '',
        entries: [
          { name: 'src', path: 'src', isDirectory: true },
          { name: 'docs', path: 'docs', isDirectory: true },
        ],
      })
    })

    render(<ProductTaskReviewDock taskId="task-1" onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('src'))
    fireEvent.click(screen.getByText('docs'))

    expect(await screen.findByText('notes.md')).toBeTruthy()

    await act(async () => {
      firstTree.resolve({
        taskId: 'task-1',
        state: 'ok',
        path: 'src',
        entries: [{ name: 'stale.ts', path: 'src/stale.ts', isDirectory: false }],
      })
      await Promise.resolve()
    })

    expect(screen.getByText('notes.md')).toBeTruthy()
    expect(screen.queryByText('stale.ts')).toBeNull()
  })

  it('contains a failed directory request in a retryable task-scoped state', async () => {
    let reportsAttempts = 0
    apiMocks.getReviewTree.mockImplementation(async (_taskId: string, path?: string) => {
      if (path === 'reports') {
        reportsAttempts += 1
        if (reportsAttempts === 1) throw new Error('workspace service unavailable')
        return {
          taskId: 'task-1',
          state: 'ok',
          path,
          entries: [{ name: 'daily.md', path: 'reports/daily.md', isDirectory: false }],
        }
      }
      return {
        taskId: 'task-1',
        state: 'ok',
        path: path ?? '',
        entries: path
          ? []
          : [{ name: 'reports', path: 'reports', isDirectory: true }],
      }
    })

    render(<ProductTaskReviewDock taskId="task-1" onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('reports'))

    expect(await screen.findByText('当前目录暂时无法读取。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重新读取当前目录' }))
    expect(await screen.findByText('daily.md')).toBeTruthy()
    expect(reportsAttempts).toBe(2)
  })

  it('keeps the latest file selection when an earlier file and diff request returns late', async () => {
    const firstFile = deferred<Record<string, unknown>>()
    const firstDiff = deferred<Record<string, unknown>>()
    apiMocks.getReviewTree.mockResolvedValue({
      taskId: 'task-1',
      state: 'ok',
      path: '',
      entries: [
        { name: 'first.ts', path: 'src/first.ts', isDirectory: false },
        { name: 'second.ts', path: 'src/second.ts', isDirectory: false },
      ],
    })
    apiMocks.getReviewFile.mockImplementation((_taskId: string, path: string) => (
      path === 'src/first.ts'
        ? firstFile.promise
        : Promise.resolve({
            taskId: 'task-1',
            state: 'ok',
            path,
            previewType: 'text',
            content: 'export const selected = "second"',
            language: 'typescript',
            size: 32,
          })
    ))
    apiMocks.getReviewDiff.mockImplementation((_taskId: string, path: string) => (
      path === 'src/first.ts'
        ? firstDiff.promise
        : Promise.resolve({
            taskId: 'task-1',
            state: 'ok',
            path,
            diff: '+export const selected = "second"',
          })
    ))

    render(<ProductTaskReviewDock taskId="task-1" onClose={vi.fn()} />)

    fireEvent.click(await screen.findByText('first.ts'))
    fireEvent.click(screen.getByText('second.ts'))

    expect(await screen.findByText('export const selected = "second"')).toBeTruthy()

    await act(async () => {
      firstFile.resolve({
        taskId: 'task-1',
        state: 'ok',
        path: 'src/first.ts',
        previewType: 'text',
        content: 'export const selected = "first"',
        language: 'typescript',
        size: 31,
      })
      firstDiff.resolve({
        taskId: 'task-1',
        state: 'ok',
        path: 'src/first.ts',
        diff: '+export const selected = "first"',
      })
      await Promise.resolve()
    })

    expect(screen.getByText('export const selected = "second"')).toBeTruthy()
    expect(screen.queryByText('export const selected = "first"')).toBeNull()
    expect(screen.getByText('+export const selected = "second"')).toBeTruthy()
    expect(screen.queryByText('+export const selected = "first"')).toBeNull()
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
    expect(apiMocks.getReviewDiff).toHaveBeenCalledWith('task-1', 'assets/replay.webm', undefined)

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
