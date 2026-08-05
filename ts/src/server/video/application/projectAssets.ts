import type { MediaOwner, VideoStudioProject } from '../../../../shared/contracts/media.js'
import type { VideoProjectStore } from '../runtime/videoProjectStore.js'
import type {
  ProjectAssetsCommandPort,
  VideoWorkbenchApplicationErrors,
} from '../runtime/videoWorkbenchApplicationPorts.js'

const STANDALONE_VIDEO_OWNER: MediaOwner = {
  kind: 'standalone',
  owner_id: 'local_workbench',
}

function sameOwner(left: MediaOwner, right: MediaOwner): boolean {
  return left.kind === right.kind && left.owner_id === right.owner_id
}

/**
 * Owns the Project shell and managed source lifecycle. It deliberately shares
 * the root's VideoProjectStore instead of keeping a second project cache or
 * mutation queue.
 */
export class ProjectAssets {
  constructor(
    private readonly commands: ProjectAssetsCommandPort,
    readonly projectStore: VideoProjectStore,
    private readonly errors: VideoWorkbenchApplicationErrors,
  ) {}

  async listProjects(owner: MediaOwner = STANDALONE_VIDEO_OWNER): Promise<VideoStudioProject[]> {
    return await this.projectStore.repository.listProjects(owner)
  }

  async getProject(projectId: string): Promise<VideoStudioProject> {
    try {
      return await this.projectStore.repository.getProject(projectId)
    } catch (error) {
      return this.errors.rethrowRepository(error)
    }
  }

  async assertProjectOwner(projectId: string, owner: MediaOwner = STANDALONE_VIDEO_OWNER): Promise<VideoStudioProject> {
    const project = await this.getProject(projectId)
    if (!sameOwner(project.owner, owner)) {
      throw this.errors.create('视频项目不属于当前工作台', 403, 'VIDEO_PROJECT_FORBIDDEN')
    }
    return project
  }

  readonly createProject = (...args: Parameters<ProjectAssetsCommandPort['createProject']>) => this.commands.createProject(...args)
  readonly addVideoSource = (...args: Parameters<ProjectAssetsCommandPort['addVideoSource']>) => this.commands.addVideoSource(...args)
  readonly sourceResponse = (...args: Parameters<ProjectAssetsCommandPort['sourceResponse']>) => this.commands.sourceResponse(...args)

  async listDeletions(owner: MediaOwner = STANDALONE_VIDEO_OWNER) {
    return await this.projectStore.repository.listDeletions(owner)
  }

  async hasProjectHistory(projectId: string, owner: MediaOwner = STANDALONE_VIDEO_OWNER): Promise<boolean> {
    return await this.projectStore.repository.hasProjectHistory(projectId, owner)
  }

  async hasOperationHistory(operationId: string, owner: MediaOwner = STANDALONE_VIDEO_OWNER): Promise<boolean> {
    return await this.projectStore.repository.hasOperationHistory(operationId, owner)
  }

  async deleteProject(projectId: string) {
    await this.assertProjectOwner(projectId)
    return await this.projectStore.repository.deleteProject(projectId)
  }

  async restoreProject(projectId: string, owner: MediaOwner = STANDALONE_VIDEO_OWNER) {
    return await this.projectStore.repository.restoreProject(projectId, owner)
  }

  readonly migrateLegacyMediaStore = (...args: Parameters<ProjectAssetsCommandPort['migrateLegacyMediaStore']>) => this.commands.migrateLegacyMediaStore(...args)
}
