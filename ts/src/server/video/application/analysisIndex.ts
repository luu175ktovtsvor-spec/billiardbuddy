import type { VideoStudioProject } from '../../../../shared/contracts/media.js'
import type { VideoFactKind } from '../domain/mediaFacts/model.js'
import type { VideoProjectStore } from '../runtime/videoProjectStore.js'
import type {
  ActiveVideoExecutionHandle,
  AnalysisIndexCommandPort,
  VideoWorkbenchApplicationErrors,
} from '../runtime/videoWorkbenchApplicationPorts.js'

/** Process-local handles only. The durable Operation and Facts rows remain
 * the recovery authority after restart. */
export class VideoAnalysisOperationState {
  readonly activeAnalyses = new Map<string, ActiveVideoExecutionHandle>()
  readonly activeFingerprints = new Map<string, Promise<void>>()
}

/**
 * Owns source facts, remote-analysis scope, budget/consent and durable
 * analysis operations. Timeline and delivery writes stay outside this module.
 */
export class AnalysisIndex {
  constructor(
    private readonly commands: AnalysisIndexCommandPort,
    readonly projectStore: VideoProjectStore,
    readonly operationState: VideoAnalysisOperationState,
    private readonly errors: VideoWorkbenchApplicationErrors,
  ) {}

  private async requireVideoProject(projectId: string): Promise<VideoStudioProject> {
    let project: VideoStudioProject
    try {
      project = await this.projectStore.repository.getProject(projectId)
    } catch (error) {
      return this.errors.rethrowRepository(error)
    }
    if (project.kind !== 'video') throw this.errors.create('这不是视频项目', 409, 'VIDEO_PROJECT_INVALID')
    return project
  }

  async getWorkspaceSnapshotData(projectId: string, eventCursor: number) {
    const snapshot = await this.projectStore.repository.getWorkspaceSnapshot(projectId, eventCursor)
    if (snapshot.project.kind !== 'video') throw this.errors.create('这不是视频项目', 409, 'VIDEO_PROJECT_INVALID')
    return snapshot
  }

  readonly estimateRemoteAnalysis = (...args: Parameters<AnalysisIndexCommandPort['estimateRemoteAnalysis']>) => this.commands.estimateRemoteAnalysis(...args)
  readonly grantRemoteAnalysisConsent = (...args: Parameters<AnalysisIndexCommandPort['grantRemoteAnalysisConsent']>) => this.commands.grantRemoteAnalysisConsent(...args)
  readonly revokeRemoteAnalysisConsent = (...args: Parameters<AnalysisIndexCommandPort['revokeRemoteAnalysisConsent']>) => this.commands.revokeRemoteAnalysisConsent(...args)

  async pageMediaFacts(projectId: string, kind: VideoFactKind, options?: { sourceId?: string; cursor?: string; limit?: number }) {
    await this.requireVideoProject(projectId)
    return await this.projectStore.repository.pageCurrentFacts(kind, projectId, options)
  }

  readonly searchMediaFacts = (...args: Parameters<AnalysisIndexCommandPort['searchMediaFacts']>) => this.commands.searchMediaFacts(...args)

  async reclaimDerivativeCache(projectId: string, maxEvictions: number): Promise<string[]> {
    await this.requireVideoProject(projectId)
    return await this.projectStore.repository.reclaimLeastRecentlyUsedDerivatives(projectId, maxEvictions)
  }

  async waitForOperationEvents(projectId: string, cursor: number, limit: number, waitMs: number) {
    const page = await this.projectStore.repository.listOperationEvents(projectId, cursor, limit)
    if (page.events.length || page.reset_required || waitMs <= 0) return page
    await this.projectStore.repository.waitForOperationEvent(projectId, cursor, waitMs)
    return await this.projectStore.repository.listOperationEvents(projectId, cursor, limit)
  }

  readonly analyzeVideoProject = (...args: Parameters<AnalysisIndexCommandPort['analyzeVideoProject']>) => this.commands.analyzeVideoProject(...args)
  readonly analyzeVideoBeat = (...args: Parameters<AnalysisIndexCommandPort['analyzeVideoBeat']>) => this.commands.analyzeVideoBeat(...args)
  readonly createBeatSyncTimelineDraft = (...args: Parameters<AnalysisIndexCommandPort['createBeatSyncTimelineDraft']>) => this.commands.createBeatSyncTimelineDraft(...args)
  readonly analyzeVideoSubjectTrack = (...args: Parameters<AnalysisIndexCommandPort['analyzeVideoSubjectTrack']>) => this.commands.analyzeVideoSubjectTrack(...args)
}
