/**
 * Product-facing review contract for a task workspace.
 *
 * These shapes intentionally omit Agent Core session identifiers, absolute
 * workspace paths, runtime settings, and raw tool payloads. They are a
 * bounded review surface for the product task page.
 */

export type ProductTaskReviewChangedFileStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'copied'
  | 'type_changed'
  | 'unknown'

export type ProductTaskReviewChangedFile = {
  path: string
  oldPath?: string
  status: ProductTaskReviewChangedFileStatus
  additions: number
  deletions: number
}

export type ProductTaskReviewStatus = {
  taskId: string
  state: 'ready' | 'unavailable'
  repository: {
    name: string
    branch: string | null
    isGitRepository: boolean
  } | null
  changedFiles: ProductTaskReviewChangedFile[]
}

export type ProductTaskReviewTreeEntry = {
  name: string
  path: string
  isDirectory: boolean
}

export type ProductTaskReviewTree = {
  taskId: string
  state: 'ok' | 'missing' | 'unavailable'
  path: string
  entries: ProductTaskReviewTreeEntry[]
}

export type ProductTaskReviewFile = {
  taskId: string
  state: 'ok' | 'binary' | 'too_large' | 'missing' | 'unavailable'
  path: string
  previewType?: 'text' | 'image'
  content?: string
  dataUrl?: string
  mimeType?: string
  language: string
  size: number
  truncated?: boolean
  readBytes?: number
}

export type ProductTaskReviewDiff = {
  taskId: string
  state: 'ok' | 'missing' | 'not_versioned' | 'unavailable'
  path: string
  diff?: string
}
