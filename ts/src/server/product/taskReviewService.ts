import * as path from 'node:path'
import { createHash } from 'node:crypto'
import type {
  ProductTaskReviewDiff,
  ProductTaskReviewFile,
  ProductTaskReviewStatus,
  ProductTaskReviewTree,
  WorkspaceFileRef,
} from '../../../shared/product/taskReview.js'
import { ApiError } from '../middleware/errorHandler.js'
import { conversationService } from '../services/conversationService.js'
import { sessionService } from '../services/sessionService.js'
import {
  WorkspaceService,
  type WorkspaceDiffResult,
  type WorkspaceFileRevisionResult,
  type WorkspaceReadFileOptions,
  type WorkspaceReadFileResult,
  type WorkspaceStatusResult,
  type WorkspaceTreeResult,
} from '../services/workspaceService.js'
import { productTaskService, type ProductTaskService } from './taskService.js'

const MAX_PRODUCT_TASK_REVIEW_IMAGE_BYTES = 8 * 1024 * 1024
const MAX_PRODUCT_TASK_REVIEW_VIDEO_BYTES = 16 * 1024 * 1024
const VCS_METADATA_PATH_SEGMENTS = new Set(['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'])

type TaskResolver = Pick<ProductTaskService, 'resolveCoreSessionId' | 'requireWorkspaceCapability'>
type CoreWorkDirResolver = (sessionId: string) => Promise<string | undefined>
type TaskReviewWorkspace = Pick<WorkspaceService, 'getStatus' | 'readTree' | 'getDiff' | 'getFileRevision'> & {
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
    private readonly getSessionWorkDir: CoreWorkDirResolver,
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
    const result = await this.withTaskWorkspace(taskId, async (sessionId) => {
      const before = await this.workspace.getFileRevision(sessionId, filePath)
      const file = await this.workspace.readFile(sessionId, filePath, {
        maxImagePreviewBytes: MAX_PRODUCT_TASK_REVIEW_IMAGE_BYTES,
        maxVideoPreviewBytes: MAX_PRODUCT_TASK_REVIEW_VIDEO_BYTES,
      })
      const after = await this.workspace.getFileRevision(sessionId, filePath)
      return { before, file, after }
    })
    if (hasRevisionError(result.before, result.after)) {
      return unavailableFile(taskId, result.file.path)
    }
    if (!sameWorkspaceRevision(result.before, result.after)) {
      return staleFile(taskId, filePath, result.after)
    }
    return projectFile(taskId, result.file, createFileRef(taskId, filePath, result.after))
  }

  async getDiff(
    taskId: string,
    requestedPath: string,
    expectedRevision?: string,
  ): Promise<ProductTaskReviewDiff> {
    const filePath = normalizeReviewPath(requestedPath, { required: true })
    const revision = normalizeExpectedRevision(expectedRevision)
    const result = await this.withTaskWorkspace(taskId, async (sessionId) => {
      const before = await this.workspace.getFileRevision(sessionId, filePath)
      if (revision && before.state === 'ok' && before.revision !== revision) {
        return { before, after: before }
      }
      const diff = await this.workspace.getDiff(sessionId, filePath)
      const after = await this.workspace.getFileRevision(sessionId, filePath)
      return { before, diff, after }
    })
    if (!('diff' in result)) {
      return staleDiff(taskId, filePath, result.after)
    }
    if (result.diff.state === 'error' && result.diff.error?.includes('outside workspace')) {
      throw new ApiError(403, '路径不在当前任务工作区内', 'FORBIDDEN')
    }
    if (hasRevisionError(result.before, result.after)) {
      return unavailableDiff(taskId, result.diff.path)
    }
    if (!sameWorkspaceRevision(result.before, result.after)) {
      return staleDiff(taskId, filePath, result.after)
    }

    const fileRef = createFileRef(taskId, filePath, result.after)
      ?? createDiffFileRef(taskId, filePath, result.diff)
    if (revision && fileRef?.revision !== revision) {
      return staleDiff(taskId, filePath, result.after, fileRef)
    }
    return projectDiff(taskId, result.diff, fileRef)
  }

  private async withTaskWorkspace<T>(
    taskId: string,
    operation: (sessionId: string) => Promise<T>,
  ): Promise<T> {
    let sessionId: string
    try {
      // This is the sole Review boundary: never resolve a Core session/cwd
      // before the ProductTask-owned workspace capability is accepted.
      const workspace = await this.tasks.requireWorkspaceCapability(taskId, 'review')
      sessionId = await this.tasks.resolveCoreSessionId(taskId)
      const cwd = await this.getSessionWorkDir(sessionId)
      if (!cwd || path.resolve(cwd) !== path.resolve(workspace.canonical_root)) throw new ApiError(409, '任务工作区不可用', 'WORKSPACE_REQUIRED')
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
  async (sessionId) => conversationService.getSessionWorkDir(sessionId) || await sessionService.getSessionWorkDir(sessionId),
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
    changedFiles: status.changedFiles
      .filter((file) => !isVcsMetadataPath(file.path) && !isVcsMetadataPath(file.oldPath ?? ''))
      .map((file) => ({
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
    entries: tree.entries
      .filter((entry) => !isVcsMetadataPath(entry.path) && !isVcsMetadataPath(entry.name))
      .map((entry) => ({
        name: entry.name,
        path: entry.path,
        isDirectory: entry.isDirectory,
      })),
  }
}

function projectFile(
  taskId: string,
  file: WorkspaceReadFileResult,
  fileRef?: WorkspaceFileRef,
): ProductTaskReviewFile {
  if (file.state === 'error') {
    return {
      taskId,
      state: 'unavailable',
      path: file.path,
      ...(fileRef ? { fileRef } : {}),
      language: file.language,
      size: file.size,
    }
  }

  return {
    taskId,
    state: file.state,
    path: file.path,
    ...(fileRef ? { fileRef } : {}),
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

function projectDiff(
  taskId: string,
  diff: WorkspaceDiffResult,
  fileRef?: WorkspaceFileRef,
): ProductTaskReviewDiff {
  const state = diff.state === 'not_git_repo'
    ? 'not_versioned'
    : diff.state === 'error'
      ? 'unavailable'
      : diff.state

  return {
    taskId,
    state,
    path: diff.path,
    ...(fileRef ? { fileRef } : {}),
    ...(typeof diff.diff === 'string' ? { diff: diff.diff } : {}),
  }
}

function sameWorkspaceRevision(
  before: WorkspaceFileRevisionResult,
  after: WorkspaceFileRevisionResult,
): boolean {
  return (
    before.state === 'ok' &&
    after.state === 'ok' &&
    before.revision === after.revision
  ) || (before.state === 'missing' && after.state === 'missing')
}

function hasRevisionError(
  before: WorkspaceFileRevisionResult,
  after: WorkspaceFileRevisionResult,
): boolean {
  return before.state === 'error' || after.state === 'error'
}

function createFileRef(
  taskId: string,
  filePath: string,
  revision: WorkspaceFileRevisionResult,
): WorkspaceFileRef | undefined {
  if (revision.state !== 'ok' || !revision.revision) return undefined
  return {
    fileId: fileId(taskId, filePath),
    path: filePath,
    revision: revision.revision,
  }
}

function createDiffFileRef(
  taskId: string,
  filePath: string,
  diff: WorkspaceDiffResult,
): WorkspaceFileRef | undefined {
  if (diff.state !== 'ok' || typeof diff.diff !== 'string') return undefined
  const revision = `rev_${createHash('sha256')
    .update(`${filePath}\0${diff.diff}`)
    .digest('hex')
    .slice(0, 32)}`
  return { fileId: fileId(taskId, filePath), path: filePath, revision }
}

function fileId(taskId: string, filePath: string): string {
  return `file_${createHash('sha256')
    .update(`${taskId}\0${filePath}`)
    .digest('hex')
    .slice(0, 20)}`
}

function staleFile(
  taskId: string,
  filePath: string,
  revision: WorkspaceFileRevisionResult,
): ProductTaskReviewFile {
  const fileRef = createFileRef(taskId, filePath, revision)
  return {
    taskId,
    state: 'stale',
    path: filePath,
    ...(fileRef ? { fileRef } : {}),
    language: 'text',
    size: 0,
  }
}

function unavailableFile(taskId: string, filePath: string): ProductTaskReviewFile {
  return {
    taskId,
    state: 'unavailable',
    path: filePath,
    language: 'text',
    size: 0,
  }
}

function staleDiff(
  taskId: string,
  filePath: string,
  revision: WorkspaceFileRevisionResult,
  fallbackRef?: WorkspaceFileRef,
): ProductTaskReviewDiff {
  const fileRef = createFileRef(taskId, filePath, revision) ?? fallbackRef
  return {
    taskId,
    state: 'stale',
    path: filePath,
    ...(fileRef ? { fileRef } : {}),
  }
}

function unavailableDiff(taskId: string, filePath: string): ProductTaskReviewDiff {
  return { taskId, state: 'unavailable', path: filePath }
}

function normalizeExpectedRevision(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  if (!/^rev_[a-f0-9]{32}$/.test(value)) {
    throw ApiError.badRequest('审阅文件 revision 无效')
  }
  return value
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

  const relativePath = normalized
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.')
    .join('/')

  if (isVcsMetadataPath(relativePath)) {
    throw new ApiError(403, '审阅不支持访问版本控制内部文件', 'FORBIDDEN')
  }

  return relativePath
}

function isVcsMetadataPath(value: string): boolean {
  return value
    .replace(/\\/g, '/')
    .split('/')
    .some((segment) => VCS_METADATA_PATH_SEGMENTS.has(segment.toLowerCase()))
}

function reviewApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    if (error.code === 'WORKSPACE_REQUIRED' || error.code === 'WORKSPACE_RELINK_REQUIRED') return error
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
