import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  addVideoSourceInputSchema,
  createImageProjectInputSchema,
  createVideoProjectInputSchema,
  imageWorkbenchProjectSchema,
  imageGenerationTaskResultSchema,
  mediaProjectSchema,
  mediaTaskSchema,
  productTaskOwnerIdSchema,
  renderVideoInputSchema,
  saveImageOutputInputSchema,
  submitImageProjectInputSchema,
  updateImageProjectInputSchema,
  updateVideoTimelineInputSchema,
  videoStudioProjectSchema,
  videoRenderTaskResultSchema,
  type AddVideoSourceInput,
  type CreateImageProjectInput,
  type CreateVideoProjectInput,
  type ImageWorkbenchProject,
  type MediaProject,
  type MediaTask,
  type RenderVideoInput,
  type SaveImageOutputInput,
  type SubmitImageProjectInput,
  type UpdateImageProjectInput,
  type UpdateVideoTimelineInput,
  type VideoClip,
  type VideoSource,
  type VideoStudioProject,
} from '../../../shared/contracts/media.js'
import {
  getInstallationId,
  getQfGatewayToken,
  getQfGatewayUrl,
  qfGatewayConfigured,
} from './qfGatewayProvider.js'

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type MediaProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export type MediaProcessRunner = (
  command: string[],
  options?: { signal?: AbortSignal },
) => Promise<MediaProcessResult>

type VideoEncoderProfile = {
  name: 'h264_videotoolbox' | 'h264_mf' | 'mpeg4'
  args: string[]
}

type ActiveVideoRender = {
  controller: AbortController
  completion: Promise<void>
}

type MoveFile = (source: string, destination: string) => Promise<void>

const FALLBACK_VIDEO_ENCODER: VideoEncoderProfile = {
  name: 'mpeg4',
  args: ['-q:v', '3'],
}

export type MediaProjectServiceOptions = {
  root?: string
  fetchImpl?: FetchLike
  runProcess?: MediaProcessRunner
  moveFile?: MoveFile
  now?: () => Date
  env?: Record<string, string | undefined>
}

type RelayImageTask = {
  task_id?: string
  status?: string
  data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string }>
  error?: string
  reused?: boolean
  input_fidelity_requested?: string
  input_fidelity_status?: 'accepted' | 'unsupported'
  input_fidelity_risk?: string
}

export class MediaServiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'MEDIA_ERROR',
  ) {
    super(message)
    this.name = 'MediaServiceError'
  }
}

class ImageSubmissionAttemptError extends MediaServiceError {
  constructor(
    message: string,
    status: number,
    readonly outcomeUnknown: boolean,
  ) {
    super(message, status, outcomeUnknown ? 'IMAGE_SUBMIT_UNKNOWN' : 'IMAGE_SUBMIT_FAILED')
  }
}

function id(prefix: 'img' | 'vid' | 'src' | 'clip' | 'task' | 'out'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function defaultTitle(prompt: string, fallback: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  return compact ? compact.slice(0, 48) : fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseRate(value: unknown): number | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined
  if (value.includes('/')) {
    const [left, right] = value.split('/').map(Number)
    if (!Number.isFinite(left) || !Number.isFinite(right) || !right) return undefined
    return Math.round((left! / right!) * 1000) / 1000
  }
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function boundedMessage(value: string, max = 2000): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`
}

function ffmpegSeconds(milliseconds: number): string {
  return (milliseconds / 1000).toFixed(3)
}

function referenceImageExtension(dataUrl: string): 'png' | 'jpg' | 'webp' {
  if (dataUrl.startsWith('data:image/jpeg;')) return 'jpg'
  if (dataUrl.startsWith('data:image/webp;')) return 'webp'
  return 'png'
}

function referenceImageMime(fileName: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  if (fileName.endsWith('.jpg')) return 'image/jpeg'
  if (fileName.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

function dataUrlBytes(dataUrl: string): Buffer {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
}

export function buildVideoRenderCommand(
  ffmpeg: string,
  project: VideoStudioProject,
  outputPath: string,
  encoder: VideoEncoderProfile = FALLBACK_VIDEO_ENCODER,
): string[] {
  const sourceById = new Map(project.sources.map(source => [source.id, source]))
  const inputs: string[] = []
  const filters: string[] = []
  const concatInputs: string[] = []
  const { width, height, fps } = project.output

  project.timeline.forEach((clip, index) => {
    const source = sourceById.get(clip.source_id)
    if (!source) throw new Error(`素材不存在: ${clip.source_id}`)
    const duration = clip.out_ms - clip.in_ms
    inputs.push(
      '-ss', ffmpegSeconds(clip.in_ms),
      '-t', ffmpegSeconds(duration),
      '-i', source.path,
    )
    filters.push(
      `[${index}:v]setpts=PTS-STARTPTS,scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${fps}[v${index}]`,
    )
    if (source.has_audio) {
      filters.push(
        `[${index}:a]asetpts=PTS-STARTPTS,aresample=48000,` +
        `aformat=sample_fmts=fltp:sample_rates=48000:channel_layouts=stereo[a${index}]`,
      )
    } else {
      filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${ffmpegSeconds(duration)}[a${index}]`)
    }
    concatInputs.push(`[v${index}][a${index}]`)
  })
  filters.push(`${concatInputs.join('')}concat=n=${project.timeline.length}:v=1:a=1[vout][aout]`)

  return [
    ffmpeg,
    '-hide_banner',
    '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]',
    '-map', '[aout]',
    '-c:v', encoder.name,
    ...encoder.args,
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-movflags', '+faststart',
    outputPath,
  ]
}

async function defaultRunProcess(
  command: string[],
  options: { signal?: AbortSignal } = {},
): Promise<MediaProcessResult> {
  const proc = Bun.spawn(command, {
    stdout: 'pipe',
    stderr: 'pipe',
    signal: options.signal,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

export class MediaProjectService {
  private readonly root: string
  private readonly projectsDir: string
  private readonly tasksDir: string
  private readonly assetsDir: string
  private readonly fetchImpl: FetchLike
  private readonly runProcess: MediaProcessRunner
  private readonly moveFile: MoveFile
  private readonly now: () => Date
  private readonly env: Record<string, string | undefined>
  private readonly activeRenders = new Map<string, ActiveVideoRender>()
  private readonly activeImageSubmissions = new Map<string, Promise<MediaTask>>()
  private readonly videoProjectMutations = new Map<string, Promise<void>>()
  /** Shared across service instances in the desktop server process. */
  private static readonly productTaskAttachmentMutations = new Map<string, Promise<void>>()
  private renderStarting = false
  private encoderProfilePromise: Promise<VideoEncoderProfile> | null = null

  constructor(options: MediaProjectServiceOptions = {}) {
    this.root = options.root ?? join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'), 'billiardbuddy', 'media')
    this.projectsDir = join(this.root, 'projects')
    this.tasksDir = join(this.root, 'tasks')
    this.assetsDir = join(this.root, 'assets')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.runProcess = options.runProcess ?? defaultRunProcess
    this.moveFile = options.moveFile ?? rename
    this.now = options.now ?? (() => new Date())
    this.env = options.env ?? process.env
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private async ensureDirs(): Promise<void> {
    await Promise.all([
      mkdir(this.projectsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.tasksDir, { recursive: true, mode: 0o700 }),
      mkdir(this.assetsDir, { recursive: true, mode: 0o700 }),
    ])
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.tmp-${randomUUID()}`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }

  private projectPath(projectId: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{7,79}$/.test(projectId)) {
      throw new MediaServiceError('无效的媒体项目 ID', 400, 'INVALID_PROJECT_ID')
    }
    return join(this.projectsDir, `${projectId}.json`)
  }

  private taskPath(taskId: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{7,79}$/.test(taskId)) {
      throw new MediaServiceError('无效的媒体任务 ID', 400, 'INVALID_TASK_ID')
    }
    return join(this.tasksDir, `${taskId}.json`)
  }

  private pathForComparison(path: string): string {
    return process.platform === 'win32' ? path.toLowerCase() : path
  }

  private pathsEqual(left: string, right: string): boolean {
    return this.pathForComparison(left) === this.pathForComparison(right)
  }

  private pathIsInside(directory: string, candidate: string): boolean {
    const fromDirectory = relative(this.pathForComparison(directory), this.pathForComparison(candidate))
    return fromDirectory === ''
      || (!fromDirectory.startsWith('..') && !isAbsolute(fromDirectory))
  }

  private async resolveOwnedAsset(
    projectId: string,
    fileName: string,
    missing: { message: string, code: string },
    subdirectory?: 'references',
  ): Promise<{ path: string, size: number }> {
    this.projectPath(projectId)
    const projectAssetDir = join(this.assetsDir, projectId)
    const assetDir = subdirectory ? join(projectAssetDir, subdirectory) : projectAssetDir
    const requestedPath = join(assetDir, fileName)

    let canonicalAssetsDir: string
    let canonicalProjectDir: string
    let canonicalAssetDir: string
    let canonicalAssetPath: string
    let info: Awaited<ReturnType<typeof stat>>
    try {
      [canonicalAssetsDir, canonicalProjectDir, canonicalAssetDir, canonicalAssetPath, info] = await Promise.all([
        realpath(this.assetsDir),
        realpath(projectAssetDir),
        realpath(assetDir),
        realpath(requestedPath),
        stat(requestedPath),
      ])
    } catch {
      throw new MediaServiceError(missing.message, 404, missing.code)
    }

    const expectedProjectDir = join(canonicalAssetsDir, projectId)
    const expectedAssetDir = subdirectory
      ? join(canonicalProjectDir, subdirectory)
      : canonicalProjectDir
    if (
      !info.isFile()
      || !this.pathsEqual(canonicalProjectDir, expectedProjectDir)
      || !this.pathsEqual(canonicalAssetDir, expectedAssetDir)
      || !this.pathIsInside(canonicalAssetDir, canonicalAssetPath)
    ) {
      if (!info.isFile()) throw new MediaServiceError(missing.message, 404, missing.code)
      throw new MediaServiceError('媒体资产不在当前项目目录内', 403, 'ASSET_OUTSIDE_PROJECT')
    }

    return { path: canonicalAssetPath, size: info.size }
  }

  private async saveProject(project: MediaProject): Promise<MediaProject> {
    const parsed = mediaProjectSchema.parse(project)
    await this.writeJson(this.projectPath(parsed.id), parsed)
    return parsed
  }

  private async saveTask(task: MediaTask): Promise<MediaTask> {
    const parsed = mediaTaskSchema.parse(task)
    await this.writeJson(this.taskPath(parsed.id), parsed)
    return parsed
  }

  private async withVideoProjectMutation<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = this.videoProjectMutations.get(projectId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolveLock => { release = resolveLock })
    const queued = previous.then(() => current)
    this.videoProjectMutations.set(projectId, queued)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.videoProjectMutations.get(projectId) === queued) {
        this.videoProjectMutations.delete(projectId)
      }
    }
  }

  /**
   * Product-media ownership is a one-time claim. Keep concurrent requests for
   * one project serialized so two task pages cannot both observe an unowned
   * draft and overwrite one another's owner.
   */
  private async withProductTaskAttachmentMutation<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    const previous = MediaProjectService.productTaskAttachmentMutations.get(projectId) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolveLock => { release = resolveLock })
    const queued = previous.then(() => current)
    MediaProjectService.productTaskAttachmentMutations.set(projectId, queued)
    await previous
    try {
      return await action()
    } finally {
      release()
      if (MediaProjectService.productTaskAttachmentMutations.get(projectId) === queued) {
        MediaProjectService.productTaskAttachmentMutations.delete(projectId)
      }
    }
  }

  private async persistReferenceImages(projectId: string, images: string[]): Promise<string[]> {
    if (images.length === 0) return []
    const directory = join(this.assetsDir, projectId, 'references')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    return await Promise.all(images.map(async image => {
      const fileName = `ref_${randomUUID().replaceAll('-', '')}.${referenceImageExtension(image)}`
      await writeFile(join(directory, fileName), dataUrlBytes(image), { mode: 0o600 })
      return fileName
    }))
  }

  private async loadReferenceImages(project: ImageWorkbenchProject): Promise<string[]> {
    const assetNames = project.reference_image_assets ?? []
    if (assetNames.length === 0) return project.reference_images
    return await Promise.all(assetNames.map(async fileName => {
      const asset = await this.resolveOwnedAsset(project.id, fileName, {
        message: '参考图片文件已经丢失',
        code: 'REFERENCE_IMAGE_MISSING',
      }, 'references')
      const bytes = await readFile(asset.path)
      return `data:${referenceImageMime(fileName)};base64,${bytes.toString('base64')}`
    }))
  }

  private async comparablePath(path: string): Promise<string> {
    const absolute = resolve(path)
    const canonical = await realpath(absolute).catch(async () => {
      const canonicalParent = await realpath(dirname(absolute)).catch(() => resolve(dirname(absolute)))
      return join(canonicalParent, basename(absolute))
    })
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical
  }

  private async outputMatchesSource(outputPath: string, sources: VideoSource[]): Promise<boolean> {
    const outputComparable = await this.comparablePath(outputPath)
    const outputInfo = await stat(outputPath).catch(() => null)
    for (const source of sources) {
      if (await this.comparablePath(source.path) === outputComparable) return true
      if (outputInfo) {
        const sourceInfo = await stat(source.path).catch(() => null)
        if (sourceInfo && sourceInfo.dev === outputInfo.dev && sourceInfo.ino === outputInfo.ino) return true
      }
    }
    return false
  }

  private async migrateLegacyReferenceImages(project: ImageWorkbenchProject): Promise<ImageWorkbenchProject> {
    if (project.reference_images.length === 0) return project
    const migratedNames = await this.persistReferenceImages(project.id, project.reference_images)
    return await this.saveProject({
      ...project,
      reference_images: [],
      reference_image_assets: [...(project.reference_image_assets ?? []), ...migratedNames],
      reference_image_count: Math.max(project.reference_image_count, project.reference_images.length),
    }) as ImageWorkbenchProject
  }

  async listProjects(kind?: 'image' | 'video'): Promise<MediaProject[]> {
    await this.ensureDirs()
    const names = await readdir(this.projectsDir)
    const projects = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
      try {
        return await this.getProject(name.slice(0, -5))
      } catch {
        return null
      }
    }))
    const validProjects = projects
      .filter((project): project is MediaProject => Boolean(project) && (!kind || project!.kind === kind))
    await Promise.all(validProjects.map(project => project.task_id
      ? this.getTask(project.task_id, false).catch(() => null)
      : null))
    const reconciled = await Promise.all(validProjects.map(project => this.getProject(project.id).catch(() => null)))
    return reconciled
      .filter((project): project is MediaProject => Boolean(project))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
  }

  async getProject(projectId: string): Promise<MediaProject> {
    try {
      const project = mediaProjectSchema.parse(JSON.parse(await readFile(this.projectPath(projectId), 'utf8')))
      return project.kind === 'image' ? await this.migrateLegacyReferenceImages(project) : project
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new MediaServiceError('找不到媒体项目', 404, 'PROJECT_NOT_FOUND')
      }
      if (error instanceof MediaServiceError) throw error
      throw new MediaServiceError(`媒体项目数据损坏: ${errorMessage(error)}`, 500, 'PROJECT_CORRUPT')
    }
  }

  async getTask(taskId: string, refreshRemote = true): Promise<MediaTask> {
    let task: MediaTask
    try {
      task = mediaTaskSchema.parse(JSON.parse(await readFile(this.taskPath(taskId), 'utf8')))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new MediaServiceError('找不到媒体任务', 404, 'TASK_NOT_FOUND')
      }
      if (error instanceof MediaServiceError) throw error
      throw new MediaServiceError(`媒体任务数据损坏: ${errorMessage(error)}`, 500, 'TASK_CORRUPT')
    }
    task = await this.reconcileTaskAndProject(task)
    if (refreshRemote && task.kind === 'image.generate' && ['queued', 'running'].includes(task.status)) {
      if (!task.remote_task_id) {
        const project = await this.getProject(task.project_id)
        if (project.kind !== 'image' || !task.idempotency_key) {
          return await this.failImageTask(
            task,
            '生图提交在应用关闭前没有保存完整凭据，无法确认上游结果，可能已经产生费用',
            true,
          )
        }
        return await this.submitPersistedImageTask(project, task)
      }
      return await this.refreshImageTask(task)
    }
    if (
      task.kind === 'video.render' &&
      ['queued', 'running', 'committing'].includes(task.status) &&
      !this.activeRenders.has(task.id)
    ) {
      return await this.recoverInterruptedVideoRender(task)
    }
    return task
  }

  private async reconcileTaskAndProject(task: MediaTask): Promise<MediaTask> {
    const project = await this.getProject(task.project_id).catch(() => null)
    if (!project || project.task_id !== task.id) return task

    if (task.kind === 'image.generate' && project.kind === 'image') {
      const result = imageGenerationTaskResultSchema.safeParse(task.result)
      if (task.status === 'succeeded' && project.state !== 'ready' && result.success && result.data.outputs.length > 0) {
        await this.saveProject({
          ...project,
          state: 'ready',
          outputs: result.data.outputs,
          notice: result.data.input_fidelity_risk,
          error: undefined,
          updated_at: this.iso(),
        })
      } else if (
        (task.status === 'failed' || task.status === 'cancelled')
        && (project.state === 'queued' || project.state === 'generating')
      ) {
        await this.saveProject({
          ...project,
          state: 'failed',
          error: task.error ?? (task.status === 'cancelled' ? '生成已取消' : '生成失败'),
          updated_at: this.iso(),
        })
      }
      return task
    }

    if (task.kind === 'video.render' && project.kind === 'video') {
      const result = videoRenderTaskResultSchema.safeParse(task.result)
      if (!result.success) return task
      const outputExists = await stat(result.data.output_path).then(info => info.isFile()).catch(() => false)
      if (task.status === 'succeeded' && project.state !== 'complete' && outputExists) {
        await this.saveProject({
          ...project,
          state: 'complete',
          output_path: result.data.output_path,
          error: undefined,
          updated_at: this.iso(),
        })
        return task
      }
      if (task.status === 'succeeded' && project.state === 'rendering' && !outputExists) {
        await this.saveProject({
          ...project,
          state: 'failed',
          error: '导出任务已完成，但输出文件已经不存在',
          updated_at: this.iso(),
        })
        return task
      }
      if (
        (task.status === 'failed' || task.status === 'cancelled')
        && project.state === 'rendering'
      ) {
        await this.saveProject({
          ...project,
          state: task.status === 'cancelled' || task.stage === '导出已中断' ? 'ready' : 'failed',
          error: task.error ?? (task.status === 'cancelled' ? '导出已取消' : '导出失败'),
          updated_at: this.iso(),
        })
        return task
      }
      if (
        task.status === 'committing'
        && !this.activeRenders.has(task.id)
        && result.data.temporary_output
      ) {
        const temporaryExists = await stat(result.data.temporary_output).then(info => info.isFile()).catch(() => false)
        if (outputExists && !temporaryExists) {
          const succeeded = await this.saveTask({
            ...task,
            status: 'succeeded',
            progress: 100,
            stage: '导出完成',
            result: { ...result.data, temporary_output: undefined },
            error: undefined,
            updated_at: this.iso(),
          })
          await this.saveProject({
            ...project,
            state: 'complete',
            output_path: result.data.output_path,
            error: undefined,
            updated_at: this.iso(),
          })
          return succeeded
        }
      }
    }
    return task
  }

  private async currentImageProjectForTask(task: MediaTask): Promise<ImageWorkbenchProject | null> {
    const project = await this.getProject(task.project_id).catch(() => null)
    return project?.kind === 'image' && project.task_id === task.id ? project : null
  }

  private async recoverInterruptedVideoRender(task: MediaTask): Promise<MediaTask> {
    const message = '上次导出因应用关闭而中断，请重新导出'
    const next = await this.saveTask({
      ...task,
      status: 'failed',
      progress: 0,
      stage: '导出已中断',
      error: message,
      updated_at: this.iso(),
    })
    const project = await this.getProject(task.project_id).catch(() => null)
    if (project?.kind === 'video') {
      await this.saveProject({ ...project, state: 'ready', error: message, updated_at: this.iso() })
    }
    const result = videoRenderTaskResultSchema.safeParse(task.result)
    if (result.success && result.data.temporary_output) {
      await rm(result.data.temporary_output, { force: true }).catch(() => undefined)
    }
    return next
  }

  async assetResponse(projectId: string, fileName: string): Promise<Response> {
    this.projectPath(projectId)
    if (!/^[a-z0-9][a-z0-9_.-]{2,120}$/.test(fileName)) {
      throw new MediaServiceError('无效的媒体资产名', 400, 'INVALID_ASSET_NAME')
    }
    const asset = await this.resolveOwnedAsset(projectId, fileName, {
      message: '找不到媒体资产',
      code: 'ASSET_NOT_FOUND',
    })
    const extension = extname(fileName).toLowerCase()
    const contentType = extension === '.jpg' || extension === '.jpeg'
      ? 'image/jpeg'
      : extension === '.webp'
        ? 'image/webp'
        : 'image/png'
    return new Response(Bun.file(asset.path), {
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(asset.size),
        'Cache-Control': 'private, max-age=31536000, immutable',
      },
    })
  }

  /**
   * Resolve an image result only when its persisted route is exactly this
   * project's owned local asset. Callers receive the safe route, never a
   * filesystem path.
   */
  async availableImageOutputAssetPath(projectId: string, assetPath: string): Promise<string | null> {
    const prefix = `/api/media/assets/${projectId}/`
    if (!assetPath.startsWith(prefix)) return null
    const fileName = assetPath.slice(prefix.length)
    if (!/^[a-z0-9][a-z0-9_.-]{2,120}$/.test(fileName)) return null
    try {
      await this.resolveOwnedAsset(projectId, fileName, {
        message: '找不到媒体资产',
        code: 'ASSET_NOT_FOUND',
      })
      return assetPath
    } catch {
      return null
    }
  }

  /**
   * Read a persisted image result by its opaque output id. Product routes use
   * this rather than exposing the backing general media-asset URL.
   */
  async imageOutputResponse(projectId: string, outputId: string): Promise<Response> {
    const project = await this.getProject(projectId)
    if (project.kind !== 'image') throw new MediaServiceError('这不是图片项目', 409, 'WRONG_PROJECT_KIND')
    const output = project.outputs.find(candidate => candidate.id === outputId)
    if (!output?.asset_path) throw new MediaServiceError('找不到图片结果', 404, 'IMAGE_OUTPUT_NOT_FOUND')
    const prefix = `/api/media/assets/${project.id}/`
    if (!output.asset_path.startsWith(prefix)) {
      throw new MediaServiceError('图片结果不可用', 404, 'IMAGE_OUTPUT_NOT_LOCAL')
    }
    const fileName = output.asset_path.slice(prefix.length)
    if (!fileName || !(await this.availableImageOutputAssetPath(project.id, output.asset_path))) {
      throw new MediaServiceError('图片结果不可用', 404, 'IMAGE_OUTPUT_NOT_LOCAL')
    }
    return await this.assetResponse(project.id, fileName)
  }

  /**
   * Bind an existing project to a public product task exactly once. This is
   * intentionally separate from the standalone create routes so callers
   * cannot smuggle arbitrary owner ids into general media project creation.
   */
  async attachProjectToProductTask(projectId: string, productTaskId: string): Promise<MediaProject> {
    const ownerId = productTaskOwnerIdSchema.parse(productTaskId)
    return await this.withProductTaskAttachmentMutation(projectId, async () => {
      const project = await this.getProject(projectId)
      if (project.product_task_id && project.product_task_id !== ownerId) {
        throw new MediaServiceError('媒体项目已关联到另一项任务', 409, 'PROJECT_ALREADY_ATTACHED')
      }
      if (project.product_task_id === ownerId) return project
      if (project.state !== 'draft') {
        throw new MediaServiceError('只有未关联的媒体草稿可以加入任务', 409, 'PROJECT_NOT_ATTACHABLE')
      }
      return await this.saveProject({
        ...project,
        product_task_id: ownerId,
        updated_at: this.iso(),
      })
    })
  }

  async saveImageOutput(projectId: string, raw: SaveImageOutputInput): Promise<{ path: string }> {
    const input = saveImageOutputInputSchema.parse(raw)
    if (!isAbsolute(input.output_path)) {
      throw new MediaServiceError('图片保存路径必须是绝对路径', 400, 'OUTPUT_PATH_NOT_ABSOLUTE')
    }
    const project = await this.getProject(projectId)
    if (project.kind !== 'image') throw new MediaServiceError('这不是图片项目', 409, 'WRONG_PROJECT_KIND')
    const output = project.outputs.find(candidate => candidate.id === input.output_id)
    if (!output) throw new MediaServiceError('找不到图片结果', 404, 'IMAGE_OUTPUT_NOT_FOUND')
    const expectedExtension = output.mime_type === 'image/jpeg' ? '.jpg' : output.mime_type === 'image/webp' ? '.webp' : '.png'
    const requestedExtension = extname(input.output_path).toLowerCase()
    if (requestedExtension !== expectedExtension && !(expectedExtension === '.jpg' && requestedExtension === '.jpeg')) {
      throw new MediaServiceError(`图片结果需要保存为 ${expectedExtension}`, 400, 'IMAGE_OUTPUT_EXTENSION_MISMATCH')
    }

    let sourcePath: string | null = null
    let bytes: Buffer | null = null
    if (output.asset_path) {
      const fileName = output.asset_path.split('/').pop() ?? ''
      if (!/^[a-z0-9][a-z0-9_.-]{2,120}$/.test(fileName)) {
        throw new MediaServiceError('图片资产地址损坏', 500, 'IMAGE_OUTPUT_CORRUPT')
      }
      sourcePath = (await this.resolveOwnedAsset(project.id, fileName, {
        message: '图片结果文件已经丢失',
        code: 'IMAGE_OUTPUT_MISSING',
      })).path
    } else if (output.data_url) {
      bytes = dataUrlBytes(output.data_url)
    } else {
      throw new MediaServiceError('远程图片结果尚未保存到本机', 409, 'IMAGE_OUTPUT_NOT_LOCAL')
    }

    await mkdir(dirname(input.output_path), { recursive: true })
    const temporary = `${input.output_path}.partial-${randomUUID()}`
    try {
      if (sourcePath) await copyFile(sourcePath, temporary)
      else await writeFile(temporary, bytes!, { mode: 0o600 })
      await this.moveFile(temporary, input.output_path)
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined)
    }
    return { path: input.output_path }
  }

  async videoSourceResponse(projectId: string, sourceId: string, request: Request): Promise<Response> {
    const project = await this.getProject(projectId)
    if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
    const source = project.sources.find(candidate => candidate.id === sourceId)
    if (!source) throw new MediaServiceError('找不到视频素材', 404, 'SOURCE_NOT_FOUND')
    const info = await stat(source.path).catch(() => null)
    if (!info?.isFile()) throw new MediaServiceError('视频素材已经移动或删除', 404, 'SOURCE_MISSING')
    const extension = extname(source.path).toLowerCase()
    const contentType = extension === '.mov'
      ? 'video/quicktime'
      : extension === '.webm'
        ? 'video/webm'
        : 'video/mp4'
    const range = request.headers.get('range')
    if (!range) {
      return new Response(Bun.file(source.path), {
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(info.size),
          'Accept-Ranges': 'bytes',
        },
      })
    }
    const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
    if (!match || info.size <= 0) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
    }
    const suffix = !match[1] && match[2] ? Number(match[2]) : 0
    const start = suffix > 0 ? Math.max(0, info.size - suffix) : match[1] ? Number(match[1]) : 0
    const end = suffix > 0 ? info.size - 1 : match[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= info.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${info.size}` } })
    }
    return new Response(Bun.file(source.path).slice(start, end + 1), {
      status: 206,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(end - start + 1),
        'Content-Range': `bytes ${start}-${end}/${info.size}`,
        'Accept-Ranges': 'bytes',
      },
    })
  }

  async createImageProject(raw: CreateImageProjectInput): Promise<ImageWorkbenchProject> {
    const input = createImageProjectInputSchema.parse(raw)
    const now = this.iso()
    const projectId = id('img')
    const referenceAssets = await this.persistReferenceImages(projectId, input.reference_images)
    const project = imageWorkbenchProjectSchema.parse({
      schema_version: 1,
      id: projectId,
      kind: 'image',
      title: input.title ?? defaultTitle(input.prompt, '新图片'),
      workspace_root: input.workspace_root,
      revision: 0,
      created_at: now,
      updated_at: now,
      state: 'draft',
      mode: input.mode,
      prompt: input.prompt,
      size: input.size,
      count: input.count,
      reference_images: [],
      reference_image_assets: referenceAssets,
      reference_image_count: input.reference_images.length,
      outputs: [],
    })
    return await this.saveProject(project) as ImageWorkbenchProject
  }

  async submitImageProject(
    projectId: string,
    raw: SubmitImageProjectInput = {},
  ): Promise<MediaTask> {
    const input = submitImageProjectInputSchema.parse(raw)
    const project = await this.getProject(projectId)
    if (project.kind !== 'image') {
      throw new MediaServiceError('这不是生图项目', 409, 'WRONG_PROJECT_KIND')
    }
    if (project.task_id) {
      const existing = await this.getTask(project.task_id, false).catch(() => null)
      if (
        existing?.kind === 'image.generate'
        && !existing.remote_task_id
        && existing.idempotency_key
        && (['queued', 'running'].includes(existing.status) || existing.outcome_unknown)
      ) {
        return await this.submitPersistedImageTask(project, existing)
      }
      if (existing?.outcome_unknown && !input.confirm_unknown_retry) {
        throw new MediaServiceError(
          '上一次任务可能已经产生费用。继续会创建新的生图任务，请在桌面工作台明确确认',
          409,
          'IMAGE_UNKNOWN_RETRY_CONFIRMATION_REQUIRED',
        )
      }
      if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') return existing
    }
    if (!qfGatewayConfigured()) {
      throw new MediaServiceError('产品网关尚未配置，无法提交生图任务', 503, 'GATEWAY_NOT_CONFIGURED')
    }

    const now = this.iso()
    const nextRevision = project.revision + 1
    const payload = await this.imageSubmissionPayload(project)
    const digest = createHash('sha256')
      .update(`${project.id}:${nextRevision}:${JSON.stringify(payload)}`)
      .digest('hex')
    let task = mediaTaskSchema.parse({
      schema_version: 1,
      id: id('task'),
      project_id: project.id,
      kind: 'image.generate',
      status: 'queued',
      progress: 0,
      stage: '正在提交',
      idempotency_key: `bb-media-${digest}`,
      created_at: now,
      updated_at: now,
    })
    task = await this.saveTask(task)
    const submittedProject = await this.saveProject({
      ...project,
      state: 'queued',
      task_id: task.id,
      error: undefined,
      notice: undefined,
      revision: nextRevision,
      updated_at: this.iso(),
    }) as ImageWorkbenchProject

    return await this.submitPersistedImageTask(submittedProject, task)
  }

  private async imageSubmissionPayload(project: ImageWorkbenchProject) {
    const referenceImages = project.mode === 'edit' ? await this.loadReferenceImages(project) : []
    return {
      mode: project.mode,
      model: 'gpt-image-2',
      prompt: project.prompt,
      n: project.count,
      size: project.size,
      response_format: 'b64_json',
      ...(project.mode === 'edit' ? { images: referenceImages, input_fidelity: 'high' } : {}),
    }
  }

  private submitPersistedImageTask(project: ImageWorkbenchProject, task: MediaTask): Promise<MediaTask> {
    const active = this.activeImageSubmissions.get(task.id)
    if (active) return active
    const submission = this.performImageSubmission(project, task)
      .finally(() => this.activeImageSubmissions.delete(task.id))
    this.activeImageSubmissions.set(task.id, submission)
    return submission
  }

  private async performImageSubmission(project: ImageWorkbenchProject, originalTask: MediaTask): Promise<MediaTask> {
    if (!qfGatewayConfigured()) {
      throw new MediaServiceError('产品网关尚未配置，无法提交生图任务', 503, 'GATEWAY_NOT_CONFIGURED')
    }
    if (!originalTask.idempotency_key) {
      throw new MediaServiceError('生图任务缺少幂等凭据', 500, 'IMAGE_SUBMISSION_CORRUPT')
    }
    const payload = await this.imageSubmissionPayload(project)
    let task = await this.saveTask({
      ...originalTask,
      status: 'queued',
      progress: Math.max(originalTask.progress, 1),
      stage: originalTask.outcome_unknown ? '正在确认上次提交' : '正在提交',
      error: undefined,
      outcome_unknown: false,
      updated_at: this.iso(),
    })
    const submittedProject = await this.saveProject({
      ...project,
      state: 'queued',
      task_id: task.id,
      error: undefined,
      updated_at: this.iso(),
    }) as ImageWorkbenchProject
    const endpoint = `${getQfGatewayUrl().replace(/\/+$/, '')}/v1/images/tasks`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${getQfGatewayToken()}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': originalTask.idempotency_key,
    }
    const installationId = getInstallationId()
    if (installationId) headers['X-QF-Client-ID'] = installationId

    try {
      const response = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
      const body = await response.json().catch(() => ({})) as RelayImageTask & { message?: string }
      if (!response.ok || !body.task_id) {
        throw new ImageSubmissionAttemptError(
          boundedMessage(body.error ?? body.message ?? `生图网关返回 HTTP ${response.status}`),
          response.status || 502,
          response.status >= 500 || response.ok,
        )
      }
      task = await this.saveTask({
        ...task,
        status: body.status === 'running' ? 'running' : 'queued',
        progress: body.status === 'running' ? 10 : 2,
        stage: body.reused ? '已复用同一任务' : '已进入生图队列',
        remote_task_id: body.task_id,
        updated_at: this.iso(),
      })
      await this.saveProject({
        ...submittedProject,
        state: task.status === 'running' ? 'generating' : 'queued',
        updated_at: this.iso(),
      })
      return task
    } catch (error) {
      const outcomeUnknown = !(error instanceof ImageSubmissionAttemptError) || error.outcomeUnknown
      const detail = boundedMessage(errorMessage(error))
      const message = outcomeUnknown
        ? boundedMessage(`${detail}。上游是否已接收无法确认，可能已经产生费用；再次确认会使用同一幂等凭据，不会主动创建第二笔任务`)
        : detail
      task = await this.saveTask({
        ...task,
        status: 'failed',
        stage: outcomeUnknown ? '提交结果待确认' : '提交失败',
        error: message,
        outcome_unknown: outcomeUnknown,
        updated_at: this.iso(),
      })
      await this.saveProject({ ...submittedProject, state: 'failed', error: message, updated_at: this.iso() })
      throw new MediaServiceError(
        message,
        error instanceof MediaServiceError ? error.status : 502,
        outcomeUnknown ? 'IMAGE_SUBMIT_UNKNOWN' : 'IMAGE_SUBMIT_FAILED',
      )
    }
  }

  async updateImageProject(projectId: string, raw: UpdateImageProjectInput): Promise<ImageWorkbenchProject> {
    const input = updateImageProjectInputSchema.parse(raw)
    const project = await this.getProject(projectId)
    if (project.kind !== 'image') throw new MediaServiceError('这不是生图项目', 409, 'WRONG_PROJECT_KIND')
    if (!['draft', 'failed'].includes(project.state)) {
      throw new MediaServiceError('图片任务已经提交，当前不能修改草稿', 409, 'IMAGE_NOT_EDITABLE')
    }
    if (project.revision !== input.revision) {
      throw new MediaServiceError('图片项目已更新，请刷新后再编辑', 409, 'REVISION_CONFLICT')
    }
    if (project.task_id) {
      const existing = await this.getTask(project.task_id, false).catch(() => null)
      if (existing?.outcome_unknown && !input.confirm_unknown_retry) {
        throw new MediaServiceError(
          '上一次任务可能已经产生费用。修改后再生成会创建新任务，请在桌面工作台明确确认',
          409,
          'IMAGE_UNKNOWN_RETRY_CONFIRMATION_REQUIRED',
        )
      }
    }
    return await this.saveProject({
      ...project,
      state: 'draft',
      task_id: undefined,
      prompt: input.prompt,
      title: defaultTitle(input.prompt, project.title),
      size: input.size,
      count: input.count,
      revision: project.revision + 1,
      error: undefined,
      notice: undefined,
      updated_at: this.iso(),
    }) as ImageWorkbenchProject
  }

  private async refreshImageTask(task: MediaTask): Promise<MediaTask> {
    if (!task.remote_task_id) return task
    if (!qfGatewayConfigured()) return task
    const headers: Record<string, string> = {
      Authorization: `Bearer ${getQfGatewayToken()}`,
    }
    const installationId = getInstallationId()
    if (installationId) headers['X-QF-Client-ID'] = installationId
    const response = await this.fetchImpl(
      `${getQfGatewayUrl().replace(/\/+$/, '')}/v1/images/tasks/${encodeURIComponent(task.remote_task_id)}`,
      { headers },
    )
    const body = await response.json().catch(() => ({})) as RelayImageTask & { message?: string }
    if (!response.ok) {
      const message = boundedMessage(body.error ?? body.message ?? `生图任务查询返回 HTTP ${response.status}`)
      if (response.status >= 500) return task
      return await this.failImageTask(task, message, body.status === 'failed_unknown')
    }
    if (body.status === 'cancelled') {
      return await this.markImageTaskCancelled(task, boundedMessage(body.error ?? '生成已取消'))
    }
    if (body.status === 'failed' || body.status === 'failed_unknown') {
      const detail = boundedMessage(body.error ?? '生图任务失败')
      const message = body.status === 'failed_unknown'
        ? `${detail}。上游结果无法确认，可能已经产生费用，请确认后再决定是否重试`
        : detail
      return await this.failImageTask(task, message, body.status === 'failed_unknown')
    }
    if (body.status !== 'succeeded') {
      const next = await this.saveTask({
        ...task,
        status: body.status === 'running' ? 'running' : 'queued',
        progress: body.status === 'running' ? Math.max(task.progress, 35) : Math.max(task.progress, 5),
        stage: body.status === 'running' ? '正在生成' : '等待生成',
        updated_at: this.iso(),
      })
      const project = await this.currentImageProjectForTask(task)
      if (project) {
        await this.saveProject({ ...project, state: next.status === 'running' ? 'generating' : 'queued', updated_at: this.iso() })
      }
      return next
    }

    const attachedProject = await this.currentImageProjectForTask(task)
    if (!attachedProject) {
      return await this.saveTask({
        ...task,
        status: 'succeeded',
        progress: 100,
        stage: '生成完成（结果未附着到当前草稿）',
        result: {
          output_count: body.data?.length ?? 0,
          ...(body.input_fidelity_requested ? { input_fidelity_requested: body.input_fidelity_requested } : {}),
          ...(body.input_fidelity_status ? { input_fidelity_status: body.input_fidelity_status } : {}),
          ...(body.input_fidelity_risk ? { input_fidelity_risk: boundedMessage(body.input_fidelity_risk) } : {}),
        },
        updated_at: this.iso(),
      })
    }

    const outputs: ImageWorkbenchProject['outputs'] = []
    const projectAssetDir = join(this.assetsDir, task.project_id)
    const createdAssets: string[] = []
    await mkdir(projectAssetDir, { recursive: true, mode: 0o700 })
    for (const item of body.data ?? []) {
      const outputId = id('out')
      if (item.b64_json) {
        const fileName = `${outputId}.png`
        const assetPath = join(projectAssetDir, fileName)
        await writeFile(assetPath, Buffer.from(item.b64_json, 'base64'), { mode: 0o600 })
        createdAssets.push(assetPath)
        outputs.push({
          id: outputId,
          mime_type: 'image/png',
          asset_path: `/api/media/assets/${task.project_id}/${fileName}`,
          revised_prompt: item.revised_prompt,
        })
      } else if (item.url) {
        outputs.push({
          id: outputId,
          mime_type: 'image/png',
          url: item.url,
          revised_prompt: item.revised_prompt,
        })
      }
    }
    if (outputs.length === 0) {
      return await this.failImageTask(task, '生图任务完成，但没有返回可用图片')
    }
    const next = await this.saveTask({
      ...task,
      status: 'succeeded',
      progress: 100,
      stage: '生成完成',
      result: {
        output_count: outputs.length,
        outputs,
        ...(body.input_fidelity_requested ? { input_fidelity_requested: body.input_fidelity_requested } : {}),
        ...(body.input_fidelity_status ? { input_fidelity_status: body.input_fidelity_status } : {}),
        ...(body.input_fidelity_risk ? { input_fidelity_risk: boundedMessage(body.input_fidelity_risk) } : {}),
      },
      updated_at: this.iso(),
    })
    const project = await this.currentImageProjectForTask(task)
    if (!project) {
      await Promise.all(createdAssets.map(assetPath => rm(assetPath, { force: true })))
      return await this.saveTask({
        ...next,
        stage: '生成完成（结果未附着到当前草稿）',
        result: {
          output_count: outputs.length,
          ...(body.input_fidelity_requested ? { input_fidelity_requested: body.input_fidelity_requested } : {}),
          ...(body.input_fidelity_status ? { input_fidelity_status: body.input_fidelity_status } : {}),
          ...(body.input_fidelity_risk ? { input_fidelity_risk: boundedMessage(body.input_fidelity_risk) } : {}),
        },
        updated_at: this.iso(),
      })
    }
    await this.saveProject({
      ...project,
      state: 'ready',
      outputs,
      notice: body.input_fidelity_risk ? boundedMessage(body.input_fidelity_risk) : undefined,
      error: undefined,
      updated_at: this.iso(),
    })
    return next
  }

  private async failImageTask(task: MediaTask, message: string, outcomeUnknown = false): Promise<MediaTask> {
    const next = await this.saveTask({
      ...task,
      status: 'failed',
      stage: '生成失败',
      error: message,
      outcome_unknown: outcomeUnknown,
      updated_at: this.iso(),
    })
    const project = await this.currentImageProjectForTask(task)
    if (project) {
      await this.saveProject({ ...project, state: 'failed', error: message, updated_at: this.iso() })
    }
    return next
  }

  private async markImageTaskCancelled(task: MediaTask, message = '生成已取消'): Promise<MediaTask> {
    const next = await this.saveTask({
      ...task,
      status: 'cancelled',
      progress: 0,
      stage: '已取消',
      error: message,
      outcome_unknown: false,
      updated_at: this.iso(),
    })
    const project = await this.getProject(task.project_id).catch(() => null)
    if (project?.kind === 'image' && project.task_id === task.id) {
      await this.saveProject({ ...project, state: 'failed', error: message, updated_at: this.iso() })
    }
    return next
  }

  async createVideoProject(raw: CreateVideoProjectInput): Promise<VideoStudioProject> {
    const input = createVideoProjectInputSchema.parse(raw)
    const now = this.iso()
    const project = videoStudioProjectSchema.parse({
      schema_version: 1,
      id: id('vid'),
      kind: 'video',
      title: input.title ?? '新视频',
      workspace_root: input.workspace_root,
      revision: 0,
      created_at: now,
      updated_at: now,
      state: 'draft',
      sources: [],
      timeline: [],
      output: input.output,
    })
    return await this.saveProject(project) as VideoStudioProject
  }

  private binary(name: 'ffmpeg' | 'ffprobe'): string {
    const explicit = this.env[name === 'ffmpeg' ? 'FFMPEG_BIN' : 'FFPROBE_BIN']?.trim()
    if (explicit) return explicit
    const directory = this.env.BB_MEDIA_BIN_DIR?.trim()
    if (directory) return join(directory, process.platform === 'win32' ? `${name}.exe` : name)
    return name
  }

  async toolchainStatus(): Promise<{
    ffmpeg: { available: boolean; command: string }
    ffprobe: { available: boolean; command: string }
  }> {
    const check = async (name: 'ffmpeg' | 'ffprobe') => {
      const command = this.binary(name)
      if (isAbsolute(command) && !existsSync(command)) return { available: false, command }
      try {
        const result = await this.runProcess([command, '-version'])
        return { available: result.exitCode === 0, command }
      } catch {
        return { available: false, command }
      }
    }
    const [ffmpeg, ffprobe] = await Promise.all([check('ffmpeg'), check('ffprobe')])
    return { ffmpeg, ffprobe }
  }

  private async videoEncoderProfile(): Promise<VideoEncoderProfile> {
    this.encoderProfilePromise ??= this.detectVideoEncoderProfile()
    return await this.encoderProfilePromise
  }

  private async detectVideoEncoderProfile(): Promise<VideoEncoderProfile> {
    const result = await this.runProcess([this.binary('ffmpeg'), '-hide_banner', '-encoders']).catch(() => null)
    const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`
    const has = (name: string) => new RegExp(`(^|\\s)${name}(\\s|$)`, 'm').test(output)
    const explicit = this.env.BB_FFMPEG_VIDEO_ENCODER?.trim()
    if (explicit) {
      if (!['h264_videotoolbox', 'h264_mf', 'mpeg4'].includes(explicit) || !has(explicit)) {
        throw new MediaServiceError(`配置的视频编码器不可用: ${explicit}`, 503, 'VIDEO_ENCODER_UNAVAILABLE')
      }
      return explicit === 'mpeg4'
        ? FALLBACK_VIDEO_ENCODER
        : { name: explicit as VideoEncoderProfile['name'], args: ['-b:v', '8M'] }
    }
    if (process.platform === 'darwin' && has('h264_videotoolbox')) {
      return { name: 'h264_videotoolbox', args: ['-b:v', '8M'] }
    }
    if (process.platform === 'win32' && has('h264_mf')) {
      return { name: 'h264_mf', args: ['-b:v', '8M'] }
    }
    return FALLBACK_VIDEO_ENCODER
  }

  async addVideoSource(projectId: string, raw: AddVideoSourceInput): Promise<{ project: VideoStudioProject; task: MediaTask }> {
    return await this.withVideoProjectMutation(projectId, () => this.addVideoSourceSerial(projectId, raw))
  }

  private async addVideoSourceSerial(projectId: string, raw: AddVideoSourceInput): Promise<{ project: VideoStudioProject; task: MediaTask }> {
    const input = addVideoSourceInputSchema.parse(raw)
    const project = await this.getProject(projectId)
    if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
    if (project.state === 'rendering') throw new MediaServiceError('正在导出，暂时不能添加素材', 409, 'RENDER_IN_PROGRESS')
    if (!isAbsolute(input.path)) throw new MediaServiceError('视频素材必须使用绝对路径', 400, 'SOURCE_PATH_NOT_ABSOLUTE')
    const info = await stat(input.path).catch(() => null)
    if (!info?.isFile()) throw new MediaServiceError('找不到视频素材文件', 404, 'SOURCE_NOT_FOUND')

    const now = this.iso()
    let task = await this.saveTask({
      schema_version: 1,
      id: id('task'),
      project_id: project.id,
      kind: 'video.probe',
      status: 'running',
      progress: 20,
      stage: '正在读取素材',
      created_at: now,
      updated_at: now,
    })
    try {
      const result = await this.runProcess([
        this.binary('ffprobe'),
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        input.path,
      ])
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `ffprobe exited ${result.exitCode}`)
      }
      const metadata = JSON.parse(result.stdout) as {
        format?: { duration?: string }
        streams?: Array<Record<string, unknown>>
      }
      const video = metadata.streams?.find(stream => stream.codec_type === 'video')
      if (!video) throw new Error('素材中没有视频轨道')
      const source: VideoSource = {
        id: id('src'),
        path: input.path,
        name: basename(input.path),
        duration_ms: Math.max(1, Math.round(Number(metadata.format?.duration ?? video.duration ?? 0) * 1000)),
        width: Math.max(0, Number(video.width ?? 0)),
        height: Math.max(0, Number(video.height ?? 0)),
        fps: parseRate(video.avg_frame_rate ?? video.r_frame_rate),
        has_audio: Boolean(metadata.streams?.some(stream => stream.codec_type === 'audio')),
      }
      const clip: VideoClip = {
        id: id('clip'),
        source_id: source.id,
        in_ms: 0,
        out_ms: Math.max(1, source.duration_ms),
      }
      const nextProject = await this.saveProject({
        ...project,
        state: 'ready',
        sources: [...project.sources, source],
        timeline: [...project.timeline, clip],
        revision: project.revision + 1,
        updated_at: this.iso(),
      }) as VideoStudioProject
      task = await this.saveTask({
        ...task,
        status: 'succeeded',
        progress: 100,
        stage: '素材已加入',
        result: { source_id: source.id },
        updated_at: this.iso(),
      })
      return { project: nextProject, task }
    } catch (error) {
      const message = boundedMessage(errorMessage(error))
      task = await this.saveTask({ ...task, status: 'failed', stage: '读取失败', error: message, updated_at: this.iso() })
      throw new MediaServiceError(`无法读取视频素材: ${message}`, 422, 'VIDEO_PROBE_FAILED')
    }
  }

  async updateVideoTimeline(projectId: string, raw: UpdateVideoTimelineInput): Promise<VideoStudioProject> {
    return await this.withVideoProjectMutation(projectId, () => this.updateVideoTimelineSerial(projectId, raw))
  }

  private async updateVideoTimelineSerial(projectId: string, raw: UpdateVideoTimelineInput): Promise<VideoStudioProject> {
    const input = updateVideoTimelineInputSchema.parse(raw)
    const project = await this.getProject(projectId)
    if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
    if (project.state === 'rendering') throw new MediaServiceError('正在导出，暂时不能修改时间线', 409, 'RENDER_IN_PROGRESS')
    if (project.revision !== input.revision) throw new MediaServiceError('视频项目已更新，请刷新后再编辑', 409, 'REVISION_CONFLICT')
    const sources = new Map(project.sources.map(source => [source.id, source]))
    for (const clip of input.clips) {
      const source = sources.get(clip.source_id)
      if (!source) throw new MediaServiceError('时间线引用了不存在的素材', 400, 'SOURCE_NOT_FOUND')
      if (clip.out_ms > source.duration_ms) throw new MediaServiceError('剪辑范围超过素材时长', 400, 'CLIP_OUT_OF_RANGE')
    }
    return await this.saveProject({
      ...project,
      timeline: input.clips,
      state: input.clips.length ? 'ready' : 'draft',
      revision: project.revision + 1,
      updated_at: this.iso(),
    }) as VideoStudioProject
  }

  async renderVideo(projectId: string, raw: RenderVideoInput): Promise<MediaTask> {
    return await this.withVideoProjectMutation(projectId, () => this.renderVideoSerial(projectId, raw))
  }

  private async renderVideoSerial(projectId: string, raw: RenderVideoInput): Promise<MediaTask> {
    if (this.renderStarting) {
      throw new MediaServiceError('另一个视频正在准备导出，请稍后重试', 409, 'VIDEO_RENDER_BUSY')
    }
    this.renderStarting = true
    try {
      const input = renderVideoInputSchema.parse(raw)
      const project = await this.getProject(projectId)
      if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
      if (project.state === 'rendering') {
        const existing = project.task_id ? await this.getTask(project.task_id, false).catch(() => null) : null
        if (existing && ['queued', 'running', 'committing'].includes(existing.status)) return existing
        throw new MediaServiceError('导出状态异常，请刷新后重试', 409, 'RENDER_STATE_CONFLICT')
      }
      if (this.activeRenders.size > 0) {
        throw new MediaServiceError('另一个视频正在导出，请等待完成或取消后再试', 409, 'VIDEO_RENDER_BUSY')
      }
      if (project.revision !== input.revision) throw new MediaServiceError('视频项目已更新，请刷新后再导出', 409, 'REVISION_CONFLICT')
      if (!project.timeline.length) throw new MediaServiceError('时间线还是空的', 409, 'EMPTY_TIMELINE')
      if (!isAbsolute(input.output_path)) throw new MediaServiceError('导出路径必须是绝对路径', 400, 'OUTPUT_PATH_NOT_ABSOLUTE')
      if (!['.mp4', '.mov'].includes(extname(input.output_path).toLowerCase())) {
        throw new MediaServiceError('视频只能导出为 MP4 或 MOV', 400, 'OUTPUT_FORMAT_UNSUPPORTED')
      }
      if (await this.outputMatchesSource(input.output_path, project.sources)) {
        throw new MediaServiceError('导出位置不能覆盖原始视频素材', 409, 'OUTPUT_OVERWRITES_SOURCE')
      }
      const status = await this.toolchainStatus()
      if (!status.ffmpeg.available || !status.ffprobe.available) {
        throw new MediaServiceError('本机尚未准备 FFmpeg/ffprobe', 503, 'VIDEO_TOOLCHAIN_UNAVAILABLE')
      }

      const now = this.iso()
      const task = await this.saveTask({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.render',
        status: 'queued',
        progress: 0,
        stage: '等待导出',
        result: { render_revision: project.revision, output_path: input.output_path },
        created_at: now,
        updated_at: now,
      })
      await this.saveProject({
        ...project,
        state: 'rendering',
        task_id: task.id,
        output_path: input.output_path,
        error: undefined,
        updated_at: this.iso(),
      })
      const controller = new AbortController()
      const completion = Promise.resolve().then(() => (
        this.runVideoRender(project, task, input.output_path, controller.signal)
      ))
      this.activeRenders.set(task.id, { controller, completion })
      return task
    } finally {
      this.renderStarting = false
    }
  }

  private async runVideoRender(
    project: VideoStudioProject,
    task: MediaTask,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const extension = extname(outputPath).toLowerCase() || '.mp4'
    const temporaryOutput = join(
      dirname(outputPath),
      `${basename(outputPath, extension)}.partial-${task.id}${extension}`,
    )
    try {
      await mkdir(dirname(outputPath), { recursive: true })
      await this.saveTask({
        ...task,
        status: 'running',
        progress: 10,
        stage: '正在导出',
        result: {
          ...(task.result ?? {}),
          temporary_output: temporaryOutput,
        },
        updated_at: this.iso(),
      })
      const encoder = await this.videoEncoderProfile()
      if (signal.aborted) throw new Error('导出已取消')
      const result = await this.runProcess(
        buildVideoRenderCommand(this.binary('ffmpeg'), project, temporaryOutput, encoder),
        { signal },
      )
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `ffmpeg exited ${result.exitCode}`)
      if (signal.aborted) throw new Error('导出已取消')
      await this.saveTask({
        ...task,
        status: 'committing',
        progress: 95,
        stage: '正在完成导出',
        result: {
          ...(task.result ?? {}),
          temporary_output: temporaryOutput,
        },
        updated_at: this.iso(),
      })
      if (signal.aborted) throw new Error('导出已取消')
      await this.moveFile(temporaryOutput, outputPath)
      await this.saveTask({
        ...task,
        status: 'succeeded',
        progress: 100,
        stage: '导出完成',
        result: {
          ...(task.result ?? {}),
          output_path: outputPath,
          temporary_output: undefined,
          video_encoder: encoder.name,
        },
        updated_at: this.iso(),
      })
      const latest = await this.getProject(project.id)
      if (latest.kind === 'video' && latest.revision === project.revision && latest.task_id === task.id) {
        await this.saveProject({ ...latest, state: 'complete', output_path: outputPath, error: undefined, updated_at: this.iso() })
      }
    } catch (error) {
      const cancelled = signal.aborted
      const message = cancelled ? '导出已取消' : boundedMessage(errorMessage(error))
      await this.saveTask({
        ...task,
        status: cancelled ? 'cancelled' : 'failed',
        progress: 0,
        stage: cancelled ? '已取消' : '导出失败',
        error: message,
        updated_at: this.iso(),
      })
      const latest = await this.getProject(project.id).catch(() => null)
      if (latest?.kind === 'video' && latest.task_id === task.id) {
        await this.saveProject({
          ...latest,
          state: cancelled ? 'ready' : 'failed',
          error: message,
          updated_at: this.iso(),
        })
      }
    } finally {
      this.activeRenders.delete(task.id)
      await rm(temporaryOutput, { force: true }).catch(() => undefined)
    }
  }

  async cancelTask(taskId: string): Promise<MediaTask> {
    const task = await this.getTask(taskId, false)
    if (task.kind === 'image.generate') {
      return await this.cancelQueuedImageTask(task)
    }
    if (task.kind !== 'video.render' || !['queued', 'running'].includes(task.status)) {
      throw new MediaServiceError('当前任务不能取消', 409, 'TASK_NOT_CANCELLABLE')
    }
    const active = this.activeRenders.get(taskId)
    if (active) {
      active.controller.abort()
      await active.completion
      return await this.getTask(taskId, false)
    }
    const latestTask = await this.getTask(taskId, false)
    if (!['queued', 'running'].includes(latestTask.status)) {
      throw new MediaServiceError('当前任务不能取消', 409, 'TASK_NOT_CANCELLABLE')
    }
    const next = await this.saveTask({
      ...latestTask,
      status: 'cancelled',
      stage: '已取消',
      error: '导出已取消',
      updated_at: this.iso(),
    })
    const project = await this.getProject(latestTask.project_id).catch(() => null)
    if (project?.kind === 'video' && project.task_id === latestTask.id) {
      await this.saveProject({ ...project, state: 'ready', error: '导出已取消', updated_at: this.iso() })
    }
    return next
  }

  private async cancelQueuedImageTask(task: MediaTask): Promise<MediaTask> {
    if (task.status !== 'queued' || !task.remote_task_id) {
      throw new MediaServiceError('生图任务已经开始或提交结果尚未确认，不能安全取消', 409, 'TASK_NOT_CANCELLABLE')
    }
    if (!qfGatewayConfigured()) {
      throw new MediaServiceError('产品网关尚未配置，无法确认取消结果', 503, 'GATEWAY_NOT_CONFIGURED')
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${getQfGatewayToken()}`,
    }
    const installationId = getInstallationId()
    if (installationId) headers['X-QF-Client-ID'] = installationId
    let response: Response
    try {
      response = await this.fetchImpl(
        `${getQfGatewayUrl().replace(/\/+$/, '')}/v1/images/tasks/${encodeURIComponent(task.remote_task_id)}/cancel`,
        { method: 'POST', headers },
      )
    } catch (error) {
      throw new MediaServiceError(
        `无法确认生图任务是否已取消: ${boundedMessage(errorMessage(error))}`,
        502,
        'IMAGE_CANCEL_UNKNOWN',
      )
    }
    const body = await response.json().catch(() => ({})) as RelayImageTask & { message?: string }
    if (!response.ok || body.status !== 'cancelled') {
      throw new MediaServiceError(
        boundedMessage(body.error ?? body.message ?? '生图任务已经开始，不能安全取消'),
        response.status || 409,
        'TASK_NOT_CANCELLABLE',
      )
    }
    return await this.markImageTaskCancelled(task)
  }

  async deleteProject(projectId: string): Promise<void> {
    const project = await this.getProject(projectId)
    if (project.task_id) {
      const task = await this.getTask(project.task_id, false).catch(() => null)
      if (task && ['queued', 'running', 'committing'].includes(task.status)) {
        throw new MediaServiceError('请先等待当前任务完成或取消导出', 409, 'TASK_IN_PROGRESS')
      }
    }
    const taskNames = await readdir(this.tasksDir).catch(() => [])
    await Promise.all(taskNames.filter(name => name.endsWith('.json')).map(async name => {
      const taskPath = join(this.tasksDir, name)
      try {
        const task = mediaTaskSchema.parse(JSON.parse(await readFile(taskPath, 'utf8')))
        if (task.project_id === projectId) await rm(taskPath, { force: true })
      } catch {
        // A corrupt unrelated task must not block deleting this project.
      }
    }))
    await Promise.all([
      rm(this.projectPath(projectId), { force: true }),
      rm(join(this.assetsDir, projectId), { recursive: true, force: true }),
    ])
  }
}
