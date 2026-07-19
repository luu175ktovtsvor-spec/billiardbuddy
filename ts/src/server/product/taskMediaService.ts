import type {
  ProductTaskMediaAsset,
  ProductTaskMediaAttachableList,
  ProductTaskMediaAttachableProject,
  ProductTaskMediaList,
  ProductTaskMediaProject,
  ProductTaskMediaTask,
} from '../../../shared/product/taskMedia.js'
import type { MediaProject, MediaTask } from '../../../shared/contracts/media.js'
import { ApiError } from '../middleware/errorHandler.js'
import { MediaProjectService, MediaServiceError } from '../services/mediaProjectService.js'
import type { ProductTaskService } from './taskService.js'

export type ProductTaskMediaApi = Pick<
  ProductTaskMediaService,
  'listForTask' | 'listAttachableForTask' | 'attachProject' | 'assetResponse'
>

type ProductTaskOwnerApi = Pick<ProductTaskService, 'getTask'>
type MediaTaskOwnerApi = Pick<
  MediaProjectService,
  | 'listProjects'
  | 'getProject'
  | 'getTask'
  | 'attachProjectToProductTask'
  | 'availableImageOutputAssetPath'
  | 'availableVideoOutputMimeType'
  | 'imageOutputResponse'
  | 'videoOutputResponse'
>

function assetUrl(taskId: string, projectId: string, assetId: string): string {
  return `/api/product/tasks/${encodeURIComponent(taskId)}/media/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`
}

function publicMediaTask(task: MediaTask | null): ProductTaskMediaTask | null {
  if (!task) return null
  return {
    status: task.status,
    progress: task.progress,
    stage: task.stage,
    outcomeUnknown: task.outcome_unknown === true,
  }
}

function publicAttachableProject(project: MediaProject): ProductTaskMediaAttachableProject {
  return {
    id: project.id,
    kind: project.kind,
    title: project.title,
    state: project.state,
    updatedAt: project.updated_at,
  }
}

function safeAttachmentError(error: unknown): never {
  if (error instanceof MediaServiceError) {
    if (error.code === 'PROJECT_ALREADY_ATTACHED') {
      throw ApiError.conflict('媒体项目已关联到另一项任务')
    }
    if (error.code === 'PROJECT_NOT_ATTACHABLE') {
      throw ApiError.conflict('只能关联未处理的媒体草稿')
    }
    if (error.status === 404) throw ApiError.notFound('找不到可关联的媒体草稿')
    if (error.status === 400) throw ApiError.badRequest('媒体项目关联参数无效')
  }
  throw error
}

function safeAssetError(error: unknown): never {
  if (error instanceof MediaServiceError && [400, 403, 404, 409].includes(error.status)) {
    throw ApiError.notFound('找不到任务媒体产物')
  }
  throw error
}

/**
 * Product-task media projection. It validates the public task before looking
 * at media persistence and only returns verified, service-owned media URLs.
 * The standalone media workbenches remain the sole surface for editing, paid
 * image submission, and final export confirmation.
 */
export class ProductTaskMediaService {
  constructor(
    private readonly tasks: ProductTaskOwnerApi,
    private readonly media: MediaTaskOwnerApi = new MediaProjectService(),
  ) {}

  async listForTask(taskId: string): Promise<ProductTaskMediaList> {
    // Validate first so an unknown task id cannot probe the media index.
    await this.tasks.getTask(taskId)
    const projects = (await this.media.listProjects())
      .filter(project => project.product_task_id === taskId)
    return {
      taskId,
      projects: await Promise.all(projects.map(project => this.publicProject(taskId, project))),
    }
  }

  /**
   * A task can only adopt a local, unowned draft through an explicit picker.
   * This deliberately excludes prompts, reference data, paths, errors, and
   * existing outputs so it is not a second general media-project browser.
   */
  async listAttachableForTask(taskId: string): Promise<ProductTaskMediaAttachableList> {
    await this.tasks.getTask(taskId)
    const projects = (await this.media.listProjects())
      .filter(project => !project.product_task_id && project.state === 'draft')
      .map(publicAttachableProject)
    return { taskId, projects }
  }

  async attachProject(taskId: string, projectId: string): Promise<ProductTaskMediaProject> {
    await this.tasks.getTask(taskId)
    try {
      const project = await this.media.attachProjectToProductTask(projectId, taskId)
      return await this.publicProject(taskId, project)
    } catch (error) {
      return safeAttachmentError(error)
    }
  }

  async assetResponse(
    taskId: string,
    projectId: string,
    assetId: string,
    _request: Request,
  ): Promise<Response> {
    const project = await this.ownedProject(taskId, projectId)
    try {
      if (project.kind === 'image') {
        return await this.media.imageOutputResponse(project.id, assetId)
      }
      if (assetId !== 'export') throw ApiError.notFound('找不到任务媒体产物')
      return await this.media.videoOutputResponse(project.id, _request)
    } catch (error) {
      return safeAssetError(error)
    }
  }

  private async ownedProject(taskId: string, projectId: string): Promise<MediaProject> {
    await this.tasks.getTask(taskId)
    let project: MediaProject
    try {
      project = await this.media.getProject(projectId)
    } catch (error) {
      return safeAssetError(error)
    }
    if (project.product_task_id !== taskId) {
      throw ApiError.notFound('找不到任务媒体产物')
    }
    return project
  }

  private async publicProject(taskId: string, project: MediaProject): Promise<ProductTaskMediaProject> {
    // Reading with refresh=true reconciles an already-submitted remote image
    // task; it never creates a new paid generation request.
    const mediaTask = project.task_id
      ? await this.media.getTask(project.task_id, true).catch(() => null)
      : null
    // Refreshing the task can update persisted outputs/state. Re-read once so
    // the same response exposes newly materialized assets rather than waiting
    // for a second UI poll.
    const currentProject = mediaTask
      ? await this.media.getProject(project.id).catch(() => project)
      : project
    const assets = currentProject.kind === 'image'
      ? await this.imageAssets(taskId, currentProject)
      : await this.videoAssets(taskId, currentProject)

    return {
      id: currentProject.id,
      kind: currentProject.kind,
      title: currentProject.title,
      state: currentProject.state,
      updatedAt: currentProject.updated_at,
      mediaTask: publicMediaTask(mediaTask),
      assets,
    }
  }

  private async imageAssets(
    taskId: string,
    project: Extract<MediaProject, { kind: 'image' }>,
  ): Promise<ProductTaskMediaAsset[]> {
    const assets = await Promise.all(project.outputs.map(async output => {
      if (!output.asset_path) return null
      const verified = await this.media.availableImageOutputAssetPath(project.id, output.asset_path)
      if (!verified) return null
      return {
        id: output.id,
        kind: 'image' as const,
        mimeType: output.mime_type,
        url: assetUrl(taskId, project.id, output.id),
      }
    }))
    return assets.filter((asset): asset is ProductTaskMediaAsset => asset !== null)
  }

  private async videoAssets(
    taskId: string,
    project: Extract<MediaProject, { kind: 'video' }>,
  ): Promise<ProductTaskMediaAsset[]> {
    const mimeType = await this.media.availableVideoOutputMimeType(project.id)
    if (!mimeType) return []
    return [{
      id: 'export',
      kind: 'video',
      mimeType,
      url: assetUrl(taskId, project.id, 'export'),
    }]
  }
}
