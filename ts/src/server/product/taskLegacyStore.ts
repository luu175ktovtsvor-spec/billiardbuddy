import type {
  ProductPermissionSnapshot,
  ProductProject,
  ProductProjectDirectory,
  ProductSideTask,
  ProductTask,
} from '../../../shared/product/domain.js'

/**
 * `product-tasks.json` is a migration input, not the Agent runtime authority.
 * Keep its schema here so legacy normalization cannot depend on the current
 * task service or leak into the durable Authority ledger contract.
 */
export const PRODUCT_TASK_STORE_VERSION = 4 as const
export const LEGACY_PRODUCT_TASK_STORE_VERSION = 1 as const

export type ProductTaskMetadata = {
  id: string
  /** Private Agent Core binding. Never return this from a product API. */
  coreSessionId: string
  /** Product-owned project binding; never derived from a Core session again. */
  projectId?: string
  /** Product-owned source-directory binding; separate from the live workDir. */
  directoryId?: string
  title?: string
  lifecycle: ProductTask['lifecycle']
  kind: ProductTask['kind']
  pinnedAt?: string
  archivedAt?: string
  parentTaskId?: string
  sourceTurnId?: string
  createdAt: string
  updatedAt: string
  worktreeState: ProductTask['worktreeState']
  visibility?: 'main' | 'side_task'
  permission_snapshot?: ProductPermissionSnapshot
}

export type ProductSideTaskMetadata = ProductSideTask & {
  /** Private Agent Core binding for the temporary branch. */
  coreSessionId: string
  /** Private Core turn selected by the product-thread entry. */
  sourceTurnId: string
}

export type ProductProjectMetadata = Pick<
  ProductProject,
  'id' | 'title' | 'rootDir' | 'createdAt' | 'updatedAt'
>

export type ProductProjectDirectoryMetadata = ProductProjectDirectory

export type ProductTaskStore = {
  version: typeof PRODUCT_TASK_STORE_VERSION
  projects: Record<string, ProductProjectMetadata>
  directories: Record<string, ProductProjectDirectoryMetadata>
  tasks: Record<string, ProductTaskMetadata>
  sideTasks: Record<string, ProductSideTaskMetadata>
  /**
   * The legacy Core-session list was imported once into this product-owned
   * registry. Future Core sessions are not automatically promoted to product
   * tasks, so the product index has a single durable source of truth.
   */
  legacyCoreSessionsImportedAt?: string
}
