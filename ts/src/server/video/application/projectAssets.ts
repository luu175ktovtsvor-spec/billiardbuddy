import { createHash, randomUUID } from 'node:crypto'
import { basename, extname, isAbsolute, join, relative } from 'node:path'
import { copyFile, mkdir, rm } from 'node:fs/promises'
import {
  addVideoProjectAssetInputSchema,
  addVideoSourceInputSchema,
  createVideoProjectInputValidationSchema,
  mediaSafeError,
  videoOutputSettingsForPreset,
  videoStudioProjectSchema,
  type AddVideoSourceInput,
  type AddVideoProjectAssetInput,
  type CreateVideoProjectInput,
  type MediaAsset,
  type MediaOwner,
  type VideoEvidence,
  type VideoStudioProject,
} from '../../../../shared/contracts/media.js'
import { timeToMilliseconds } from '../domain/mediaFacts/time.js'
import type { VideoProjectStore } from '../runtime/videoProjectStore.js'
import type { VideoOperation } from '../../services/videoWorkbenchRepository.js'
import type {
  ProjectAssetsCommandPort,
  VideoWorkbenchApplicationErrors,
} from '../runtime/videoWorkbenchApplicationPorts.js'
import { videoMimeType } from '../runtime/videoMime.js'

const STANDALONE_VIDEO_OWNER: MediaOwner = {
  kind: 'standalone',
  owner_id: 'local_workbench',
}

function sameOwner(left: MediaOwner, right: MediaOwner): boolean {
  return left.kind === right.kind && left.owner_id === right.owner_id
}

function id(prefix: 'src' | 'task'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function evidenceRevision(evidence: VideoEvidence[]): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(evidence.map(item => ({
    id: item.id,
    kind: item.kind,
    source_id: item.source_id,
    source_fingerprint: item.source_fingerprint,
    in_ms: item.in_ms,
    out_ms: item.out_ms,
    text: item.text,
  })))).digest('hex')}`
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
    private readonly now: () => Date,
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

  private async requireVideoProject(projectId: string): Promise<VideoStudioProject> {
    const project = await this.getProject(projectId)
    if (project.kind !== 'video') throw this.errors.create('这不是视频项目', 409, 'VIDEO_PROJECT_INVALID')
    return project
  }

  async assertProjectOwner(projectId: string, owner: MediaOwner = STANDALONE_VIDEO_OWNER): Promise<VideoStudioProject> {
    const project = await this.getProject(projectId)
    if (!sameOwner(project.owner, owner)) {
      throw this.errors.create('视频项目不属于当前工作台', 403, 'VIDEO_PROJECT_FORBIDDEN')
    }
    return project
  }

  /** The project shell is an application-owned SQLite write, rather than a
   * compatibility call into the old runtime. */
  async createProject(raw: CreateVideoProjectInput): Promise<VideoStudioProject> {
    const input = createVideoProjectInputValidationSchema.parse(raw)
    const createdAt = this.now().toISOString()
    return await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
      schema_version: 1,
      id: `vid_${randomUUID().replaceAll('-', '')}`,
      kind: 'video',
      title: input.title ?? '新视频',
      workspace_root: input.workspace_root,
      owner: STANDALONE_VIDEO_OWNER,
      assets: [],
      versions: [],
      revision: 0,
      created_at: createdAt,
      updated_at: createdAt,
      state: 'draft',
      sources: [],
      timeline: [],
      evidence: [],
      timeline_versions: [],
      alternatives: [],
      output: input.output ?? (input.output_preset ? videoOutputSettingsForPreset(input.output_preset) : undefined),
      delivery_format: input.delivery_format,
    }))
  }
  /**
   * The durable source lifecycle lives here: a probe Fact, Project mutation
   * and its Operations are committed through the one SQLite writer. Runtime
   * only supplies FFprobe and starts the process-local fingerprint handle.
   */
  async addVideoSource(projectId: string, raw: AddVideoSourceInput): Promise<{ project: VideoStudioProject; task: VideoOperation }> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = addVideoSourceInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      if (project.state === 'rendering') throw this.errors.create('正在导出，暂时不能添加素材', 409, 'VIDEO_RENDER_ACTIVE')
      if (!isAbsolute(input.path)) throw this.errors.create('视频素材必须使用绝对路径', 400, 'SOURCE_PATH_NOT_ABSOLUTE')
      const now = this.now().toISOString()
      let task = await this.projectStore.repository.saveOperation({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        owner: STANDALONE_VIDEO_OWNER,
        kind: 'video.probe',
        status: 'running',
        progress: 20,
        stage: '正在读取素材',
        created_at: now,
        updated_at: now,
      } as VideoOperation)
      try {
        const sourceId = id('src')
        const sourceFact = await this.commands.probeSourceFact({
          id: sourceId,
          project_id: project.id,
          path: input.path,
          name: basename(input.path),
          now,
        })
        await this.projectStore.repository.saveFact(sourceFact)
        const primaryVideoDuration = sourceFact.primary_video_stream.duration
        if (!primaryVideoDuration) {
          throw this.errors.create('素材原始视频流时长缺失，不能安全导入可编辑素材', 409, 'VIDEO_EDITORIAL_FACTS_UNAVAILABLE')
        }
        const durationMs = Math.max(1, timeToMilliseconds(primaryVideoDuration))
        const averageRate = sourceFact.primary_video_stream.average_frame_rate
        const asset: MediaAsset = {
          id: sourceId,
          role: 'source',
          version_id: sourceId,
          storage: { kind: 'external', locator: input.path },
          mime_type: videoMimeType(input.path),
          created_at: now,
        }
        const saved = await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          state: 'ready',
          sources: [...project.sources, {
            id: sourceId,
            path: input.path,
            name: basename(input.path),
            duration_ms: durationMs,
            width: sourceFact.primary_video_stream.width,
            height: sourceFact.primary_video_stream.height,
            ...(averageRate ? { fps: averageRate.num / averageRate.den } : {}),
            has_audio: sourceFact.audio_tracks.length > 0,
            rotation: sourceFact.primary_video_stream.rotation,
            video_stream_count: sourceFact.video_stream_count,
            audio_stream_count: sourceFact.audio_tracks.length,
            missing: false,
            content_changed: false,
          }],
          assets: [...project.assets, asset],
          evidence_revision: evidenceRevision(project.evidence),
          alternatives: [],
          revision: project.revision + 1,
          updated_at: now,
          error: undefined,
          error_code: undefined,
        }))
        task = await this.projectStore.repository.saveOperation({
          ...task,
          status: 'succeeded',
          progress: 100,
          stage: '素材已加入',
          result: { source_id: sourceId },
          updated_at: now,
        })
        const fingerprintTask = await this.projectStore.repository.saveOperation({
          schema_version: 1,
          id: id('task'),
          project_id: project.id,
          owner: STANDALONE_VIDEO_OWNER,
          kind: 'video.fingerprint',
          status: 'queued',
          progress: 0,
          stage: '等待计算完整指纹',
          result: { source_id: sourceId },
          created_at: now,
          updated_at: now,
        } as unknown as VideoOperation)
        this.commands.startSourceFingerprint(fingerprintTask, sourceId)
        return { project: saved, task }
      } catch (error) {
        const failure = mediaSafeError('MEDIA_VIDEO_SOURCE_UNREADABLE')
        task = await this.projectStore.repository.saveOperation({
          ...task,
          status: 'failed',
          progress: 0,
          stage: '读取失败',
          error: failure.message,
          error_code: failure.code,
          updated_at: this.now().toISOString(),
        })
        if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^(VIDEO_|SOURCE_)/.test(error.code)) throw error
        throw this.errors.create(failure.message, 422, 'VIDEO_PROBE_FAILED')
      }
    })
  }

  /**
   * Import a user-selected secondary input into the managed project store.
   * This is intentionally not an editorial write: it only creates an
   * attested asset. A later accepted CommandSet decides whether/how it enters
   * a Timeline Version.
   */
  async importProjectAsset(projectId: string, raw: AddVideoProjectAssetInput): Promise<{
    project: VideoStudioProject
    asset: MediaAsset
    reused: boolean
  }> {
    return await this.projectStore.mutate(projectId, async () => {
      const input = addVideoProjectAssetInputSchema.parse(raw)
      const project = await this.requireVideoProject(projectId)
      if (project.state === 'rendering') throw this.errors.create('正在导出，暂时不能导入项目资产', 409, 'VIDEO_RENDER_ACTIVE')
      if (!isAbsolute(input.path)) throw this.errors.create('项目资产必须使用绝对路径', 400, 'SOURCE_PATH_NOT_ABSOLUTE')

      const sourceProbe = await this.commands.probeProjectAsset({ path: input.path, asset_kind: input.asset_kind })
      const existing = project.assets.find(candidate => candidate.storage.kind === 'managed'
        && candidate.content_hash === sourceProbe.content_hash
        && project.video_asset_attestations.some(attestation => attestation.asset_id === candidate.id && attestation.asset_kind === input.asset_kind))
      if (existing) return { project, asset: existing, reused: true }

      const now = this.now().toISOString()
      const assetId = `asset_${randomUUID().replaceAll('-', '')}`
      const extension = extname(input.path).toLowerCase().match(/^\.[a-z0-9]{1,12}$/u)?.[0] ?? '.bin'
      const assetsRoot = this.projectStore.repository.paths().assets
      const projectAssetRoot = join(assetsRoot, project.id, 'project-assets')
      const targetPath = join(projectAssetRoot, `${assetId}${extension}`)
      await mkdir(projectAssetRoot, { recursive: true, mode: 0o700 })
      try {
        await copyFile(input.path, targetPath)
        const targetProbe = await this.commands.probeProjectAsset({ path: targetPath, asset_kind: input.asset_kind })
        if (targetProbe.content_hash !== sourceProbe.content_hash || targetProbe.byte_size !== sourceProbe.byte_size) {
          throw new Error('项目资产复制后字节校验失败')
        }
        const locator = relative(assetsRoot, targetPath)
        if (!locator || locator.startsWith('..')) throw new Error('项目资产受管定位符无效')
        const asset: MediaAsset = {
          id: assetId,
          role: 'source',
          version_id: assetId,
          storage: { kind: 'managed', locator },
          mime_type: targetProbe.mime_type,
          byte_size: targetProbe.byte_size,
          content_hash: targetProbe.content_hash,
          created_at: now,
        }
        const saved = await this.projectStore.repository.saveProject(videoStudioProjectSchema.parse({
          ...project,
          state: 'ready',
          assets: [...project.assets, asset],
          video_asset_attestations: [...project.video_asset_attestations, {
            asset_id: asset.id,
            asset_kind: input.asset_kind,
            provenance: input.provenance,
            license_attestation: input.license_attestation,
            ...(targetProbe.video_color ? { video_color: targetProbe.video_color } : {}),
            ...(targetProbe.video_stream ? { video_stream: targetProbe.video_stream } : {}),
            ...(targetProbe.audio_stream ? { audio_stream: targetProbe.audio_stream } : {}),
            approved_at: now,
          }],
          revision: project.revision + 1,
          updated_at: now,
          error: undefined,
          error_code: undefined,
        }))
        return { project: saved, asset, reused: false }
      } catch (error) {
        await rm(targetPath, { force: true }).catch(() => undefined)
        if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && /^(VIDEO_|SOURCE_)/.test(error.code)) throw error
        throw this.errors.create(error instanceof Error ? error.message : '项目资产导入失败', 422, 'VIDEO_PROJECT_ASSET_IMPORT_FAILED')
      }
    })
  }
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
