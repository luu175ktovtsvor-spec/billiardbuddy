/**
 * Narrow, product-facing media projection for one public product task.
 * It deliberately contains no filesystem paths, Agent Core ids, prompts,
 * references, provider details, or raw task errors.
 */
export type ProductTaskMediaAsset = {
  id: string
  kind: 'image'
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
  /** A server-relative URL that was verified to resolve to a real local asset. */
  url: string
}

export type ProductTaskMediaTask = {
  status: 'queued' | 'running' | 'committing' | 'succeeded' | 'failed' | 'cancelled'
  progress: number
  stage: string
  outcomeUnknown: boolean
}

export type ProductTaskMediaProject = {
  id: string
  kind: 'image' | 'video'
  title: string
  state: 'draft' | 'queued' | 'generating' | 'ready' | 'failed' | 'rendering' | 'complete'
  updatedAt: string
  mediaTask: ProductTaskMediaTask | null
  assets: ProductTaskMediaAsset[]
}

export type ProductTaskMediaList = {
  taskId: string
  projects: ProductTaskMediaProject[]
}

/** A deliberately minimal summary shown only in an explicit attach picker. */
export type ProductTaskMediaAttachableProject = {
  id: string
  kind: 'image' | 'video'
  title: string
  state: 'draft' | 'queued' | 'generating' | 'ready' | 'failed' | 'rendering' | 'complete'
  updatedAt: string
}

export type ProductTaskMediaAttachableList = {
  taskId: string
  projects: ProductTaskMediaAttachableProject[]
}
