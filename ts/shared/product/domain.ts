export const PRODUCT_DOMAIN_VERSION = 1 as const

export type ProductTaskLifecycle = 'active' | 'archived'
export type ProductTaskKind = 'main' | 'continuation'
/** A worktree is planned by the Agent core and materialized when its session starts. */
export type ProductWorktreeState = 'not_requested' | 'planned'

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
