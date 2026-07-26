import { describe, expect, it } from 'bun:test'
import { ProductTaskReviewService } from '../product/taskReviewService.js'

const taskId = 'task-1'
const stableRevision = `rev_${'a'.repeat(32)}`

function createService() {
  const commentWrites: Array<Record<string, unknown>> = []
  const calls: Array<{
    name: string
    sessionId: string
    path?: string
    maxImagePreviewBytes?: number
    maxVideoPreviewBytes?: number
  }> = []
  const workspace = {
    async getFileRevision(_sessionId: string, filePath: string) {
      return { state: 'ok' as const, path: filePath, revision: stableRevision }
    },
    async getStatus(sessionId: string) {
      calls.push({ name: 'status', sessionId })
      return {
        state: 'ok' as const,
        workDir: '/private/workspaces/hall-operations',
        repoName: 'hall-operations',
        branch: 'feature/review',
        isGitRepo: true,
        changedFiles: [
          {
            path: 'src/price.ts',
            status: 'modified' as const,
            additions: 4,
            deletions: 1,
          },
        ],
      }
    },
    async readTree(sessionId: string, filePath: string) {
      calls.push({ name: 'tree', sessionId, path: filePath })
      return {
        state: 'ok' as const,
        path: filePath,
        entries: [{ name: 'price.ts', path: 'src/price.ts', isDirectory: false }],
      }
    },
    async readFile(
      sessionId: string,
      filePath: string,
      options?: { maxImagePreviewBytes?: number; maxVideoPreviewBytes?: number },
    ) {
      calls.push({
        name: 'file',
        sessionId,
        path: filePath,
        maxImagePreviewBytes: options?.maxImagePreviewBytes,
        maxVideoPreviewBytes: options?.maxVideoPreviewBytes,
      })
      if (filePath === 'assets/large.png') {
        return {
          state: 'too_large' as const,
          path: filePath,
          mimeType: 'image/png',
          language: 'image',
          size: 8 * 1024 * 1024 + 1,
        }
      }
      if (filePath === 'assets/replay.webm') {
        return {
          state: 'ok' as const,
          path: filePath,
          previewType: 'video' as const,
          dataUrl: 'data:video/webm;base64,AAAA',
          mimeType: 'video/webm',
          language: 'video',
          size: 3,
        }
      }
      return {
        state: 'ok' as const,
        path: filePath,
        previewType: 'text' as const,
        content: 'export const hourlyRate = 48\n',
        language: 'typescript',
        size: 30,
      }
    },
    async getDiff(sessionId: string, filePath: string) {
      calls.push({ name: 'diff', sessionId, path: filePath })
      return {
        state: 'ok' as const,
        path: filePath,
        diff: 'diff --git a/src/price.ts b/src/price.ts\n@@ -1,2 +1,2 @@\n-old rate\n+new rate\n context',
      }
    },
  }
  const service = new ProductTaskReviewService(
    {
      requireWorkspaceCapability: async () => ({ canonical_root: '/private/workspaces/hall-operations' }),
      listReviewComments: async () => [],
      createReviewComment: async (input) => {
        commentWrites.push(input)
        return {
          outcome: 'accepted' as const,
          authorityRevision: 4,
          comment: {
            commentId: 'comment_aaaaaaaaaaaaaaaaaaaa',
            taskId: input.taskId,
            fileRef: input.fileRef,
            side: input.side,
            line: input.line,
            body: input.body,
            createdAt: '2026-07-24T00:00:00.000Z',
          },
        }
      },
    },
    workspace,
    async () => '/private/workspaces/hall-operations',
  )

  return { calls, commentWrites, service }
}

describe('ProductTaskReviewService', () => {
  it('uses the ProductTask workspace key and returns only product review data', async () => {
    const { calls, service } = createService()

    const [status, tree, file, diff] = await Promise.all([
      service.getStatus(taskId),
      service.getTree(taskId, 'src'),
      service.getFile(taskId, 'src/price.ts'),
      service.getDiff(taskId, 'src/price.ts'),
    ])

    expect(calls).toEqual([
      { name: 'status', sessionId: taskId },
      { name: 'tree', sessionId: taskId, path: 'src' },
      {
        name: 'file',
        sessionId: taskId,
        path: 'src/price.ts',
        maxImagePreviewBytes: 8 * 1024 * 1024,
        maxVideoPreviewBytes: 16 * 1024 * 1024,
      },
      { name: 'diff', sessionId: taskId, path: 'src/price.ts' },
    ])
    expect(status).toEqual({
      taskId,
      state: 'ready',
      repository: {
        name: 'hall-operations',
        branch: 'feature/review',
        isGitRepository: true,
      },
      changedFiles: [{
        path: 'src/price.ts',
        status: 'modified',
        additions: 4,
        deletions: 1,
      }],
    })
    expect(tree).toMatchObject({ taskId, state: 'ok', path: 'src' })
    expect(file).toMatchObject({
      taskId,
      state: 'ok',
      path: 'src/price.ts',
      content: 'export const hourlyRate = 48\n',
      fileRef: { path: 'src/price.ts', revision: stableRevision },
    })
    expect(diff).toMatchObject({ taskId, state: 'ok', path: 'src/price.ts', fileRef: { revision: stableRevision } })

    const publicJson = JSON.stringify({ status, tree, file, diff })
    expect(publicJson).not.toContain('/private/workspaces/hall-operations')
    expect(status).not.toHaveProperty('workDir')
  })

  it('caps image previews before the workspace service reads the image bytes', async () => {
    const { calls, service } = createService()

    await expect(service.getFile(taskId, 'assets/large.png')).resolves.toEqual({
      taskId,
      state: 'too_large',
      path: 'assets/large.png',
      fileRef: { fileId: expect.stringMatching(/^file_[a-f0-9]{20}$/), path: 'assets/large.png', revision: stableRevision },
      mimeType: 'image/png',
      language: 'image',
      size: 8 * 1024 * 1024 + 1,
    })
    expect(calls).toEqual([{
      name: 'file',
      sessionId: taskId,
      path: 'assets/large.png',
      maxImagePreviewBytes: 8 * 1024 * 1024,
      maxVideoPreviewBytes: 16 * 1024 * 1024,
    }])
  })

  it('projects an explicitly bounded task video preview without exposing its workspace path', async () => {
    const { calls, service } = createService()

    const file = await service.getFile(taskId, 'assets/replay.webm')
    expect(file).toEqual({
      taskId,
      state: 'ok',
      path: 'assets/replay.webm',
      fileRef: { fileId: expect.stringMatching(/^file_[a-f0-9]{20}$/), path: 'assets/replay.webm', revision: stableRevision },
      previewType: 'video',
      dataUrl: 'data:video/webm;base64,AAAA',
      mimeType: 'video/webm',
      language: 'video',
      size: 3,
    })
    expect(JSON.stringify(file)).not.toContain('/private/')
    expect(calls).toEqual([{
      name: 'file',
      sessionId: taskId,
      path: 'assets/replay.webm',
      maxImagePreviewBytes: 8 * 1024 * 1024,
      maxVideoPreviewBytes: 16 * 1024 * 1024,
    }])
  })

  it('rejects absolute and traversal review paths before calling the workspace service', async () => {
    const { calls, service } = createService()

    for (const filePath of ['/private/secret.txt', '../secret.txt', 'src/../secret.txt', 'C:\\secret.txt']) {
      await expect(service.getFile(taskId, filePath)).rejects.toMatchObject({
        statusCode: 403,
        code: 'FORBIDDEN',
      })
    }

    expect(calls).toEqual([])
  })

  it('keeps version-control internals outside the product review surface', async () => {
    const { calls, service } = createService()

    await expect(service.getTree(taskId, '.git')).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    })
    await expect(service.getFile(taskId, '.git/config')).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    })
    await expect(service.getDiff(taskId, 'src/.SVN/entries')).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    })

    expect(calls).toEqual([])
  })

  it('returns a controlled stale file instead of mixing two workspace revisions', async () => {
    const revisions = [`rev_${'1'.repeat(32)}`, `rev_${'2'.repeat(32)}`]
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/workspace/bound' }) },
      {
        getStatus: async () => ({ state: 'missing' as const, workDir: '/workspace/bound', repoName: null, branch: null, isGitRepo: false, changedFiles: [] }),
        readTree: async () => ({ state: 'missing' as const, path: '', entries: [] }),
        getFileRevision: async (_sessionId, filePath) => ({ state: 'ok' as const, path: filePath, revision: revisions.shift()! }),
        readFile: async (_sessionId, filePath) => ({ state: 'ok' as const, path: filePath, previewType: 'text' as const, content: 'mixed content', language: 'text', size: 13 }),
        getDiff: async (_sessionId, filePath) => ({ state: 'missing' as const, path: filePath }),
      },
      async () => '/workspace/bound',
    )

    const result = await service.getFile(taskId, 'notes.txt')
    expect(result).toMatchObject({
      taskId,
      state: 'stale',
      path: 'notes.txt',
      fileRef: { revision: `rev_${'2'.repeat(32)}` },
    })
    expect(result).not.toHaveProperty('content')
  })

  it('rejects an old expected revision before generating a new diff', async () => {
    let diffCalls = 0
    const currentRevision = `rev_${'2'.repeat(32)}`
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/workspace/bound' }) },
      {
        getStatus: async () => ({ state: 'missing' as const, workDir: '/workspace/bound', repoName: null, branch: null, isGitRepo: false, changedFiles: [] }),
        readTree: async () => ({ state: 'missing' as const, path: '', entries: [] }),
        getFileRevision: async (_sessionId, filePath) => ({ state: 'ok' as const, path: filePath, revision: currentRevision }),
        readFile: async (_sessionId, filePath) => ({ state: 'missing' as const, path: filePath, language: 'text', size: 0 }),
        getDiff: async (_sessionId, filePath) => { diffCalls += 1; return { state: 'ok' as const, path: filePath, diff: '+new' } },
      },
      async () => '/workspace/bound',
    )

    await expect(service.getDiff(taskId, 'notes.txt', `rev_${'1'.repeat(32)}`)).resolves.toMatchObject({
      taskId,
      state: 'stale',
      fileRef: { revision: currentRevision },
    })
    expect(diffCalls).toBe(0)
    await expect(service.getDiff(taskId, 'notes.txt', 'old')).rejects.toMatchObject({ statusCode: 400 })
  })

  it('gives a deleted-file diff a stable ref derived from its bounded diff', async () => {
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/workspace/bound' }) },
      {
        getStatus: async () => ({ state: 'missing' as const, workDir: '/workspace/bound', repoName: null, branch: null, isGitRepo: false, changedFiles: [] }),
        readTree: async () => ({ state: 'missing' as const, path: '', entries: [] }),
        getFileRevision: async (_sessionId, filePath) => ({ state: 'missing' as const, path: filePath }),
        readFile: async (_sessionId, filePath) => ({ state: 'missing' as const, path: filePath, language: 'text', size: 0 }),
        getDiff: async (_sessionId, filePath) => ({ state: 'ok' as const, path: filePath, diff: '-deleted line' }),
      },
      async () => '/workspace/bound',
    )

    const first = await service.getDiff(taskId, 'deleted.txt')
    expect(first.state).toBe('ok')
    expect(first.fileRef?.path).toBe('deleted.txt')
    expect(first.fileRef?.fileId).toMatch(/^file_[a-f0-9]{20}$/)
    const deletedRevision = first.fileRef?.revision
    expect(deletedRevision).toMatch(/^rev_[a-f0-9]{32}$/)
    const second = await service.getDiff(taskId, 'deleted.txt', deletedRevision)
    expect(second).toEqual(first)
  })

  it('accepts only current unified-diff line identities before persisting a comment', async () => {
    const { commentWrites, service } = createService()
    const diff = await service.getDiff(taskId, 'src/price.ts')
    expect(diff.fileRef).toBeDefined()

    const created = await service.createComment({
      taskId,
      fileRef: diff.fileRef!,
      side: 'new',
      line: 1,
      body: '  请确认新价格  ',
      clientOperationId: 'review-comment-1',
    })
    expect(created).toMatchObject({ outcome: 'accepted', comment: { body: '请确认新价格', side: 'new', line: 1 } })
    expect(commentWrites).toHaveLength(1)

    await expect(service.createComment({
      taskId,
      fileRef: diff.fileRef!,
      side: 'old',
      line: 1,
      body: '旧价格也需要说明',
      clientOperationId: 'review-comment-old',
    })).resolves.toMatchObject({ comment: { side: 'old', line: 1 } })
    expect(commentWrites).toHaveLength(2)

    await expect(service.createComment({
      taskId,
      fileRef: diff.fileRef!,
      side: 'new',
      line: 3,
      body: '越界',
      clientOperationId: 'review-comment-2',
    })).rejects.toMatchObject({ statusCode: 400 })
    await expect(service.createComment({
      taskId,
      fileRef: { ...diff.fileRef!, revision: `rev_${'b'.repeat(32)}` },
      side: 'old',
      line: 1,
      body: '旧版本',
      clientOperationId: 'review-comment-3',
    })).rejects.toMatchObject({ statusCode: 409 })
    expect(commentWrites).toHaveLength(2)

    await expect(service.getComments(taskId, 'src/price.ts', stableRevision)).resolves.toMatchObject({
      taskId,
      fileRef: { revision: stableRevision },
      comments: [],
    })
  })

  it('rejects a missing task workspace before invoking the review reader', async () => {
    let calls = 0
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/workspace/bound' }) },
      { getStatus: async () => { calls += 1; return { state: 'missing' as const, workDir: '/workspace/bound', repoName: null, branch: null, isGitRepo: false, changedFiles: [] } }, readTree: async () => ({ state: 'missing' as const, path: '', entries: [] }), readFile: async () => ({ state: 'missing' as const, path: '', language: 'text', size: 0 }), getDiff: async () => ({ state: 'missing' as const, path: '' }), getFileRevision: async () => ({ state: 'missing' as const, path: '' }) },
      async () => undefined,
    )
    await expect(service.getStatus(taskId)).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRED' })
    expect(calls).toBe(0)
  })

  it('rejects a stale task directory from another workspace before review downstream', async () => {
    let calls = 0
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/workspace/bound' }) },
      { getStatus: async () => { calls += 1; return { state: 'missing' as const, workDir: '/workspace/bound', repoName: null, branch: null, isGitRepo: false, changedFiles: [] } }, readTree: async () => ({ state: 'missing' as const, path: '', entries: [] }), readFile: async () => ({ state: 'missing' as const, path: '', language: 'text', size: 0 }), getDiff: async () => ({ state: 'missing' as const, path: '' }), getFileRevision: async () => ({ state: 'missing' as const, path: '' }) },
      async () => '/workspace/old',
    )
    await expect(service.getStatus(taskId)).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRED' })
    expect(calls).toBe(0)
  })

  it('filters version-control metadata from product status and tree results', async () => {
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/private/workspaces/hall-operations' }) },
      {
        getFileRevision: async (_sessionId: string, filePath: string) => ({ state: 'missing' as const, path: filePath }),
        getStatus: async () => ({
          state: 'ok' as const,
          workDir: '/private/workspaces/hall-operations',
          repoName: 'hall-operations',
          branch: null,
          isGitRepo: true,
          changedFiles: [
            { path: '.git', status: 'modified' as const, additions: 1, deletions: 0 },
            { path: 'src/.hg/store', status: 'modified' as const, additions: 1, deletions: 0 },
            { path: 'src/price.ts', status: 'modified' as const, additions: 4, deletions: 1 },
          ],
        }),
        readTree: async () => ({
          state: 'ok' as const,
          path: '',
          entries: [
            { name: '.git', path: '.git', isDirectory: false },
            { name: '.svn', path: '.svn', isDirectory: true },
            { name: 'src', path: 'src', isDirectory: true },
          ],
        }),
        readFile: async () => ({
          state: 'missing' as const,
          path: 'src/price.ts',
          language: 'typescript',
          size: 0,
        }),
        getDiff: async () => ({ state: 'missing' as const, path: 'src/price.ts' }),
      },
      async () => '/private/workspaces/hall-operations',
    )

    await expect(service.getStatus(taskId)).resolves.toMatchObject({
      changedFiles: [{ path: 'src/price.ts' }],
    })
    await expect(service.getTree(taskId)).resolves.toMatchObject({
      entries: [{ name: 'src', path: 'src' }],
    })
  })

  it('turns internal workspace failures into a generic product state', async () => {
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/private/workspaces/hall-operations' }) },
      {
        getFileRevision: async (_sessionId: string, filePath: string) => ({ state: 'error' as const, path: filePath, error: '/private/revision' }),
        getStatus: async () => ({
          state: 'error' as const,
          workDir: '/private/workspaces/hall-operations',
          repoName: null,
          branch: null,
          isGitRepo: false,
          changedFiles: [],
          error: 'failed for private binding',
        }),
        readTree: async () => ({ state: 'error' as const, path: '', entries: [], error: '/private/tree' }),
        readFile: async () => ({
          state: 'error' as const,
          path: 'src/price.ts',
          language: 'typescript',
          size: 0,
          error: '/private/file',
        }),
        getDiff: async () => ({
          state: 'error' as const,
          path: 'src/price.ts',
          error: '/private/diff',
        }),
      },
      async () => '/private/workspaces/hall-operations',
    )

    const [status, tree, file, diff] = await Promise.all([
      service.getStatus(taskId),
      service.getTree(taskId),
      service.getFile(taskId, 'src/price.ts'),
      service.getDiff(taskId, 'src/price.ts'),
    ])

    expect(status).toEqual({ taskId, state: 'unavailable', repository: null, changedFiles: [] })
    expect(tree).toEqual({ taskId, state: 'unavailable', path: '', entries: [] })
    expect(file).toEqual({
      taskId,
      state: 'unavailable',
      path: 'src/price.ts',
      language: 'text',
      size: 0,
    })
    expect(diff).toEqual({ taskId, state: 'unavailable', path: 'src/price.ts' })
    expect(JSON.stringify({ status, tree, file, diff })).not.toContain('/private/')
    expect(JSON.stringify({ status, tree, file, diff })).not.toContain('private binding')
  })

  it('keeps a workspace-boundary failure forbidden even when diff generation reports it as a result', async () => {
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/private/workspaces/hall-operations' }) },
      {
        getFileRevision: async (_sessionId: string, filePath: string) => ({ state: 'missing' as const, path: filePath }),
        getStatus: async () => ({
          state: 'ok' as const,
          workDir: '/private/workspaces/hall-operations',
          repoName: 'hall-operations',
          branch: null,
          isGitRepo: true,
          changedFiles: [],
        }),
        readTree: async () => ({ state: 'missing' as const, path: '', entries: [] }),
        readFile: async () => ({
          state: 'missing' as const,
          path: 'src/price.ts',
          language: 'typescript',
          size: 0,
        }),
        getDiff: async () => ({
          state: 'error' as const,
          path: 'src/price.ts',
          error: 'Path is outside workspace: src/price.ts',
        }),
      },
      async () => '/private/workspaces/hall-operations',
    )

    await expect(service.getDiff(taskId, 'src/price.ts')).rejects.toMatchObject({
      statusCode: 403,
      code: 'FORBIDDEN',
    })
  })
})
