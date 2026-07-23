import { describe, expect, it } from 'bun:test'
import { ProductTaskReviewService } from '../product/taskReviewService.js'

const taskId = 'task-1'
const coreSessionId = 'core-session-secret-17'

function createService() {
  const calls: Array<{
    name: string
    sessionId: string
    path?: string
    maxImagePreviewBytes?: number
    maxVideoPreviewBytes?: number
  }> = []
  const workspace = {
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
        diff: 'diff --git a/src/price.ts b/src/price.ts',
      }
    },
  }
  const service = new ProductTaskReviewService(
    { requireWorkspaceCapability: async () => ({ canonical_root: '/private/workspaces/hall-operations' }), resolveCoreSessionId: async (id) => {
      expect(id).toBe(taskId)
      return coreSessionId
    } },
    workspace,
    async () => '/private/workspaces/hall-operations',
  )

  return { calls, service }
}

describe('ProductTaskReviewService', () => {
  it('adapts the Core workspace internally and returns only product review data', async () => {
    const { calls, service } = createService()

    const [status, tree, file, diff] = await Promise.all([
      service.getStatus(taskId),
      service.getTree(taskId, 'src'),
      service.getFile(taskId, 'src/price.ts'),
      service.getDiff(taskId, 'src/price.ts'),
    ])

    expect(calls).toEqual([
      { name: 'status', sessionId: coreSessionId },
      { name: 'tree', sessionId: coreSessionId, path: 'src' },
      {
        name: 'file',
        sessionId: coreSessionId,
        path: 'src/price.ts',
        maxImagePreviewBytes: 8 * 1024 * 1024,
        maxVideoPreviewBytes: 16 * 1024 * 1024,
      },
      { name: 'diff', sessionId: coreSessionId, path: 'src/price.ts' },
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
    })
    expect(diff).toMatchObject({ taskId, state: 'ok', path: 'src/price.ts' })

    const publicJson = JSON.stringify({ status, tree, file, diff })
    expect(publicJson).not.toContain(coreSessionId)
    expect(publicJson).not.toContain('/private/workspaces/hall-operations')
    expect(status).not.toHaveProperty('workDir')
  })

  it('caps image previews before the workspace service reads the image bytes', async () => {
    const { calls, service } = createService()

    await expect(service.getFile(taskId, 'assets/large.png')).resolves.toEqual({
      taskId,
      state: 'too_large',
      path: 'assets/large.png',
      mimeType: 'image/png',
      language: 'image',
      size: 8 * 1024 * 1024 + 1,
    })
    expect(calls).toEqual([{
      name: 'file',
      sessionId: coreSessionId,
      path: 'assets/large.png',
      maxImagePreviewBytes: 8 * 1024 * 1024,
      maxVideoPreviewBytes: 16 * 1024 * 1024,
    }])
  })

  it('projects an explicitly bounded task video preview without exposing its Core workspace', async () => {
    const { calls, service } = createService()

    const file = await service.getFile(taskId, 'assets/replay.webm')
    expect(file).toEqual({
      taskId,
      state: 'ok',
      path: 'assets/replay.webm',
      previewType: 'video',
      dataUrl: 'data:video/webm;base64,AAAA',
      mimeType: 'video/webm',
      language: 'video',
      size: 3,
    })
    expect(JSON.stringify(file)).not.toContain(coreSessionId)
    expect(JSON.stringify(file)).not.toContain('/private/')
    expect(calls).toEqual([{
      name: 'file',
      sessionId: coreSessionId,
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

  it('rejects a missing Core cwd before invoking the review workspace', async () => {
    let calls = 0
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/workspace/bound' }), resolveCoreSessionId: async () => coreSessionId },
      { getStatus: async () => { calls += 1; return { state: 'missing' as const, workDir: '/workspace/bound', repoName: null, branch: null, isGitRepo: false, changedFiles: [] } }, readTree: async () => ({ state: 'missing' as const, path: '', entries: [] }), readFile: async () => ({ state: 'missing' as const, path: '', language: 'text', size: 0 }), getDiff: async () => ({ state: 'missing' as const, path: '' }) },
      async () => undefined,
    )
    await expect(service.getStatus(taskId)).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRED' })
    expect(calls).toBe(0)
  })

  it('rejects an old Core cwd from another workspace before review downstream', async () => {
    let calls = 0
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/workspace/bound' }), resolveCoreSessionId: async () => coreSessionId },
      { getStatus: async () => { calls += 1; return { state: 'missing' as const, workDir: '/workspace/bound', repoName: null, branch: null, isGitRepo: false, changedFiles: [] } }, readTree: async () => ({ state: 'missing' as const, path: '', entries: [] }), readFile: async () => ({ state: 'missing' as const, path: '', language: 'text', size: 0 }), getDiff: async () => ({ state: 'missing' as const, path: '' }) },
      async () => '/workspace/old',
    )
    await expect(service.getStatus(taskId)).rejects.toMatchObject({ code: 'WORKSPACE_REQUIRED' })
    expect(calls).toBe(0)
  })

  it('filters version-control metadata from product status and tree results', async () => {
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/private/workspaces/hall-operations' }), resolveCoreSessionId: async () => coreSessionId },
      {
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
      { requireWorkspaceCapability: async () => ({ canonical_root: '/private/workspaces/hall-operations' }), resolveCoreSessionId: async () => coreSessionId },
      {
        getStatus: async () => ({
          state: 'error' as const,
          workDir: '/private/workspaces/hall-operations',
          repoName: null,
          branch: null,
          isGitRepo: false,
          changedFiles: [],
          error: `failed for ${coreSessionId}`,
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
      language: 'typescript',
      size: 0,
    })
    expect(diff).toEqual({ taskId, state: 'unavailable', path: 'src/price.ts' })
    expect(JSON.stringify({ status, tree, file, diff })).not.toContain('/private/')
    expect(JSON.stringify({ status, tree, file, diff })).not.toContain(coreSessionId)
  })

  it('keeps a workspace-boundary failure forbidden even when diff generation reports it as a result', async () => {
    const service = new ProductTaskReviewService(
      { requireWorkspaceCapability: async () => ({ canonical_root: '/private/workspaces/hall-operations' }), resolveCoreSessionId: async () => coreSessionId },
      {
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
