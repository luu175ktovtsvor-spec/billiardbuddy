import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  addImageProjectReferencesInputSchema,
  addVideoSourceInputSchema,
  analyzeVideoProjectInputSchema,
  applyVideoAlternativeInputSchema,
  commitImageVersionInputSchema,
  createImageProjectInputSchema,
  createVideoProjectInputSchema,
  imageGenerationModelSchema,
  imageSizeSupportedByModel,
  imageWorkbenchProjectSchema,
  imageGenerationTaskResultSchema,
  MAX_REFERENCE_IMAGES_TOTAL_BYTES,
  mediaDeletionReceiptSchema,
  mediaJobEventJournalSchema,
  mediaSafeError,
  mediaProjectSchema,
  mediaTaskSchema,
  previewVideoInputSchema,
  renderVideoInputSchema,
  saveImageOutputInputSchema,
  selectImageVersionInputSchema,
  selectVideoTimelineVersionInputSchema,
  startImageOperationInputSchema,
  submitImageProjectInputSchema,
  updateImageProjectInputSchema,
  updateVideoTimelineInputSchema,
  lockVideoSceneInputSchema,
  videoStudioProjectSchema,
  videoPreviewTaskResultSchema,
  videoRenderTaskResultSchema,
  type AddVideoSourceInput,
  type AddImageProjectReferencesInput,
  type AnalyzeVideoProjectInput,
  type ApplyVideoAlternativeInput,
  type CommitImageVersionInput,
  type CreateImageProjectInput,
  type CreateVideoProjectInput,
  type ImageWorkbenchProject,
  type MediaAsset,
  type MediaDeletionReceipt,
  type MediaJobEvent,
  type MediaJobEventJournal,
  type MediaOwner,
  type MediaProject,
  type MediaSafeErrorCode,
  type MediaTask,
  type MediaTaskInput,
  type PreviewVideoInput,
  type RenderVideoInput,
  type SaveImageOutputInput,
  type SelectImageVersionInput,
  type SelectVideoTimelineVersionInput,
  type StartImageOperationInput,
  type SubmitImageProjectInput,
  type UpdateImageProjectInput,
  type UpdateVideoTimelineInput,
  type LockVideoSceneInput,
  type VideoClip,
  type VideoAlternative,
  type VideoEvidence,
  type VideoOutputVerification,
  type VideoScene,
  type VideoSource,
  type VideoStudioProject,
  type VideoTimelineVersion,
} from '../../../shared/contracts/media.js'
import {
  MEDIA_RESULT_HANDOFF_DIRECT_V1,
  MEDIA_RESULT_HANDOFF_HEADER,
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
} from '../../../shared/product/providerGateway.js'
import { diagnosticsService } from './diagnosticsService.js'
import { lock } from '../../utils/lockfile.js'
import {
  productGatewayConfigured,
  productGatewayTarget,
} from '../product/productGatewayRuntime.js'
import { providerRegistryEntriesForCapability } from '../../../../gateway/providerRegistry.js'
import { applyImageBriefOverrides, compileImageBrief, providerPromptForImageBrief } from './imageBrief.js'
import {
  assessImageCandidates,
  ImageReasoningError,
  reasonImageBrief,
  type ImageQualityAssessment,
} from './imageReasoning.js'
import { transcribeVoiceFile } from './voiceTranscription.js'
import {
  analyzeVideoEvidence,
  compileVideoBrief,
  planVideoTimeline,
  VideoAnalysisError,
  type VideoAnalysisFrame,
  type VideoPlanDraft,
} from './videoAnalysis.js'

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
  outputPath: string
}

type ActiveVideoPreview = {
  controller: AbortController
  completion: Promise<void>
  outputPath: string
}

type ActiveVideoAnalysis = {
  controller: AbortController
  completion: Promise<void>
}

type QueuedVideoRender = {
  project: VideoStudioProject
  task: MediaTask
  outputPath: string
}

type MoveFile = (source: string, destination: string) => Promise<void>

const FALLBACK_VIDEO_ENCODER: VideoEncoderProfile = {
  name: 'mpeg4',
  args: ['-q:v', '3'],
}

/**
 * A desktop export owns the local encoder, rather than a shared gateway
 * worker. Keep one FFmpeg process active per desktop sidecar, but retain nine
 * lightweight task records so a user's ten-window burst is accepted rather than
 * rejected. This does not claim ten simultaneous encoders: video bytes and CPU
 * remain local and exactly one export runs per desktop.
 */
const DEFAULT_MAX_QUEUED_VIDEO_RENDERS = 9
const MAX_QUEUED_VIDEO_RENDERS = 9
const MAX_CONCURRENT_VIDEO_PROBES = 2
// Match the ten-window export envelope while still serializing the actual
// local metadata reads to two FFprobe processes. Eight lightweight waiters
// means every window can import a source, without turning that burst into ten
// disk scans at once.
const DEFAULT_MAX_QUEUED_VIDEO_PROBES = 8
const MAX_QUEUED_VIDEO_PROBES = 8
const MAX_MEDIA_JOB_EVENTS_PER_PROJECT = 2000
const MAX_IMAGE_QUALITY_REQUEST_CHARS = 1024 * 1024
const IMAGE_QUALITY_PREVIEW_EDGE = 512

function maxQueuedVideoRenders(env: Record<string, string | undefined>): number {
  const configured = env.BB_MEDIA_MAX_QUEUED_RENDERS?.trim()
  if (!configured) return DEFAULT_MAX_QUEUED_VIDEO_RENDERS
  const parsed = Number(configured)
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_MAX_QUEUED_VIDEO_RENDERS
  return Math.min(parsed, MAX_QUEUED_VIDEO_RENDERS)
}

function maxQueuedVideoProbes(env: Record<string, string | undefined>): number {
  const configured = env.BB_MEDIA_MAX_QUEUED_VIDEO_PROBES?.trim()
  if (!configured) return DEFAULT_MAX_QUEUED_VIDEO_PROBES
  const parsed = Number(configured)
  if (!Number.isInteger(parsed) || parsed < 0) return DEFAULT_MAX_QUEUED_VIDEO_PROBES
  return Math.min(parsed, MAX_QUEUED_VIDEO_PROBES)
}

export type MediaProjectServiceOptions = {
  root?: string
  fetchImpl?: FetchLike
  /** Complete gateway response deadline; injectable only for deterministic timeout tests. */
  imageResultTimeoutMs?: number
  runProcess?: MediaProcessRunner
  moveFile?: MoveFile
  now?: () => Date
  env?: Record<string, string | undefined>
  /** Injectable only for deterministic encoder-selection tests. */
  platform?: NodeJS.Platform
  /** Injectable retention window for deterministic deletion/GC tests. */
  deletionRetentionDays?: number
}

type RelayImageTask = {
  task_id?: string
  status?: string
  poll_after_seconds?: number
  data?: Array<{
    b64_json?: string
    url?: string
    revised_prompt?: string
    mime_type?: 'image/png' | 'image/jpeg' | 'image/webp'
  }>
  error?: string
  reused?: boolean
  input_fidelity_requested?: string
  input_fidelity_status?: 'accepted' | 'unsupported'
  input_fidelity_risk?: string
  provider_receipt_hash?: string
  result_acknowledged?: boolean
  acknowledged_at?: number
  result_url?: string
  result_urls?: string[]
}

function trustedMediaResultUrl(value: unknown, gatewayBaseUrl: string): string | null {
  if (typeof value !== 'string') return null
  try {
    const result = new URL(value)
    const gateway = new URL(gatewayBaseUrl)
    if (
      result.protocol !== 'https:'
      || result.origin !== gateway.origin
      || result.username
      || result.password
      || result.search
      || result.hash
    ) return null
    const prefix = '/relay/imgtasks/images/results/'
    if (!result.pathname.startsWith(prefix)) return null
    const grant = result.pathname.slice(prefix.length)
    if (!/^[A-Za-z0-9_-]+\.[a-f0-9]{64}(?:\/[0-3])?$/.test(grant)) return null
    return result.toString()
  } catch {
    return null
  }
}

function relayPollAfterSeconds(value: unknown, fallbackSeconds: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  const seconds = Number.isFinite(parsed) ? Math.trunc(parsed) : fallbackSeconds
  return Math.max(1, Math.min(3600, seconds))
}

function routedImageModel(userRequest: string, size: ImageWorkbenchProject['size'], hasSubjectReference: boolean) {
  const candidates = providerRegistryEntriesForCapability('ImageGeneration')
    .map(entry => imageGenerationModelSchema.safeParse(entry.model_id))
    .flatMap(result => result.success ? [result.data] : [])
    .filter(model => imageSizeSupportedByModel(model, size))
  if (candidates.length === 0) {
    throw new MediaServiceError('当前 ImageGeneration 能力不支持这个图片尺寸', 400, 'IMAGE_SIZE_UNSUPPORTED')
  }
  if (candidates.length === 1) return candidates[0]!
  if (!hasSubjectReference && /中文|海报|宣传图|活动图|招聘图|朋友圈|易拉宝/u.test(userRequest)) {
    const seedream = candidates.find(model => model === 'doubao-seedream-4-5-251128')
    if (seedream) return seedream
  }
  return candidates.find(model => model === 'gpt-image-2') ?? candidates[0]!
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

function id(prefix: 'img' | 'vid' | 'src' | 'clip' | 'task' | 'out' | 'preview' | 'mask' | 'evidence' | 'scene' | 'alternative' | 'timeline'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

const LEGACY_MEDIA_WRITER_FENCE = `fence_${'0'.repeat(32)}`
const STANDALONE_MEDIA_OWNER: MediaOwner = {
  kind: 'standalone',
  owner_id: 'local_workbench',
}

function migrateLegacyMediaOwnerRecord(raw: unknown): { value: unknown; migrated: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { value: raw, migrated: false }
  const record = raw as Record<string, unknown>
  const owner = record.owner
  const legacyOwner = Boolean(
    'product_task_id' in record
    || (owner && typeof owner === 'object' && !Array.isArray(owner)
      && (owner as Record<string, unknown>).kind === 'product_task'),
  )
  const legacyConsent = 'data_egress_consent' in record
  if (!legacyOwner && !legacyConsent) return { value: raw, migrated: false }
  const value = { ...record }
  if (legacyOwner) {
    value.owner = STANDALONE_MEDIA_OWNER
    delete value.product_task_id
  }
  delete value.data_egress_consent
  return { value, migrated: true }
}

function foundationId(prefix: 'op' | 'ver' | 'export', ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

function videoEvidenceRevision(evidence: VideoEvidence[]): `sha256:${string}` {
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

function scenesFromClips(clips: VideoClip[], evidence: VideoEvidence[]): VideoScene[] {
  return clips.map((clip, index) => ({
    id: clip.id,
    source_id: clip.source_id,
    in_ms: clip.in_ms,
    out_ms: clip.out_ms,
    story_role: index === 0 ? 'hook' as const : index === clips.length - 1 ? 'result' as const : 'action' as const,
    evidence_ids: evidence
      .filter(item => item.source_id === clip.source_id && item.in_ms < clip.out_ms && item.out_ms > clip.in_ms)
      .map(item => item.id),
    rationale: '按当前用户时间线保留真实素材范围',
    needs_review: true,
    locked: false,
  }))
}

function sameOwner(left: MediaOwner, right: MediaOwner): boolean {
  return left.kind === right.kind && left.owner_id === right.owner_id
}

function defaultTitle(prompt: string, fallback: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  return compact ? compact.slice(0, 48) : fallback
}

/**
 * Upstream and local-process diagnostics are useful to support staff, but they
 * are never persisted into a task/project or sent to the renderer. The
 * diagnostics service redacts credential-shaped values before writing.
 */
function recordMediaFailure(operation: string, error: unknown): void {
  void diagnosticsService.recordEvent({
    type: 'media_operation_failed',
    severity: 'error',
    summary: `Media ${operation} failed`,
    details: { operation, error },
  })
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

function detectedImageMime(bytes: Buffer): 'image/png' | 'image/jpeg' | 'image/webp' | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return null
}

function imageDimensions(bytes: Buffer, mimeType: string): { width: number; height: number } | null {
  if (mimeType === 'image/png' && bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
  }
  if (mimeType === 'image/jpeg' && bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      const marker = bytes[offset + 1]!
      if ([0xd8, 0xd9].includes(marker)) { offset += 2; continue }
      const length = bytes.readUInt16BE(offset + 2)
      if (length < 2 || offset + 2 + length > bytes.length) return null
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
        return { width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) }
      }
      offset += 2 + length
    }
  }
  if (mimeType === 'image/webp' && bytes.length >= 30 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('ascii', 12, 16)
    if (chunk === 'VP8X') {
      return {
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      }
    }
    if (chunk === 'VP8L' && bytes[20] === 0x2f && bytes.length >= 25) {
      return {
        width: 1 + bytes[21]! + ((bytes[22]! & 0x3f) << 8),
        height: 1 + (bytes[22]! >> 6) + (bytes[23]! << 2) + ((bytes[24]! & 0x0f) << 10),
      }
    }
    if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
      return {
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      }
    }
  }
  return null
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
  private readonly eventsDir: string
  private readonly assetsDir: string
  private readonly locksDir: string
  private readonly deletionsDir: string
  private readonly trashDir: string
  private readonly casDir: string
  private readonly fetchImpl: FetchLike
  private readonly imageResultTimeoutMs: number
  private readonly runProcess: MediaProcessRunner
  private readonly moveFile: MoveFile
  private readonly now: () => Date
  private readonly env: Record<string, string | undefined>
  private readonly platform: NodeJS.Platform
  private readonly deletionRetentionDays: number
  private readonly activeRenders = new Map<string, ActiveVideoRender>()
  private readonly activeVideoPreviews = new Map<string, ActiveVideoPreview>()
  private readonly activeVideoAnalyses = new Map<string, ActiveVideoAnalysis>()
  private readonly queuedVideoRenders: QueuedVideoRender[] = []
  private readonly maxQueuedVideoRenders: number
  private readonly maxQueuedVideoProbes: number
  private readonly activeImageSubmissions = new Map<string, Promise<MediaTask>>()
  private readonly activeImageRefreshes = new Map<string, Promise<MediaTask>>()
  private readonly videoProjectMutations = new Map<string, Promise<void>>()
  private readonly eventWaiters = new Map<string, Set<() => void>>()
  private videoRenderAdmissions: Promise<void> = Promise.resolve()
  private activeVideoProbes = 0
  private readonly queuedVideoProbeAdmissions: Array<() => void> = []
  private encoderProfilePromise: Promise<VideoEncoderProfile> | null = null

  constructor(options: MediaProjectServiceOptions = {}) {
    this.root = options.root ?? join(process.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'media')
    this.projectsDir = join(this.root, 'projects')
    this.tasksDir = join(this.root, 'tasks')
    this.eventsDir = join(this.root, 'events')
    this.assetsDir = join(this.root, 'assets')
    this.locksDir = join(this.root, 'locks')
    this.deletionsDir = join(this.root, 'deletions')
    this.trashDir = join(this.root, 'trash')
    this.casDir = join(this.root, 'cas', 'sha256')
    this.fetchImpl = options.fetchImpl ?? fetch
    this.imageResultTimeoutMs = Math.max(1, options.imageResultTimeoutMs ?? 5 * 60_000)
    this.runProcess = options.runProcess ?? defaultRunProcess
    this.moveFile = options.moveFile ?? rename
    this.now = options.now ?? (() => new Date())
    this.env = options.env ?? process.env
    this.platform = options.platform ?? process.platform
    this.deletionRetentionDays = Math.max(1, Math.min(365, Math.trunc(
      options.deletionRetentionDays ?? Number(this.env.BB_MEDIA_DELETION_RETENTION_DAYS ?? 30),
    ) || 30))
    this.maxQueuedVideoRenders = maxQueuedVideoRenders(this.env)
    this.maxQueuedVideoProbes = maxQueuedVideoProbes(this.env)
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private async fileFingerprint(path: string): Promise<`sha256:${string}`> {
    const digest = createHash('sha256')
    for await (const chunk of Bun.file(path).stream()) digest.update(chunk)
    return `sha256:${digest.digest('hex')}`
  }

  private timelineVersion(
    project: VideoStudioProject,
    scenes: VideoScene[],
    evidenceRevision = project.evidence_revision ?? videoEvidenceRevision(project.evidence),
    projectRevision = project.revision + 1,
  ): VideoTimelineVersion {
    return {
      id: id('timeline'),
      parent_version_id: project.current_timeline_version_id,
      project_revision: projectRevision,
      evidence_revision: evidenceRevision,
      scenes,
      created_at: this.iso(),
    }
  }

  private async fetchImageGatewayJson(
    input: RequestInfo | URL,
    init: RequestInit,
  ): Promise<{ response: Response; body: RelayImageTask & { message?: string } }> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('image gateway response deadline exceeded'))
      }, this.imageResultTimeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    const fetchAndRead = async () => {
      const response = await this.fetchImpl(input, { ...init, signal: controller.signal })
      const text = await response.text()
      const body = (text ? JSON.parse(text) : {}) as RelayImageTask & { message?: string }
      return { response, body }
    }
    try {
      return await Promise.race([fetchAndRead(), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private async boundedImageQualityCandidates(
    candidates: Array<{
      data_url: string
      candidate_index: number
      source_path: string
      width?: number
      height?: number
    }>,
    options: {
      maxChars?: number
      previewEdge?: number
      jpegQuality?: number
    } = {},
  ): Promise<Array<{ data_url: string; candidate_index: number }>> {
    const maxChars = options.maxChars ?? MAX_IMAGE_QUALITY_REQUEST_CHARS
    const previewEdge = options.previewEdge ?? IMAGE_QUALITY_PREVIEW_EDGE
    const jpegQuality = options.jpegQuality ?? 6
    const needsPreview = candidates.reduce((total, candidate) => total + candidate.data_url.length, 0)
      > maxChars
      || candidates.some(candidate => Math.max(candidate.width ?? 0, candidate.height ?? 0) > previewEdge)
    if (!needsPreview) {
      return candidates.map(({ data_url, candidate_index }) => ({ data_url, candidate_index }))
    }

    const previews: Array<{ data_url: string; candidate_index: number }> = []
    for (const candidate of candidates) {
      const previewPath = `${candidate.source_path}.quality-${randomUUID()}.jpg`
      try {
        const result = await this.runProcess([
          this.binary('ffmpeg'),
          '-hide_banner', '-loglevel', 'error', '-y',
          '-i', candidate.source_path,
          '-vf', `scale=${previewEdge}:${previewEdge}:force_original_aspect_ratio=decrease`,
          '-map_metadata', '-1',
          '-frames:v', '1',
          '-pix_fmt', 'yuv420p',
          '-q:v', String(jpegQuality),
          previewPath,
        ], { signal: AbortSignal.timeout(30_000) })
        if (result.exitCode !== 0) throw new Error('image quality preview conversion failed')
        const bytes = await readFile(previewPath)
        if (bytes.length === 0) throw new Error('image quality preview is empty')
        previews.push({
          candidate_index: candidate.candidate_index,
          data_url: `data:image/jpeg;base64,${bytes.toString('base64')}`,
        })
      } finally {
        await rm(previewPath, { force: true }).catch(() => undefined)
      }
    }
    if (previews.reduce((total, candidate) => total + candidate.data_url.length, 0) > maxChars) {
      throw new Error('image quality previews exceed the bounded reasoning payload')
    }
    return previews
  }

  private async ensureDirs(): Promise<void> {
    await Promise.all([
      mkdir(this.projectsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.tasksDir, { recursive: true, mode: 0o700 }),
      mkdir(this.eventsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.assetsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.locksDir, { recursive: true, mode: 0o700 }),
      mkdir(this.deletionsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.trashDir, { recursive: true, mode: 0o700 }),
      mkdir(this.casDir, { recursive: true, mode: 0o700 }),
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

  private eventJournalPath(projectId: string): string {
    this.projectPath(projectId)
    return join(this.eventsDir, `${projectId}.json`)
  }

  private deletionPath(deletionId: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{7,79}$/.test(deletionId)) {
      throw new MediaServiceError('无效的媒体删除回执 ID', 400, 'INVALID_DELETION_ID')
    }
    return join(this.deletionsDir, `${deletionId}.json`)
  }

  private trashPath(trashKey: string): string {
    if (!/^[a-z0-9][a-z0-9_-]{7,79}$/.test(trashKey)) {
      throw new MediaServiceError('无效的媒体回收目录 ID', 400, 'INVALID_TRASH_KEY')
    }
    return join(this.trashDir, trashKey)
  }

  private async withProjectWriteLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    await this.ensureDirs()
    const guard = join(this.locksDir, `${projectId}.guard`)
    await writeFile(guard, '', { flag: 'a', mode: 0o600 })
    const release = await lock(guard, {
      stale: 30_000,
      retries: { retries: 100, minTimeout: 5, maxTimeout: 25 },
    })
    try {
      return await action()
    } finally {
      await release()
    }
  }

  private async withCasWriteLock<T>(action: () => Promise<T>): Promise<T> {
    await this.ensureDirs()
    const guard = join(this.locksDir, 'cas.guard')
    await writeFile(guard, '', { flag: 'a', mode: 0o600 })
    const release = await lock(guard, {
      stale: 30_000,
      retries: { retries: 100, minTimeout: 5, maxTimeout: 25 },
    })
    try {
      return await action()
    } finally {
      await release()
    }
  }

  private async withEventWriteLock<T>(projectId: string, action: () => Promise<T>): Promise<T> {
    await this.ensureDirs()
    const guard = join(this.locksDir, `events-${projectId}.guard`)
    await writeFile(guard, '', { flag: 'a', mode: 0o600 })
    const release = await lock(guard, {
      stale: 30_000,
      retries: { retries: 100, minTimeout: 5, maxTimeout: 25 },
    })
    try {
      return await action()
    } finally {
      await release()
    }
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

  private async managedAssetMetadata(
    locator: string,
  ): Promise<Pick<MediaAsset, 'byte_size' | 'content_hash' | 'storage'>> {
    const path = join(this.assetsDir, locator)
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return { storage: { kind: 'managed', locator } }
    const bytes = await readFile(path)
    const digest = createHash('sha256').update(bytes).digest('hex')
    const blob = join(this.casDir, digest)
    const temporary = join(this.casDir, `.tmp-${randomUUID()}`)
    await writeFile(temporary, bytes, { mode: 0o600 })
    try {
      await link(temporary, blob)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existingDigest = createHash('sha256').update(await readFile(blob)).digest('hex')
      if (existingDigest !== digest) {
        throw new MediaServiceError('媒体内容寻址存储校验失败', 500, 'MEDIA_CAS_CORRUPT')
      }
    } finally {
      await rm(temporary, { force: true })
    }
    return {
      storage: { kind: 'cas', locator: `sha256/${digest}` },
      byte_size: info.size,
      content_hash: `sha256:${digest}`,
    }
  }

  private async verifiedImageMimeCorrection(existing: MediaAsset, candidate: MediaAsset): Promise<boolean> {
    if (existing.storage.kind !== 'cas' || candidate.storage.kind !== 'cas') return false
    if (JSON.stringify({ ...existing, mime_type: candidate.mime_type }) !== JSON.stringify(candidate)) return false
    const match = /^sha256\/([a-f0-9]{64})$/.exec(existing.storage.locator)
    if (!match) return false
    const bytes = await readFile(join(this.casDir, match[1]!)).catch(() => null)
    return Boolean(bytes && detectedImageMime(bytes) === candidate.mime_type)
  }

  private async materializeProjectFoundation(
    project: MediaProject,
    current?: MediaProject,
  ): Promise<MediaProject> {
    const owner = project.owner
    const seeds: Array<Omit<MediaAsset, 'version_id' | 'created_at' | 'byte_size' | 'content_hash'> & {
      version_id?: string
      byte_size?: number
      content_hash?: `sha256:${string}`
    }> = []

    if (project.kind === 'image') {
      for (const fileName of project.reference_image_assets ?? []) {
        seeds.push({
          id: fileName.slice(0, fileName.lastIndexOf('.')),
          role: 'reference',
          storage: { kind: 'managed', locator: join(project.id, 'references', fileName) },
          mime_type: referenceImageMime(fileName),
        })
      }
      for (const output of project.outputs) {
        if (output.asset_path) {
          const fileName = output.asset_path.split('/').pop()
          if (fileName) {
            seeds.push({
              id: output.id,
              version_id: output.version_id,
              role: 'result',
              storage: { kind: 'managed', locator: join(project.id, fileName) },
              mime_type: output.mime_type,
            })
          }
        } else if (output.url) {
          seeds.push({
            id: output.id,
            version_id: output.version_id,
            role: 'result',
            storage: { kind: 'remote', locator: output.url },
            mime_type: output.mime_type,
          })
      } else if (output.data_url) {
          const bytes = dataUrlBytes(output.data_url)
          const digest = createHash('sha256').update(bytes).digest('hex')
          seeds.push({
            id: output.id,
            version_id: output.version_id,
            role: 'result',
            storage: { kind: 'remote', locator: `legacy-inline:sha256:${digest}` },
            mime_type: output.mime_type,
            byte_size: bytes.byteLength,
            content_hash: `sha256:${digest}`,
          })
        }
      }
    } else {
      for (const source of project.sources) {
        const info = await stat(source.path).catch(() => null)
        seeds.push({
          id: source.id,
          role: 'source',
          storage: { kind: 'external', locator: source.path },
          mime_type: this.videoContentType(source.path),
          byte_size: info?.isFile() ? info.size : undefined,
          content_hash: source.fingerprint as `sha256:${string}` | undefined,
        })
      }
      if (project.state === 'complete' && project.output_path) {
        seeds.push({
          id: project.output_asset_id ?? foundationId('export', project.id, String(project.revision), project.output_path),
          role: 'export',
          storage: { kind: 'external', locator: project.output_path },
          mime_type: this.videoContentType(project.output_path),
          byte_size: await stat(project.output_path).then(info => info.isFile() ? info.size : undefined).catch(() => undefined),
          content_hash: project.output_content_hash as `sha256:${string}` | undefined,
        })
      }
    }

    const versionId = foundationId(
      'ver',
      project.id,
      String(project.revision),
      JSON.stringify(seeds.map(seed => [seed.id, seed.role, seed.storage.kind, seed.storage.locator])),
      project.kind === 'image'
        ? JSON.stringify([project.prompt, project.outputs.map(output => output.id)])
        : JSON.stringify(project.timeline),
    )
    const existingAssets = new Map((current?.assets ?? []).map(asset => [asset.id, asset]))
    for (const asset of project.assets) {
      const existing = existingAssets.get(asset.id)
      if (existing && JSON.stringify(existing) !== JSON.stringify(asset)) {
        if (!await this.verifiedImageMimeCorrection(existing, asset)) {
          throw new MediaServiceError('媒体资产记录不可原地改写', 409, 'ASSET_IMMUTABLE')
        }
        existingAssets.set(asset.id, asset)
      }
      if (!existing) existingAssets.set(asset.id, asset)
    }
    for (const seed of seeds) {
      const metadata = seed.storage.kind === 'managed'
        ? await this.managedAssetMetadata(seed.storage.locator)
        : { byte_size: seed.byte_size, content_hash: seed.content_hash }
      const candidate = {
        ...seed,
        ...metadata,
        version_id: seed.version_id ?? versionId,
        created_at: project.updated_at,
      } as MediaAsset
      const existing = existingAssets.get(candidate.id)
      if (existing) {
        const immutableExisting = JSON.stringify({
          role: existing.role,
          storage: existing.storage,
          mime_type: existing.mime_type,
          byte_size: existing.byte_size,
          content_hash: existing.content_hash,
        })
        const immutableCandidate = JSON.stringify({
          role: candidate.role,
          storage: candidate.storage,
          mime_type: candidate.mime_type,
          byte_size: candidate.byte_size,
          content_hash: candidate.content_hash,
        })
        const sourceIdentityEnrichment = project.kind === 'video'
          && candidate.role === 'source'
          && existing.role === candidate.role
          && JSON.stringify(existing.storage) === JSON.stringify(candidate.storage)
          && existing.mime_type === candidate.mime_type
          && existing.content_hash === undefined
          && candidate.content_hash !== undefined
          && (existing.byte_size === undefined || existing.byte_size === candidate.byte_size)
        if (immutableExisting !== immutableCandidate && !sourceIdentityEnrichment) {
          throw new MediaServiceError('媒体资产记录不可原地改写', 409, 'ASSET_IMMUTABLE')
        }
        if (sourceIdentityEnrichment) existingAssets.set(candidate.id, candidate)
      } else {
        existingAssets.set(candidate.id, candidate)
      }
    }
    const assets = [...existingAssets.values()]
    const versions = [...(current?.versions ?? project.versions)]
    if (!versions.some(version => version.id === versionId)) {
      versions.push({
        id: versionId,
        parent_version_id: versions.at(-1)?.id,
        project_revision: project.revision,
        asset_ids: seeds.filter(seed => !seed.version_id).map(seed => seed.id),
        created_at: project.updated_at,
      })
    }
    if (project.kind === 'image') {
      for (const output of project.outputs) {
        if (!output.version_id || versions.some(version => version.id === output.version_id)) continue
        versions.push({
          id: output.version_id,
          parent_version_id: output.parent_version_id ?? versionId,
          project_revision: project.revision,
          asset_ids: [output.id],
          kind: output.version_kind ?? 'generated',
          operation_id: output.operation_id,
          width: output.width,
          height: output.height,
          text_layers: output.text_layers,
          image_layers: output.image_layers,
          created_at: project.updated_at,
        })
      }
    }
    return mediaProjectSchema.parse({ ...project, owner, assets, versions })
  }

  private async saveProject(project: MediaProject): Promise<MediaProject> {
    const input = mediaProjectSchema.parse(project)
    return await this.withProjectWriteLock(input.id, async () => {
      const current = await readFile(this.projectPath(input.id), 'utf8')
        .then(value => mediaProjectSchema.parse(migrateLegacyMediaOwnerRecord(JSON.parse(value)).value))
        .catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        })
      if (current && input.writer_fence !== current.writer_fence) {
        throw new MediaServiceError('媒体项目已被另一写入者更新，请刷新后重试', 409, 'WRITER_FENCE_CONFLICT')
      }
      if (!current && input.writer_fence !== LEGACY_MEDIA_WRITER_FENCE) {
        throw new MediaServiceError('媒体项目创建凭据无效', 409, 'WRITER_FENCE_CONFLICT')
      }
      const persist = async () => {
        const founded = await this.materializeProjectFoundation(input, current)
        const next = mediaProjectSchema.parse({
          ...founded,
          writer_fence: `fence_${randomUUID().replaceAll('-', '')}`,
        })
        await this.writeJson(this.projectPath(next.id), next)
        return next
      }
      const needsCas = input.kind === 'image' && (
        (input.reference_image_assets?.length ?? 0) > 0
        || input.outputs.some(output => Boolean(output.asset_path || output.data_url))
        || input.assets.some(asset => asset.storage.kind === 'cas')
      )
      if (!needsCas) return await persist()
      return await this.withCasWriteLock(async () => {
        try {
          return await persist()
        } catch (error) {
          await this.garbageCollectCasUnlocked().catch(cleanupError => {
            recordMediaFailure('cas_rollback_gc', cleanupError)
          })
          throw error
        }
      })
    })
  }

  private taskEventProjection(task: MediaTask): unknown {
    return {
      project_id: task.project_id,
      operation_id: task.operation_id,
      kind: task.kind,
      status: task.status,
      progress: task.progress,
      stage: task.stage,
      remote_task_id: task.remote_task_id,
      outcome_unknown: task.outcome_unknown,
      provider_receipt_hash: task.provider_receipt_hash,
      result: task.result,
      error: task.error,
      error_code: task.error_code,
    }
  }

  private async readEventJournal(projectId: string): Promise<MediaJobEventJournal> {
    await this.ensureDirs()
    const raw = await readFile(this.eventJournalPath(projectId), 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (raw === null) return { schema_version: 1, next_cursor: 1, events: [] }
    return mediaJobEventJournalSchema.parse(JSON.parse(raw))
  }

  private async appendTaskEventUnlocked(task: MediaTask): Promise<void> {
    const journal = await this.readEventJournal(task.project_id)
    const cursor = journal.next_cursor
    const event: MediaJobEvent = {
      schema_version: 1,
      cursor,
      project_id: task.project_id,
      task_id: task.id,
      operation_id: task.operation_id!,
      status_sequence: task.status_sequence,
      occurred_at: task.updated_at,
      task,
    }
    await this.writeJson(this.eventJournalPath(task.project_id), {
      schema_version: 1,
      next_cursor: cursor + 1,
      events: [...journal.events, event].slice(-MAX_MEDIA_JOB_EVENTS_PER_PROJECT),
    } satisfies MediaJobEventJournal)
    for (const notify of this.eventWaiters.get(task.project_id) ?? []) notify()
  }

  private async saveTask(task: MediaTaskInput): Promise<MediaTask> {
    const input = mediaTaskSchema.parse(task)
    return await this.withEventWriteLock(input.project_id, async () => {
      const previousRaw = await readFile(this.taskPath(input.id), 'utf8')
        .then(value => JSON.parse(value) as unknown)
        .catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
          throw error
        })
      const previous = previousRaw === null
        ? null
        : mediaTaskSchema.parse(migrateLegacyMediaOwnerRecord(previousRaw).value)
      const previousHadSequence = Boolean(
        previousRaw
        && typeof previousRaw === 'object'
        && 'status_sequence' in previousRaw,
      )
      let owner = input.owner ?? previous?.owner
      if (!owner) {
        owner = await readFile(this.projectPath(input.project_id), 'utf8')
          .then(value => mediaProjectSchema.parse(migrateLegacyMediaOwnerRecord(JSON.parse(value)).value).owner)
          .catch(() => STANDALONE_MEDIA_OWNER)
      }
      const operationId = input.operation_id ?? previous?.operation_id ?? foundationId(
        'op',
        input.project_id,
        input.kind,
        input.idempotency_key ?? input.id,
      )
      const eventChanged = previous === null
        || !previousHadSequence
        || JSON.stringify(this.taskEventProjection(previous)) !== JSON.stringify(this.taskEventProjection({
          ...input,
          owner,
          operation_id: operationId,
        }))
      const parsed = mediaTaskSchema.parse({
        ...input,
        owner,
        operation_id: operationId,
        status_sequence: eventChanged
          ? (previous?.status_sequence ?? 0) + 1
          : previous?.status_sequence ?? input.status_sequence,
      })
      await this.writeJson(this.taskPath(parsed.id), parsed)
      if (eventChanged) await this.appendTaskEventUnlocked(parsed)
      return parsed
    })
  }

  async listJobEvents(
    projectId: string,
    afterCursor = 0,
    limit = 100,
  ): Promise<{ events: MediaJobEvent[]; cursor: number; reset_required: boolean }> {
    const journal = await this.readEventJournal(projectId)
    const safeCursor = Math.max(0, Math.trunc(afterCursor) || 0)
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit) || 100))
    const firstCursor = journal.events[0]?.cursor ?? journal.next_cursor
    const latestCursor = journal.next_cursor - 1
    const resetRequired = safeCursor > latestCursor
      || (safeCursor > 0 && safeCursor < firstCursor - 1)
    const effectiveCursor = resetRequired ? firstCursor - 1 : safeCursor
    const events = journal.events
      .filter(event => event.cursor > effectiveCursor)
      .slice(0, safeLimit)
    return {
      events,
      cursor: events.at(-1)?.cursor ?? (resetRequired ? latestCursor : safeCursor),
      reset_required: resetRequired,
    }
  }

  async waitForJobEvents(
    projectId: string,
    afterCursor = 0,
    limit = 100,
    waitMs = 25_000,
    signal?: AbortSignal,
  ): Promise<{ events: MediaJobEvent[]; cursor: number; reset_required: boolean }> {
    let existing = await this.listJobEvents(projectId, afterCursor, limit)
    if (existing.events.length > 0 || existing.reset_required || waitMs <= 0 || signal?.aborted) return existing
    const remoteRefreshDelay = await this.remoteImageRefreshDelay(projectId)
    if (remoteRefreshDelay === 0) {
      await this.refreshActiveRemoteImageTask(projectId)
      existing = await this.listJobEvents(projectId, afterCursor, limit)
      if (existing.events.length > 0 || existing.reset_required || signal?.aborted) return existing
    }
    const boundedWaitMs = Math.max(1, Math.min(
      25_000,
      Math.trunc(waitMs),
      remoteRefreshDelay ?? 25_000,
    ))
    let timedOut = false
    await new Promise<void>(resolveWait => {
      let settled = false
      const waiters = this.eventWaiters.get(projectId) ?? new Set<() => void>()
      const finish = () => {
        if (settled) return
        settled = true
        clearTimeout(timeout)
        waiters.delete(finish)
        signal?.removeEventListener('abort', finish)
        if (waiters.size === 0) this.eventWaiters.delete(projectId)
        resolveWait()
      }
      const timeout = setTimeout(() => {
        timedOut = true
        finish()
      }, boundedWaitMs)
      ;(timeout as unknown as { unref?: () => void }).unref?.()
      waiters.add(finish)
      this.eventWaiters.set(projectId, waiters)
      signal?.addEventListener('abort', finish, { once: true })
    })
    if (timedOut && !signal?.aborted) await this.refreshActiveRemoteImageTask(projectId)
    return await this.listJobEvents(projectId, afterCursor, limit)
  }

  private async remoteImageRefreshDelay(projectId: string): Promise<number | null> {
    const project = await this.getProject(projectId).catch(() => null)
    if (project?.kind !== 'image' || !project.task_id) return null
    const task = await this.getTask(project.task_id, false).catch(() => null)
    if (!task || task.kind !== 'image.generate' || !['queued', 'running'].includes(task.status)) return null
    const interval = (task.poll_after_seconds ?? (task.status === 'running' ? 3 : 15)) * 1000
    return Math.max(0, interval - Math.max(0, this.now().getTime() - Date.parse(task.updated_at)))
  }

  private async refreshActiveRemoteImageTask(projectId: string): Promise<void> {
    const project = await this.getProject(projectId).catch(() => null)
    if (project?.kind !== 'image' || !project.task_id) return
    const task = await this.getTask(project.task_id, false).catch(() => null)
    if (task?.kind === 'image.generate' && ['queued', 'running'].includes(task.status)) {
      await this.getTask(task.id, true).catch(error => recordMediaFailure('image_event_refresh', error))
    }
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
   * Admission is deliberately separate from a project mutation. Different
   * project windows can request export at the same instant, but they must
   * observe one shared active-plus-waiting limit before any task is persisted.
   */
  private async withVideoRenderAdmission<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.videoRenderAdmissions
    let release!: () => void
    const current = new Promise<void>(resolveLock => { release = resolveLock })
    const queued = previous.then(() => current)
    this.videoRenderAdmissions = queued
    await previous
    try {
      return await action()
    } finally {
      release()
      if (this.videoRenderAdmissions === queued) {
        this.videoRenderAdmissions = Promise.resolve()
      }
    }
  }

  /**
   * FFprobe is much lighter than an encoder, but concurrent metadata scans
   * still compete for the user's local disk. Two scans plus eight waiting
   * admissions cover a ten-window burst without allowing an unbounded local
   * scan burst.
   */
  private async withVideoProbeAdmission<T>(action: () => Promise<T>): Promise<T> {
    if (this.activeVideoProbes < MAX_CONCURRENT_VIDEO_PROBES) {
      this.activeVideoProbes += 1
    } else {
      if (this.queuedVideoProbeAdmissions.length >= this.maxQueuedVideoProbes) {
        throw new MediaServiceError('本机视频素材读取队列已满，请稍后重试', 409, 'VIDEO_PROBE_BUSY')
      }
      await new Promise<void>(resolveAdmission => this.queuedVideoProbeAdmissions.push(resolveAdmission))
    }
    try {
      return await action()
    } finally {
      const next = this.queuedVideoProbeAdmissions.shift()
      if (next) next()
      else this.activeVideoProbes -= 1
    }
  }

  private async persistReferenceImages(projectId: string, images: string[]): Promise<string[]> {
    if (images.length === 0) return []
    const directory = join(this.assetsDir, projectId, 'references')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const written: string[] = []
    try {
      for (const image of images) {
        const fileName = `ref_${randomUUID().replaceAll('-', '')}.${referenceImageExtension(image)}`
        await writeFile(join(directory, fileName), dataUrlBytes(image), { mode: 0o600 })
        written.push(fileName)
      }
      return written
    } catch (error) {
      await Promise.all(written.map(fileName => rm(join(directory, fileName), { force: true })))
      throw error
    }
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

  /**
   * A queued render reserves its chosen final path. Without this check, two
   * independent windows could both select the same file and the later FFmpeg
   * commit would silently replace the first export.
   */
  private async outputReservedByVideoRender(outputPath: string): Promise<boolean> {
    const requested = await this.comparablePath(outputPath)
    const reserved = [
      ...[...this.activeRenders.values()].map(render => render.outputPath),
      ...this.queuedVideoRenders.map(render => render.outputPath),
    ]
    for (const candidate of reserved) {
      if (this.pathsEqual(await this.comparablePath(candidate), requested)) return true
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

  private async migrateImageBrief(project: ImageWorkbenchProject): Promise<ImageWorkbenchProject> {
    const referenceIds = (project.reference_image_assets ?? []).map(fileName => fileName.slice(0, fileName.lastIndexOf('.')))
    const currentReferences = new Map(project.references.map(reference => [reference.asset_id, reference]))
    const references = referenceIds.map(assetId => currentReferences.get(assetId) ?? {
      asset_id: assetId,
      role: 'unclassified' as const,
    })
    if (
      project.brief
      && references.length === project.references.length
      && references.every((reference, index) => reference.asset_id === project.references[index]?.asset_id)
    ) return project
    const userRequest = project.brief?.user_request ?? project.prompt
    const compiled = compileImageBrief(userRequest, references)
    const brief = applyImageBriefOverrides(compiled.brief, project.brief_overrides)
    return await this.saveProject({
      ...project,
      brief,
      prompt: providerPromptForImageBrief(brief),
      references,
    }) as ImageWorkbenchProject
  }

  private async migrateImageVersions(project: ImageWorkbenchProject): Promise<ImageWorkbenchProject> {
    if (project.outputs.length === 0) return project
    if (project.outputs.every(output => (
      output.operation_id
      && output.version_id
      && output.version_kind
      && project.versions.some(version => version.id === output.version_id)
    ))) return project
    const legacyParent = project.versions.at(-1)?.id
    const operationId = foundationId('op', project.id, project.task_id ?? 'legacy-image-results')
    const outputs = project.outputs.map(output => {
      const versionId = output.version_id ?? foundationId('ver', project.id, operationId, output.id)
      const existingVersion = project.versions.find(version => version.id === versionId)
      const parentVersionId = output.parent_version_id ?? existingVersion?.parent_version_id ?? legacyParent
      return {
        ...output,
        operation_id: output.operation_id ?? operationId,
        version_id: versionId,
        version_kind: output.version_kind ?? 'generated' as const,
        parent_version_id: parentVersionId === versionId ? undefined : parentVersionId,
      }
    })
    return await this.saveProject({ ...project, outputs }) as ImageWorkbenchProject
  }

  private async migrateImageMimeMetadata(project: ImageWorkbenchProject): Promise<ImageWorkbenchProject> {
    const corrections = new Map<string, {
      mime_type: 'image/png' | 'image/jpeg' | 'image/webp'
      width: number
      height: number
      asset_path: string
    }>()
    const stagedPaths: Array<{ previous: string; next: string }> = []
    for (const output of project.outputs) {
      const asset = project.assets.find(candidate => candidate.id === output.id && candidate.role === 'result')
      if (!asset || asset.storage.kind !== 'cas') continue
      const match = /^sha256\/([a-f0-9]{64})$/.exec(asset.storage.locator)
      if (!match) continue
      const casPath = join(this.casDir, match[1]!)
      const bytes = await readFile(casPath).catch(() => null)
      if (!bytes) continue
      const mimeType = detectedImageMime(bytes)
      const dimensions = mimeType ? imageDimensions(bytes, mimeType) : null
      if (!mimeType || !dimensions) continue
      const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
      const nextFileName = `${output.id}.${extension}`
      const nextAssetPath = `/api/media/assets/${project.id}/${nextFileName}`
      if (
        output.mime_type === mimeType
        && output.width === dimensions.width
        && output.height === dimensions.height
        && output.asset_path === nextAssetPath
        && asset.mime_type === mimeType
      ) continue
      corrections.set(output.id, { mime_type: mimeType, ...dimensions, asset_path: nextAssetPath })
      const previousFileName = output.asset_path?.split('/').pop()
      if (previousFileName && previousFileName !== nextFileName) {
        const nextPath = join(this.assetsDir, project.id, nextFileName)
        const alreadyExists = await stat(nextPath).then(info => info.isFile()).catch(() => false)
        if (!alreadyExists) {
          await link(casPath, nextPath).catch(async error => {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') await copyFile(casPath, nextPath)
          })
          stagedPaths.push({ previous: join(this.assetsDir, project.id, previousFileName), next: nextPath })
        }
      }
    }
    if (corrections.size === 0) return project
    const outputs = project.outputs.map(output => corrections.has(output.id) ? { ...output, ...corrections.get(output.id)! } : output)
    const assets = project.assets.map(asset => corrections.has(asset.id) ? { ...asset, mime_type: corrections.get(asset.id)!.mime_type } : asset)
    const versions = project.versions.map(version => {
      const outputId = version.asset_ids.find(assetId => corrections.has(assetId))
      const correction = outputId ? corrections.get(outputId) : undefined
      return correction ? { ...version, width: correction.width, height: correction.height } : version
    })
    try {
      const saved = await this.saveProject({ ...project, outputs, assets, versions }) as ImageWorkbenchProject
      await Promise.all(stagedPaths.map(path => rm(path.previous, { force: true })))
      return saved
    } catch (error) {
      await Promise.all(stagedPaths.map(path => rm(path.next, { force: true })))
      throw error
    }
  }

  private async migrateVideoTimeline(project: VideoStudioProject): Promise<VideoStudioProject> {
    if (
      project.current_timeline_version_id
      && project.timeline_versions.some(version => version.id === project.current_timeline_version_id)
    ) return project
    const evidenceRevision = project.evidence_revision ?? videoEvidenceRevision(project.evidence)
    const version = this.timelineVersion(project, scenesFromClips(project.timeline, project.evidence), evidenceRevision, project.revision)
    return await this.saveProject({
      ...project,
      evidence_revision: evidenceRevision,
      timeline_versions: [...project.timeline_versions, version],
      current_timeline_version_id: version.id,
    }) as VideoStudioProject
  }

  private async reconcileVideoOutputAvailability(project: VideoStudioProject): Promise<VideoStudioProject> {
    if (project.state !== 'complete' || !project.output_path) return project
    const info = await stat(project.output_path).catch(() => null)
    const verification = project.output_verification
    const changed = !info?.isFile()
      || Boolean(verification && (
        info.size !== verification.byte_size
        || (verification.file_mtime_ms !== undefined && Math.abs(info.mtimeMs - verification.file_mtime_ms) > 1)
      ))
    if (!changed) return project
    const failure = mediaSafeError('MEDIA_VIDEO_OUTPUT_UNAVAILABLE')
    return await this.saveProject({
      ...project,
      state: 'failed',
      revision: project.revision + 1,
      error: failure.message,
      error_code: failure.code,
      updated_at: this.iso(),
    }) as VideoStudioProject
  }

  /** Upgrade every supported persisted record without swallowing a corrupt or future schema. */
  async migrateSupportedStorage(): Promise<void> {
    await this.ensureDirs()
    for (const name of (await readdir(this.projectsDir)).filter(name => name.endsWith('.json')).sort()) {
      await this.getProject(name.slice(0, -5))
    }
    const videoTaskIds: string[] = []
    for (const name of (await readdir(this.tasksDir)).filter(name => name.endsWith('.json')).sort()) {
      const raw = JSON.parse(await readFile(join(this.tasksDir, name), 'utf8')) as unknown
      const migrated = migrateLegacyMediaOwnerRecord(raw)
      const task = mediaTaskSchema.parse(migrated.value)
      const hasStatusSequence = Boolean(raw && typeof raw === 'object' && 'status_sequence' in raw)
      if (migrated.migrated || !task.operation_id || !task.owner || !hasStatusSequence) await this.saveTask(task)
      if (task.kind.startsWith('video.')) videoTaskIds.push(task.id)
    }
    for (const name of (await readdir(this.deletionsDir)).filter(name => name.endsWith('.json')).sort()) {
      const filePath = join(this.deletionsDir, name)
      const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown
      const migrated = migrateLegacyMediaOwnerRecord(raw)
      const receipt = mediaDeletionReceiptSchema.parse(migrated.value)
      if (migrated.migrated || !raw || typeof raw !== 'object' || !('schema_version' in raw)) {
        await this.writeJson(filePath, receipt)
      }
    }
    // Video preview/export workers are local child processes. They cannot survive a
    // server restart, so settle their persisted state during boot rather than waiting
    // for a client to read the project. Deliberately do not refresh image tasks here:
    // image refresh can continue an externally billed provider submission.
    for (const taskId of videoTaskIds) await this.getTask(taskId, false)
  }

  async listProjects(kind?: 'image' | 'video', owner?: MediaOwner): Promise<MediaProject[]> {
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
      .filter((project): project is MediaProject => Boolean(project)
        && (!kind || project!.kind === kind)
        && (!owner || sameOwner(project!.owner, owner)))
    await Promise.all(validProjects.flatMap(project => [
      project.task_id ? this.getTask(project.task_id, false).catch(() => null) : null,
      project.kind === 'video' && project.preview_task_id
        ? this.getTask(project.preview_task_id, false).catch(() => null)
        : null,
    ]))
    const reconciled = await Promise.all(validProjects.map(project => this.getProject(project.id).catch(() => null)))
    return reconciled
      .filter((project): project is MediaProject => Boolean(project))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
  }

  async getProject(projectId: string): Promise<MediaProject> {
    try {
      const raw = JSON.parse(await readFile(this.projectPath(projectId), 'utf8')) as unknown
      const migrated = migrateLegacyMediaOwnerRecord(raw)
      let project = mediaProjectSchema.parse(migrated.value)
      if (
        migrated.migrated
        || project.writer_fence === LEGACY_MEDIA_WRITER_FENCE
        || project.versions.length === 0
      ) {
        try {
          project = await this.saveProject(project)
        } catch (error) {
          if (!(error instanceof MediaServiceError) || error.code !== 'WRITER_FENCE_CONFLICT') throw error
          project = mediaProjectSchema.parse(migrateLegacyMediaOwnerRecord(
            JSON.parse(await readFile(this.projectPath(projectId), 'utf8')),
          ).value)
        }
      }
      if (project.kind === 'video') {
        return await this.reconcileVideoOutputAvailability(await this.migrateVideoTimeline(project))
      }
      return await this.migrateImageMimeMetadata(await this.migrateImageVersions(
        await this.migrateImageBrief(await this.migrateLegacyReferenceImages(project)),
      ))
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new MediaServiceError('找不到媒体项目', 404, 'PROJECT_NOT_FOUND')
      }
      if (error instanceof MediaServiceError) throw error
      recordMediaFailure('read_project', error)
      throw new MediaServiceError('媒体项目暂时无法读取', 500, 'PROJECT_CORRUPT')
    }
  }

  async assertProjectOwner(projectId: string, owner: MediaOwner): Promise<MediaProject> {
    const project = await this.getProject(projectId)
    if (!sameOwner(project.owner, owner)) {
      // Deliberately indistinguishable from an unknown id across owner boundaries.
      throw new MediaServiceError('找不到媒体项目', 404, 'PROJECT_NOT_FOUND')
    }
    return project
  }

  async listProjectsForOwner(owner: MediaOwner, kind?: 'image' | 'video'): Promise<MediaProject[]> {
    return await this.listProjects(kind, owner)
  }

  async assertTaskOwner(taskId: string, owner: MediaOwner): Promise<MediaTask> {
    let task: MediaTask
    try {
      task = mediaTaskSchema.parse(migrateLegacyMediaOwnerRecord(
        JSON.parse(await readFile(this.taskPath(taskId), 'utf8')),
      ).value)
    } catch {
      throw new MediaServiceError('找不到媒体任务', 404, 'TASK_NOT_FOUND')
    }
    if (!task.owner) {
      const projectOwner = await readFile(this.projectPath(task.project_id), 'utf8')
        .then(value => mediaProjectSchema.parse(migrateLegacyMediaOwnerRecord(JSON.parse(value)).value).owner)
        .catch(() => null)
      if (projectOwner && sameOwner(projectOwner, owner)) task = await this.saveTask({ ...task, owner: projectOwner })
    }
    if (!task.owner || !sameOwner(task.owner, owner)) {
      throw new MediaServiceError('找不到媒体任务', 404, 'TASK_NOT_FOUND')
    }
    return task
  }

  async getTask(taskId: string, refreshRemote = true): Promise<MediaTask> {
    let task: MediaTask
    try {
      const raw = JSON.parse(await readFile(this.taskPath(taskId), 'utf8')) as unknown
      const migrated = migrateLegacyMediaOwnerRecord(raw)
      task = mediaTaskSchema.parse(migrated.value)
      const hasStatusSequence = Boolean(raw && typeof raw === 'object' && 'status_sequence' in raw)
      if (migrated.migrated || !task.operation_id || !task.owner || !hasStatusSequence) task = await this.saveTask(task)
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        throw new MediaServiceError('找不到媒体任务', 404, 'TASK_NOT_FOUND')
      }
      if (error instanceof MediaServiceError) throw error
      recordMediaFailure('read_task', error)
      throw new MediaServiceError('媒体任务暂时无法读取', 500, 'TASK_CORRUPT')
    }
    task = await this.reconcileTaskAndProject(task)
    if (refreshRemote && task.kind === 'image.generate' && ['queued', 'running'].includes(task.status)) {
      if (!task.remote_task_id) {
        task = await this.fenceInterruptedImageSubmission(task)
        if (task.outcome_unknown) return task
        const project = await this.getProject(task.project_id)
        if (project.kind !== 'image' || !task.idempotency_key) {
          return await this.failImageTask(
            task,
            'MEDIA_IMAGE_OUTCOME_UNKNOWN',
            true,
          )
        }
        return await this.submitPersistedImageTask(project, task)
      }
      return await this.refreshPersistedImageTask(task)
    }
    if (
      refreshRemote
      && task.kind === 'image.generate'
      && task.status === 'succeeded'
      && task.remote_task_id
      && task.provider_receipt_hash
      && !task.remote_result_acknowledged_at
    ) {
      return await this.acknowledgePersistedImageResult(task)
    }
    if (
      task.kind === 'video.render' &&
      ['queued', 'running', 'committing'].includes(task.status) &&
      !this.activeRenders.has(task.id) &&
      !this.queuedVideoRenders.some(render => render.task.id === task.id)
    ) {
      return await this.recoverInterruptedVideoRender(task)
    }
    if (
      task.kind === 'video.preview'
      && ['queued', 'running', 'committing'].includes(task.status)
      && !this.activeVideoPreviews.has(task.id)
    ) {
      return await this.recoverInterruptedVideoPreview(task)
    }
    if (
      task.kind === 'video.probe'
      && ['queued', 'running'].includes(task.status)
    ) {
      const failure = mediaSafeError('MEDIA_VIDEO_PROBE_INTERRUPTED')
      return await this.saveTask({
        ...task,
        status: 'failed',
        progress: 0,
        stage: '素材读取已中断',
        error: failure.message,
        error_code: failure.code,
        updated_at: this.iso(),
      })
    }
    if (
      (task.kind === 'video.analyze' || task.kind === 'video.plan')
      && ['queued', 'running'].includes(task.status)
      && !this.activeVideoAnalyses.has(task.id)
    ) {
      const failure = mediaSafeError('MEDIA_VIDEO_ANALYSIS_INTERRUPTED')
      return await this.saveTask({
        ...task,
        status: 'failed',
        progress: 0,
        stage: '分析已中断',
        error: failure.message,
        error_code: failure.code,
        updated_at: this.iso(),
      })
    }
    return task
  }

  private async reconcileTaskAndProject(task: MediaTask): Promise<MediaTask> {
    const project = await this.getProject(task.project_id).catch(() => null)
    if (!project) return task

    if (task.kind === 'video.preview' && project.kind === 'video') {
      if (project.preview_task_id !== task.id) return task
      const result = videoPreviewTaskResultSchema.safeParse(task.result)
      if (
        task.status === 'committing'
        && !this.activeVideoPreviews.has(task.id)
        && result.success
        && result.data.content_hash
        && project.preview?.asset_id === result.data.asset_id
        && project.preview.asset_path === result.data.asset_path
        && project.preview.content_hash === result.data.content_hash
        && project.current_timeline_version_id === result.data.timeline_version_id
      ) {
        const previewPath = join(this.assetsDir, project.id, basename(result.data.asset_path))
        const fingerprint = await this.fileFingerprint(previewPath).catch(() => null)
        if (fingerprint === result.data.content_hash) {
          return await this.saveTask({
            ...task,
            status: 'succeeded',
            progress: 100,
            stage: '预览完成（已恢复）',
            result: { ...result.data, temporary_output: undefined },
            error: undefined,
            error_code: undefined,
            updated_at: this.iso(),
          })
        }
      }
      if (task.status === 'succeeded' && result.success && project.preview?.asset_id !== result.data.asset_id) {
        const assetExists = await stat(join(this.assetsDir, project.id, basename(result.data.asset_path)))
          .then(info => info.isFile())
          .catch(() => false)
        if (
          assetExists
          && project.current_timeline_version_id === result.data.timeline_version_id
          && result.data.content_hash
        ) {
          await this.saveProject({
            ...project,
            preview: {
              timeline_version_id: result.data.timeline_version_id,
              asset_id: result.data.asset_id,
              asset_path: result.data.asset_path,
              content_hash: result.data.content_hash,
              created_at: task.updated_at,
            },
            updated_at: this.iso(),
          })
        }
      }
      return task
    }

    if (project.task_id !== task.id) return task

    if (task.kind === 'image.generate' && project.kind === 'image') {
      const result = imageGenerationTaskResultSchema.safeParse(task.result)
      if (
        task.status === 'committing'
        && !this.activeImageRefreshes.has(task.id)
        && result.success
        && result.data.outputs.length > 0
      ) {
        const assetsExist = await Promise.all(result.data.outputs.map(async output => {
          if (!output.asset_path) return false
          const fileName = output.asset_path.split('/').pop() ?? ''
          if (!/^[a-z0-9][a-z0-9_.-]{2,120}$/.test(fileName)) return false
          return await stat(join(this.assetsDir, project.id, fileName)).then(info => info.isFile()).catch(() => false)
        }))
        if (assetsExist.every(Boolean)) {
          const operationKind = task.image_operation?.kind ?? 'generate'
          await this.saveProject({
            ...project,
            state: 'ready',
            outputs: [
              ...project.outputs.filter(output => !result.data.outputs.some(completed => completed.id === output.id)),
              ...result.data.outputs,
            ],
            current_version_id: operationKind === 'generate'
              ? project.current_version_id
              : result.data.outputs[0]?.version_id ?? project.current_version_id,
            notice: '候选已从中断的本地提交恢复；视觉质检可在后续迭代中重新执行。',
            error: undefined,
            error_code: undefined,
            updated_at: this.iso(),
          })
          return await this.saveTask({
            ...task,
            status: 'succeeded',
            progress: 100,
            stage: '生成完成（已恢复）',
            updated_at: this.iso(),
          })
        }
        return await this.failImageTask(task, 'MEDIA_IMAGE_OUTCOME_UNKNOWN', true, task.provider_receipt_hash)
      }
      if (task.status === 'succeeded' && project.state !== 'ready' && result.success && result.data.outputs.length > 0) {
        const completedOutputs = result.data.outputs
        const operationKind = task.image_operation?.kind ?? 'generate'
        await this.saveProject({
          ...project,
          state: 'ready',
          outputs: [
            ...project.outputs.filter(output => !completedOutputs.some(completed => completed.id === output.id)),
            ...completedOutputs,
          ],
          current_version_id: operationKind === 'generate'
            ? project.current_version_id
            : completedOutputs[0]?.version_id ?? project.current_version_id,
          notice: result.data.input_fidelity_risk,
          error: undefined,
          error_code: undefined,
          updated_at: this.iso(),
        })
      } else if (
        (task.status === 'failed' || task.status === 'cancelled')
        && (project.state === 'queued' || project.state === 'generating')
      ) {
        const failure = mediaSafeError(task.error_code ?? (task.status === 'cancelled'
          ? 'MEDIA_IMAGE_CANCELLED'
          : 'MEDIA_IMAGE_UNAVAILABLE'))
        await this.saveProject({
          ...project,
          state: 'failed',
          error: failure.message,
          error_code: failure.code,
          updated_at: this.iso(),
        })
      }
      return task
    }

    if (task.kind === 'video.render' && project.kind === 'video') {
      const result = videoRenderTaskResultSchema.safeParse(task.result)
      if (!result.success) return task
      const outputExists = await stat(result.data.output_path).then(info => info.isFile()).catch(() => false)
      const resultMatchesProject = (
        result.data.render_revision === project.revision
        && result.data.timeline_version_id === project.current_timeline_version_id
      )
      if (task.status === 'succeeded' && !resultMatchesProject) {
        return await this.rejectStaleVideoRender(task)
      }
      if (task.status === 'succeeded' && project.state !== 'complete' && outputExists) {
        await this.saveProject({
          ...project,
          state: 'complete',
          output_path: result.data.output_path,
          output_asset_id: result.data.output_asset_id,
          output_content_hash: result.data.output_content_hash,
          output_verification: result.data.output_verification,
          error: undefined,
          error_code: undefined,
          updated_at: this.iso(),
        })
        return task
      }
      if (task.status === 'succeeded' && project.state === 'rendering' && !outputExists) {
        await this.saveProject({
          ...project,
          state: 'failed',
          error: mediaSafeError('MEDIA_VIDEO_OUTPUT_UNAVAILABLE').message,
          error_code: 'MEDIA_VIDEO_OUTPUT_UNAVAILABLE',
          updated_at: this.iso(),
        })
        return task
      }
      if (
        (task.status === 'failed' || task.status === 'cancelled')
        && project.state === 'rendering'
      ) {
        const failure = mediaSafeError(task.error_code ?? (task.status === 'cancelled'
          ? 'MEDIA_VIDEO_EXPORT_CANCELLED'
          : task.stage === '导出已中断'
            ? 'MEDIA_VIDEO_EXPORT_INTERRUPTED'
            : 'MEDIA_VIDEO_EXPORT_FAILED'))
        await this.saveProject({
          ...project,
          state: task.status === 'cancelled' || task.stage === '导出已中断' ? 'ready' : 'failed',
          error: failure.message,
          error_code: failure.code,
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
          if (!resultMatchesProject) return await this.rejectStaleVideoRender(task)
          const succeeded = await this.saveTask({
            ...task,
            status: 'succeeded',
            progress: 100,
            stage: '导出完成',
            result: { ...result.data, temporary_output: undefined },
            error: undefined,
            error_code: undefined,
            updated_at: this.iso(),
          })
          await this.saveProject({
            ...project,
            state: 'complete',
            output_path: result.data.output_path,
            output_asset_id: result.data.output_asset_id,
            output_content_hash: result.data.output_content_hash,
            output_verification: result.data.output_verification,
            error: undefined,
            error_code: undefined,
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
    const failure = mediaSafeError('MEDIA_VIDEO_EXPORT_INTERRUPTED')
    const next = await this.saveTask({
      ...task,
      status: 'failed',
      progress: 0,
      stage: '导出已中断',
      error: failure.message,
      error_code: failure.code,
      updated_at: this.iso(),
    })
    const project = await this.getProject(task.project_id).catch(() => null)
    if (project?.kind === 'video') {
      await this.saveProject({
        ...project,
        state: 'ready',
        error: failure.message,
        error_code: failure.code,
        updated_at: this.iso(),
      })
    }
    const result = videoRenderTaskResultSchema.safeParse(task.result)
    if (result.success && result.data.temporary_output) {
      await rm(result.data.temporary_output, { force: true }).catch(() => undefined)
    }
    return next
  }

  private async rejectStaleVideoRender(task: MediaTask): Promise<MediaTask> {
    const failure = mediaSafeError('MEDIA_STATE_CONFLICT')
    const next = await this.saveTask({
      ...task,
      status: 'cancelled',
      progress: 0,
      stage: '导出结果已过期',
      error: failure.message,
      error_code: failure.code,
      updated_at: this.iso(),
    })
    const project = await this.getProject(task.project_id).catch(() => null)
    if (project?.kind === 'video' && project.task_id === task.id) {
      await this.saveProject({
        ...project,
        state: 'ready',
        error: failure.message,
        error_code: failure.code,
        updated_at: this.iso(),
      })
    }
    return next
  }

  private async recoverInterruptedVideoPreview(task: MediaTask): Promise<MediaTask> {
    const failure = mediaSafeError('MEDIA_VIDEO_PREVIEW_INTERRUPTED')
    const next = await this.saveTask({
      ...task,
      status: 'failed',
      progress: 0,
      stage: '预览已中断',
      error: failure.message,
      error_code: failure.code,
      updated_at: this.iso(),
    })
    const result = videoPreviewTaskResultSchema.safeParse(task.result)
    if (result.success && result.data.temporary_output) {
      await rm(result.data.temporary_output, { force: true }).catch(() => undefined)
    }
    return next
  }

  async assetResponse(
    projectId: string,
    fileName: string,
    request?: Request,
    subdirectory?: 'references',
  ): Promise<Response> {
    this.projectPath(projectId)
    if (!/^[a-z0-9][a-z0-9_.-]{2,120}$/.test(fileName)) {
      throw new MediaServiceError('无效的媒体资产名', 400, 'INVALID_ASSET_NAME')
    }
    const asset = await this.resolveOwnedAsset(projectId, fileName, {
      message: '找不到媒体资产',
      code: 'ASSET_NOT_FOUND',
    }, subdirectory)
    const extension = extname(fileName).toLowerCase()
    if (['.mp4', '.mov', '.webm'].includes(extension)) {
      return await this.videoFileResponse(
        asset.path,
        request ?? new Request('http://localhost/media-asset'),
        '找不到媒体资产',
        'ASSET_NOT_FOUND',
      )
    }
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

  async imageReferenceResponse(projectId: string, referenceId: string, request?: Request): Promise<Response> {
    const project = await this.getProject(projectId)
    if (project.kind !== 'image') throw new MediaServiceError('这不是图片项目', 409, 'WRONG_PROJECT_KIND')
    if (!project.references.some(reference => reference.asset_id === referenceId)) {
      throw new MediaServiceError('找不到图片参考素材', 404, 'ASSET_NOT_FOUND')
    }
    const fileName = project.reference_image_assets?.find(candidate => candidate.startsWith(`${referenceId}.`))
    if (!fileName) throw new MediaServiceError('找不到图片参考素材', 404, 'ASSET_NOT_FOUND')
    return await this.assetResponse(projectId, fileName, request, 'references')
  }

  async imageLayerAssetResponse(projectId: string, assetId: string, request?: Request): Promise<Response> {
    const project = await this.getProject(projectId)
    if (project.kind !== 'image') throw new MediaServiceError('这不是图片项目', 409, 'WRONG_PROJECT_KIND')
    const usedByVersion = project.versions.some(version => (
      version.image_layers?.some(layer => layer.source_asset_id === assetId)
    ))
    if (!usedByVersion) throw new MediaServiceError('找不到图片图层素材', 404, 'ASSET_NOT_FOUND')
    const asset = project.assets.find(candidate => candidate.id === assetId && candidate.role === 'reference')
    if (!asset || !['managed', 'cas'].includes(asset.storage.kind)) {
      throw new MediaServiceError('找不到图片图层素材', 404, 'ASSET_NOT_FOUND')
    }
    if (asset.storage.kind === 'managed') {
      const prefix = `${project.id}/references/`
      if (!asset.storage.locator.startsWith(prefix)) {
        throw new MediaServiceError('图片图层素材地址无效', 404, 'ASSET_NOT_FOUND')
      }
      const fileName = asset.storage.locator.slice(prefix.length)
      return await this.assetResponse(projectId, fileName, request, 'references')
    }
    const digest = /^sha256\/([a-f0-9]{64})$/.exec(asset.storage.locator)?.[1]
    const path = digest ? join(this.casDir, digest) : ''
    const info = path ? await stat(path).catch(() => null) : null
    if (!info?.isFile()) throw new MediaServiceError('找不到图片图层素材', 404, 'ASSET_NOT_FOUND')
    return new Response(Bun.file(path), {
      headers: {
        'Content-Type': asset.mime_type ?? 'application/octet-stream',
        'Content-Length': String(info.size),
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

  private imageVersionRecord(project: ImageWorkbenchProject, versionId: string) {
    const version = project.versions.find(candidate => candidate.id === versionId)
    if (!version) throw new MediaServiceError('找不到指定图片版本', 404, 'IMAGE_VERSION_NOT_FOUND')
    const resultAssets = version.asset_ids
      .map(assetId => project.assets.find(asset => asset.id === assetId))
      .filter((asset): asset is MediaAsset => asset?.role === 'result')
    if (resultAssets.length !== 1) {
      throw new MediaServiceError('指定版本没有唯一的图片结果', 409, 'IMAGE_VERSION_INVALID')
    }
    return { version, asset: resultAssets[0]! }
  }

  private async imageVersionBytes(project: ImageWorkbenchProject, versionId: string) {
    const record = this.imageVersionRecord(project, versionId)
    const mimeType = record.asset.mime_type
    if (mimeType !== 'image/png' && mimeType !== 'image/jpeg' && mimeType !== 'image/webp') {
      throw new MediaServiceError('图片版本格式不可用', 409, 'IMAGE_VERSION_INVALID')
    }
    let sourcePath: string
    if (record.asset.storage.kind === 'cas') {
      const match = /^sha256\/([a-f0-9]{64})$/.exec(record.asset.storage.locator)
      if (!match) throw new MediaServiceError('图片版本存储地址损坏', 500, 'IMAGE_VERSION_CORRUPT')
      sourcePath = join(this.casDir, match[1]!)
    } else if (record.asset.storage.kind === 'managed') {
      sourcePath = join(this.assetsDir, record.asset.storage.locator)
    } else {
      throw new MediaServiceError('图片版本尚未保存到本机', 409, 'IMAGE_VERSION_NOT_LOCAL')
    }
    const bytes = await readFile(sourcePath).catch(() => null)
    if (!bytes) throw new MediaServiceError('图片版本文件已经丢失', 404, 'IMAGE_VERSION_MISSING')
    if (record.asset.byte_size !== undefined && record.asset.byte_size !== bytes.byteLength) {
      throw new MediaServiceError('图片版本文件大小已经变化', 409, 'IMAGE_VERSION_CORRUPT')
    }
    const actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const locatorHash = record.asset.storage.kind === 'cas'
      ? /^sha256\/([a-f0-9]{64})$/.exec(record.asset.storage.locator)?.[1]
      : undefined
    const expectedHash = record.asset.content_hash ?? (locatorHash ? `sha256:${locatorHash}` : undefined)
    if (expectedHash && actualHash !== expectedHash) {
      throw new MediaServiceError('图片版本内容已经变化', 409, 'IMAGE_VERSION_CORRUPT')
    }
    if (detectedImageMime(bytes) !== mimeType) {
      throw new MediaServiceError('图片版本格式已经变化', 409, 'IMAGE_VERSION_CORRUPT')
    }
    const dimensions = imageDimensions(bytes, mimeType)
    if (!dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > 12000 || dimensions.height > 12000) {
      throw new MediaServiceError('图片版本尺寸无法验证', 409, 'IMAGE_DIMENSIONS_INVALID')
    }
    return { ...record, bytes, mimeType, dimensions, sourcePath }
  }

  async selectImageVersion(projectId: string, raw: SelectImageVersionInput): Promise<ImageWorkbenchProject> {
    const input = selectImageVersionInputSchema.parse(raw)
    const project = await this.getProject(projectId)
    if (project.kind !== 'image') throw new MediaServiceError('这不是图片项目', 409, 'WRONG_PROJECT_KIND')
    if (project.revision !== input.revision) {
      throw new MediaServiceError('图片项目已更新，请刷新后再选择版本', 409, 'REVISION_CONFLICT')
    }
    await this.imageVersionBytes(project, input.version_id)
    return await this.saveProject({
      ...project,
      current_version_id: input.version_id,
      revision: project.revision + 1,
      updated_at: this.iso(),
    }) as ImageWorkbenchProject
  }

  async commitImageVersion(projectId: string, raw: CommitImageVersionInput): Promise<ImageWorkbenchProject> {
    const input = commitImageVersionInputSchema.parse(raw)
    const project = await this.getProject(projectId)
    if (project.kind !== 'image') throw new MediaServiceError('这不是图片项目', 409, 'WRONG_PROJECT_KIND')
    if (project.revision !== input.revision) {
      throw new MediaServiceError('图片项目已更新，请刷新后再提交版本', 409, 'REVISION_CONFLICT')
    }
    if (project.task_id) {
      const task = await this.getTask(project.task_id, false).catch(() => null)
      if (task && ['queued', 'running', 'committing'].includes(task.status)) {
        throw new MediaServiceError('当前图片操作尚未完成', 409, 'IMAGE_OPERATION_ACTIVE')
      }
    }
    const base = await this.imageVersionBytes(project, input.base_version_id)
    const renderedBytes = dataUrlBytes(input.rendered_image)
    const dimensions = imageDimensions(renderedBytes, 'image/png')
    if (!dimensions || dimensions.width !== input.width || dimensions.height !== input.height) {
      throw new MediaServiceError('渲染结果尺寸与声明不一致', 400, 'IMAGE_DIMENSIONS_MISMATCH')
    }
    if (input.kind === 'upscale') {
      if (
        input.width !== base.dimensions.width * input.scale!
        || input.height !== base.dimensions.height * input.scale!
      ) {
        throw new MediaServiceError('放大结果必须严格匹配基础版本与倍数', 400, 'IMAGE_UPSCALE_MISMATCH')
      }
    } else if (input.kind === 'text_layout') {
      if (input.width !== base.dimensions.width || input.height !== base.dimensions.height) {
        throw new MediaServiceError('文字排版不能改变基础画布尺寸', 400, 'IMAGE_TEXT_CANVAS_MISMATCH')
      }
      if (input.text_layers.some(layer => (
        layer.x > input.width
        || layer.y > input.height
        || (layer.max_width ?? input.width) > input.width
      ))) {
        throw new MediaServiceError('文字图层超出基础画布', 400, 'IMAGE_TEXT_LAYER_OUT_OF_BOUNDS')
      }
      const renderedText = new Set(input.text_layers.map(layer => layer.text))
      const missing = (project.brief?.exact_text ?? []).filter(text => !renderedText.has(text))
      if (missing.length > 0) {
        throw new MediaServiceError('文字图层缺少 Brief 中要求的精确文字', 400, 'IMAGE_EXACT_TEXT_MISSING')
      }
    } else {
      if (input.width !== base.dimensions.width || input.height !== base.dimensions.height) {
        throw new MediaServiceError('图片组合不能改变基础画布尺寸', 400, 'IMAGE_COMPOSITE_CANVAS_MISMATCH')
      }
      if (input.image_layers.some(layer => (
        layer.x + layer.width > input.width
        || layer.y + layer.height > input.height
      ))) {
        throw new MediaServiceError('图片图层超出基础画布', 400, 'IMAGE_LAYER_OUT_OF_BOUNDS')
      }
      const sourceAssets = new Map(project.assets
        .filter(asset => asset.role === 'reference')
        .map(asset => [asset.id, asset]))
      for (const layer of input.image_layers) {
        const source = sourceAssets.get(layer.source_asset_id)
        if (!source || !['managed', 'cas'].includes(source.storage.kind)) {
          throw new MediaServiceError('图片图层引用的素材不存在', 400, 'IMAGE_LAYER_SOURCE_MISSING')
        }
        if (source.storage.kind === 'managed') {
          const prefix = `${project.id}/references/`
          if (!source.storage.locator.startsWith(prefix)) {
            throw new MediaServiceError('图片图层引用的素材不属于当前项目', 400, 'IMAGE_LAYER_SOURCE_INVALID')
          }
          const fileName = source.storage.locator.slice(prefix.length)
          await this.resolveOwnedAsset(project.id, fileName, {
            message: '图片图层引用的素材文件已经丢失',
            code: 'IMAGE_LAYER_SOURCE_MISSING',
          }, 'references')
        } else {
          const digest = /^sha256\/([a-f0-9]{64})$/.exec(source.storage.locator)?.[1]
          const info = digest ? await stat(join(this.casDir, digest)).catch(() => null) : null
          if (!info?.isFile()) {
            throw new MediaServiceError('图片图层引用的素材文件已经丢失', 400, 'IMAGE_LAYER_SOURCE_MISSING')
          }
        }
      }
    }
    const outputId = id('out')
    const operationId = foundationId('op', project.id, input.kind, String(project.revision), input.base_version_id)
    const versionId = foundationId('ver', project.id, operationId, outputId)
    const fileName = `${outputId}.png`
    const assetPath = join(this.assetsDir, project.id, fileName)
    await mkdir(dirname(assetPath), { recursive: true, mode: 0o700 })
    await writeFile(assetPath, renderedBytes, { mode: 0o600 })
    const output = {
      id: outputId,
      operation_id: operationId,
      version_id: versionId,
      version_kind: input.kind,
      parent_version_id: input.base_version_id,
      width: input.width,
      height: input.height,
      text_layers: input.kind === 'text_layout' ? input.text_layers : undefined,
      image_layers: input.kind === 'composite' ? input.image_layers : undefined,
      mime_type: 'image/png' as const,
      asset_path: `/api/media/assets/${project.id}/${fileName}`,
    }
    try {
      return await this.saveProject({
        ...project,
        state: 'ready',
        current_version_id: versionId,
        outputs: [...project.outputs, output],
        revision: project.revision + 1,
        updated_at: this.iso(),
      }) as ImageWorkbenchProject
    } catch (error) {
      await rm(assetPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  async saveImageOutput(projectId: string, raw: SaveImageOutputInput): Promise<{ path: string }> {
    const input = saveImageOutputInputSchema.parse(raw)
    if (!isAbsolute(input.output_path)) {
      throw new MediaServiceError('图片保存路径必须是绝对路径', 400, 'OUTPUT_PATH_NOT_ABSOLUTE')
    }
    const project = await this.getProject(projectId)
    if (project.kind !== 'image') throw new MediaServiceError('这不是图片项目', 409, 'WRONG_PROJECT_KIND')
    const versionSource = input.version_id ? await this.imageVersionBytes(project, input.version_id) : null
    const output = input.output_id ? project.outputs.find(candidate => candidate.id === input.output_id) : undefined
    if (!versionSource && !output) throw new MediaServiceError('找不到图片结果', 404, 'IMAGE_OUTPUT_NOT_FOUND')
    const mimeType = versionSource?.mimeType ?? output!.mime_type
    const expectedExtension = mimeType === 'image/jpeg' ? '.jpg' : mimeType === 'image/webp' ? '.webp' : '.png'
    const requestedExtension = extname(input.output_path).toLowerCase()
    if (requestedExtension !== expectedExtension && !(expectedExtension === '.jpg' && requestedExtension === '.jpeg')) {
      throw new MediaServiceError(`图片结果需要保存为 ${expectedExtension}`, 400, 'IMAGE_OUTPUT_EXTENSION_MISMATCH')
    }

    let sourcePath: string | null = null
    let bytes: Buffer | null = null
    if (versionSource) {
      sourcePath = versionSource.sourcePath
    } else if (output!.asset_path) {
      const fileName = output!.asset_path!.split('/').pop() ?? ''
      if (!/^[a-z0-9][a-z0-9_.-]{2,120}$/.test(fileName)) {
        throw new MediaServiceError('图片资产地址损坏', 500, 'IMAGE_OUTPUT_CORRUPT')
      }
      sourcePath = (await this.resolveOwnedAsset(project.id, fileName, {
        message: '图片结果文件已经丢失',
        code: 'IMAGE_OUTPUT_MISSING',
      })).path
    } else if (output!.data_url) {
      bytes = dataUrlBytes(output!.data_url!)
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
    return await this.videoFileResponse(source.path, request, '视频素材已经移动或删除', 'SOURCE_MISSING')
  }

  async availableVideoOutputMimeType(
    projectId: string,
  ): Promise<'video/mp4' | 'video/quicktime' | 'video/webm' | null> {
    const project = await this.getProject(projectId)
    if (project.kind !== 'video' || project.state !== 'complete' || !project.output_path) return null
    const info = await stat(project.output_path).catch(() => null)
    if (!info?.isFile()) return null
    return this.videoContentType(project.output_path)
  }

  async videoOutputResponse(projectId: string, request: Request): Promise<Response> {
    const project = await this.getProject(projectId)
    if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
    if (project.state !== 'complete' || !project.output_path) {
      throw new MediaServiceError('找不到已导出的视频', 404, 'VIDEO_OUTPUT_NOT_FOUND')
    }
    return await this.videoFileResponse(
      project.output_path,
      request,
      '导出视频已经移动或删除',
      'VIDEO_OUTPUT_MISSING',
    )
  }

  private videoContentType(path: string): 'video/mp4' | 'video/quicktime' | 'video/webm' {
    const extension = extname(path).toLowerCase()
    if (extension === '.mov') return 'video/quicktime'
    if (extension === '.webm') return 'video/webm'
    return 'video/mp4'
  }

  private async validateVideoOutput(
    path: string,
  ): Promise<{
      contentHash: `sha256:${string}`
      byteSize: number
      durationMs: number
      modifiedAtMs: number
      videoStreamCount: number
      audioStreamCount: number
      width?: number
      height?: number
      fps?: number
    }> {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile() || info.size <= 0) throw new Error('导出文件不存在或为空')
    const probe = await this.runProcess([
      this.binary('ffprobe'),
      '-v', 'error',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      path,
    ])
    if (probe.exitCode !== 0) throw new Error('导出文件无法通过 ffprobe 校验')
    const metadata = JSON.parse(probe.stdout) as {
      streams?: Array<{ codec_type?: unknown; width?: unknown; height?: unknown; avg_frame_rate?: unknown; r_frame_rate?: unknown }>
      format?: { duration?: string }
    }
    const videoStreams = metadata.streams?.filter(stream => stream.codec_type === 'video') ?? []
    const audioStreams = metadata.streams?.filter(stream => stream.codec_type === 'audio') ?? []
    const primaryVideo = videoStreams[0]
    const duration = Number(metadata.format?.duration ?? 0)
    if (!videoStreams.length || !Number.isFinite(duration) || duration <= 0) throw new Error('导出文件缺少有效视频轨或时长')
    const width = Number(primaryVideo?.width)
    const height = Number(primaryVideo?.height)
    const fps = parseRate(primaryVideo?.avg_frame_rate ?? primaryVideo?.r_frame_rate)
    return {
      byteSize: info.size,
      durationMs: Math.max(1, Math.round(duration * 1000)),
      modifiedAtMs: info.mtimeMs,
      videoStreamCount: videoStreams.length,
      audioStreamCount: audioStreams.length,
      ...(Number.isInteger(width) && width > 0 ? { width } : {}),
      ...(Number.isInteger(height) && height > 0 ? { height } : {}),
      ...(fps && fps > 0 ? { fps } : {}),
      contentHash: await this.fileFingerprint(path),
    }
  }

  private async videoFileResponse(
    path: string,
    request: Request,
    missingMessage: string,
    missingCode: string,
  ): Promise<Response> {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) throw new MediaServiceError(missingMessage, 404, missingCode)
    const contentType = this.videoContentType(path)
    const range = request.headers.get('range')
    if (!range) {
      return new Response(Bun.file(path), {
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
    return new Response(Bun.file(path).slice(start, end + 1), {
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
    const references = referenceAssets.map((fileName, index) => ({
      asset_id: fileName.slice(0, fileName.lastIndexOf('.')),
      role: input.reference_roles[index]!,
    }))
    const { brief, providerPrompt } = compileImageBrief(input.user_request, references)
    const routedModel = routedImageModel(
      input.user_request,
      input.size,
      references.some(reference => reference.role === 'subject'),
    )
    const project = imageWorkbenchProjectSchema.parse({
      schema_version: 1,
      id: projectId,
      kind: 'image',
      title: input.title ?? defaultTitle(input.user_request, '新图片'),
      workspace_root: input.workspace_root,
      revision: 0,
      created_at: now,
      updated_at: now,
      state: 'draft',
      mode: referenceAssets.length > 0 ? 'edit' : 'generate',
      model: routedModel,
      prompt: providerPrompt,
      size: input.size,
      count: 3,
      candidate_count: 3,
      brief,
      brief_overrides: {},
      references,
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
      let existing = await this.getTask(project.task_id, false).catch(() => null)
      if (existing) existing = await this.fenceInterruptedImageSubmission(existing)
      if (
        existing?.kind === 'image.generate'
        && !existing.remote_task_id
        && existing.idempotency_key
        && ['queued', 'running'].includes(existing.status)
      ) {
        return await this.submitPersistedImageTask(project, existing)
      }
      if (existing?.outcome_unknown && !input.confirm_unknown_retry) {
        throw new MediaServiceError(
          '上一次任务是否已被远程服务受理暂时无法确认。继续会创建新的生图操作，请在桌面工作台明确确认',
          409,
          'IMAGE_UNKNOWN_RETRY_CONFIRMATION_REQUIRED',
        )
      }
      if (existing && existing.status !== 'failed' && existing.status !== 'cancelled') return existing
    }
    if (!productGatewayConfigured()) {
      throw new MediaServiceError(mediaSafeError('MEDIA_IMAGE_UNAVAILABLE').message, 503, 'GATEWAY_NOT_CONFIGURED')
    }
    // Admission validates project-scoped reference bytes before publishing a Job.
    // The reasoning stage reads them again so a post-admission swap still fails closed.
    await this.loadReferenceImages(project)

    const now = this.iso()
    const nextRevision = project.revision + 1
    const operationId = foundationId(
      'op',
      project.id,
      'generate',
      String(nextRevision),
      project.brief?.user_request ?? project.prompt,
    )
    const digest = createHash('sha256').update(operationId).digest('hex')
    let task = mediaTaskSchema.parse({
      schema_version: 1,
      id: id('task'),
      project_id: project.id,
      operation_id: operationId,
      kind: 'image.generate',
      status: 'queued',
      progress: 0,
      stage: '等待理解参考图',
      idempotency_key: `bb-media-${digest}`,
      image_operation: {
        kind: 'generate',
        model: project.model,
        output_count: 3,
      },
      created_at: now,
      updated_at: now,
    })
    task = await this.saveTask(task)
    const submittedProject = await this.saveProject({
      ...project,
      state: 'queued',
      task_id: task.id,
      error: undefined,
      error_code: undefined,
      notice: undefined,
      revision: nextRevision,
      updated_at: this.iso(),
    }) as ImageWorkbenchProject

    return await this.submitPersistedImageTask(submittedProject, task)
  }

  async startImageOperation(
    projectId: string,
    raw: StartImageOperationInput,
  ): Promise<MediaTask> {
    const input = startImageOperationInputSchema.parse(raw)
    const project = await this.getProject(projectId)
    if (project.kind !== 'image') throw new MediaServiceError('这不是图片项目', 409, 'WRONG_PROJECT_KIND')
    if (project.revision !== input.revision) {
      throw new MediaServiceError('图片项目已更新，请刷新后再编辑', 409, 'REVISION_CONFLICT')
    }
    if (project.task_id) {
      let existing = await this.getTask(project.task_id, false).catch(() => null)
      if (existing) existing = await this.fenceInterruptedImageSubmission(existing)
      if (existing?.outcome_unknown && !input.confirm_unknown_retry) {
        throw new MediaServiceError('上一次任务是否已被远程服务受理暂时无法确认，请明确确认后再创建新操作', 409, 'IMAGE_UNKNOWN_RETRY_CONFIRMATION_REQUIRED')
      }
      if (existing && ['queued', 'running', 'committing'].includes(existing.status)) {
        throw new MediaServiceError('当前图片操作尚未完成', 409, 'IMAGE_OPERATION_ACTIVE')
      }
    }
    if (!productGatewayConfigured()) {
      throw new MediaServiceError(mediaSafeError('MEDIA_IMAGE_UNAVAILABLE').message, 503, 'GATEWAY_NOT_CONFIGURED')
    }
    const base = await this.imageVersionBytes(project, input.base_version_id)
    const model = input.kind === 'inpaint'
      ? 'gpt-image-2' as const
      : routedImageModel(input.instruction, project.size, true)
    if (!imageSizeSupportedByModel(model, project.size)) {
      throw new MediaServiceError('当前 ImageGeneration 能力不支持这个基础版本尺寸', 400, 'IMAGE_SIZE_UNSUPPORTED')
    }
    const now = this.iso()
    const operationId = foundationId('op', project.id, input.kind, String(project.revision), input.base_version_id, input.instruction)
    const providerInstruction = [
      `编辑要求：${input.instruction}`,
      project.brief?.must_preserve.length ? `必须保留：${project.brief.must_preserve.join('；')}` : '',
      '除编辑要求明确指定的区域外，不得改变基础版本中的主体、品牌、Logo、二维码或已确认事实。',
      '不得编造价格、日期、地址、联系方式、品牌或活动规则。',
      project.brief?.exact_text.length ? '不要重新绘制可读文字，保留供确定性文字图层使用的区域。' : '',
    ].filter(Boolean).join('\n')
    let maskAsset: MediaAsset | undefined
    let maskPath: string | undefined
    if (input.mask_data_url) {
      const maskBytes = dataUrlBytes(input.mask_data_url)
      const maskDimensions = imageDimensions(maskBytes, 'image/png')
      if (!maskDimensions || maskDimensions.width !== base.dimensions.width || maskDimensions.height !== base.dimensions.height) {
        throw new MediaServiceError('局部重绘蒙版必须与基础版本尺寸一致', 400, 'IMAGE_MASK_DIMENSIONS_MISMATCH')
      }
      const maskId = id('mask')
      const fileName = `${maskId}.png`
      maskPath = join(this.assetsDir, project.id, 'masks', fileName)
      await mkdir(dirname(maskPath), { recursive: true, mode: 0o700 })
      await writeFile(maskPath, maskBytes, { mode: 0o600 })
      maskAsset = {
        id: maskId,
        role: 'mask',
        version_id: input.base_version_id,
        storage: { kind: 'managed', locator: join(project.id, 'masks', fileName) },
        mime_type: 'image/png',
        byte_size: maskBytes.byteLength,
        content_hash: `sha256:${createHash('sha256').update(maskBytes).digest('hex')}`,
        created_at: now,
      }
    }
    const operation = {
      kind: input.kind,
      base_version_id: input.base_version_id,
      instruction: providerInstruction,
      mask_asset_id: maskAsset?.id,
      model,
      output_count: 1,
    } as const
    const payload = await this.imageSubmissionPayload(
      { ...project, assets: maskAsset ? [...project.assets, maskAsset] : project.assets },
      { image_operation: operation },
    )
    const digest = createHash('sha256').update(`${operationId}:${JSON.stringify(payload)}`).digest('hex')
    let task = mediaTaskSchema.parse({
      schema_version: 1,
      id: id('task'),
      project_id: project.id,
      operation_id: operationId,
      kind: 'image.generate',
      status: 'queued',
      progress: 0,
      stage: input.kind === 'inpaint' ? '正在提交局部重绘' : '正在提交图片编辑',
      idempotency_key: `bb-media-${digest}`,
      image_operation: operation,
      created_at: now,
      updated_at: now,
    })
    let projectPublished = false
    try {
      task = await this.saveTask(task)
      const submittedProject = await this.saveProject({
        ...project,
        assets: maskAsset ? [...project.assets, maskAsset] : project.assets,
        state: 'queued',
        task_id: task.id,
        error: undefined,
        error_code: undefined,
        notice: undefined,
        revision: project.revision + 1,
        updated_at: this.iso(),
      }) as ImageWorkbenchProject
      projectPublished = true
      return await this.submitPersistedImageTask(submittedProject, task)
    } catch (error) {
      if (maskPath && !projectPublished) await rm(maskPath, { force: true }).catch(() => undefined)
      throw error
    }
  }

  private async imageSubmissionPayload(project: ImageWorkbenchProject, task?: Pick<MediaTask, 'image_operation'>) {
    const operation = task?.image_operation
    if (operation && operation.kind !== 'generate') {
      const base = await this.imageVersionBytes(project, operation.base_version_id!)
      let mask: string | undefined
      if (operation.mask_asset_id) {
        const asset = project.assets.find(candidate => candidate.id === operation.mask_asset_id && candidate.role === 'mask')
        if (!asset || asset.storage.kind !== 'cas' && asset.storage.kind !== 'managed') {
          throw new MediaServiceError('局部重绘蒙版不可用', 409, 'IMAGE_MASK_INVALID')
        }
        const path = asset.storage.kind === 'cas'
          ? join(this.casDir, asset.storage.locator.replace(/^sha256\//, ''))
          : join(this.assetsDir, asset.storage.locator)
        mask = `data:image/png;base64,${(await readFile(path)).toString('base64')}`
      }
      return {
        mode: 'edit' as const,
        model: operation.model,
        prompt: operation.instruction,
        n: operation.output_count,
        size: project.size,
        ...(operation.model === 'doubao-seedream-4-5-251128' ? { response_format: 'b64_json' } : {}),
        images: [`data:${base.mimeType};base64,${base.bytes.toString('base64')}`],
        ...(mask ? { mask } : {}),
      }
    }
    const referenceImages = project.mode === 'edit' ? await this.loadReferenceImages(project) : []
    return {
      mode: project.mode,
      model: operation?.model ?? project.model,
      prompt: project.prompt,
      n: operation?.output_count ?? project.count,
      size: project.size,
      ...(project.model === 'doubao-seedream-4-5-251128' ? { response_format: 'b64_json' } : {}),
      ...(project.mode === 'edit' ? { images: referenceImages } : {}),
    }
  }

  private submitPersistedImageTask(project: ImageWorkbenchProject, task: MediaTask): Promise<MediaTask> {
    const active = this.activeImageSubmissions.get(task.id)
    if (active) return active
    const submission = this.performPersistedImagePipeline(project, task)
      .finally(() => this.activeImageSubmissions.delete(task.id))
    this.activeImageSubmissions.set(task.id, submission)
    return submission
  }

  private async fenceInterruptedImageSubmission(task: MediaTask): Promise<MediaTask> {
    if (
      task.kind !== 'image.generate'
      || task.remote_task_id
      || !task.remote_submission_started_at
      || !['queued', 'running'].includes(task.status)
      || this.activeImageSubmissions.has(task.id)
    ) return task
    return await this.failImageTask(task, 'MEDIA_IMAGE_OUTCOME_UNKNOWN', true)
  }

  private async performPersistedImagePipeline(
    originalProject: ImageWorkbenchProject,
    originalTask: MediaTask,
  ): Promise<MediaTask> {
    let project = originalProject
    let task = originalTask
    if (task.image_operation?.kind === 'generate' && task.result?.reasoning_complete !== true) {
      task = await this.saveTask({
        ...task,
        status: 'running',
        progress: Math.max(task.progress, 1),
        stage: '正在理解参考图与整理 Brief',
        error: undefined,
        error_code: undefined,
        updated_at: this.iso(),
      })
      try {
        const referenceImages = await this.loadReferenceImages(project)
        const reasoned = await reasonImageBrief({
          userRequest: project.brief?.user_request ?? project.prompt,
          references: project.references.map((reference, index) => ({
            ...reference,
            data_url: referenceImages[index]!,
          })),
          overrides: project.brief_overrides,
        }, {
          operationId: `${task.operation_id ?? task.id}-reasoning`,
          fetchImpl: this.fetchImpl as typeof fetch,
          env: this.env,
        })
        project = await this.saveProject({
          ...project,
          brief: reasoned.brief,
          prompt: reasoned.providerPrompt,
          updated_at: this.iso(),
        }) as ImageWorkbenchProject
        task = await this.saveTask({
          ...task,
          status: 'queued',
          progress: Math.max(task.progress, 5),
          stage: 'Brief 已就绪，等待提交生成',
          result: { ...(task.result ?? {}), reasoning_complete: true },
          updated_at: this.iso(),
        })
      } catch (error) {
        recordMediaFailure('image_brief_reasoning', error)
        const failure = mediaSafeError('MEDIA_IMAGE_REASONING_UNAVAILABLE')
        task = await this.saveTask({
          ...task,
          status: 'failed',
          progress: 0,
          stage: '图片理解失败',
          error: failure.message,
          error_code: failure.code,
          updated_at: this.iso(),
        })
        await this.saveProject({
          ...project,
          state: 'failed',
          error: failure.message,
          error_code: failure.code,
          updated_at: this.iso(),
        })
        throw new MediaServiceError(
          failure.message,
          error instanceof ImageReasoningError ? error.status : 502,
          'IMAGE_REASONING_FAILED',
        )
      }
    }
    return await this.performImageSubmission(project, task)
  }

  private refreshPersistedImageTask(task: MediaTask): Promise<MediaTask> {
    const active = this.activeImageRefreshes.get(task.id)
    if (active) return active
    const refresh = this.refreshImageTask(task)
      .finally(() => this.activeImageRefreshes.delete(task.id))
    this.activeImageRefreshes.set(task.id, refresh)
    return refresh
  }

  private async performImageSubmission(project: ImageWorkbenchProject, originalTask: MediaTask): Promise<MediaTask> {
    if (!productGatewayConfigured()) {
      throw new MediaServiceError(mediaSafeError('MEDIA_IMAGE_UNAVAILABLE').message, 503, 'GATEWAY_NOT_CONFIGURED')
    }
    if (!originalTask.idempotency_key) {
      throw new MediaServiceError('生图任务缺少幂等凭据', 500, 'IMAGE_SUBMISSION_CORRUPT')
    }
    const payload = await this.imageSubmissionPayload(project, originalTask)
    let task = await this.saveTask({
      ...originalTask,
      status: 'queued',
      progress: Math.max(originalTask.progress, 1),
      stage: originalTask.outcome_unknown ? '正在确认上次提交' : '正在提交',
      remote_submission_started_at: originalTask.remote_submission_started_at ?? this.iso(),
      error: undefined,
      error_code: undefined,
      outcome_unknown: false,
      updated_at: this.iso(),
    })
    const submittedProject = await this.saveProject({
      ...project,
      state: 'queued',
      task_id: task.id,
      error: undefined,
      error_code: undefined,
      updated_at: this.iso(),
    }) as ImageWorkbenchProject
    const gateway = productGatewayTarget()
    if (!gateway) throw new MediaServiceError('产品网关未配置', 503, 'GATEWAY_NOT_CONFIGURED')
    const endpoint = `${gateway.baseUrl}/v1/images/tasks`
    const headers: Record<string, string> = {
      Authorization: `Bearer ${gateway.token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': originalTask.idempotency_key,
      [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    }

    try {
      const { response, body } = await this.fetchImageGatewayJson(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      })
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
        poll_after_seconds: relayPollAfterSeconds(body.poll_after_seconds, body.status === 'running' ? 3 : 15),
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
      recordMediaFailure('image_submission', error)
      const failure = mediaSafeError(
        outcomeUnknown ? 'MEDIA_IMAGE_OUTCOME_UNKNOWN' : 'MEDIA_IMAGE_UNAVAILABLE',
      )
      task = await this.saveTask({
        ...task,
        status: 'failed',
        stage: outcomeUnknown ? '提交结果待确认' : '提交失败',
        error: failure.message,
        error_code: failure.code,
        outcome_unknown: outcomeUnknown,
        updated_at: this.iso(),
      })
      await this.saveProject({
        ...submittedProject,
        state: 'failed',
        error: failure.message,
        error_code: failure.code,
        updated_at: this.iso(),
      })
      throw new MediaServiceError(
        failure.message,
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
      let existing = await this.getTask(project.task_id, false).catch(() => null)
      if (existing) existing = await this.fenceInterruptedImageSubmission(existing)
      if (existing?.outcome_unknown && !input.confirm_unknown_retry) {
        throw new MediaServiceError(
          '上一次任务是否已被远程服务受理暂时无法确认。修改后再生成会创建新操作，请在桌面工作台明确确认',
          409,
          'IMAGE_UNKNOWN_RETRY_CONFIRMATION_REQUIRED',
        )
      }
    }
    const availableReferenceIds = new Set(project.references.map(reference => reference.asset_id))
    const references = input.references ?? project.references
    if (references.some(reference => !availableReferenceIds.has(reference.asset_id))) {
      throw new MediaServiceError('图片参考素材已更新，请刷新后再编辑', 409, 'IMAGE_REFERENCE_CONFLICT')
    }
    if (references.length + input.new_reference_images.length > 8) {
      throw new MediaServiceError('每个图片项目最多保留 8 张参考图片', 400, 'TOO_MANY_REFERENCE_IMAGES')
    }
    const referenceIds = new Set(references.map(reference => reference.asset_id))
    const retainedReferenceAssets = (project.reference_image_assets ?? [])
      .filter(fileName => referenceIds.has(fileName.slice(0, fileName.lastIndexOf('.'))))
    const retainedBytes = (await Promise.all(retainedReferenceAssets.map(fileName => this.resolveOwnedAsset(
      project.id,
      fileName,
      { message: '参考图片文件已经丢失', code: 'REFERENCE_IMAGE_MISSING' },
      'references',
    )))).reduce((total, asset) => total + asset.size, 0)
    const addedBytes = input.new_reference_images.reduce((total, image) => total + dataUrlBytes(image).byteLength, 0)
    if (retainedBytes + addedBytes > MAX_REFERENCE_IMAGES_TOTAL_BYTES) {
      throw new MediaServiceError('参考图片合计不能超过 20 MB', 400, 'REFERENCE_IMAGES_TOO_LARGE')
    }
    const addedReferenceAssets = await this.persistReferenceImages(project.id, input.new_reference_images)
    try {
      const addedReferences = addedReferenceAssets.map((fileName, index) => ({
        asset_id: fileName.slice(0, fileName.lastIndexOf('.')),
        role: input.new_reference_roles[index]!,
      }))
      const nextReferences = [...references, ...addedReferences]
      const referenceImageAssets = [...retainedReferenceAssets, ...addedReferenceAssets]
      const compiled = compileImageBrief(input.user_request, nextReferences)
      const briefOverrides = input.brief_overrides ?? project.brief_overrides
      const brief = applyImageBriefOverrides(compiled.brief, briefOverrides)
      const providerPrompt = providerPromptForImageBrief(brief)
      const routedModel = routedImageModel(
        input.user_request,
        input.size,
        nextReferences.some(reference => reference.role === 'subject'),
      )
      return await this.saveProject({
        ...project,
        state: 'draft',
        task_id: undefined,
        prompt: providerPrompt,
        brief,
        brief_overrides: briefOverrides,
        references: nextReferences,
        reference_image_assets: referenceImageAssets,
        reference_image_count: nextReferences.length,
        mode: nextReferences.length > 0 ? 'edit' : 'generate',
        title: defaultTitle(input.user_request, project.title),
        model: routedModel,
        size: input.size,
        count: 3,
        candidate_count: 3,
        revision: project.revision + 1,
        error: undefined,
        error_code: undefined,
        notice: undefined,
        updated_at: this.iso(),
      }) as ImageWorkbenchProject
    } catch (error) {
      await Promise.all(addedReferenceAssets.map(fileName => rm(
        join(this.assetsDir, project.id, 'references', fileName),
        { force: true },
      )))
      throw error
    }
  }

  async addImageProjectReferences(
    projectId: string,
    raw: AddImageProjectReferencesInput,
  ): Promise<ImageWorkbenchProject> {
    const input = addImageProjectReferencesInputSchema.parse(raw)
    const project = await this.getProject(projectId)
    if (project.kind !== 'image') throw new MediaServiceError('这不是图片项目', 409, 'WRONG_PROJECT_KIND')
    if (['queued', 'generating'].includes(project.state)) {
      throw new MediaServiceError('当前图片操作尚未完成，暂时不能追加参考素材', 409, 'IMAGE_OPERATION_ACTIVE')
    }
    if (project.revision !== input.revision) {
      throw new MediaServiceError('图片项目已更新，请刷新后再追加参考素材', 409, 'REVISION_CONFLICT')
    }
    if (project.references.length + input.reference_images.length > 8) {
      throw new MediaServiceError('每个图片项目最多保留 8 张参考图片', 400, 'TOO_MANY_REFERENCE_IMAGES')
    }
    const retainedAssets = project.reference_image_assets ?? []
    const retainedBytes = (await Promise.all(retainedAssets.map(fileName => this.resolveOwnedAsset(
      project.id,
      fileName,
      { message: '参考图片文件已经丢失', code: 'REFERENCE_IMAGE_MISSING' },
      'references',
    )))).reduce((total, asset) => total + asset.size, 0)
    const addedBytes = input.reference_images.reduce((total, image) => total + dataUrlBytes(image).byteLength, 0)
    if (retainedBytes + addedBytes > MAX_REFERENCE_IMAGES_TOTAL_BYTES) {
      throw new MediaServiceError('参考图片合计不能超过 20 MB', 400, 'REFERENCE_IMAGES_TOO_LARGE')
    }
    const addedAssets = await this.persistReferenceImages(project.id, input.reference_images)
    try {
      const addedReferences = addedAssets.map((fileName, index) => ({
        asset_id: fileName.slice(0, fileName.lastIndexOf('.')),
        role: input.reference_roles[index]!,
      }))
      const references = [...project.references, ...addedReferences]
      const compiled = compileImageBrief(project.brief?.user_request ?? project.title, references)
      const brief = applyImageBriefOverrides(compiled.brief, project.brief_overrides)
      return await this.saveProject({
        ...project,
        prompt: providerPromptForImageBrief(brief),
        brief,
        references,
        reference_image_assets: [...retainedAssets, ...addedAssets],
        reference_image_count: references.length,
        mode: 'edit',
        model: routedImageModel(
          brief.user_request,
          project.size,
          references.some(reference => reference.role === 'subject'),
        ),
        revision: project.revision + 1,
        updated_at: this.iso(),
      }) as ImageWorkbenchProject
    } catch (error) {
      await Promise.all(addedAssets.map(fileName => rm(
        join(this.assetsDir, project.id, 'references', fileName),
        { force: true },
      )))
      throw error
    }
  }

  private async acknowledgePersistedImageResult(task: MediaTask): Promise<MediaTask> {
    if (
      task.kind !== 'image.generate'
      || task.status !== 'succeeded'
      || !task.remote_task_id
      || !task.provider_receipt_hash
      || task.remote_result_acknowledged_at
      || !productGatewayConfigured()
    ) return task
    const result = imageGenerationTaskResultSchema.safeParse(task.result)
    if (!result.success || result.data.outputs.length === 0) return task
    const project = await this.getProject(task.project_id).catch(() => null)
    if (project?.kind !== 'image') return task
    const localAssets = await Promise.all(result.data.outputs.map(async output => {
      if (!output.version_id) return false
      try {
        return (await this.imageVersionBytes(project, output.version_id)).asset.id === output.id
      } catch {
        return false
      }
    }))
    if (localAssets.some(persisted => !persisted)) return task

    const gateway = productGatewayTarget()
    if (!gateway) return task
    const headers: Record<string, string> = {
      Authorization: `Bearer ${gateway.token}`,
      [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    }
    try {
      const { response, body } = await this.fetchImageGatewayJson(
        `${gateway.baseUrl}/v1/images/tasks/${encodeURIComponent(task.remote_task_id)}/ack`,
        { method: 'POST', headers },
      )
      if (!response.ok || body.result_acknowledged !== true) {
        recordMediaFailure('image_result_ack', { status: response.status })
        return task
      }
      return await this.saveTask({
        ...task,
        remote_result_acknowledged_at: this.iso(),
        updated_at: this.iso(),
      })
    } catch (error) {
      // The local Version/Asset is already durable. A transient ack failure may
      // retain the relay blob until the next task read, but must never retry generation.
      recordMediaFailure('image_result_ack', error)
      return task
    }
  }

  private async refreshImageTask(task: MediaTask): Promise<MediaTask> {
    if (!task.remote_task_id) return task
    if (!productGatewayConfigured()) return task
    const gateway = productGatewayTarget()
    if (!gateway) return task
    const headers: Record<string, string> = {
      Authorization: `Bearer ${gateway.token}`,
      [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
      [MEDIA_RESULT_HANDOFF_HEADER]: MEDIA_RESULT_HANDOFF_DIRECT_V1,
    }
    let response: Response
    let body: RelayImageTask & { message?: string }
    try {
      const result = await this.fetchImageGatewayJson(
        `${gateway.baseUrl}/v1/images/tasks/${encodeURIComponent(task.remote_task_id)}`,
        { headers },
      )
      response = result.response
      body = result.body
      if (response.ok && body.status === 'succeeded' && body.result_urls?.length) {
        if (body.result_urls.length > 4) throw new Error('too many image result handoff URLs')
        const resultUrls = body.result_urls.map(value => trustedMediaResultUrl(value, gateway.baseUrl))
        if (resultUrls.some(value => !value)) throw new Error('untrusted image result handoff URL')
        const direct = await Promise.all(resultUrls.map(resultUrl => this.fetchImageGatewayJson(resultUrl!, {
          method: 'GET',
          redirect: 'error',
          headers: { Accept: 'application/json' },
        })))
        const failed = direct.find(result => !result.response.ok)
        if (failed) {
          response = failed.response
          body = failed.body
        } else {
          body = { ...body, data: direct.flatMap(result => result.body.data ?? []) }
        }
      } else if (response.ok && body.status === 'succeeded' && body.result_url) {
        const resultUrl = trustedMediaResultUrl(body.result_url, gateway.baseUrl)
        if (!resultUrl) throw new Error('untrusted image result handoff URL')
        const direct = await this.fetchImageGatewayJson(resultUrl, {
          method: 'GET',
          redirect: 'error',
          headers: { Accept: 'application/json' },
        })
        response = direct.response
        body = { ...body, ...direct.body }
      }
    } catch (error) {
      // The remote task can still be running. Keep its persisted status rather
      // than inventing a terminal result from a transient status-read failure.
      recordMediaFailure('image_status', error)
      return task
    }
    if (!response.ok) {
      recordMediaFailure('image_status', { status: response.status, body })
      if (response.status >= 500) return task
      return await this.failImageTask(
        task,
        body.status === 'failed_unknown' ? 'MEDIA_IMAGE_OUTCOME_UNKNOWN' : 'MEDIA_IMAGE_UNAVAILABLE',
        body.status === 'failed_unknown',
        body.provider_receipt_hash,
      )
    }
    if (body.status === 'cancelled') {
      if (body.error) recordMediaFailure('image_status_cancelled', body)
      return await this.markImageTaskCancelled(task)
    }
    if (body.status === 'failed' || body.status === 'failed_unknown') {
      recordMediaFailure('image_status_failed', body)
      return await this.failImageTask(
        task,
        body.status === 'failed_unknown' ? 'MEDIA_IMAGE_OUTCOME_UNKNOWN' : 'MEDIA_IMAGE_UNAVAILABLE',
        body.status === 'failed_unknown',
        body.provider_receipt_hash,
      )
    }
    if (body.status !== 'succeeded') {
      const next = await this.saveTask({
        ...task,
        status: body.status === 'running' ? 'running' : 'queued',
        progress: body.status === 'running' ? Math.max(task.progress, 35) : Math.max(task.progress, 5),
        stage: body.status === 'running' ? '正在生成' : '等待生成',
        poll_after_seconds: relayPollAfterSeconds(body.poll_after_seconds, body.status === 'running' ? 3 : 15),
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
        provider_receipt_hash: body.provider_receipt_hash,
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
    const operationKind = task.image_operation?.kind ?? 'generate'
    const versionKind = operationKind === 'generate' ? 'generated' as const : operationKind
    const parentVersionId = task.image_operation?.base_version_id ?? attachedProject.versions.at(-1)?.id
    const projectAssetDir = join(this.assetsDir, task.project_id)
    const createdAssets: string[] = []
    const qualityCandidates: Array<{
      data_url: string
      candidate_index: number
      source_path: string
      width?: number
      height?: number
    }> = []
    await mkdir(projectAssetDir, { recursive: true, mode: 0o700 })
    for (const item of body.data ?? []) {
      const outputId = id('out')
      const operationId = task.operation_id ?? foundationId('op', task.project_id, task.kind, task.id)
      const versionId = foundationId('ver', task.project_id, operationId, outputId)
      if (item.b64_json) {
        const bytes = Buffer.from(item.b64_json, 'base64')
        const mimeType = detectedImageMime(bytes) ?? item.mime_type ?? 'image/png'
        const dimensions = imageDimensions(bytes, mimeType)
        const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
        const fileName = `${outputId}.${extension}`
        const assetPath = join(projectAssetDir, fileName)
        await writeFile(assetPath, bytes, { mode: 0o600 })
        createdAssets.push(assetPath)
        qualityCandidates.push({
          data_url: `data:${mimeType};base64,${item.b64_json}`,
          candidate_index: outputs.length,
          source_path: assetPath,
          width: dimensions?.width,
          height: dimensions?.height,
        })
        outputs.push({
          id: outputId,
          operation_id: operationId,
          version_id: versionId,
          version_kind: versionKind,
          parent_version_id: parentVersionId,
          width: dimensions?.width,
          height: dimensions?.height,
          mime_type: mimeType,
          asset_path: `/api/media/assets/${task.project_id}/${fileName}`,
          revised_prompt: item.revised_prompt,
        })
      } else if (item.url) {
        outputs.push({
          id: outputId,
          operation_id: operationId,
          version_id: versionId,
          version_kind: versionKind,
          parent_version_id: parentVersionId,
          mime_type: 'image/png',
          url: item.url,
          revised_prompt: item.revised_prompt,
        })
      }
    }
    if (outputs.length === 0) {
      recordMediaFailure('image_result_empty', body)
      return await this.failImageTask(task, 'MEDIA_IMAGE_UNAVAILABLE')
    }
    let outputsWithQuality = outputs
    let qualityStatus: 'completed' | 'unavailable' = 'unavailable'
    await this.saveTask({
      ...task,
      status: 'committing',
      progress: 90,
      stage: '正在质检并保存候选',
      provider_receipt_hash: body.provider_receipt_hash,
      result: { output_count: outputs.length, outputs, quality_status: 'pending' },
      updated_at: this.iso(),
    })
    if (attachedProject.brief && qualityCandidates.length > 0) {
      try {
        const boundedCandidates = await this.boundedImageQualityCandidates(qualityCandidates)
        const primaryOperationId = foundationId('op', task.operation_id ?? task.id, 'quality')
        let assessments: ImageQualityAssessment[]
        try {
          assessments = await assessImageCandidates({
            brief: attachedProject.brief,
            candidates: boundedCandidates,
          }, {
            operationId: primaryOperationId,
            fetchImpl: this.fetchImpl as typeof fetch,
            env: this.env,
          })
        } catch (error) {
          if (!(error instanceof ImageReasoningError) || error.status !== 400) throw error
          const fallbackCandidates = await this.boundedImageQualityCandidates(qualityCandidates, {
            maxChars: 512 * 1024,
            previewEdge: 320,
            jpegQuality: 8,
          })
          assessments = await assessImageCandidates({
            brief: attachedProject.brief,
            candidates: fallbackCandidates,
          }, {
            operationId: foundationId('op', primaryOperationId, 'smaller-preview'),
            fetchImpl: this.fetchImpl as typeof fetch,
            env: this.env,
          })
        }
        outputsWithQuality = outputs.map((output, index) => {
          const assessment = assessments.find(item => item.candidate_index === index)
          return assessment ? {
            ...output,
            quality_assessment: {
              score: assessment.score,
              summary: assessment.summary,
              issues: assessment.issues,
              suggestions: assessment.suggestions,
            },
          } : output
        })
        qualityStatus = 'completed'
      } catch (error) {
        recordMediaFailure('image_quality_reasoning', error instanceof ImageReasoningError
          ? { name: error.name, message: error.message, status: error.status, code: error.code }
          : error)
      }
    }
    const next = await this.saveTask({
      ...task,
      status: 'succeeded',
      progress: 100,
      stage: '生成完成',
      provider_receipt_hash: body.provider_receipt_hash,
      result: {
        output_count: outputs.length,
        outputs: outputsWithQuality,
        quality_status: qualityStatus,
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
          output_count: outputsWithQuality.length,
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
      outputs: [
        ...project.outputs.filter(output => !outputsWithQuality.some(completed => completed.id === output.id)),
        ...outputsWithQuality,
      ],
      current_version_id: operationKind === 'generate'
        ? project.current_version_id
        : outputsWithQuality[0]?.version_id ?? project.current_version_id,
      notice: body.input_fidelity_risk
        ? boundedMessage(body.input_fidelity_risk)
        : qualityStatus === 'unavailable'
          ? '候选已保存；视觉质检暂时不可用，可稍后继续编辑或重新生成。'
          : undefined,
      error: undefined,
      error_code: undefined,
      updated_at: this.iso(),
    })
    return await this.acknowledgePersistedImageResult(next)
  }

  private async failImageTask(
    task: MediaTask,
    errorCode: MediaSafeErrorCode,
    outcomeUnknown = false,
    providerReceiptHash?: string,
  ): Promise<MediaTask> {
    const failure = mediaSafeError(errorCode)
    const next = await this.saveTask({
      ...task,
      status: 'failed',
      stage: '生成失败',
      error: failure.message,
      error_code: failure.code,
      outcome_unknown: outcomeUnknown,
      provider_receipt_hash: providerReceiptHash,
      updated_at: this.iso(),
    })
    const project = await this.currentImageProjectForTask(task)
    if (project) {
      await this.saveProject({
        ...project,
        state: 'failed',
        error: failure.message,
        error_code: failure.code,
        updated_at: this.iso(),
      })
    }
    return next
  }

  private async markImageTaskCancelled(task: MediaTask): Promise<MediaTask> {
    const failure = mediaSafeError('MEDIA_IMAGE_CANCELLED')
    const next = await this.saveTask({
      ...task,
      status: 'cancelled',
      progress: 0,
      stage: '已取消',
      error: failure.message,
      error_code: failure.code,
      outcome_unknown: false,
      updated_at: this.iso(),
    })
    const project = await this.getProject(task.project_id).catch(() => null)
    if (project?.kind === 'image' && project.task_id === task.id) {
      await this.saveProject({
        ...project,
        state: 'failed',
        error: failure.message,
        error_code: failure.code,
        updated_at: this.iso(),
      })
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
    return await this.migrateVideoTimeline(await this.saveProject(project) as VideoStudioProject)
  }

  private binary(name: 'ffmpeg' | 'ffprobe'): string {
    const explicit = this.env[name === 'ffmpeg' ? 'FFMPEG_BIN' : 'FFPROBE_BIN']?.trim()
    if (explicit) return explicit
    const directory = this.env.BB_MEDIA_BIN_DIR?.trim()
    if (directory) return join(directory, this.platform === 'win32' ? `${name}.exe` : name)
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
        throw new MediaServiceError(
          mediaSafeError('MEDIA_VIDEO_TOOLCHAIN_UNAVAILABLE').message,
          503,
          'VIDEO_ENCODER_UNAVAILABLE',
        )
      }
      return explicit === 'mpeg4'
        ? FALLBACK_VIDEO_ENCODER
        : { name: explicit as VideoEncoderProfile['name'], args: ['-b:v', '8M'] }
    }
    if (this.platform === 'darwin' && has('h264_videotoolbox')) {
      return { name: 'h264_videotoolbox', args: ['-b:v', '8M'] }
    }
    if (this.platform === 'win32' && has('h264_mf')) {
      return { name: 'h264_mf', args: ['-b:v', '8M'] }
    }
    return FALLBACK_VIDEO_ENCODER
  }

  async addVideoSource(projectId: string, raw: AddVideoSourceInput): Promise<{ project: VideoStudioProject; task: MediaTask }> {
    return await this.withVideoProbeAdmission(() => (
      this.withVideoProjectMutation(projectId, () => this.addVideoSourceSerial(projectId, raw))
    ))
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
      const videoStreams = metadata.streams?.filter(stream => stream.codec_type === 'video') ?? []
      const audioStreams = metadata.streams?.filter(stream => stream.codec_type === 'audio') ?? []
      const rotationRaw = (video.tags as Record<string, unknown> | undefined)?.rotate
        ?? (Array.isArray(video.side_data_list)
          ? (video.side_data_list as Array<Record<string, unknown>>).find(item => item.rotation !== undefined)?.rotation
          : undefined)
      const rotation = Number(rotationRaw)
      const fingerprint = await this.fileFingerprint(input.path)
      const source: VideoSource = {
        id: id('src'),
        path: input.path,
        name: basename(input.path),
        duration_ms: Math.max(1, Math.round(Number(metadata.format?.duration ?? video.duration ?? 0) * 1000)),
        width: Math.max(0, Number(video.width ?? 0)),
        height: Math.max(0, Number(video.height ?? 0)),
        fps: parseRate(video.avg_frame_rate ?? video.r_frame_rate),
        has_audio: audioStreams.length > 0,
        fingerprint,
        rotation: Number.isFinite(rotation) ? ((Math.trunc(rotation) % 360) + 360) % 360 : 0,
        video_stream_count: videoStreams.length,
        audio_stream_count: audioStreams.length,
        missing: false,
      }
      const clip: VideoClip = {
        id: id('clip'),
        source_id: source.id,
        in_ms: 0,
        out_ms: Math.max(1, source.duration_ms),
      }
      const sourceEvidence: VideoEvidence = {
        id: id('evidence'),
        kind: 'source_role',
        source_id: source.id,
        source_fingerprint: fingerprint,
        in_ms: 0,
        out_ms: source.duration_ms,
        text: `真实视频素材：${source.name}，${source.width}×${source.height}，${source.duration_ms}ms${source.has_audio ? '，含音轨' : '，无音轨'}`,
        confidence: 1,
        warnings: [],
        created_at: this.iso(),
      }
      const evidence = [...project.evidence, sourceEvidence]
      const evidenceRevision = videoEvidenceRevision(evidence)
      const currentTimeline = project.timeline_versions.find(version => version.id === project.current_timeline_version_id)
      const addedScene = scenesFromClips([clip], evidence)[0]!
      const timelineVersion = this.timelineVersion(
        { ...project, evidence, evidence_revision: evidenceRevision },
        [...(currentTimeline?.scenes ?? scenesFromClips(project.timeline, project.evidence)), addedScene],
        evidenceRevision,
      )
      const nextProject = await this.saveProject({
        ...project,
        state: 'ready',
        sources: [...project.sources, source],
        timeline: [...project.timeline, clip],
        evidence,
        evidence_revision: evidenceRevision,
        timeline_versions: [...project.timeline_versions, timelineVersion],
        current_timeline_version_id: timelineVersion.id,
        alternatives: [],
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
      recordMediaFailure('video_probe', error)
      const failure = mediaSafeError('MEDIA_VIDEO_SOURCE_UNREADABLE')
      task = await this.saveTask({
        ...task,
        status: 'failed',
        stage: '读取失败',
        error: failure.message,
        error_code: failure.code,
        updated_at: this.iso(),
      })
      throw new MediaServiceError(failure.message, 422, 'VIDEO_PROBE_FAILED')
    }
  }

  async updateVideoTimeline(projectId: string, raw: UpdateVideoTimelineInput): Promise<VideoStudioProject> {
    return await this.withVideoProjectMutation(projectId, () => this.updateVideoTimelineSerial(projectId, raw))
  }

  async selectVideoTimelineVersion(
    projectId: string,
    raw: SelectVideoTimelineVersionInput,
  ): Promise<VideoStudioProject> {
    return await this.withVideoProjectMutation(projectId, async () => {
      const input = selectVideoTimelineVersionInputSchema.parse(raw)
      const project = await this.getProject(projectId)
      if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
      if (project.state === 'rendering') throw new MediaServiceError('正在导出，暂时不能恢复时间线', 409, 'RENDER_IN_PROGRESS')
      if (project.revision !== input.revision) {
        throw new MediaServiceError('视频项目已更新，请刷新后再选择版本', 409, 'REVISION_CONFLICT')
      }
      const version = project.timeline_versions.find(candidate => candidate.id === input.version_id)
      if (!version) throw new MediaServiceError('视频时间线版本不存在', 404, 'TIMELINE_VERSION_MISSING')
      if (project.current_timeline_version_id === version.id) return project
      return await this.saveProject({
        ...project,
        timeline: version.scenes.map(scene => ({
          id: scene.id,
          source_id: scene.source_id,
          in_ms: scene.in_ms,
          out_ms: scene.out_ms,
        })),
        current_timeline_version_id: version.id,
        alternatives: [],
        state: version.scenes.length ? 'ready' : 'draft',
        revision: project.revision + 1,
        updated_at: this.iso(),
      }) as VideoStudioProject
    })
  }

  private async updateVideoTimelineSerial(projectId: string, raw: UpdateVideoTimelineInput): Promise<VideoStudioProject> {
    const input = updateVideoTimelineInputSchema.parse(raw)
    const project = await this.getProject(projectId)
    if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
    if (project.state === 'rendering') throw new MediaServiceError('正在导出，暂时不能修改时间线', 409, 'RENDER_IN_PROGRESS')
    if (project.revision !== input.base_revision) throw new MediaServiceError('视频项目已更新，请刷新后再编辑', 409, 'REVISION_CONFLICT')
    const baseTimelineVersionId = input.base_timeline_version_id ?? project.current_timeline_version_id
    if (project.current_timeline_version_id !== baseTimelineVersionId) {
      throw new MediaServiceError('视频时间线已更新，请刷新后再编辑', 409, 'TIMELINE_VERSION_CONFLICT')
    }
    const currentTimeline = project.timeline_versions.find(version => version.id === baseTimelineVersionId)
    if (!currentTimeline) throw new MediaServiceError('视频时间线版本不存在', 409, 'TIMELINE_VERSION_MISSING')
    const sources = new Map(project.sources.map(source => [source.id, source]))
    for (const clip of input.clips) {
      const source = sources.get(clip.source_id)
      if (!source) throw new MediaServiceError('时间线引用了不存在的素材', 400, 'SOURCE_NOT_FOUND')
      if (clip.out_ms > source.duration_ms) throw new MediaServiceError('剪辑范围超过素材时长', 400, 'CLIP_OUT_OF_RANGE')
    }
    const nextScenes = input.clips.map((clip, index) => {
      const current = currentTimeline.scenes.find(scene => scene.id === clip.id)
      return current
        ? { ...current, source_id: clip.source_id, in_ms: clip.in_ms, out_ms: clip.out_ms }
        : scenesFromClips([clip], project.evidence).map(scene => ({
          ...scene,
          story_role: index === 0 ? 'hook' as const : index === input.clips.length - 1 ? 'result' as const : 'action' as const,
        }))[0]!
    })
    for (const locked of currentTimeline.scenes.filter(scene => scene.locked)) {
      const candidate = nextScenes.find(scene => scene.id === locked.id)
      if (!candidate || candidate.source_id !== locked.source_id || candidate.in_ms !== locked.in_ms || candidate.out_ms !== locked.out_ms) {
        throw new MediaServiceError('锁定场景不能被移动、删除或替换', 409, 'LOCKED_SCENE_CONFLICT')
      }
    }
    const timelineVersion = this.timelineVersion(project, nextScenes)
    return await this.saveProject({
      ...project,
      timeline: input.clips,
      timeline_versions: [...project.timeline_versions, timelineVersion],
      current_timeline_version_id: timelineVersion.id,
      alternatives: [],
      state: input.clips.length ? 'ready' : 'draft',
      revision: project.revision + 1,
      updated_at: this.iso(),
    }) as VideoStudioProject
  }

  async lockVideoScene(
    projectId: string,
    sceneId: string,
    raw: LockVideoSceneInput,
  ): Promise<VideoStudioProject> {
    return await this.withVideoProjectMutation(projectId, async () => {
      const input = lockVideoSceneInputSchema.parse(raw)
      const project = await this.getProject(projectId)
      if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
      if (project.state === 'rendering') throw new MediaServiceError('正在导出，暂时不能修改时间线', 409, 'RENDER_IN_PROGRESS')
      if (project.revision !== input.base_revision) throw new MediaServiceError('视频项目已更新，请刷新后再编辑', 409, 'REVISION_CONFLICT')
      if (project.current_timeline_version_id !== input.timeline_version_id) throw new MediaServiceError('视频时间线已更新，请刷新后再编辑', 409, 'TIMELINE_VERSION_CONFLICT')
      const current = project.timeline_versions.find(version => version.id === input.timeline_version_id)
      if (!current) throw new MediaServiceError('视频时间线版本不存在', 409, 'TIMELINE_VERSION_MISSING')
      if (!current.scenes.some(scene => scene.id === sceneId)) throw new MediaServiceError('场景不存在', 404, 'SCENE_NOT_FOUND')
      const scenes = current.scenes.map(scene => scene.id === sceneId ? { ...scene, locked: input.locked } : scene)
      const timelineVersion = this.timelineVersion(project, scenes)
      return await this.saveProject({
        ...project,
        timeline_versions: [...project.timeline_versions, timelineVersion],
        current_timeline_version_id: timelineVersion.id,
        revision: project.revision + 1,
        updated_at: this.iso(),
      }) as VideoStudioProject
    })
  }

  async applyVideoAlternative(
    projectId: string,
    raw: ApplyVideoAlternativeInput,
  ): Promise<VideoStudioProject> {
    return await this.withVideoProjectMutation(projectId, async () => {
      const input = applyVideoAlternativeInputSchema.parse(raw)
      const project = await this.getProject(projectId)
      if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
      if (project.state === 'rendering') throw new MediaServiceError('正在导出，暂时不能修改时间线', 409, 'RENDER_IN_PROGRESS')
      if (project.revision !== input.base_revision) throw new MediaServiceError('视频项目已更新，请刷新后再编辑', 409, 'REVISION_CONFLICT')
      const alternative = project.alternatives.find(candidate => candidate.id === input.alternative_id)
      if (!alternative) throw new MediaServiceError('备选方案不存在', 404, 'ALTERNATIVE_NOT_FOUND')
      if (alternative.base_timeline_version_id !== project.current_timeline_version_id) {
        throw new MediaServiceError('备选方案已经过期，请重新分析', 409, 'ALTERNATIVE_STALE')
      }
      const current = project.timeline_versions.find(version => version.id === project.current_timeline_version_id)
      if (!current) throw new MediaServiceError('视频时间线版本不存在', 409, 'TIMELINE_VERSION_MISSING')
      for (const locked of current.scenes.filter(scene => scene.locked)) {
        const candidate = alternative.scenes.find(scene => scene.id === locked.id)
        if (!candidate || JSON.stringify(candidate) !== JSON.stringify(locked)) {
          throw new MediaServiceError('备选方案不能覆盖锁定场景', 409, 'LOCKED_SCENE_CONFLICT')
        }
      }
      const timelineVersion = this.timelineVersion(project, alternative.scenes)
      return await this.saveProject({
        ...project,
        timeline: alternative.scenes.map(scene => ({
          id: scene.id,
          source_id: scene.source_id,
          in_ms: scene.in_ms,
          out_ms: scene.out_ms,
        })),
        timeline_versions: [...project.timeline_versions, timelineVersion],
        current_timeline_version_id: timelineVersion.id,
        alternatives: [],
        revision: project.revision + 1,
        state: alternative.scenes.length ? 'ready' : 'draft',
        updated_at: this.iso(),
      }) as VideoStudioProject
    })
  }

  private async prepareVideoProjectSources(project: VideoStudioProject): Promise<VideoStudioProject> {
    let enriched = false
    const sources: VideoSource[] = []
    for (const source of project.sources) {
      const info = await stat(source.path).catch(() => null)
      if (!info?.isFile()) throw new MediaServiceError('视频素材已不可用', 404, 'SOURCE_MISSING')
      const fingerprint = await this.fileFingerprint(source.path)
      if (source.fingerprint && source.fingerprint !== fingerprint) {
        throw new MediaServiceError('视频素材内容已经变化，请重新导入', 409, 'SOURCE_CHANGED')
      }
      enriched ||= !source.fingerprint || source.missing
      sources.push({ ...source, fingerprint, missing: false })
    }
    return enriched
      ? await this.saveProject({ ...project, sources }) as VideoStudioProject
      : project
  }

  private async extractVideoAnalysisInputs(
    project: VideoStudioProject,
    operationId: string,
    signal: AbortSignal,
  ): Promise<{ frames: VideoAnalysisFrame[]; transcripts: VideoEvidence[]; gaps: string[] }> {
    const directory = join(this.root, 'analysis', operationId)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const frames: VideoAnalysisFrame[] = []
    const transcripts: VideoEvidence[] = []
    const gaps: string[] = []
    const sampled = project.sources.slice(0, 4)
    if (project.sources.length > sampled.length) gaps.push(`仅抽取前 ${sampled.length} 个素材的远端画面与音频证据；其余素材仍保留来源证据。`)
    try {
      for (const source of sampled) {
        if (signal.aborted) throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
        const frameTimes = [...new Set([0.1, 0.5, 0.9].map(position => (
          Math.max(0, Math.min(source.duration_ms - 1, Math.floor(source.duration_ms * position)))
        )))]
        let extractedFrames = 0
        for (const [frameIndex, frameTimeMs] of frameTimes.entries()) {
          if (signal.aborted) throw new VideoAnalysisError('视频分析已取消', 499, 'VIDEO_ANALYSIS_CANCELLED')
          const framePath = join(directory, `${source.id}-${frameIndex}.jpg`)
          const frame = await this.runProcess([
            this.binary('ffmpeg'), '-hide_banner', '-loglevel', 'error',
            '-ss', (frameTimeMs / 1000).toFixed(3), '-i', source.path,
            '-frames:v', '1', '-vf', 'scale=1280:-2:force_original_aspect_ratio=decrease',
            '-q:v', '3', '-y', framePath,
          ], { signal }).catch(() => null)
          const frameBytes = frame?.exitCode === 0 ? await readFile(framePath).catch(() => null) : null
          if (!frameBytes?.length) continue
          frames.push({ source_id: source.id, in_ms: frameTimeMs, data_url: `data:image/jpeg;base64,${frameBytes.toString('base64')}` })
          extractedFrames += 1
        }
        if (extractedFrames === 0) {
          gaps.push(`${source.name} 未能抽取画面证据。`)
        } else if (extractedFrames < frameTimes.length) {
          gaps.push(`${source.name} 仅抽取到 ${extractedFrames}/${frameTimes.length} 个画面采样点。`)
        }

        if (!source.has_audio) continue
        const audioPath = join(directory, `${source.id}.mp3`)
        const audioDurationMs = Math.min(source.duration_ms, 10 * 60_000)
        const audio = await this.runProcess([
          this.binary('ffmpeg'), '-hide_banner', '-loglevel', 'error', '-i', source.path,
          '-t', (audioDurationMs / 1000).toFixed(3), '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k',
          '-y', audioPath,
        ], { signal }).catch(() => null)
        const audioBytes = audio?.exitCode === 0 ? await readFile(audioPath).catch(() => null) : null
        if (!audioBytes?.length) {
          gaps.push(`${source.name} 未能抽取音频证据。`)
          continue
        }
        try {
          const transcript = await transcribeVoiceFile(
            new File([audioBytes], `${source.id}.mp3`, { type: 'audio/mpeg' }),
            {
              env: this.env,
              fetchImpl: this.fetchImpl,
              signal,
              providerProtocol: PROVIDER_GATEWAY_PROTOCOL.headerValue,
              operationId: `${operationId}-speech-${source.id}`,
            },
          )
          if (transcript.text.trim()) {
            transcripts.push({
              id: id('evidence'),
              kind: 'transcript',
              source_id: source.id,
              source_fingerprint: source.fingerprint!,
              in_ms: 0,
              out_ms: Math.max(1, audioDurationMs),
              text: transcript.text.trim(),
              confidence: 0.8,
              warnings: audioDurationMs < source.duration_ms ? ['仅转写素材前十分钟。'] : [],
              created_at: this.iso(),
            })
          }
        } catch (error) {
          if (signal.aborted) throw error
          gaps.push(`${source.name} 未能获得语音转写。`)
        }
      }
      return { frames, transcripts, gaps }
    } finally {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined)
    }
  }

  private materializeVideoEvidence(
    project: VideoStudioProject,
    drafts: Awaited<ReturnType<typeof analyzeVideoEvidence>>['evidence'],
  ): VideoEvidence[] {
    const sources = new Map(project.sources.map(source => [source.id, source]))
    return drafts.map(draft => {
      const source = sources.get(draft.source_id)
      if (!source?.fingerprint) throw new MediaServiceError('分析引用了不存在的素材', 502, 'VIDEO_ANALYSIS_FAILED')
      if (draft.out_ms > source.duration_ms) throw new MediaServiceError('分析引用了素材范围外的时间', 502, 'VIDEO_ANALYSIS_FAILED')
      return {
        id: id('evidence'),
        ...draft,
        source_fingerprint: source.fingerprint,
        created_at: this.iso(),
      }
    })
  }

  private materializeVideoScenes(
    project: VideoStudioProject,
    drafts: VideoPlanDraft['scenes'],
    evidence: VideoEvidence[],
  ): VideoScene[] {
    const sources = new Map(project.sources.map(source => [source.id, source]))
    const evidenceById = new Map(evidence.map(item => [item.id, item]))
    return drafts.map(draft => {
      const source = sources.get(draft.source_id)
      if (!source || draft.out_ms > source.duration_ms) {
        throw new MediaServiceError('视频方案引用了不存在的素材时间', 502, 'VIDEO_ANALYSIS_FAILED')
      }
      for (const evidenceId of draft.evidence_ids) {
        const item = evidenceById.get(evidenceId)
        if (
          !item
          || item.source_id !== draft.source_id
          || item.out_ms <= draft.in_ms
          || item.in_ms >= draft.out_ms
        ) throw new MediaServiceError('视频方案包含无效证据引用', 502, 'VIDEO_ANALYSIS_FAILED')
      }
      return { id: id('scene'), ...draft, locked: false }
    })
  }

  private preserveLockedVideoScenes(current: VideoScene[], proposed: VideoScene[]): VideoScene[] {
    const locked = current.filter(scene => scene.locked)
    const overlapsLocked = (scene: VideoScene) => locked.some(candidate => (
      candidate.source_id === scene.source_id
      && candidate.in_ms < scene.out_ms
      && candidate.out_ms > scene.in_ms
    ))
    const available = proposed.filter(scene => !overlapsLocked(scene))
    const result: VideoScene[] = []
    let cursor = 0
    for (const scene of current) {
      if (scene.locked) result.push(scene)
      else if (available[cursor]) result.push(available[cursor++]!)
    }
    result.push(...available.slice(cursor))
    return result
  }

  async analyzeVideoProject(projectId: string, raw: AnalyzeVideoProjectInput): Promise<MediaTask> {
    const input = analyzeVideoProjectInputSchema.parse(raw)
    const launch = await this.withVideoProjectMutation(projectId, async () => {
      let project = await this.getProject(projectId)
      if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
      if (project.revision !== input.base_revision) throw new MediaServiceError('视频项目已更新，请刷新后再分析', 409, 'REVISION_CONFLICT')
      if (!project.sources.length) throw new MediaServiceError('请先导入视频素材', 409, 'SOURCE_NOT_FOUND')
      if (project.state === 'rendering') throw new MediaServiceError('正在导出，暂时不能分析', 409, 'RENDER_IN_PROGRESS')
      const active = project.task_id ? await this.getTask(project.task_id, false).catch(() => null) : null
      if (active && ['queued', 'running', 'committing'].includes(active.status)) {
        throw new MediaServiceError('当前已有媒体任务在运行', 409, 'TASK_IN_PROGRESS')
      }
      project = await this.prepareVideoProjectSources(project)
      const now = this.iso()
      const operationId = foundationId('op', project.id, 'video.analyze', String(project.revision), input.user_goal)
      const task = await this.saveTask({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        operation_id: operationId,
        kind: 'video.analyze',
        status: 'running',
        progress: 5,
        stage: '正在提取素材证据',
        result: {
          base_revision: project.revision,
          base_timeline_version_id: project.current_timeline_version_id,
        },
        created_at: now,
        updated_at: now,
      })
      await this.saveProject({ ...project, task_id: task.id, updated_at: this.iso() })
      return { project, task, userGoal: input.user_goal }
    })
    const controller = new AbortController()
    const active: ActiveVideoAnalysis = {
      controller,
      completion: Promise.resolve(),
    }
    active.completion = Promise.resolve().then(() => this.runVideoAnalysis(
      launch.project,
      launch.task,
      launch.userGoal,
      controller.signal,
      active,
    ))
    this.activeVideoAnalyses.set(launch.task.id, active)
    return launch.task
  }

  private async runVideoAnalysis(
    baseProject: VideoStudioProject,
    analyzeTask: MediaTask,
    userGoal: string,
    signal: AbortSignal,
    active: ActiveVideoAnalysis,
  ): Promise<void> {
    let activeTask = analyzeTask
    try {
      const extracted = await this.extractVideoAnalysisInputs(baseProject, analyzeTask.operation_id!, signal)
      await this.saveTask({ ...analyzeTask, progress: 45, stage: '正在分析画面与语音证据', updated_at: this.iso() })
      const retainedEvidenceIds = new Set(
        baseProject.timeline_versions
          .find(version => version.id === baseProject.current_timeline_version_id)
          ?.scenes.filter(scene => scene.locked).flatMap(scene => scene.evidence_ids) ?? [],
      )
      const retained = baseProject.evidence.filter(item => item.kind === 'source_role' || retainedEvidenceIds.has(item.id))
      const draft = await analyzeVideoEvidence({
        sources: baseProject.sources,
        existingEvidence: retained,
        transcriptEvidence: extracted.transcripts,
        frames: extracted.frames,
        userGoal,
        extractionGaps: extracted.gaps,
      }, {
        operationId: `${analyzeTask.operation_id}-evidence`,
        signal,
        fetchImpl: this.fetchImpl,
        env: this.env,
      })
      const generated = this.materializeVideoEvidence(baseProject, draft.evidence)
      const next = await this.withVideoProjectMutation(baseProject.id, async () => {
        const latest = await this.getProject(baseProject.id)
        if (
          latest.kind !== 'video'
          || latest.revision !== baseProject.revision
          || latest.current_timeline_version_id !== baseProject.current_timeline_version_id
          || JSON.stringify(latest.sources.map(source => source.fingerprint)) !== JSON.stringify(baseProject.sources.map(source => source.fingerprint))
        ) throw new MediaServiceError('视频项目已更新，本次分析结果未写入', 409, 'VIDEO_ANALYSIS_STALE')
        const evidence = [...retained, ...extracted.transcripts, ...generated]
        const evidenceRevision = videoEvidenceRevision(evidence)
        const evidenceProject = await this.saveProject({
          ...latest,
          evidence,
          evidence_revision: evidenceRevision,
          revision: latest.revision + 1,
          updated_at: this.iso(),
        }) as VideoStudioProject
        const now = this.iso()
        const planTask = await this.saveTask({
          schema_version: 1,
          id: id('task'),
          project_id: latest.id,
          operation_id: foundationId('op', latest.id, 'video.plan', evidenceRevision, userGoal),
          kind: 'video.plan',
          status: 'running',
          progress: 60,
          stage: '正在编译剪辑方案',
          result: {
            base_revision: evidenceProject.revision,
            base_timeline_version_id: evidenceProject.current_timeline_version_id,
            evidence_revision: evidenceRevision,
          },
          created_at: now,
          updated_at: now,
        })
        this.activeVideoAnalyses.set(planTask.id, active)
        await this.saveProject({ ...evidenceProject, task_id: planTask.id, updated_at: this.iso() })
        await this.saveTask({
          ...analyzeTask,
          status: 'succeeded',
          progress: 100,
          stage: '证据分析完成',
          result: {
            evidence_revision: evidenceRevision,
            evidence_count: evidence.length,
            next_task_id: planTask.id,
          },
          updated_at: this.iso(),
        })
        return { project: evidenceProject, planTask, evidence, gaps: [...extracted.gaps, ...draft.gaps] }
      })
      this.activeVideoAnalyses.delete(analyzeTask.id)
      activeTask = next.planTask
      const currentScenes = next.project.timeline_versions
        .find(version => version.id === next.project.current_timeline_version_id)?.scenes ?? []
      const plan = await planVideoTimeline({
        sources: next.project.sources,
        evidence: next.evidence,
        currentScenes,
        userGoal,
        analysisGaps: next.gaps,
      }, {
        operationId: `${next.planTask.operation_id}-timeline`,
        signal,
        fetchImpl: this.fetchImpl,
        env: this.env,
      })
      await this.withVideoProjectMutation(baseProject.id, async () => {
        const latest = await this.getProject(baseProject.id)
        if (
          latest.kind !== 'video'
          || latest.revision !== next.project.revision
          || latest.evidence_revision !== next.project.evidence_revision
          || latest.current_timeline_version_id !== next.project.current_timeline_version_id
        ) throw new MediaServiceError('视频项目已更新，本次剪辑方案未写入', 409, 'VIDEO_ANALYSIS_STALE')
        const proposed = this.materializeVideoScenes(latest, plan.scenes, next.evidence)
        const scenes = this.preserveLockedVideoScenes(currentScenes, proposed)
        const timelineVersion = this.timelineVersion(latest, scenes, latest.evidence_revision)
        const alternatives: VideoAlternative[] = plan.alternatives.map(alternative => ({
          id: id('alternative'),
          base_timeline_version_id: timelineVersion.id,
          label: alternative.label,
          tradeoff: alternative.tradeoff,
          scenes: this.preserveLockedVideoScenes(
            currentScenes,
            this.materializeVideoScenes(latest, alternative.scenes, next.evidence),
          ),
        }))
        const briefDraft = {
          ...plan.brief,
          gaps: [...new Set([...plan.brief.gaps, ...next.gaps])].slice(0, 20),
        }
        const completed = await this.saveProject({
          ...latest,
          brief: compileVideoBrief(userGoal, briefDraft),
          timeline: scenes.map(scene => ({ id: scene.id, source_id: scene.source_id, in_ms: scene.in_ms, out_ms: scene.out_ms })),
          timeline_versions: [...latest.timeline_versions, timelineVersion],
          current_timeline_version_id: timelineVersion.id,
          alternatives,
          state: 'ready',
          revision: latest.revision + 1,
          updated_at: this.iso(),
        }) as VideoStudioProject
        await this.saveTask({
          ...next.planTask,
          status: 'succeeded',
          progress: 100,
          stage: '剪辑方案已生成',
          result: {
            timeline_version_id: timelineVersion.id,
            project_revision: completed.revision,
            alternative_count: alternatives.length,
          },
          updated_at: this.iso(),
        })
      })
    } catch (error) {
      const cancelled = signal.aborted || (error instanceof VideoAnalysisError && error.code === 'VIDEO_ANALYSIS_CANCELLED')
      const stale = error instanceof MediaServiceError && error.code === 'VIDEO_ANALYSIS_STALE'
      if (!cancelled && !stale) recordMediaFailure('video_analysis', error)
      const failure = mediaSafeError(cancelled
        ? 'MEDIA_VIDEO_ANALYSIS_CANCELLED'
        : stale
          ? 'MEDIA_STATE_CONFLICT'
          : 'MEDIA_VIDEO_ANALYSIS_UNAVAILABLE')
      await this.saveTask({
        ...activeTask,
        status: cancelled ? 'cancelled' : 'failed',
        progress: 0,
        stage: cancelled ? '已取消' : stale ? '方案已过期' : '视频分析失败',
        error: failure.message,
        error_code: failure.code,
        updated_at: this.iso(),
      }).catch(() => undefined)
    } finally {
      this.activeVideoAnalyses.delete(analyzeTask.id)
      this.activeVideoAnalyses.delete(activeTask.id)
    }
  }

  async previewVideo(projectId: string, raw: PreviewVideoInput): Promise<MediaTask> {
    return await this.withVideoProjectMutation(projectId, async () => {
      const input = previewVideoInputSchema.parse(raw)
      let project = await this.getProject(projectId)
      if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
      if (project.state === 'rendering') throw new MediaServiceError('正在导出，暂时不能生成预览', 409, 'RENDER_IN_PROGRESS')
      if (project.revision !== input.base_revision) throw new MediaServiceError('视频项目已更新，请刷新后再生成预览', 409, 'REVISION_CONFLICT')
      if (project.current_timeline_version_id !== input.timeline_version_id) {
        throw new MediaServiceError('视频时间线已更新，请刷新后再生成预览', 409, 'TIMELINE_VERSION_CONFLICT')
      }
      if (!project.timeline_versions.some(version => version.id === input.timeline_version_id)) {
        throw new MediaServiceError('视频时间线版本不存在', 409, 'TIMELINE_VERSION_MISSING')
      }
      if (!project.timeline.length) throw new MediaServiceError('时间线还是空的', 409, 'EMPTY_TIMELINE')
      project = await this.prepareVideoProjectSources(project)
      if (project.preview_task_id) {
        const existing = await this.getTask(project.preview_task_id, false).catch(() => null)
        const existingResult = videoPreviewTaskResultSchema.safeParse(existing?.result)
        if (
          existing?.kind === 'video.preview'
          && ['queued', 'running', 'committing'].includes(existing.status)
          && existingResult.success
          && existingResult.data.timeline_version_id === input.timeline_version_id
        ) return existing
        if (existing && ['queued', 'running', 'committing'].includes(existing.status)) {
          throw new MediaServiceError('已有视频预览正在生成，请先取消', 409, 'VIDEO_PREVIEW_BUSY')
        }
      }
      const status = await this.toolchainStatus()
      if (!status.ffmpeg.available || !status.ffprobe.available) {
        throw new MediaServiceError(
          mediaSafeError('MEDIA_VIDEO_TOOLCHAIN_UNAVAILABLE').message,
          503,
          'VIDEO_TOOLCHAIN_UNAVAILABLE',
        )
      }

      const assetId = id('preview')
      const assetFileName = `${assetId}.mp4`
      const outputPath = join(this.assetsDir, project.id, assetFileName)
      const assetPath = `/api/media/assets/${project.id}/${assetFileName}`
      const now = this.iso()
      const task = await this.saveTask({
        schema_version: 1,
        id: id('task'),
        project_id: project.id,
        kind: 'video.preview',
        status: 'queued',
        progress: 0,
        stage: '等待生成预览',
        result: {
          preview_revision: project.revision,
          timeline_version_id: input.timeline_version_id,
          asset_id: assetId,
          asset_path: assetPath,
        },
        created_at: now,
        updated_at: now,
      })
      await this.saveProject({
        ...project,
        preview_task_id: task.id,
        updated_at: this.iso(),
      })
      const controller = new AbortController()
      const completion = Promise.resolve().then(() => this.runVideoPreview(
        project,
        task,
        outputPath,
        controller.signal,
      ))
      this.activeVideoPreviews.set(task.id, { controller, completion, outputPath })
      return task
    })
  }

  private previewProject(project: VideoStudioProject): VideoStudioProject {
    const scale = Math.min(1, 960 / Math.max(project.output.width, project.output.height))
    const even = (value: number) => Math.max(2, Math.round(value / 2) * 2)
    return {
      ...project,
      output: {
        width: even(project.output.width * scale),
        height: even(project.output.height * scale),
        fps: Math.min(24, project.output.fps),
      },
    }
  }

  private async runVideoPreview(
    project: VideoStudioProject,
    task: MediaTask,
    outputPath: string,
    signal: AbortSignal,
  ): Promise<void> {
    const temporaryOutput = `${outputPath}.partial-${task.id}.mp4`
    try {
      await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 })
      await this.saveTask({
        ...task,
        status: 'running',
        progress: 10,
        stage: '正在生成预览',
        result: { ...(task.result ?? {}), temporary_output: temporaryOutput },
        updated_at: this.iso(),
      })
      const result = await this.runProcess(
        buildVideoRenderCommand(
          this.binary('ffmpeg'),
          this.previewProject(project),
          temporaryOutput,
          { name: 'mpeg4', args: ['-q:v', '5'] },
        ),
        { signal },
      )
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `ffmpeg exited ${result.exitCode}`)
      if (signal.aborted) throw new Error('预览已取消')
      await this.prepareVideoProjectSources(project)
      await this.saveTask({
        ...task,
        status: 'running',
        progress: 90,
        stage: '正在校验预览',
        result: { ...(task.result ?? {}), temporary_output: temporaryOutput },
        updated_at: this.iso(),
      })
      const validated = await this.validateVideoOutput(temporaryOutput)
      await this.saveTask({
        ...task,
        status: 'committing',
        progress: 95,
        stage: '正在发布预览',
        result: {
          ...(task.result ?? {}),
          temporary_output: temporaryOutput,
          content_hash: validated.contentHash,
        },
        updated_at: this.iso(),
      })
      if (signal.aborted) throw new Error('预览已取消')
      const parsedResult = videoPreviewTaskResultSchema.parse({
        ...(task.result ?? {}),
        temporary_output: temporaryOutput,
        content_hash: validated.contentHash,
      })
      await this.withVideoProjectMutation(project.id, async () => {
        const latest = await this.getProject(project.id)
        if (
          latest.kind !== 'video'
          || latest.revision !== parsedResult.preview_revision
          || latest.current_timeline_version_id !== parsedResult.timeline_version_id
          || latest.preview_task_id !== task.id
        ) throw new MediaServiceError('视频时间线已更新，本次预览不再发布', 409, 'VIDEO_PREVIEW_STALE')
        await this.moveFile(temporaryOutput, outputPath)
        const preview = {
          timeline_version_id: parsedResult.timeline_version_id,
          asset_id: parsedResult.asset_id,
          asset_path: parsedResult.asset_path,
          content_hash: validated.contentHash,
          created_at: this.iso(),
        }
        const asset: MediaAsset = {
          id: parsedResult.asset_id,
          role: 'preview',
          version_id: parsedResult.timeline_version_id,
          storage: { kind: 'managed', locator: join(project.id, basename(outputPath)) },
          mime_type: 'video/mp4',
          byte_size: validated.byteSize,
          content_hash: validated.contentHash,
          created_at: preview.created_at,
        }
        await this.saveProject({
          ...latest,
          assets: [...latest.assets.filter(candidate => candidate.role !== 'preview'), asset],
          preview,
          updated_at: this.iso(),
        })
        if (latest.preview && latest.preview.asset_id !== preview.asset_id) {
          await rm(join(this.assetsDir, project.id, basename(latest.preview.asset_path)), { force: true })
            .catch(() => undefined)
        }
      })
      await this.saveTask({
        ...task,
        status: 'succeeded',
        progress: 100,
        stage: '预览已就绪',
        result: {
          ...(task.result ?? {}),
          content_hash: validated.contentHash,
          temporary_output: undefined,
        },
        updated_at: this.iso(),
      })
    } catch (error) {
      const cancelled = signal.aborted
      const stale = error instanceof MediaServiceError && error.code === 'VIDEO_PREVIEW_STALE'
      if (!cancelled && !stale) recordMediaFailure('video_preview', error)
      const failure = mediaSafeError(cancelled
        ? 'MEDIA_VIDEO_PREVIEW_CANCELLED'
        : stale
          ? 'MEDIA_STATE_CONFLICT'
          : 'MEDIA_VIDEO_PREVIEW_FAILED')
      await this.saveTask({
        ...task,
        status: cancelled || stale ? 'cancelled' : 'failed',
        progress: 0,
        stage: cancelled ? '已取消' : stale ? '预览已过期' : '预览生成失败',
        error: failure.message,
        error_code: failure.code,
        updated_at: this.iso(),
      }).catch(() => undefined)
    } finally {
      await rm(temporaryOutput, { force: true }).catch(() => undefined)
      this.activeVideoPreviews.delete(task.id)
    }
  }

  async renderVideo(projectId: string, raw: RenderVideoInput): Promise<MediaTask> {
    return await this.withVideoRenderAdmission(() => (
      this.withVideoProjectMutation(projectId, () => this.renderVideoSerial(projectId, raw))
    ))
  }

  private async renderVideoSerial(projectId: string, raw: RenderVideoInput): Promise<MediaTask> {
    this.startNextQueuedVideoRender()
    const input = renderVideoInputSchema.parse(raw)
    let project = await this.getProject(projectId)
    if (project.kind !== 'video') throw new MediaServiceError('这不是视频项目', 409, 'WRONG_PROJECT_KIND')
    if (project.state === 'rendering') {
      const existing = project.task_id ? await this.getTask(project.task_id, false).catch(() => null) : null
      if (existing && ['queued', 'running', 'committing'].includes(existing.status)) return existing
      throw new MediaServiceError('导出状态异常，请刷新后重试', 409, 'RENDER_STATE_CONFLICT')
    }
    if (project.preview_task_id) {
      const previewTask = await this.getTask(project.preview_task_id, false).catch(() => null)
      if (previewTask?.kind === 'video.preview' && ['queued', 'running', 'committing'].includes(previewTask.status)) {
        throw new MediaServiceError('请先等待视频预览完成或取消预览', 409, 'VIDEO_PREVIEW_BUSY')
      }
    }
    if (project.revision !== input.base_revision) throw new MediaServiceError('视频项目已更新，请刷新后再导出', 409, 'REVISION_CONFLICT')
    const timelineVersionId = input.timeline_version_id ?? project.current_timeline_version_id
    if (project.current_timeline_version_id !== timelineVersionId) {
      throw new MediaServiceError('视频时间线已更新，请刷新后再导出', 409, 'TIMELINE_VERSION_CONFLICT')
    }
    if (!timelineVersionId || !project.timeline_versions.some(version => version.id === timelineVersionId)) {
      throw new MediaServiceError('视频时间线版本不存在', 409, 'TIMELINE_VERSION_MISSING')
    }
    if (!project.timeline.length) throw new MediaServiceError('时间线还是空的', 409, 'EMPTY_TIMELINE')
    project = await this.prepareVideoProjectSources(project)
    if (!isAbsolute(input.output_path)) throw new MediaServiceError('导出路径必须是绝对路径', 400, 'OUTPUT_PATH_NOT_ABSOLUTE')
    if (!['.mp4', '.mov'].includes(extname(input.output_path).toLowerCase())) {
      throw new MediaServiceError('视频只能导出为 MP4 或 MOV', 400, 'OUTPUT_FORMAT_UNSUPPORTED')
    }
    if (await this.outputMatchesSource(input.output_path, project.sources)) {
      throw new MediaServiceError('导出位置不能覆盖原始视频素材', 409, 'OUTPUT_OVERWRITES_SOURCE')
    }
    if (await this.outputReservedByVideoRender(input.output_path)) {
      throw new MediaServiceError('另一个视频任务已占用这个导出位置，请选择其他文件', 409, 'VIDEO_OUTPUT_PATH_BUSY')
    }
    if (this.activeRenders.size + this.queuedVideoRenders.length >= 1 + this.maxQueuedVideoRenders) {
      throw new MediaServiceError('本机视频导出队列已满，请等待当前任务完成或取消后再试', 409, 'VIDEO_RENDER_BUSY')
    }
    const status = await this.toolchainStatus()
    if (!status.ffmpeg.available || !status.ffprobe.available) {
      throw new MediaServiceError(
        mediaSafeError('MEDIA_VIDEO_TOOLCHAIN_UNAVAILABLE').message,
        503,
        'VIDEO_TOOLCHAIN_UNAVAILABLE',
      )
    }

    const now = this.iso()
    const task = await this.saveTask({
      schema_version: 1,
      id: id('task'),
      project_id: project.id,
      kind: 'video.render',
      status: 'queued',
      progress: 0,
      stage: this.activeRenders.size > 0 ? '正在排队等待本机视频导出' : '等待导出',
      result: {
        render_revision: project.revision,
        timeline_version_id: timelineVersionId,
        output_path: input.output_path,
      },
      created_at: now,
      updated_at: now,
    })
    await this.saveProject({
      ...project,
      state: 'rendering',
      task_id: task.id,
      output_path: input.output_path,
      output_asset_id: undefined,
      output_content_hash: undefined,
      output_verification: undefined,
      error: undefined,
      error_code: undefined,
      updated_at: this.iso(),
    })
    const render: QueuedVideoRender = { project, task, outputPath: input.output_path }
    if (this.activeRenders.size > 0) {
      this.queuedVideoRenders.push(render)
    } else {
      this.startVideoRender(render)
    }
    return task
  }

  private startVideoRender(render: QueuedVideoRender): void {
    const controller = new AbortController()
    const completion = Promise.resolve().then(() => (
      this.runVideoRender(render.project, render.task, render.outputPath, controller.signal)
    ))
    this.activeRenders.set(render.task.id, { controller, completion, outputPath: render.outputPath })
  }

  private startNextQueuedVideoRender(): void {
    if (this.activeRenders.size > 0) return
    const next = this.queuedVideoRenders.shift()
    if (next) this.startVideoRender(next)
  }

  private removeQueuedVideoRender(taskId: string): boolean {
    const index = this.queuedVideoRenders.findIndex(render => render.task.id === taskId)
    if (index < 0) return false
    this.queuedVideoRenders.splice(index, 1)
    return true
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
      let encoder = await this.videoEncoderProfile()
      if (signal.aborted) throw new Error('导出已取消')
      let result = await this.runProcess(
        buildVideoRenderCommand(this.binary('ffmpeg'), project, temporaryOutput, encoder),
        { signal },
      )
      // Encoder discovery only proves that a binary advertises a hardware codec. On
      // real macOS/Windows machines the hardware session can still be busy or absent.
      // For an automatic hardware choice, retry the same atomic temporary export once
      // with the portable software encoder and remember it for this sidecar. An explicit
      // BB_FFMPEG_VIDEO_ENCODER remains a deliberate operator choice and is not changed.
      if (
        result.exitCode !== 0
        && !signal.aborted
        && !this.env.BB_FFMPEG_VIDEO_ENCODER?.trim()
        && encoder.name !== FALLBACK_VIDEO_ENCODER.name
      ) {
        await rm(temporaryOutput, { force: true }).catch(() => undefined)
        encoder = FALLBACK_VIDEO_ENCODER
        this.encoderProfilePromise = Promise.resolve(FALLBACK_VIDEO_ENCODER)
        result = await this.runProcess(
          buildVideoRenderCommand(this.binary('ffmpeg'), project, temporaryOutput, encoder),
          { signal },
        )
      }
      if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `ffmpeg exited ${result.exitCode}`)
      if (signal.aborted) throw new Error('导出已取消')
      await this.prepareVideoProjectSources(project)
      await this.saveTask({
        ...task,
        status: 'running',
        progress: 90,
        stage: '正在校验导出',
        result: {
          ...(task.result ?? {}),
          temporary_output: temporaryOutput,
        },
        updated_at: this.iso(),
      })
      const timelineVersionId = project.current_timeline_version_id!
      const inspection = await this.validateVideoOutput(temporaryOutput)
      const validated: VideoOutputVerification = {
        timeline_version_id: timelineVersionId,
        byte_size: inspection.byteSize,
        file_mtime_ms: inspection.modifiedAtMs,
        duration_ms: inspection.durationMs,
        video_stream_count: inspection.videoStreamCount,
        audio_stream_count: inspection.audioStreamCount,
        ...(inspection.width ? { width: inspection.width } : {}),
        ...(inspection.height ? { height: inspection.height } : {}),
        ...(inspection.fps ? { fps: inspection.fps } : {}),
        content_hash: inspection.contentHash,
        verified_at: this.iso(),
      }
      const outputAssetId = id('out')
      await this.saveTask({
        ...task,
        status: 'committing',
        progress: 95,
        stage: '正在完成导出',
        result: {
          ...(task.result ?? {}),
          temporary_output: temporaryOutput,
          output_asset_id: outputAssetId,
          output_content_hash: validated.content_hash,
          output_verification: validated,
        },
        updated_at: this.iso(),
      })
      if (signal.aborted) throw new Error('导出已取消')
      await this.moveFile(temporaryOutput, outputPath)
      const latest = await this.getProject(project.id)
      if (
        latest.kind !== 'video'
        || latest.revision !== project.revision
        || latest.current_timeline_version_id !== timelineVersionId
        || latest.task_id !== task.id
      ) throw new MediaServiceError('视频项目已更新，本次导出结果不再发布', 409, 'VIDEO_RENDER_STALE')
      await this.saveProject({
        ...latest,
        state: 'complete',
        output_path: outputPath,
        output_asset_id: outputAssetId,
        output_content_hash: validated.content_hash,
        output_verification: validated,
        error: undefined,
        error_code: undefined,
        updated_at: this.iso(),
      })
      await this.saveTask({
        ...task,
        status: 'succeeded',
        progress: 100,
        stage: '导出完成',
        result: {
          ...(task.result ?? {}),
          output_path: outputPath,
          temporary_output: undefined,
          output_asset_id: outputAssetId,
          output_content_hash: validated.content_hash,
          output_verification: validated,
          video_encoder: encoder.name,
        },
        updated_at: this.iso(),
      })
    } catch (error) {
      const cancelled = signal.aborted
      const stale = error instanceof MediaServiceError && error.code === 'VIDEO_RENDER_STALE'
      if (!cancelled && !stale) recordMediaFailure('video_render', error)
      const failure = mediaSafeError(cancelled
        ? 'MEDIA_VIDEO_EXPORT_CANCELLED'
        : stale
          ? 'MEDIA_STATE_CONFLICT'
        : error instanceof MediaServiceError && error.code === 'VIDEO_ENCODER_UNAVAILABLE'
          ? 'MEDIA_VIDEO_TOOLCHAIN_UNAVAILABLE'
          : 'MEDIA_VIDEO_EXPORT_FAILED')
      await this.saveTask({
        ...task,
        status: cancelled || stale ? 'cancelled' : 'failed',
        progress: 0,
        stage: cancelled ? '已取消' : stale ? '导出结果已过期' : '导出失败',
        error: failure.message,
        error_code: failure.code,
        updated_at: this.iso(),
      })
      const latest = await this.getProject(project.id).catch(() => null)
      if (latest?.kind === 'video' && latest.task_id === task.id) {
        await this.saveProject({
          ...latest,
          state: cancelled || stale ? 'ready' : 'failed',
          error: failure.message,
          error_code: failure.code,
          updated_at: this.iso(),
        })
      }
    } finally {
      await rm(temporaryOutput, { force: true }).catch(() => undefined)
      this.activeRenders.delete(task.id)
      this.startNextQueuedVideoRender()
    }
  }

  async cancelTask(taskId: string): Promise<MediaTask> {
    const task = await this.getTask(taskId, false)
    if (task.kind === 'image.generate') {
      return await this.cancelQueuedImageTask(task)
    }
    if ((task.kind === 'video.analyze' || task.kind === 'video.plan') && task.status === 'running') {
      const active = this.activeVideoAnalyses.get(task.id)
      if (!active) throw new MediaServiceError('当前任务不能取消', 409, 'TASK_NOT_CANCELLABLE')
      active.controller.abort(new Error('video analysis cancelled'))
      await active.completion
      return await this.getTask(task.id, false)
    }
    if (task.kind === 'video.preview' && ['queued', 'running', 'committing'].includes(task.status)) {
      const active = this.activeVideoPreviews.get(task.id)
      if (!active) throw new MediaServiceError('当前任务不能取消', 409, 'TASK_NOT_CANCELLABLE')
      active.controller.abort(new Error('video preview cancelled'))
      await active.completion
      return await this.getTask(task.id, false)
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
    const removedFromQueue = this.removeQueuedVideoRender(taskId)
    // Re-reading a just-removed queued task would correctly look like an
    // interrupted task to crash recovery. The first read above is authoritative
    // while this synchronous queue removal holds it out of the scheduler.
    const latestTask = removedFromQueue ? task : await this.getTask(taskId, false)
    if (!['queued', 'running'].includes(latestTask.status)) {
      throw new MediaServiceError('当前任务不能取消', 409, 'TASK_NOT_CANCELLABLE')
    }
    const next = await this.saveTask({
      ...latestTask,
      status: 'cancelled',
      stage: '已取消',
      error: mediaSafeError('MEDIA_VIDEO_EXPORT_CANCELLED').message,
      error_code: 'MEDIA_VIDEO_EXPORT_CANCELLED',
      updated_at: this.iso(),
    })
    const project = await this.getProject(latestTask.project_id).catch(() => null)
    if (project?.kind === 'video' && project.task_id === latestTask.id) {
      await this.saveProject({
        ...project,
        state: 'ready',
        error: mediaSafeError('MEDIA_VIDEO_EXPORT_CANCELLED').message,
        error_code: 'MEDIA_VIDEO_EXPORT_CANCELLED',
        updated_at: this.iso(),
      })
    }
    return next
  }

  private async cancelQueuedImageTask(task: MediaTask): Promise<MediaTask> {
    if (task.status !== 'queued' || !task.remote_task_id) {
      throw new MediaServiceError('生图任务已经开始或提交结果尚未确认，不能安全取消', 409, 'TASK_NOT_CANCELLABLE')
    }
    if (!productGatewayConfigured()) {
      throw new MediaServiceError(mediaSafeError('MEDIA_IMAGE_CANCEL_UNKNOWN').message, 503, 'GATEWAY_NOT_CONFIGURED')
    }
    const gateway = productGatewayTarget()
    if (!gateway) throw new MediaServiceError(mediaSafeError('MEDIA_IMAGE_CANCEL_UNKNOWN').message, 503, 'GATEWAY_NOT_CONFIGURED')
    const headers: Record<string, string> = {
      Authorization: `Bearer ${gateway.token}`,
      [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    }
    let response: Response
    try {
      response = await this.fetchImpl(
        `${gateway.baseUrl}/v1/images/tasks/${encodeURIComponent(task.remote_task_id)}/cancel`,
        { method: 'POST', headers },
      )
    } catch (error) {
      recordMediaFailure('image_cancel', error)
      throw new MediaServiceError(
        mediaSafeError('MEDIA_IMAGE_CANCEL_UNKNOWN').message,
        502,
        'IMAGE_CANCEL_UNKNOWN',
      )
    }
    const body = await response.json().catch(() => ({})) as RelayImageTask & { message?: string }
    if (!response.ok || body.status !== 'cancelled') {
      recordMediaFailure('image_cancel', { status: response.status, body })
      throw new MediaServiceError(
        mediaSafeError('MEDIA_IMAGE_CANCEL_UNKNOWN').message,
        response.status || 409,
        'IMAGE_CANCEL_UNKNOWN',
      )
    }
    return await this.markImageTaskCancelled(task)
  }

  private async moveIfPresent(source: string, destination: string): Promise<void> {
    if (await stat(destination).then(() => true).catch(() => false)) return
    if (!(await stat(source).then(() => true).catch(() => false))) return
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    await rename(source, destination)
  }

  private async managedStorageUsage(path: string): Promise<{ count: number; bytes: number }> {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => [])
    let count = 0
    let bytes = 0
    for (const entry of entries) {
      const candidate = join(path, entry.name)
      if (entry.isDirectory()) {
        const nested = await this.managedStorageUsage(candidate)
        count += nested.count
        bytes += nested.bytes
      } else if (entry.isFile()) {
        const info = await stat(candidate)
        count += 1
        bytes += info.size
      }
    }
    return { count, bytes }
  }

  private async readDeletionReceipts(): Promise<MediaDeletionReceipt[]> {
    await this.ensureDirs()
    const names = await readdir(this.deletionsDir)
    const receipts = await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
      try {
        const filePath = join(this.deletionsDir, name)
        const raw = JSON.parse(await readFile(filePath, 'utf8')) as unknown
        const migrated = migrateLegacyMediaOwnerRecord(raw)
        const receipt = mediaDeletionReceiptSchema.parse(migrated.value)
        if (migrated.migrated) await this.writeJson(filePath, receipt)
        return receipt
      } catch (error) {
        recordMediaFailure('read_deletion_receipt', error)
        return null
      }
    }))
    return receipts.filter((receipt): receipt is MediaDeletionReceipt => receipt !== null)
  }

  private async latestDeletion(
    projectId: string,
    statuses: MediaDeletionReceipt['status'][],
  ): Promise<MediaDeletionReceipt | null> {
    return (await this.readDeletionReceipts())
      .filter(receipt => receipt.project_id === projectId && statuses.includes(receipt.status))
      .sort((left, right) => right.deleted_at.localeCompare(left.deleted_at))[0] ?? null
  }

  private async resumeDeletion(receipt: MediaDeletionReceipt): Promise<MediaDeletionReceipt> {
    const trash = this.trashPath(receipt.trash_key)
    await mkdir(join(trash, 'tasks'), { recursive: true, mode: 0o700 })
    // The project disappears first. A crash can leave a pending receipt, but
    // never an apparently-live project whose managed assets were already moved.
    await this.moveIfPresent(this.projectPath(receipt.project_id), join(trash, 'project.json'))
    for (const taskId of receipt.task_ids) {
      await this.moveIfPresent(this.taskPath(taskId), join(trash, 'tasks', `${taskId}.json`))
    }
    await this.moveIfPresent(this.eventJournalPath(receipt.project_id), join(trash, 'events.json'))
    await this.moveIfPresent(join(this.assetsDir, receipt.project_id), join(trash, 'assets'))
    const deleted = mediaDeletionReceiptSchema.parse({ ...receipt, status: 'deleted' })
    await this.writeJson(this.deletionPath(deleted.deletion_id), deleted)
    return deleted
  }

  async listDeletionsForOwner(owner: MediaOwner): Promise<MediaDeletionReceipt[]> {
    return (await this.readDeletionReceipts())
      .filter(receipt => sameOwner(receipt.owner, owner) && receipt.status !== 'purged')
      .sort((left, right) => right.deleted_at.localeCompare(left.deleted_at))
  }

  async deleteProject(projectId: string): Promise<MediaDeletionReceipt> {
    await this.ensureDirs()
    try {
      await this.getProject(projectId)
    } catch (error) {
      if (!(error instanceof MediaServiceError) || error.code !== 'PROJECT_NOT_FOUND') throw error
      const pending = await this.latestDeletion(projectId, ['pending', 'deleted'])
      if (!pending) throw error
      return await this.withProjectWriteLock(projectId, () => this.resumeDeletion(pending))
    }

    return await this.withProjectWriteLock(projectId, async () => {
      const current = await readFile(this.projectPath(projectId), 'utf8')
        .then(value => mediaProjectSchema.parse(migrateLegacyMediaOwnerRecord(JSON.parse(value)).value))
        .catch(async error => {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          const pending = await this.latestDeletion(projectId, ['pending', 'deleted'])
          if (pending) return await this.resumeDeletion(pending)
          throw new MediaServiceError('找不到媒体项目', 404, 'PROJECT_NOT_FOUND')
        })
      if ('deletion_id' in current) return current
      const activeTaskIds = [
        current.task_id,
        current.kind === 'video' ? current.preview_task_id : undefined,
      ].filter((taskId): taskId is string => Boolean(taskId))
      for (const taskId of activeTaskIds) {
        const task = await readFile(this.taskPath(taskId), 'utf8')
          .then(value => mediaTaskSchema.parse(migrateLegacyMediaOwnerRecord(JSON.parse(value)).value))
          .catch(() => null)
        if (task && ['queued', 'running', 'committing'].includes(task.status)) {
          throw new MediaServiceError('请先等待当前媒体任务完成或取消', 409, 'TASK_IN_PROGRESS')
        }
      }
      const taskNames = await readdir(this.tasksDir)
      const taskIds: string[] = []
      for (const name of taskNames.filter(name => name.endsWith('.json'))) {
        try {
          const task = mediaTaskSchema.parse(migrateLegacyMediaOwnerRecord(
            JSON.parse(await readFile(join(this.tasksDir, name), 'utf8')),
          ).value)
          if (task.project_id === projectId) taskIds.push(task.id)
        } catch {
          // A corrupt unrelated task must not block an accounted project deletion.
        }
      }
      const usage = await this.managedStorageUsage(join(this.assetsDir, projectId))
      const deletedAt = this.iso()
      const purgeAfter = new Date(this.now().getTime() + this.deletionRetentionDays * 86_400_000).toISOString()
      const deletionId = `del_${randomUUID().replaceAll('-', '')}`
      const receipt = mediaDeletionReceiptSchema.parse({
        deletion_id: deletionId,
        project_id: projectId,
        project_kind: current.kind,
        project_title: current.title,
        owner: current.owner,
        status: 'pending',
        deleted_at: deletedAt,
        purge_after: purgeAfter,
        task_ids: taskIds,
        managed_asset_count: usage.count,
        managed_asset_bytes: usage.bytes,
        trash_key: deletionId,
      })
      await this.writeJson(this.deletionPath(receipt.deletion_id), receipt)
      return await this.resumeDeletion(receipt)
    })
  }

  async restoreProject(projectId: string, owner: MediaOwner): Promise<MediaDeletionReceipt> {
    const receipt = await this.latestDeletion(projectId, ['pending', 'deleted', 'restoring'])
    if (!receipt || !sameOwner(receipt.owner, owner)) {
      throw new MediaServiceError('找不到可恢复的媒体项目', 404, 'PROJECT_NOT_FOUND')
    }
    return await this.withProjectWriteLock(projectId, async () => {
      const deleted = receipt.status === 'pending' ? await this.resumeDeletion(receipt) : receipt
      const trash = this.trashPath(deleted.trash_key)
      const activeProjectExists = await stat(this.projectPath(projectId)).then(() => true).catch(() => false)
      const trashedProjectExists = await stat(join(trash, 'project.json')).then(() => true).catch(() => false)
      if (activeProjectExists && trashedProjectExists) {
        throw new MediaServiceError('媒体项目 ID 已被占用，不能恢复', 409, 'PROJECT_RESTORE_CONFLICT')
      }
      const restoring = mediaDeletionReceiptSchema.parse({ ...deleted, status: 'restoring' })
      await this.writeJson(this.deletionPath(restoring.deletion_id), restoring)
      await this.moveIfPresent(join(trash, 'assets'), join(this.assetsDir, projectId))
      for (const taskId of restoring.task_ids) {
        await this.moveIfPresent(join(trash, 'tasks', `${taskId}.json`), this.taskPath(taskId))
      }
      await this.moveIfPresent(join(trash, 'events.json'), this.eventJournalPath(projectId))
      // Publish the project last so readers never observe a partially restored owner.
      await this.moveIfPresent(join(trash, 'project.json'), this.projectPath(projectId))
      if (!(await stat(this.projectPath(projectId)).then(() => true).catch(() => false))) {
        throw new MediaServiceError('媒体项目恢复不完整，可安全重试', 503, 'PROJECT_RESTORE_INCOMPLETE')
      }
      const restored = mediaDeletionReceiptSchema.parse({
        ...restoring,
        status: 'restored',
        restored_at: this.iso(),
      })
      await this.writeJson(this.deletionPath(restored.deletion_id), restored)
      return restored
    })
  }

  private async collectProjectCasReferences(path: string, references: Set<string>): Promise<void> {
    const raw = await readFile(path, 'utf8').catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    })
    if (raw === null) return
    const project = mediaProjectSchema.parse(migrateLegacyMediaOwnerRecord(JSON.parse(raw)).value)
    for (const asset of project.assets) {
      if (asset.storage.kind === 'cas' && /^sha256\/[a-f0-9]{64}$/.test(asset.storage.locator)) {
        references.add(asset.storage.locator.slice('sha256/'.length))
      }
    }
  }

  private async garbageCollectCasUnlocked(): Promise<void> {
    const references = new Set<string>()
    const projectNames = await readdir(this.projectsDir)
    for (const name of projectNames.filter(name => name.endsWith('.json'))) {
      await this.collectProjectCasReferences(join(this.projectsDir, name), references)
    }
    const trashEntries = await readdir(this.trashDir, { withFileTypes: true })
    for (const entry of trashEntries) {
      if (entry.isDirectory()) {
        await this.collectProjectCasReferences(join(this.trashDir, entry.name, 'project.json'), references)
      }
    }
    const blobs = await readdir(this.casDir, { withFileTypes: true })
    for (const blob of blobs) {
      if (blob.isFile() && blob.name.startsWith('.tmp-')) {
        await rm(join(this.casDir, blob.name), { force: true })
        continue
      }
      if (blob.isFile() && /^[a-f0-9]{64}$/.test(blob.name) && !references.has(blob.name)) {
        await rm(join(this.casDir, blob.name), { force: true })
      }
    }
  }

  async purgeExpiredDeletions(): Promise<MediaDeletionReceipt[]> {
    const now = this.now().getTime()
    const purged: MediaDeletionReceipt[] = []
    for (const candidate of await this.readDeletionReceipts()) {
      if (!['pending', 'deleted'].includes(candidate.status) || Date.parse(candidate.purge_after) > now) continue
      const receipt = await this.withProjectWriteLock(candidate.project_id, async () => {
        const deleted = candidate.status === 'pending' ? await this.resumeDeletion(candidate) : candidate
        await rm(this.trashPath(deleted.trash_key), { recursive: true, force: true })
        const next = mediaDeletionReceiptSchema.parse({
          ...deleted,
          status: 'purged',
          purged_at: this.iso(),
        })
        await this.writeJson(this.deletionPath(next.deletion_id), next)
        return next
      })
      purged.push(receipt)
    }
    await this.withCasWriteLock(() => this.garbageCollectCasUnlocked())
    return purged
  }
}
