export const PRODUCT_DOMAIN_VERSION = 1 as const

export type ProductTaskLifecycle = 'active' | 'archived'
export type ProductTaskKind = 'main' | 'continuation'
export type ProductWorktreeState = 'not_requested' | 'planned' | 'materialized'
export type ProductSideTaskStatus = 'open' | 'closed'

export type ProductProject = {
  id: string
  title: string
  workDir: string
  taskCount: number
  archivedTaskCount: number
  updatedAt: string
}

export type ProductTask = {
  id: string
  projectId: string
  workDir: string
  title: string
  coreSessionId: string
  lifecycle: ProductTaskLifecycle
  kind: ProductTaskKind
  pinnedAt?: string
  archivedAt?: string
  parentTaskId?: string
  parentThreadId?: string
  sourceTurnId?: string
  createdAt: string
  updatedAt: string
  worktreeState: ProductWorktreeState
}

/**
 * A temporary, message-anchored fork of a product task.
 *
 * Side tasks deliberately do not use ProductTaskKind: their Core session is
 * isolated from the regular task index and remains available after closing.
 */
export type ProductSideTask = {
  id: string
  parentTaskId: string
  sourceTurnId: string
  coreSessionId: string
  title: string
  status: ProductSideTaskStatus
  createdAt: string
  updatedAt: string
  closedAt?: string
}

export type ProductSideTaskList = {
  sideTasks: ProductSideTask[]
}

export type ProductTaskIndex = {
  schemaVersion: typeof PRODUCT_DOMAIN_VERSION
  projects: ProductProject[]
  tasks: ProductTask[]
  total: number
}

export type CreateProductTaskInput = {
  workDir: string
  title?: string
  permissionMode?: string
  useWorktree?: boolean
}

export type UpdateProductTaskInput = {
  title?: string
  pinned?: boolean
}

export type ContinueProductTaskInput = {
  title?: string
  sourceTurnId?: string
}

export type CreateProductSideTaskInput = {
  sourceTurnId: string
  title?: string
}
