import * as path from 'node:path'
import type {
  ProductTaskReviewDiff,
  ProductTaskReviewFile,
  ProductTaskReviewStatus,
  ProductTaskReviewTree,
} from '../../../shared/product/taskReview.js'
import { ApiError } from '../middleware/errorHandler.js'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import {
  WorkspaceService,
  type WorkspaceDiffResult,
  type WorkspaceReadFileOptions,
  type WorkspaceReadFileResult,
  type WorkspaceStatusResult,
  type WorkspaceTreeResult,
} from '../services/workspaceService.js'
import { productTaskService, type ProductTaskService } from './taskService.js'

const MAX_PRODUCT_TASK_REVIEW_IMAGE_BYTES = 8 * 1024 * 1024

type TaskResolver = Pick<ProductTaskService, 'resolveCoreSessionId'>
type TaskReviewWorkspace = Pick<WorkspaceService, 'getStatus' | 'readTree' | 'getDiff'> & {
  readFile(
    sessionId: string,
    filePath: string,
    options?: WorkspaceReadFileOptions,
  ): Promise<WorkspaceReadFileResult>
}

/**
 * A task-scoped adapter over the existing WorkspaceService.
 *
 * The Core session id is resolved only for the call into WorkspaceService and
 * is never included in a public result. The projection also removes absolute
 * work-directory paths and implementation error text from that service.
 */
export class ProductTaskReviewService {
  constructor(
    private readonly tasks: TaskResolver,
    private readonly workspace: TaskReviewWorkspace,
  ) {}

  async getStatus(taskId: string): Promise<ProductTaskReviewStatus> {
    const status = await this.withTaskWorkspace(taskId, (sessionId) => (
      this.workspace.getStatus(sessionId)
    ))
    return projectStatus(taskId, status)
  }

  async getTree(taskId: string, requestedPath = ''): Promise<ProductTaskReviewTree> {
    const treePath = normalizeReviewPath(requestedPath, { required: false })
    const tree = await this.withTaskWorkspace(taskId, (sessionId) => (
      this.workspace.readTree(sessionId, treePath)
    ))
    return projectTree(taskId, tree)
  }

  async getFile(taskId: string, requestedPath: string): Promise<ProductTaskReviewFile> {
    const filePath = normalizeReviewPath(requestedPath, { required: true })
    const file = await this.withTaskWorkspace(taskId, (sessionId) => (
      this.workspace.readFile(sessionId, filePath, {
        maxImagePreviewBytes: MAX_PRODUCT_TASK_REVIEW_IMAGE_BYTES,
      })
    ))
    return projectFile(taskId, file)
  }

  async getDiff(taskId: string, requestedPath: string): Promise<ProductTaskReviewDiff> {
    const filePath = normalizeReviewPath(requestedPath, { required: true })
    const diff = await this.withTaskWorkspace(taskId, (sessionId) => (
      this.workspace.getDiff(sessionId, filePath)
    ))
    if (diff.state === 'error' && diff.error?.includes('outside workspace')) {
      throw new ApiError(403, '路径不在当前任务工作区内', 'FORBIDDEN')
    }
    return projectDiff(taskId, diff)
  }

  private async withTaskWorkspace<T>(
    taskId: string,
    operation: (sessionId: string) => Promise<T>,
  ): Promise<T> {
    let sessionId: string
    try {
      sessionId = await this.tasks.resolveCoreSessionId(taskId)
    } catch (error) {
      throw reviewApiError(error)
    }

    try {
      return await operation(sessionId)
    } catch (error) {
      throw reviewApiError(error)
    }
  }
}

const workspaceService = new WorkspaceService(
  async (sessionId) => (
    conversationService.getSessionWorkDir(sessionId) ||
    await sessionService.getSessionWorkDir(sessionId)
  ),
  async (sessionId) => sessionService.getSessionMessages(sessionId),
  async (sessionId) => sessionService.getSessionFileHistorySnapshots(sessionId),
)

export const productTaskReviewService = new ProductTaskReviewService(
  productTaskService,
  workspaceService,
)

function projectStatus(taskId: string, status: WorkspaceStatusResult): ProductTaskReviewStatus {
  if (status.state !== 'ok') {
    return {
      taskId,
      state: 'unavailable',
      repository: null,
      changedFiles: [],
    }
  }

  return {
    taskId,
    state: 'ready',
    repository: {
      name: status.repoName ?? '当前项目',
      branch: status.branch,
      isGitRepository: status.isGitRepo,
    },
    changedFiles: status.changedFiles.map((file) => ({
      path: file.path,
      ...(file.oldPath ? { oldPath: file.oldPath } : {}),
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
  }
}

function projectTree(taskId: string, tree: WorkspaceTreeResult): ProductTaskReviewTree {
  if (tree.state === 'error') {
    return { taskId, state: 'unavailable', path: tree.path, entries: [] }
  }

  return {
    taskId,
    state: tree.state,
    path: tree.path,
    entries: tree.entries.map((entry) => ({
      name: entry.name,
      path: entry.path,
      isDirectory: entry.isDirectory,
    })),
  }
}

function projectFile(taskId: string, file: WorkspaceReadFileResult): ProductTaskReviewFile {
  if (file.state === 'error') {
    return {
      taskId,
      state: 'unavailable',
      path: file.path,
      language: file.language,
      size: file.size,
    }
  }

  return {
    taskId,
    state: file.state,
    path: file.path,
    ...(file.previewType ? { previewType: file.previewType } : {}),
    ...(typeof file.content === 'string' ? { content: file.content } : {}),
    ...(typeof file.dataUrl === 'string' ? { dataUrl: file.dataUrl } : {}),
    ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    language: file.language,
    size: file.size,
    ...(file.truncated === undefined ? {} : { truncated: file.truncated }),
    ...(file.readBytes === undefined ? {} : { readBytes: file.readBytes }),
  }
}

function projectDiff(taskId: string, diff: WorkspaceDiffResult): ProductTaskReviewDiff {
  const state = diff.state === 'not_git_repo'
    ? 'not_versioned'
    : diff.state === 'error'
      ? 'unavailable'
      : diff.state

  return {
    taskId,
    state,
    path: diff.path,
    ...(typeof diff.diff === 'string' ? { diff: diff.diff } : {}),
  }
}

function normalizeReviewPath(
  value: string,
  options: { required: boolean },
): string {
  if (typeof value !== 'string') {
    throw ApiError.badRequest('审阅路径必须是字符串')
  }
  const trimmed = value.trim()
  if (!trimmed) {
    if (options.required) {
      throw ApiError.badRequest('审阅文件需要 path 参数')
    }
    return ''
  }
  if (trimmed.length > 4_096) {
    throw ApiError.badRequest('审阅路径过长')
  }

  const normalized = trimmed.replace(/\\/g, '/')
  if (
    normalized.startsWith('/') ||
    normalized.startsWith('//') ||
    path.win32.isAbsolute(trimmed) ||
    normalized.split('/').some((segment) => segment === '..')
  ) {
    throw new ApiError(403, '路径不在当前任务工作区内', 'FORBIDDEN')
  }

  return normalized
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')
}

function reviewApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    if (error.statusCode === 400 || error.statusCode === 403) return error
    if (error.statusCode === 404) return ApiError.notFound('任务或其工作区不存在')
  }

  if (error instanceof Error && error.message.includes('outside workspace')) {
    return new ApiError(403, '路径不在当前任务工作区内', 'FORBIDDEN')
  }
  if (error instanceof Error && error.message.startsWith('Session not found:')) {
    return ApiError.notFound('任务或其工作区不存在')
  }

  return new ApiError(503, '任务审阅暂不可用', 'PRODUCT_TASK_REVIEW_UNAVAILABLE')
}
