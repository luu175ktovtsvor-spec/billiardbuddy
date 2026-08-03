import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  addImageProjectReferencesInputSchema,
  commitImageVersionInputSchema,
  createImageProjectInputSchema,
  imageGenerationTaskResultSchema,
  imageWorkbenchProjectSchema,
  mediaSafeError,
  mediaTaskSchema,
  saveImageOutputInputSchema,
  selectImageVersionInputSchema,
  startImageOperationInputSchema,
  submitImageProjectInputSchema,
  updateImageProjectInputSchema,
  type AddImageProjectReferencesInput,
  type CommitImageVersionInput,
  type CreateImageProjectInput,
  type ImageWorkbenchProject,
  type MediaAsset,
  type MediaOwner,
  type MediaSafeErrorCode,
  type SaveImageOutputInput,
  type SaveImageOutputResult,
  type SelectImageVersionInput,
  type StartImageOperationInput,
  type SubmitImageProjectInput,
  type UpdateImageProjectInput,
} from '../../../shared/contracts/media.js'
import {
  adoptImageCandidateInputSchema,
  createCreativePlanInputSchema,
  createGenerationRoundInputSchema,
  decideImageCandidateInputSchema,
  deriveImageCandidateInputSchema,
  estimateGenerationRoundInputSchema,
  type AdoptImageCandidateInput,
  type CreateCreativePlanInput,
  type CreateGenerationRoundInput,
  type DecideImageCandidateInput,
  type DeriveImageCandidateInput,
  type EstimateGenerationRoundInput,
  type ImageBriefSnapshot,
  type ImageCandidateAdoption,
  type ImageCandidateDecision,
  type ImageCandidateGroup,
  type ImageCandidate,
  type ImageCreativeDirection,
  type ImageCreativePlan,
  type ImageDeliverySpec,
  type ImageGenerationRound,
  type ImageOperationV2,
  type ImageReferenceV2,
  type ProviderExecutionReceipt,
  type UpdateImageReferenceControlInput,
  updateImageReferenceControlInputSchema,
} from '../../../shared/contracts/imageGeneration.js'
import { providerRegistryEntry } from '../../../../gateway/providerRegistry.js'
import {
  MEDIA_RESULT_HANDOFF_DIRECT_V1,
  MEDIA_RESULT_HANDOFF_HEADER,
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
} from '../../../shared/product/providerGateway.js'
import { productGatewayConfigured, productGatewayTarget } from '../product/productGatewayRuntime.js'
import { applyImageBriefOverrides, compileImageBrief, providerPromptForImageBrief } from './imageBrief.js'
import { IMAGE_PROVIDER_POLICY_REVISION, ImageProviderPolicyError, resolveImageProviderPolicy } from './imageProviderPolicy.js'
import {
  ImageAssetStore,
  ImageAssetStoreError,
  type SupportedImageMime,
  type VerifiedImageBytes,
} from './imageAssetStore.js'
import {
  ImageWorkbenchRepositoryError,
  type ImageOperation,
  type ImageOperationEvent,
} from './imageWorkbenchRepository.js'
import {
  LegacyImageProjectReader,
  legacyProjectOperations,
  legacyProjectSourceHash,
} from '../media/image/infrastructure/legacyImageProjectReader.js'
import { SqliteImageMetadataStore } from '../media/image/infrastructure/sqliteImageMetadataStore.js'

const STANDALONE_IMAGE_OWNER: MediaOwner = {
  kind: 'standalone',
  owner_id: 'local_workbench',
}
const INITIAL_WRITER_FENCE = `fence_${'0'.repeat(32)}`

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type ImageWorkbenchCrashPoint =
  | 'after_cas_publish_before_db_commit'
  | 'after_db_commit_before_relay_ack'
  | 'after_project_migration_before_operations'

type RelayImageTask = {
  task_id?: string
  status?: string
  poll_after_seconds?: number
  data?: Array<{
    b64_json?: string
    url?: string
    revised_prompt?: string
    mime_type?: SupportedImageMime
  }>
  error?: string
  message?: string
  reused?: boolean
  input_fidelity_requested?: string
  input_fidelity_status?: 'accepted' | 'unsupported'
  input_fidelity_risk?: string
  provider_receipt_hash?: string
  refusal?: { category?: string; safe_message?: string }
  policy_refusal?: { category?: string; safe_message?: string }
  result_acknowledged?: boolean
  result_url?: string
  result_urls?: string[]
}

function id(prefix: 'img' | 'ref' | 'mask' | 'out' | 'task' | 'brf' | 'dsp' | 'art' | 'plan' | 'dir' | 'rnd' | 'grp' | 'cand' | 'receipt' | 'adopt' | 'canvas'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function stableId(prefix: 'op' | 'ver' | 'ref' | 'dsp' | 'art' | 'plan' | 'dir' | 'rnd' | 'grp' | 'cand' | 'out' | 'receipt' | 'adopt' | 'canvas', ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`
}

function sizeDimensions(size: string): { width: number; height: number } {
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(size)
  if (!match) throw new ImageWorkbenchServiceError('图片尺寸格式无效', 500, 'IMAGE_OPERATION_CORRUPT')
  return { width: Number(match[1]), height: Number(match[2]) }
}

function extensionForMime(mimeType: SupportedImageMime): 'png' | 'jpg' | 'webp' {
  return mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
}

function isSupportedImageMime(value: unknown): value is SupportedImageMime {
  return value === 'image/png' || value === 'image/jpeg' || value === 'image/webp'
}

function titleForRequest(userRequest: string, fallback = '新图片'): string {
  const normalized = userRequest.replace(/\s+/g, ' ').trim()
  return normalized.slice(0, 40) || fallback
}

function relayPollAfterSeconds(value: unknown, fallbackSeconds: number): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  const seconds = Number.isFinite(parsed) ? Math.trunc(parsed) : fallbackSeconds
  return Math.max(1, Math.min(3600, seconds))
}

function boundedMessage(value: unknown, fallback = '图片服务暂时不可用'): string {
  return typeof value === 'string' && value.trim()
    ? value.replace(/\s+/g, ' ').trim().slice(0, 2000)
    : fallback
}

function relayPolicyRefusal(body: RelayImageTask): { category: string; safe_message: string } | null {
  const refusal = body.refusal ?? body.policy_refusal
  if (body.status !== 'blocked_by_policy' && !refusal) return null
  return {
    category: typeof refusal?.category === 'string' && refusal.category.trim()
      ? refusal.category.trim().slice(0, 120)
      : 'provider_policy',
    safe_message: boundedMessage(refusal?.safe_message ?? body.error ?? body.message, mediaSafeError('MEDIA_IMAGE_POLICY_BLOCKED').message),
  }
}

function trustedResultUrl(value: unknown, gatewayBaseUrl: string): string | null {
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
      || !result.pathname.startsWith('/relay/imgtasks/images/results/')
    ) return null
    const grant = result.pathname.slice('/relay/imgtasks/images/results/'.length)
    return /^[A-Za-z0-9_-]+\.[a-f0-9]{64}(?:\/[0-3])?$/.test(grant) ? result.toString() : null
  } catch {
    return null
  }
}

function mediaErrorCode(error: unknown): string {
  if (error instanceof ImageAssetStoreError || error instanceof ImageWorkbenchRepositoryError) return error.code
  if (error instanceof ImageWorkbenchServiceError) return error.code
  return 'IMAGE_WORKBENCH_ERROR'
}

export class ImageWorkbenchServiceError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly code = 'IMAGE_WORKBENCH_ERROR',
  ) {
    super(message)
    this.name = 'ImageWorkbenchServiceError'
  }
}

/**
 * The image workbench owns image project state, bytes, versions and operation
 * records. It deliberately has no dependency on MediaProjectService, video
 * state, or an Agent session. Remote image execution is attached to the
 * persisted ImageOperation record in a later section of this same service.
 */
export class ImageWorkbenchService {
  readonly repository: SqliteImageMetadataStore
  readonly assets: ImageAssetStore
  private readonly now: () => Date
  private readonly fetchImpl: FetchLike
  private readonly imageResultTimeoutMs: number
  private readonly legacyMediaRoot: string
  private readonly legacyReader: LegacyImageProjectReader
  private readonly crashInjector?: (point: ImageWorkbenchCrashPoint) => void
  private readonly activeSubmissions = new Map<string, Promise<ImageOperation>>()
  private readonly activeRefreshes = new Map<string, Promise<ImageOperation>>()

  constructor(options: {
    root?: string
    now?: () => Date
    fetchImpl?: FetchLike
    imageResultTimeoutMs?: number
    legacyMediaRoot?: string
    casOrphanRetentionMs?: number
    /** Deliberate crash boundaries used by recovery verification only. */
    crashInjector?: (point: ImageWorkbenchCrashPoint) => void
  } = {}) {
    this.now = options.now ?? (() => new Date())
    this.fetchImpl = options.fetchImpl ?? fetch
    this.imageResultTimeoutMs = Math.max(1_000, Math.min(120_000, options.imageResultTimeoutMs ?? 30_000))
    this.legacyMediaRoot = options.legacyMediaRoot
      ?? join(process.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'media')
    this.legacyReader = new LegacyImageProjectReader(this.legacyMediaRoot)
    this.repository = new SqliteImageMetadataStore({
      root: options.root,
      now: this.now,
      casOrphanRetentionMs: options.casOrphanRetentionMs,
    })
    this.crashInjector = options.crashInjector
    this.assets = new ImageAssetStore(this.repository.paths(), {
      afterCasPublish: async () => this.injectCrash('after_cas_publish_before_db_commit'),
    })
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private injectCrash(point: ImageWorkbenchCrashPoint): void {
    this.crashInjector?.(point)
  }

  /** Compatibility projection only; every paid submission resolves policy again. */
  private initialProjectionModel(userRequest: string, size: ImageWorkbenchProject['size']): ImageWorkbenchProject['model'] {
    return this.resolveGenerationPolicy({
      user_request: userRequest,
      size,
      operation_mode: 'generate',
      references: [],
    }).model_id
  }

  private generationReferences(project: ImageWorkbenchProject): ImageReferenceV2[] {
    const assets = new Map(project.assets.map(asset => [asset.id, asset]))
    return project.references.map((reference, index) => {
      const asset = assets.get(reference.asset_id)
      if (!asset?.content_hash) {
        throw new ImageWorkbenchServiceError('图片参考素材缺少可验证内容哈希', 409, 'REFERENCE_IMAGE_MISSING')
      }
      const preservation = reference.preservation
        ?? (reference.role === 'logo' || reference.role === 'qrcode'
          ? 'exact'
          : ['subject', 'product', 'character'].includes(reference.role)
            ? 'must_preserve'
            : 'prefer_preserve')
      const influence = reference.influence_strength
        ?? (['subject', 'product', 'character'].includes(reference.role) ? 'high' : 'medium')
      return {
        id: stableId('ref', project.id, reference.asset_id),
        project_id: project.id,
        asset_id: reference.asset_id,
        role: reference.role,
        ...(reference.label ? { label: reference.label } : {}),
        content_hash: asset.content_hash as `sha256:${string}`,
        influence_strength: influence,
        preservation,
        priority: reference.priority ?? index,
        created_at: asset.created_at,
      }
    })
  }

  private async ensureDeliverySpec(project: ImageWorkbenchProject): Promise<ImageDeliverySpec> {
    const existing = await this.repository.currentDeliverySpec(project.id)
    const { width, height } = sizeDimensions(project.size)
    const defaultArtboardId = stableId('art', project.id, 'default-artboard')
    if (existing) {
      const isLegacyDefault = existing.artboards.length === 1 && existing.artboards[0]?.id === defaultArtboardId
      if (!isLegacyDefault || (existing.artboards[0]!.width === width && existing.artboards[0]!.height === height)) return existing
      return await this.repository.saveDeliverySpec({
        schema_version: 1,
        id: id('dsp'),
        project_id: project.id,
        revision: existing.revision + 1,
        purpose: 'custom',
        artboards: [{
          id: defaultArtboardId,
          label: '默认画板',
          width,
          height,
          required: true,
          output: { format: 'png', transparent: false },
        }],
        created_at: this.iso(),
      })
    }
    const createdAt = this.iso()
    return await this.repository.saveDeliverySpec({
      schema_version: 1,
      id: stableId('dsp', project.id, 'delivery-spec-v1'),
      project_id: project.id,
      revision: 0,
      purpose: 'custom',
      artboards: [{
        id: defaultArtboardId,
        label: '默认画板',
        width,
        height,
        required: true,
        output: { format: 'png', transparent: false },
      }],
      created_at: createdAt,
    })
  }

  private exactTextRole(text: string): 'title' | 'subtitle' | 'price' | 'date' | 'address' | 'contact' | 'body' {
    if (/价格|¥|￥|元/u.test(text)) return 'price'
    if (/日期|时间|年|月|日/u.test(text)) return 'date'
    if (/地址|地点/u.test(text)) return 'address'
    if (/电话|联系|微信/u.test(text)) return 'contact'
    if (/标题/u.test(text)) return 'title'
    return 'body'
  }

  private async compileGenerationBrief(project: ImageWorkbenchProject): Promise<ImageBriefSnapshot> {
    const references = this.generationReferences(project)
    const legacy = project.brief ?? compileImageBrief(project.prompt, project.references).brief
    const { width, height } = sizeDimensions(project.size)
    const snapshot = {
      schema_version: 2 as const,
      id: id('brf'),
      project_id: project.id,
      user_request: legacy.user_request,
      confirmed_facts: legacy.confirmed_facts,
      must_preserve: legacy.must_preserve,
      may_change: legacy.may_change,
      missing_information: legacy.missing_information,
      exact_text: legacy.exact_text.map((text, index) => ({
        id: stableId('ref', project.id, 'exact-text', String(index), text),
        text,
        role: this.exactTextRole(text),
        required: true,
      })),
      reference_rules: references.map(reference => ({
        reference_id: reference.id,
        role: reference.role,
        influence_strength: reference.influence_strength,
        preservation: reference.preservation,
        priority: reference.priority,
      })),
      generation_canvas: { width, height, color_space: 'srgb' as const },
      compiler_name: 'image-brief' as const,
      compiler_version: 'image-brief-v2',
      created_at: this.iso(),
    }
    return await this.repository.saveGenerationBrief({
      ...snapshot,
      snapshot_hash: sha256({
        user_request: snapshot.user_request,
        confirmed_facts: snapshot.confirmed_facts,
        must_preserve: snapshot.must_preserve,
        may_change: snapshot.may_change,
        missing_information: snapshot.missing_information,
        exact_text: snapshot.exact_text.map(requirement => ({ text: requirement.text, role: requirement.role, required: requirement.required })),
        reference_rules: snapshot.reference_rules,
        generation_canvas: snapshot.generation_canvas,
        compiler_version: snapshot.compiler_version,
      }),
    })
  }

  private async initializeGenerationHeader(project: ImageWorkbenchProject): Promise<ImageWorkbenchProject> {
    const delivery = await this.ensureDeliverySpec(project)
    const brief = await this.compileGenerationBrief(project)
    if (
      project.current_brief_id === brief.id
      && project.current_delivery_spec_id === delivery.id
      && project.current_delivery_spec_revision === delivery.revision
    ) return project
    return await this.repository.saveProject({
      ...project,
      current_brief_id: brief.id,
      current_delivery_spec_id: delivery.id,
      current_delivery_spec_revision: delivery.revision,
      revision: project.revision + 1,
    })
  }

  private defaultDirection(project: ImageWorkbenchProject, brief: ImageBriefSnapshot): ImageCreativeDirection {
    return {
      id: stableId('dir', project.id, brief.snapshot_hash, 'default-commercial-direction'),
      label: '稳妥商业版',
      rationale: '保留已确认事实和参考图约束，提供可直接评审的单一方向。',
      generation_intent: {
        composition_goal: '清晰主视觉、主体完整、层级明确',
        visual_tone: '与用户需求和已确认参考一致',
        ...(brief.exact_text.length > 0 ? { text_space_goal: '预留清晰的确定性文字排版区域' } : {}),
      },
      preservation_rules: brief.must_preserve,
    }
  }

  private providerPromptForDirection(brief: ImageBriefSnapshot, direction: ImageCreativeDirection): string {
    const exactOverlayRoles = brief.reference_rules
      .filter(rule => rule.role === 'logo' || rule.role === 'qrcode')
      .map(rule => rule.role === 'logo' ? 'Logo' : '二维码')
    return [
      `用户原始需求：${brief.user_request}`,
      brief.confirmed_facts.length ? `已确认事实：${brief.confirmed_facts.join('；')}` : '',
      brief.must_preserve.length ? `必须保留：${brief.must_preserve.join('；')}` : '',
      `创作方向：${direction.label}`,
      `构图目标：${direction.generation_intent.composition_goal}`,
      `视觉基调：${direction.generation_intent.visual_tone}`,
      direction.generation_intent.text_space_goal ? `文字区域：${direction.generation_intent.text_space_goal}` : '',
      exactOverlayRoles.length ? `为后续确定性叠加的${exactOverlayRoles.join('、')}预留清晰位置，不要重绘其图形。` : '',
      '不得编造价格、日期、地址、联系方式、品牌或活动规则。',
    ].filter(Boolean).join('\n')
  }

  private resolveGenerationPolicy(input: Parameters<typeof resolveImageProviderPolicy>[0]) {
    try {
      return resolveImageProviderPolicy(input)
    } catch (error) {
      if (error instanceof ImageProviderPolicyError) {
        throw new ImageWorkbenchServiceError(error.message, 422, error.gap.code)
      }
      throw error
    }
  }

  private async project(projectId: string): Promise<ImageWorkbenchProject> {
    try {
      return await this.repository.getProject(projectId)
    } catch (error) {
      if (error instanceof ImageWorkbenchRepositoryError) {
        throw new ImageWorkbenchServiceError(error.message, error.status, error.code)
      }
      throw error
    }
  }

  async listProjects(owner: MediaOwner = STANDALONE_IMAGE_OWNER): Promise<ImageWorkbenchProject[]> {
    return await this.repository.listProjects(owner)
  }

  async getProject(projectId: string): Promise<ImageWorkbenchProject> {
    return await this.project(projectId)
  }

  async assertProjectOwner(projectId: string, owner: MediaOwner = STANDALONE_IMAGE_OWNER): Promise<ImageWorkbenchProject> {
    const project = await this.project(projectId)
    if (project.owner.kind !== owner.kind || project.owner.owner_id !== owner.owner_id) {
      throw new ImageWorkbenchServiceError('图片项目不属于当前工作台', 403, 'IMAGE_PROJECT_FORBIDDEN')
    }
    return project
  }

  async listDeletions(owner: MediaOwner = STANDALONE_IMAGE_OWNER) {
    return await this.repository.listDeletions(owner)
  }

  async hasProjectHistory(projectId: string, owner: MediaOwner = STANDALONE_IMAGE_OWNER): Promise<boolean> {
    return await this.repository.hasProjectHistory(projectId, owner)
  }

  async hasOperationHistory(operationId: string, owner: MediaOwner = STANDALONE_IMAGE_OWNER): Promise<boolean> {
    return await this.repository.hasOperationHistory(operationId, owner)
  }

  async deleteProject(projectId: string) {
    await this.assertProjectOwner(projectId)
    return await this.repository.deleteProject(projectId)
  }

  async restoreProject(projectId: string, owner: MediaOwner = STANDALONE_IMAGE_OWNER) {
    return await this.repository.restoreProject(projectId, owner)
  }

  private async persistImages(
    projectId: string,
    images: string[],
    roles: ImageWorkbenchProject['references'][number]['role'][],
    createdAt: string,
  ): Promise<{ assets: MediaAsset[]; references: ImageWorkbenchProject['references']; fileNames: string[] }> {
    const records: Array<{ asset: MediaAsset; reference: ImageWorkbenchProject['references'][number]; fileName: string }> = []
    for (const [index, image] of images.entries()) {
      const verified = await this.assets.verifyDataUrl(image)
      const assetId = id('ref')
      const saved = await this.assets.persist(projectId, assetId, 'reference', verified, projectId, createdAt)
      records.push({
        asset: saved.asset,
        reference: { asset_id: assetId, role: roles[index]! },
        fileName: saved.file_name,
      })
    }
    return {
      assets: records.map(record => record.asset),
      references: records.map(record => record.reference),
      fileNames: records.map(record => record.fileName),
    }
  }

  private referenceAssets(project: ImageWorkbenchProject): MediaAsset[] {
    return project.assets.filter(asset => asset.role === 'reference')
  }

  private async assertReferenceSet(
    project: ImageWorkbenchProject,
    references: ImageWorkbenchProject['references'],
  ): Promise<void> {
    const assets = new Map(this.referenceAssets(project).map(asset => [asset.id, asset]))
    if (new Set(references.map(reference => reference.asset_id)).size !== references.length) {
      throw new ImageWorkbenchServiceError('参考素材不能重复', 400, 'REFERENCE_IMAGES_INVALID')
    }
    for (const reference of references) {
      const asset = assets.get(reference.asset_id)
      if (!asset) throw new ImageWorkbenchServiceError('图片参考素材不存在', 400, 'REFERENCE_IMAGE_MISSING')
      await this.assets.readVerified(asset)
    }
  }

  async createProject(raw: CreateImageProjectInput): Promise<ImageWorkbenchProject> {
    const input = createImageProjectInputSchema.parse(raw)
    const now = this.iso()
    const projectId = id('img')
    const persisted = await this.persistImages(projectId, input.reference_images, input.reference_roles, now)
    const { brief, providerPrompt } = compileImageBrief(input.user_request, persisted.references)
    const project = imageWorkbenchProjectSchema.parse({
      schema_version: 1,
      id: projectId,
      kind: 'image',
      title: input.title ?? titleForRequest(input.user_request),
      workspace_root: input.workspace_root,
      owner: STANDALONE_IMAGE_OWNER,
      writer_fence: INITIAL_WRITER_FENCE,
      assets: persisted.assets,
      versions: [],
      revision: 0,
      created_at: now,
      updated_at: now,
      state: 'draft',
      mode: persisted.references.length > 0 ? 'edit' : 'generate',
      model: this.initialProjectionModel(input.user_request, input.size),
      prompt: providerPrompt,
      size: input.size,
      count: 3,
      candidate_count: 3,
      brief,
      brief_overrides: {},
      references: persisted.references,
      reference_images: [],
      reference_image_assets: persisted.fileNames,
      reference_image_count: persisted.references.length,
      outputs: [],
    })
    try {
      const saved = await this.repository.saveProject(project)
      return await this.initializeGenerationHeader(saved)
    } catch (error) {
      throw new ImageWorkbenchServiceError('无法创建图片项目', 500, mediaErrorCode(error))
    }
  }

  private assertRevision(project: ImageWorkbenchProject, revision: number, message: string): void {
    if (project.revision !== revision) throw new ImageWorkbenchServiceError(message, 409, 'IMAGE_REVISION_CONFLICT')
  }

  private async assertNoActiveOperation(project: ImageWorkbenchProject, allowUnknownRetry = false): Promise<void> {
    if (!project.task_id) return
    const operation = await this.repository.getOperation(project.task_id).catch(() => null)
    if (!operation) return
    if (operation.outcome_unknown && !allowUnknownRetry) {
      throw new ImageWorkbenchServiceError('上一次图片操作结果未知，请在桌面工作台明确确认后再继续', 409, 'IMAGE_UNKNOWN_RETRY_CONFIRMATION_REQUIRED')
    }
    if (['queued', 'running', 'committing'].includes(operation.status)) {
      throw new ImageWorkbenchServiceError('当前图片操作尚未完成', 409, 'IMAGE_OPERATION_ACTIVE')
    }
  }

  async updateProject(projectId: string, raw: UpdateImageProjectInput): Promise<ImageWorkbenchProject> {
    const input = updateImageProjectInputSchema.parse(raw)
    const project = await this.project(projectId)
    this.assertRevision(project, input.revision, '图片项目已更新，请刷新后再编辑')
    await this.assertNoActiveOperation(project, input.confirm_unknown_retry)
    const references = input.references ?? project.references
    await this.assertReferenceSet(project, references)
    if (references.length + input.new_reference_images.length > 8) {
      throw new ImageWorkbenchServiceError('每个图片项目最多保留 8 张参考图片', 400, 'TOO_MANY_REFERENCE_IMAGES')
    }
    const now = this.iso()
    const added = await this.persistImages(project.id, input.new_reference_images, input.new_reference_roles, now)
    const nextReferences = [...references, ...added.references]
    const { brief: baseBrief } = compileImageBrief(input.user_request, nextReferences)
    const briefOverrides = input.brief_overrides ?? project.brief_overrides
    const brief = applyImageBriefOverrides(baseBrief, briefOverrides)
    const saved = await this.repository.saveProject(imageWorkbenchProjectSchema.parse({
      ...project,
      state: 'draft',
      task_id: undefined,
      title: titleForRequest(input.user_request, project.title),
      mode: nextReferences.length > 0 ? 'edit' : 'generate',
      model: this.initialProjectionModel(input.user_request, input.size),
      prompt: providerPromptForImageBrief(brief),
      size: input.size,
      count: 3,
      candidate_count: 3,
      brief,
      brief_overrides: briefOverrides,
      references: nextReferences,
      reference_image_assets: nextReferences.map(reference => {
        const asset = [...project.assets, ...added.assets].find(candidate => candidate.id === reference.asset_id)
        if (!asset?.mime_type || !isSupportedImageMime(asset.mime_type)) {
          throw new ImageWorkbenchServiceError('图片参考素材格式无效', 409, 'REFERENCE_IMAGE_MISSING')
        }
        return `${asset.id}.${extensionForMime(asset.mime_type)}`
      }),
      reference_image_count: nextReferences.length,
      assets: [...project.assets, ...added.assets],
      revision: project.revision + 1,
      error: undefined,
      error_code: undefined,
      notice: undefined,
    }))
    return await this.initializeGenerationHeader(saved)
  }

  async addReferences(projectId: string, raw: AddImageProjectReferencesInput): Promise<ImageWorkbenchProject> {
    const input = addImageProjectReferencesInputSchema.parse(raw)
    const project = await this.project(projectId)
    this.assertRevision(project, input.revision, '图片项目已更新，请刷新后再追加参考素材')
    await this.assertNoActiveOperation(project)
    if (project.references.length + input.reference_images.length > 8) {
      throw new ImageWorkbenchServiceError('每个图片项目最多保留 8 张参考图片', 400, 'TOO_MANY_REFERENCE_IMAGES')
    }
    return await this.updateProject(projectId, {
      revision: project.revision,
      user_request: project.brief?.user_request ?? project.title,
      size: project.size,
      references: project.references,
      new_reference_images: input.reference_images,
      new_reference_roles: input.reference_roles,
    })
  }

  async updateReferenceControl(projectId: string, referenceId: string, raw: UpdateImageReferenceControlInput): Promise<ImageWorkbenchProject> {
    const input = updateImageReferenceControlInputSchema.parse(raw)
    const project = await this.project(projectId)
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再更新参考图控制')
    await this.assertNoActiveOperation(project)
    await this.assertNoActiveGenerationOperation(project)
    const references = project.references.map(reference => stableId('ref', project.id, reference.asset_id) === referenceId
      ? {
          ...reference,
          role: input.role,
          influence_strength: input.influence_strength,
          preservation: input.preservation,
          priority: input.priority,
          ...(input.label === undefined ? {} : { label: input.label }),
        }
      : reference)
    if (references.every(reference => stableId('ref', project.id, reference.asset_id) !== referenceId)) {
      throw new ImageWorkbenchServiceError('图片参考图不存在', 404, 'REFERENCE_IMAGE_MISSING')
    }
    const saved = await this.repository.saveProject({
      ...project,
      references,
      revision: project.revision + 1,
      error: undefined,
      error_code: undefined,
      notice: undefined,
    })
    return await this.initializeGenerationHeader(saved)
  }

  private async activeGenerationOperations(projectId: string): Promise<ImageOperationV2[]> {
    return (await this.repository.listGenerationOperations(projectId)).filter(operation =>
      ['queued', 'running', 'cancelling', 'committing', 'outcome_unknown'].includes(operation.status),
    )
  }

  private async assertNoActiveGenerationOperation(project: ImageWorkbenchProject): Promise<void> {
    const active = await this.activeGenerationOperations(project.id)
    if (active.length > 0) {
      throw new ImageWorkbenchServiceError('当前图片生成轮次尚未完成', 409, 'IMAGE_OPERATION_ACTIVE')
    }
  }

  async createCreativePlan(projectId: string, raw: CreateCreativePlanInput): Promise<ImageCreativePlan> {
    const input = createCreativePlanInputSchema.parse(raw)
    const project = await this.project(projectId)
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再创建创作方向')
    const brief = await this.compileGenerationBrief(project)
    const directions = input.directions?.map((direction, index) => ({
      ...direction,
      id: stableId('dir', project.id, input.idempotency_key, String(index)),
    })) ?? [this.defaultDirection(project, brief)]
    const plan: ImageCreativePlan = {
      id: stableId('plan', project.id, input.idempotency_key),
      project_id: project.id,
      brief_snapshot_hash: brief.snapshot_hash,
      directions,
      source: 'deterministic',
      created_at: this.iso(),
    }
    return await this.repository.saveCreativePlan(plan)
  }

  async getCreativePlan(projectId: string, planId: string): Promise<ImageCreativePlan> {
    return await this.repository.getCreativePlan(projectId, planId)
  }

  private async creativePlanForGeneration(project: ImageWorkbenchProject, planId: string): Promise<{ plan: ImageCreativePlan; brief: ImageBriefSnapshot; delivery: ImageDeliverySpec; references: ImageReferenceV2[] }> {
    const [plan, delivery] = await Promise.all([
      this.repository.getCreativePlan(project.id, planId),
      this.ensureDeliverySpec(project),
    ])
    const brief = await this.compileGenerationBrief(project)
    if (plan.brief_snapshot_hash !== brief.snapshot_hash) {
      throw new ImageWorkbenchServiceError('创作方向基于过期 Brief，请重新确认方向和费用', 409, 'IMAGE_REVISION_CONFLICT')
    }
    return { plan, brief, delivery, references: this.generationReferences(project) }
  }

  /** Logo/QR source bytes are Canvas-owned exact overlays, not Provider inputs. */
  private providerReferences(references: ImageReferenceV2[]): ImageReferenceV2[] {
    return references.filter(reference => reference.role !== 'logo' && reference.role !== 'qrcode')
  }

  private generationProviderMode(references: ImageReferenceV2[]): 'generate' | 'edit' {
    return this.providerReferences(references).length > 0 ? 'edit' : 'generate'
  }

  private deliveryRequiresTransparency(delivery: ImageDeliverySpec): boolean {
    return delivery.artboards.some(artboard => artboard.output.format !== 'jpeg' && artboard.output.transparent)
  }

  private estimateHash(project: ImageWorkbenchProject, plan: ImageCreativePlan, brief: ImageBriefSnapshot, delivery: ImageDeliverySpec, directions: ImageCreativeDirection[], policies: Array<{ policy_revision: string; provider: string; model_id: string }>): `sha256:${string}` {
    return sha256({
      project_id: project.id,
      base_revision: project.revision,
      plan_id: plan.id,
      brief_snapshot_hash: brief.snapshot_hash,
      delivery_spec: { id: delivery.id, revision: delivery.revision },
      directions: directions.map(direction => direction.id),
      policies,
      candidate_count_per_operation: 3,
    })
  }

  async estimateGenerationRound(projectId: string, raw: EstimateGenerationRoundInput): Promise<{
    estimate_hash: `sha256:${string}`
    direction_count: number
    paid_operation_count: number
    candidate_count_per_operation: number
    concurrency: number
    price_upper_bound: null
  }> {
    const input = estimateGenerationRoundInputSchema.parse(raw)
    const project = await this.project(projectId)
    this.assertRevision(project, input.base_revision, '图片项目已更新，请重新估算费用')
    const { plan, brief, delivery, references } = await this.creativePlanForGeneration(project, input.creative_plan_id)
    const directions = input.direction_ids
      ? plan.directions.filter(direction => input.direction_ids!.includes(direction.id))
      : plan.directions
    if (directions.length === 0 || (input.direction_ids && directions.length !== input.direction_ids.length)) {
      throw new ImageWorkbenchServiceError('创作方向不存在', 404, 'IMAGE_OPERATION_CORRUPT')
    }
    const policies = directions.map(() => this.resolveGenerationPolicy({
      user_request: brief.user_request,
      size: project.size,
      operation_mode: this.generationProviderMode(references),
      references,
      transparent_output: this.deliveryRequiresTransparency(delivery),
    }))
    return {
      estimate_hash: this.estimateHash(project, plan, brief, delivery, directions, policies),
      direction_count: directions.length,
      paid_operation_count: directions.length,
      candidate_count_per_operation: 3,
      concurrency: Math.min(2, directions.length),
      price_upper_bound: null,
    }
  }

  private generationRequestHash(input: {
    project: ImageWorkbenchProject
    brief: ImageBriefSnapshot
    delivery: ImageDeliverySpec
    references: ImageReferenceV2[]
    direction: ImageCreativeDirection
    model: string
  }): `sha256:${string}` {
    return sha256({
      project_id: input.project.id,
      owner: input.project.owner,
      kind: 'generate',
      project_revision: input.project.revision,
      brief_snapshot_hash: input.brief.snapshot_hash,
      delivery_spec_revision: input.delivery.revision,
      execution_policy_revision: IMAGE_PROVIDER_POLICY_REVISION,
      asset_hashes: input.references.map(reference => reference.content_hash),
      direction: input.direction,
      model: input.model,
      logical_attempt: 1,
    })
  }

  async createGenerationRound(projectId: string, raw: CreateGenerationRoundInput): Promise<{
    round: ImageGenerationRound
    operations: ImageOperationV2[]
  }> {
    const input = createGenerationRoundInputSchema.parse(raw)
    const project = await this.project(projectId)
    const roundId = stableId('rnd', project.id, input.idempotency_key)
    const existingRound = await this.repository.getGenerationRound(project.id, roundId).catch(error => {
      if (error instanceof ImageWorkbenchRepositoryError && error.status === 404) return null
      throw error
    })
    if (existingRound) {
      return {
        round: existingRound,
        operations: await Promise.all(existingRound.direction_operations.map(async direction => await this.repository.getGenerationOperation(project.id, direction.operation_id))),
      }
    }
    this.assertRevision(project, input.base_revision, '图片项目已更新，请重新确认生成费用')
    await this.assertNoActiveOperation(project)
    await this.assertNoActiveGenerationOperation(project)
    const { plan, brief, delivery, references } = await this.creativePlanForGeneration(project, input.creative_plan_id)
    const directions = plan.directions.filter(direction => input.direction_ids.includes(direction.id))
    if (directions.length !== input.direction_ids.length) {
      throw new ImageWorkbenchServiceError('存在无效的创作方向', 404, 'IMAGE_OPERATION_CORRUPT')
    }
    const policies = directions.map(direction => ({ direction, policy: this.resolveGenerationPolicy({
      user_request: brief.user_request,
      size: project.size,
      operation_mode: this.generationProviderMode(references),
      references,
      transparent_output: this.deliveryRequiresTransparency(delivery),
    }) }))
    const estimateHash = this.estimateHash(project, plan, brief, delivery, directions, policies.map(item => item.policy))
    if (estimateHash !== input.estimate_hash) {
      throw new ImageWorkbenchServiceError('费用估算已过期或不属于当前输入，请重新确认', 409, 'IMAGE_REVISION_CONFLICT')
    }
    if (!productGatewayConfigured()) {
      throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'GATEWAY_NOT_CONFIGURED')
    }
    await this.referenceDataUrls(project)
    const now = this.iso()
    const operationPairs = policies.map(({ direction, policy }) => {
      const operationId = stableId('op', project.id, roundId, direction.id)
      const requestHash = this.generationRequestHash({ project, brief, delivery, references, direction, model: policy.model_id })
      const idempotencyKey = `bb-image-${requestHash.slice('sha256:'.length)}`
      const taskId = id('task')
      const operation: ImageOperationV2 = {
        id: operationId,
        project_id: project.id,
        owner: project.owner,
        kind: 'generate',
        status: 'queued',
        idempotency_key: idempotencyKey,
        request_hash: requestHash,
        logical_attempt: 1,
        input_refs: {
          project_revision: project.revision,
          brief_snapshot_hash: brief.snapshot_hash,
          delivery_spec_revision: delivery.revision,
          execution_policy_revision: policy.policy_revision,
          asset_hashes: references.map(reference => reference.content_hash),
        },
        transport_task_id: taskId,
        execution_receipt_id: stableId('receipt', project.id, operationId),
        cost_state: 'not_submitted',
        created_at: now,
        updated_at: now,
      }
      const transport = this.operation({
        schema_version: 1,
        id: taskId,
        project_id: project.id,
        operation_id: operationId,
        owner: project.owner,
        kind: 'image.generate',
        status: 'queued',
        progress: 0,
        stage: '等待提交创作方向',
        idempotency_key: idempotencyKey,
        image_operation: {
          kind: 'generate',
          instruction: this.providerPromptForDirection(brief, direction),
          model: policy.model_id,
          output_count: 3,
        },
        created_at: now,
        updated_at: now,
      })
      return { direction, policy, operation, transport }
    })
    const round: ImageGenerationRound = {
      id: roundId,
      project_id: project.id,
      creative_plan_id: plan.id,
      direction_operations: operationPairs.map(pair => ({ direction_id: pair.direction.id, operation_id: pair.operation.id })),
      estimate_hash: estimateHash,
      confirmed_at: now,
      created_at: now,
    }
    const persisted = await this.repository.createGenerationRoundWithOperations({
      project,
      base_revision: input.base_revision,
      round,
      operations: operationPairs.map(pair => pair.operation),
      transport_operations: operationPairs.map(pair => pair.transport),
    })
    const submitted: ImageOperationV2[] = []
    for (const pair of operationPairs) {
      submitted.push(await this.submitGenerationTransport(persisted.project, pair.operation, pair.transport, pair.policy.provider, pair.policy.model_id))
    }
    return { round: persisted.round, operations: submitted }
  }

  /**
   * Derivation is a normal paid edit Operation whose source is an immutable,
   * possibly unadopted Candidate. It deliberately creates another one-
   * direction Round and Candidate Group instead of mutating the source.
   */
  async deriveCandidate(projectId: string, candidateId: string, raw: DeriveImageCandidateInput): Promise<{
    round: ImageGenerationRound
    operation: ImageOperationV2
  }> {
    const input = deriveImageCandidateInputSchema.parse(raw)
    const project = await this.project(projectId)
    const roundId = stableId('rnd', project.id, 'derive', input.idempotency_key)
    const existing = await this.repository.getGenerationRound(project.id, roundId).catch(error => {
      if (error instanceof ImageWorkbenchRepositoryError && error.status === 404) return null
      throw error
    })
    if (existing) {
      const operationId = existing.direction_operations[0]?.operation_id
      if (!operationId) throw new ImageWorkbenchServiceError('候选派生轮次缺少操作', 500, 'IMAGE_OPERATION_CORRUPT')
      return { round: existing, operation: await this.repository.getGenerationOperation(project.id, operationId) }
    }
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再派生候选')
    await this.assertNoActiveOperation(project)
    await this.assertNoActiveGenerationOperation(project)
    const candidate = await this.repository.getCandidate(project.id, candidateId)
    const source = project.assets.find(asset => asset.id === candidate.asset_id && asset.role === 'result')
    if (!source?.content_hash) throw new ImageWorkbenchServiceError('候选资产不存在', 409, 'IMAGE_ASSET_NOT_FOUND')
    await this.assets.readVerified(source)
    const plan = await this.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: `${input.idempotency_key}-plan`,
    })
    const { brief, delivery, references } = await this.creativePlanForGeneration(project, plan.id)
    const direction = plan.directions[0]!
    const policy = this.resolveGenerationPolicy({
      user_request: input.instruction,
      size: project.size,
      operation_mode: 'edit',
      references,
      transparent_output: this.deliveryRequiresTransparency(delivery),
      preferred_model: 'gpt-image-2',
    })
    if (!productGatewayConfigured()) throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'GATEWAY_NOT_CONFIGURED')
    const now = this.iso()
    const operationId = stableId('op', project.id, roundId, candidate.id)
    const assetHashes = [...new Set([candidate.content_hash, ...references.map(reference => reference.content_hash)])]
    const requestHash = sha256({
      project_id: project.id,
      owner: project.owner,
      kind: 'edit',
      base_candidate_id: candidate.id,
      instruction: input.instruction,
      project_revision: project.revision,
      brief_snapshot_hash: brief.snapshot_hash,
      delivery_spec_revision: delivery.revision,
      execution_policy_revision: policy.policy_revision,
      asset_hashes: assetHashes,
      model: policy.model_id,
      logical_attempt: 1,
    })
    const taskId = id('task')
    const operation: ImageOperationV2 = {
      id: operationId,
      project_id: project.id,
      owner: project.owner,
      kind: 'edit',
      status: 'queued',
      idempotency_key: `bb-image-${requestHash.slice('sha256:'.length)}`,
      request_hash: requestHash,
      logical_attempt: 1,
      base_candidate_id: candidate.id,
      instruction: input.instruction,
      input_refs: {
        project_revision: project.revision,
        brief_snapshot_hash: brief.snapshot_hash,
        delivery_spec_revision: delivery.revision,
        execution_policy_revision: policy.policy_revision,
        asset_hashes: assetHashes,
      },
      transport_task_id: taskId,
      execution_receipt_id: stableId('receipt', project.id, operationId),
      cost_state: 'not_submitted',
      created_at: now,
      updated_at: now,
    }
    const transport = this.operation({
      schema_version: 1,
      id: taskId,
      project_id: project.id,
      operation_id: operationId,
      owner: project.owner,
      kind: 'image.generate',
      status: 'queued',
      progress: 0,
      stage: '等待提交候选派生',
      idempotency_key: operation.idempotency_key,
      image_operation: {
        kind: 'edit',
        base_candidate_asset_id: candidate.asset_id,
        instruction: `${this.providerPromptForDirection(brief, direction)}\n编辑要求：${input.instruction}`,
        model: policy.model_id,
        output_count: 3,
      },
      created_at: now,
      updated_at: now,
    })
    const round: ImageGenerationRound = {
      id: roundId,
      project_id: project.id,
      creative_plan_id: plan.id,
      direction_operations: [{ direction_id: direction.id, operation_id: operation.id }],
      estimate_hash: sha256({ kind: 'derive', request_hash: operation.request_hash, candidate_id: candidate.id }),
      confirmed_at: now,
      created_at: now,
    }
    const persisted = await this.repository.createGenerationRoundWithOperations({
      project,
      base_revision: input.base_revision,
      round,
      operations: [operation],
      transport_operations: [transport],
    })
    return {
      round: persisted.round,
      operation: await this.submitGenerationTransport(persisted.project, operation, transport, policy.provider, policy.model_id),
    }
  }

  private async submitGenerationTransport(
    project: ImageWorkbenchProject,
    operation: ImageOperationV2,
    transport: ImageOperation,
    provider: string,
    modelId: ImageWorkbenchProject['model'],
  ): Promise<ImageOperationV2> {
    const submittedAt = this.iso()
    const receipt: ProviderExecutionReceipt = {
      id: operation.execution_receipt_id!,
      project_id: operation.project_id,
      owner: operation.owner,
      capability: operation.kind === 'generate' ? 'image_generation' : operation.kind === 'edit' || operation.kind === 'inpaint' ? 'image_editing' : 'image_generation',
      registry_capability: 'ImageGeneration',
      provider,
      model_id: modelId,
      policy_revision: operation.input_refs.execution_policy_revision,
      prompt_compiler_version: 'image-brief-v2',
      idempotency_key: operation.idempotency_key,
      request_hash: operation.request_hash,
      input_asset_hashes: operation.input_refs.asset_hashes,
      submitted_at: submittedAt,
    }
    const pending = await this.repository.updateGenerationOperation({
      ...operation,
      status: 'queued',
      cost_state: 'submitted_charge_possible',
      submitted_at: operation.submitted_at ?? submittedAt,
      updated_at: submittedAt,
    })
    const refreshedTransport = await this.submitPersistedOperation(project, transport)
    const refusal = relayPolicyRefusal((refreshedTransport.result ?? {}) as RelayImageTask)
    await this.repository.saveExecutionReceipt({
      ...receipt,
      ...(refreshedTransport.remote_task_id ? { provider_request_id: refreshedTransport.remote_task_id } : {}),
      ...(refusal ? { refusal, completed_at: this.iso() } : {}),
    })
    return await this.syncGenerationOperationFromTransport(pending, refreshedTransport)
  }

  private async ensureGenerationReceiptForTransport(operation: ImageOperationV2, transport: ImageOperation): Promise<void> {
    if (!operation.execution_receipt_id) return
    const existing = await this.repository.getExecutionReceipt(operation.project_id, operation.execution_receipt_id).catch(error => {
      if (error instanceof ImageWorkbenchRepositoryError && error.status === 404) return null
      throw error
    })
    if (existing) return
    const entry = providerRegistryEntry(transport.image_operation.model)
    if (!entry) throw new ImageWorkbenchServiceError('图片操作缺少已注册 Provider', 500, 'IMAGE_OPERATION_CORRUPT')
    const refusal = relayPolicyRefusal((transport.result ?? {}) as RelayImageTask)
    await this.repository.saveExecutionReceipt({
      id: operation.execution_receipt_id,
      project_id: operation.project_id,
      owner: operation.owner,
      capability: operation.kind === 'generate' ? 'image_generation' : 'image_editing',
      registry_capability: 'ImageGeneration',
      provider: entry.provider,
      model_id: transport.image_operation.model,
      policy_revision: operation.input_refs.execution_policy_revision,
      prompt_compiler_version: 'image-brief-v2',
      ...(transport.remote_task_id ? { provider_request_id: transport.remote_task_id } : {}),
      idempotency_key: operation.idempotency_key,
      request_hash: operation.request_hash,
      input_asset_hashes: operation.input_refs.asset_hashes,
      ...(refusal ? { refusal, completed_at: this.iso() } : {}),
      submitted_at: operation.submitted_at ?? transport.remote_submission_started_at ?? this.iso(),
    })
  }

  private async syncGenerationOperationFromTransport(operation: ImageOperationV2, transport: ImageOperation): Promise<ImageOperationV2> {
    // Polling may have committed a Candidate Group while this caller still
    // holds the earlier queued projection. Always layer transport state onto
    // the newest formal record so a refresh cannot erase its discriminated
    // result, receipt link or cost facts.
    const current = await this.repository.getGenerationOperation(operation.project_id, operation.id).catch(() => operation)
    await this.ensureGenerationReceiptForTransport(current, transport)
    const refusal = relayPolicyRefusal((transport.result ?? {}) as RelayImageTask)
    const status: ImageOperationV2['status'] = refusal
      ? 'blocked_by_policy'
      : transport.outcome_unknown
      ? 'outcome_unknown'
      : transport.status === 'queued' || transport.status === 'running' || transport.status === 'committing' || transport.status === 'succeeded' || transport.status === 'failed' || transport.status === 'cancelled'
        ? transport.status
        : 'outcome_unknown'
    const safeError = refusal
      ? { code: 'MEDIA_IMAGE_POLICY_BLOCKED', message: mediaSafeError('MEDIA_IMAGE_POLICY_BLOCKED').message }
      : transport.error_code && transport.error
      ? { code: transport.error_code, message: mediaSafeError(transport.error_code).message }
      : undefined
    return await this.repository.updateGenerationOperation({
      ...current,
      status,
      remote_task_id: transport.remote_task_id,
      cost_state: status === 'succeeded' ? 'usage_recorded' : status === 'blocked_by_policy' ? 'not_submitted' : current.cost_state,
      ...(status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'blocked_by_policy' || status === 'outcome_unknown'
        ? { completed_at: current.completed_at ?? this.iso() }
        : {}),
      ...(safeError ? { safe_error: safeError } : {}),
      updated_at: this.iso(),
    })
  }

  async getGenerationOperation(projectId: string, operationId: string): Promise<ImageOperationV2> {
    const operation = await this.repository.getGenerationOperation(projectId, operationId)
    if (!operation.transport_task_id) return operation
    const storedTransport = await this.repository.getOperation(operation.transport_task_id)
    const transport = (operation.status === 'outcome_unknown' && storedTransport.remote_task_id)
      || (operation.status === 'cancelled' && operation.cancellation?.late_result_policy === 'retain_as_unadopted' && storedTransport.remote_task_id)
      ? await this.refreshPersistedOperation(storedTransport)
      : await this.getOperation(operation.transport_task_id)
    return await this.syncGenerationOperationFromTransport(operation, transport)
  }

  async findGenerationOperation(operationId: string): Promise<ImageOperationV2 | null> {
    const operation = await this.repository.findGenerationOperation(operationId)
    return operation ? await this.getGenerationOperation(operation.project_id, operation.id) : null
  }

  async cancelGenerationOperation(operationId: string): Promise<ImageOperationV2> {
    const stored = await this.repository.findGenerationOperation(operationId)
    if (!stored) throw new ImageWorkbenchServiceError('图片生成操作不存在', 404, 'IMAGE_OPERATION_NOT_FOUND')
    const operation = await this.getGenerationOperation(stored.project_id, stored.id)
    if (operation.status !== 'queued' || !operation.transport_task_id) {
      throw new ImageWorkbenchServiceError('当前图片操作不能安全取消', 409, 'IMAGE_OPERATION_NOT_CANCELLABLE')
    }
    const cancelled = await this.cancelOperation(operation.transport_task_id)
    return await this.repository.updateGenerationOperation({
      ...operation,
      status: cancelled.status === 'cancelled' ? 'cancelled' : 'outcome_unknown',
      cancellation: {
        requested_at: this.iso(),
        remote_state: cancelled.status === 'cancelled' ? 'confirmed' : 'too_late',
        late_result_policy: 'retain_as_unadopted',
      },
      completed_at: cancelled.status === 'cancelled' ? this.iso() : undefined,
      updated_at: this.iso(),
    })
  }

  async listGenerationOperations(projectId: string): Promise<ImageOperationV2[]> {
    const operations = await this.repository.listGenerationOperations(projectId)
    return await Promise.all(operations.map(async operation => await this.getGenerationOperation(projectId, operation.id)))
  }

  async getGenerationRound(projectId: string, roundId: string): Promise<{ round: ImageGenerationRound; operations: ImageOperationV2[] }> {
    const round = await this.repository.getGenerationRound(projectId, roundId)
    return { round, operations: await Promise.all(round.direction_operations.map(async direction => await this.getGenerationOperation(projectId, direction.operation_id))) }
  }

  async getCandidateGroup(projectId: string, groupId: string): Promise<{ group: ImageCandidateGroup; candidates: ImageCandidate[] }> {
    return await this.repository.getCandidateGroup(projectId, groupId)
  }

  async decideCandidate(projectId: string, candidateId: string, raw: DecideImageCandidateInput): Promise<ImageCandidateDecision> {
    const input = decideImageCandidateInputSchema.parse(raw)
    const project = await this.project(projectId)
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再决定候选')
    const now = this.iso()
    return await this.repository.decideCandidate({
      id: stableId('adopt', project.id, candidateId, input.idempotency_key, 'decision'),
      project_id: project.id,
      candidate_id: candidateId,
      decision: input.decision,
      actor: project.owner,
      idempotency_key: input.idempotency_key,
      request_hash: sha256({ candidate_id: candidateId, decision: input.decision, base_revision: input.base_revision }),
      created_at: now,
    })
  }

  async adoptCandidate(projectId: string, candidateId: string, raw: AdoptImageCandidateInput): Promise<{ project: ImageWorkbenchProject; adoptions: ImageCandidateAdoption[] }> {
    const input = adoptImageCandidateInputSchema.parse(raw)
    const project = await this.project(projectId)
    const candidate = await this.repository.getCandidate(projectId, candidateId)
    const delivery = await this.ensureDeliverySpec(project)
    const artboards = new Map(delivery.artboards.map(artboard => [artboard.id, artboard]))
    if (input.adoptions.some(adoption => !artboards.has(adoption.artboard_id))) {
      throw new ImageWorkbenchServiceError('候选采纳包含不属于当前交付规格的画板', 400, 'IMAGE_OPERATION_CORRUPT')
    }
    const asset = project.assets.find(item => item.id === candidate.asset_id && item.role === 'result')
    if (!asset) throw new ImageWorkbenchServiceError('候选资产不存在', 409, 'IMAGE_ASSET_NOT_FOUND')
    await this.assets.readVerified(asset)
    const requestHash = sha256({
      candidate_id: candidateId,
      base_revision: input.base_revision,
      adoptions: input.adoptions,
    })
    const now = this.iso()
    const adoptions: ImageCandidateAdoption[] = input.adoptions.map(adoption => ({
      id: stableId('adopt', project.id, candidateId, input.idempotency_key, adoption.artboard_id),
      project_id: project.id,
      candidate_id: candidateId,
      artboard_id: adoption.artboard_id,
      version_id: stableId('ver', project.id, candidateId, input.idempotency_key, adoption.artboard_id),
      canvas_id: stableId('canvas', project.id, candidateId, input.idempotency_key, adoption.artboard_id),
      canvas_revision: 0,
      placement: adoption.placement,
      actor: project.owner,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      created_at: now,
    }))
    const versions = adoptions.map(adoption => ({
      id: adoption.version_id,
      project_revision: project.revision + 1,
      asset_ids: [candidate.asset_id],
      kind: 'generated' as const,
      operation_id: undefined,
      width: candidate.width,
      height: candidate.height,
      created_at: now,
    }))
    return await this.repository.adoptCandidate({
      project,
      base_revision: input.base_revision,
      candidate_id: candidateId,
      request_hash: requestHash,
      idempotency_key: input.idempotency_key,
      adoptions,
      versions,
    })
  }

  private imageVersion(project: ImageWorkbenchProject, versionId: string): { version: ImageWorkbenchProject['versions'][number]; asset: MediaAsset } {
    const version = project.versions.find(candidate => candidate.id === versionId)
    if (!version) throw new ImageWorkbenchServiceError('找不到指定图片版本', 404, 'IMAGE_VERSION_NOT_FOUND')
    const assets = version.asset_ids
      .map(assetId => project.assets.find(asset => asset.id === assetId))
      .filter((asset): asset is MediaAsset => asset?.role === 'result')
    if (assets.length !== 1) throw new ImageWorkbenchServiceError('图片版本没有唯一结果资产', 409, 'IMAGE_VERSION_INVALID')
    return { version, asset: assets[0]! }
  }

  private async imageVersionBytes(project: ImageWorkbenchProject, versionId: string): Promise<{
    version: ImageWorkbenchProject['versions'][number]
    asset: MediaAsset
    verified: VerifiedImageBytes
  }> {
    const record = this.imageVersion(project, versionId)
    try {
      return { ...record, verified: await this.assets.readVerified(record.asset) }
    } catch (error) {
      if (error instanceof ImageAssetStoreError) {
        throw new ImageWorkbenchServiceError(error.message, error.status, error.code)
      }
      throw error
    }
  }

  async selectVersion(projectId: string, raw: SelectImageVersionInput): Promise<ImageWorkbenchProject> {
    const input = selectImageVersionInputSchema.parse(raw)
    const project = await this.project(projectId)
    this.assertRevision(project, input.revision, '图片项目已更新，请刷新后再选择版本')
    await this.imageVersionBytes(project, input.version_id)
    return await this.repository.saveProject({
      ...project,
      current_version_id: input.version_id,
      revision: project.revision + 1,
    })
  }

  private async assertCompositeSources(project: ImageWorkbenchProject, layers: CommitImageVersionInput['image_layers']): Promise<void> {
    const assets = new Map(this.referenceAssets(project).map(asset => [asset.id, asset]))
    for (const layer of layers ?? []) {
      const asset = assets.get(layer.source_asset_id)
      if (!asset) throw new ImageWorkbenchServiceError('图片图层引用的素材不存在', 400, 'IMAGE_LAYER_SOURCE_MISSING')
      await this.assets.readVerified(asset)
    }
  }

  async commitVersion(projectId: string, raw: CommitImageVersionInput): Promise<ImageWorkbenchProject> {
    const input = commitImageVersionInputSchema.parse(raw)
    const project = await this.project(projectId)
    this.assertRevision(project, input.revision, '图片项目已更新，请刷新后再提交版本')
    await this.assertNoActiveOperation(project)
    const base = await this.imageVersionBytes(project, input.base_version_id)
    const rendered = await this.assets.verifyDataUrl(input.rendered_image)
    if (rendered.mime_type !== 'image/png' || rendered.width !== input.width || rendered.height !== input.height) {
      throw new ImageWorkbenchServiceError('渲染结果尺寸或格式与声明不一致', 400, 'IMAGE_DIMENSIONS_MISMATCH')
    }
    if (input.kind === 'upscale') {
      if (input.width !== base.verified.width * input.scale! || input.height !== base.verified.height * input.scale!) {
        throw new ImageWorkbenchServiceError('放大结果必须严格匹配基础版本与倍数', 400, 'IMAGE_UPSCALE_MISMATCH')
      }
    } else if (input.kind === 'text_layout') {
      if (input.width !== base.verified.width || input.height !== base.verified.height) {
        throw new ImageWorkbenchServiceError('文字排版不能改变基础画布尺寸', 400, 'IMAGE_TEXT_CANVAS_MISMATCH')
      }
      if (input.text_layers.some(layer => layer.x > input.width || layer.y > input.height || (layer.max_width ?? input.width) > input.width)) {
        throw new ImageWorkbenchServiceError('文字图层超出基础画布', 400, 'IMAGE_TEXT_LAYER_OUT_OF_BOUNDS')
      }
      const renderedText = new Set(input.text_layers.map(layer => layer.text))
      if ((project.brief?.exact_text ?? []).some(text => !renderedText.has(text))) {
        throw new ImageWorkbenchServiceError('文字图层缺少 Brief 中要求的精确文字', 400, 'IMAGE_EXACT_TEXT_MISSING')
      }
    } else {
      if (input.width !== base.verified.width || input.height !== base.verified.height) {
        throw new ImageWorkbenchServiceError('图片组合不能改变基础画布尺寸', 400, 'IMAGE_COMPOSITE_CANVAS_MISMATCH')
      }
      if (input.image_layers.some(layer => layer.x + layer.width > input.width || layer.y + layer.height > input.height)) {
        throw new ImageWorkbenchServiceError('图片图层超出基础画布', 400, 'IMAGE_LAYER_OUT_OF_BOUNDS')
      }
      await this.assertCompositeSources(project, input.image_layers)
    }
    const outputId = id('out')
    const operationId = stableId('op', project.id, input.kind, String(project.revision), input.base_version_id)
    const versionId = stableId('ver', project.id, operationId, outputId)
    const now = this.iso()
    const persisted = await this.assets.persist(project.id, outputId, 'result', rendered, versionId, now)
    const output = {
      id: outputId,
      operation_id: operationId,
      version_id: versionId,
      version_kind: input.kind,
      parent_version_id: input.base_version_id,
      width: rendered.width,
      height: rendered.height,
      text_layers: input.kind === 'text_layout' ? input.text_layers : undefined,
      image_layers: input.kind === 'composite' ? input.image_layers : undefined,
      mime_type: rendered.mime_type,
      asset_path: `/api/images/projects/${project.id}/outputs/${outputId}/content`,
    }
    return await this.repository.saveProject(imageWorkbenchProjectSchema.parse({
      ...project,
      state: 'ready',
      current_version_id: versionId,
      assets: [...project.assets, persisted.asset],
      versions: [...project.versions, {
        id: versionId,
        parent_version_id: input.base_version_id,
        project_revision: project.revision + 1,
        asset_ids: [outputId],
        kind: input.kind,
        operation_id: operationId,
        width: rendered.width,
        height: rendered.height,
        text_layers: input.kind === 'text_layout' ? input.text_layers : undefined,
        image_layers: input.kind === 'composite' ? input.image_layers : undefined,
        created_at: now,
      }],
      outputs: [...project.outputs, output],
      revision: project.revision + 1,
      error: undefined,
      error_code: undefined,
      notice: undefined,
    }))
  }

  async saveOutput(projectId: string, raw: SaveImageOutputInput): Promise<SaveImageOutputResult> {
    const input = saveImageOutputInputSchema.parse(raw)
    const project = await this.project(projectId)
    const output = input.output_id ? project.outputs.find(candidate => candidate.id === input.output_id) : undefined
    const versionId = input.version_id ?? output?.version_id
    if (!versionId) throw new ImageWorkbenchServiceError('找不到图片版本', 404, 'IMAGE_OUTPUT_NOT_FOUND')
    const source = await this.imageVersionBytes(project, versionId)
    try {
      const verification = await this.assets.verifiedExport(source.asset, input.output_path)
      return { path: input.output_path, verification }
    } catch (error) {
      if (error instanceof ImageAssetStoreError) throw new ImageWorkbenchServiceError(error.message, error.status, error.code)
      throw error
    }
  }

  private async contentResponse(projectId: string, assetId: string, role: 'reference' | 'mask' | 'result'): Promise<Response> {
    const project = await this.project(projectId)
    const asset = project.assets.find(candidate => candidate.id === assetId && candidate.role === role)
    if (!asset?.mime_type || !isSupportedImageMime(asset.mime_type)) {
      throw new ImageWorkbenchServiceError('图片资产不存在', 404, 'IMAGE_ASSET_NOT_FOUND')
    }
    return await this.assets.response(
      project.id,
      role === 'reference' ? 'references' : role === 'mask' ? 'masks' : 'results',
      `${asset.id}.${extensionForMime(asset.mime_type)}`,
    )
  }

  async referenceResponse(projectId: string, assetId: string): Promise<Response> {
    return await this.contentResponse(projectId, assetId, 'reference')
  }

  async layerAssetResponse(projectId: string, assetId: string): Promise<Response> {
    return await this.contentResponse(projectId, assetId, 'reference')
  }

  async outputResponse(projectId: string, outputId: string): Promise<Response> {
    return await this.contentResponse(projectId, outputId, 'result')
  }

  async candidateResponse(projectId: string, candidateId: string): Promise<Response> {
    const candidate = await this.repository.getCandidate(projectId, candidateId)
    return await this.contentResponse(projectId, candidate.asset_id, 'result')
  }

  async getOperation(operationId: string): Promise<ImageOperation> {
    let operation = await this.repository.getOperation(operationId)
    operation = await this.fenceInterruptedSubmission(operation)
    if (operation.status === 'succeeded') return await this.acknowledgeRemoteResult(operation)
    if (!operation.remote_task_id || ['failed', 'cancelled'].includes(operation.status)) return operation
    return await this.refreshPersistedOperation(operation)
  }

  async listOperationEvents(projectId: string, after = 0, limit = 200): Promise<{
    events: ImageOperationEvent[]
    cursor: number
    reset_required: boolean
  }> {
    await this.project(projectId)
    return await this.repository.listOperationEvents(projectId, after, limit)
  }

  async waitForOperationEvents(projectId: string, after = 0, limit = 200, waitMs = 25_000): Promise<{
    events: ImageOperationEvent[]
    cursor: number
    reset_required: boolean
  }> {
    let page = await this.listOperationEvents(projectId, after, limit)
    if (page.events.length > 0 || page.reset_required || waitMs <= 0) return page

    // Event long-polling is also this workbench's reconciliation clock for a
    // persisted remote image operation. Keep that responsibility here rather
    // than adding a renderer timer or coupling image work to an Agent Thread.
    let remoteRefreshDelay = await this.remoteRefreshDelay(projectId)
    if (remoteRefreshDelay === 0) {
      await this.refreshActiveRemoteOperation(projectId)
      page = await this.listOperationEvents(projectId, after, limit)
      if (page.events.length > 0 || page.reset_required) return page
      remoteRefreshDelay = await this.remoteRefreshDelay(projectId)
    }

    const boundedWaitMs = Math.max(1, Math.min(
      25_000,
      Math.trunc(waitMs),
      remoteRefreshDelay ?? 25_000,
    ))
    await this.repository.waitForOperationEvent(projectId, after, boundedWaitMs)
    page = await this.listOperationEvents(projectId, after, limit)
    if (page.events.length > 0 || page.reset_required) return page

    // A timeout may have reached the Relay-provided polling deadline. Re-read
    // it because a concurrent local event can have moved that deadline.
    if (await this.remoteRefreshDelay(projectId) === 0) {
      await this.refreshActiveRemoteOperation(projectId)
    }
    return await this.listOperationEvents(projectId, after, limit)
  }

  private async remoteRefreshDelay(projectId: string): Promise<number | null> {
    const project = await this.project(projectId).catch(() => null)
    if (!project?.task_id) return null
    const operation = await this.repository.getOperation(project.task_id).catch(() => null)
    if (!operation || !['queued', 'running'].includes(operation.status)) return null
    const interval = (operation.poll_after_seconds ?? (operation.status === 'running' ? 3 : 15)) * 1_000
    return Math.max(0, interval - Math.max(0, this.now().getTime() - Date.parse(operation.updated_at)))
  }

  private async refreshActiveRemoteOperation(projectId: string): Promise<void> {
    const project = await this.project(projectId).catch(() => null)
    if (!project?.task_id) return
    const operation = await this.repository.getOperation(project.task_id).catch(() => null)
    if (operation && ['queued', 'running'].includes(operation.status)) {
      await this.getOperation(operation.id)
    }
  }

  private async fetchGatewayJson(input: RequestInfo | URL, init: RequestInit): Promise<{
    response: Response
    body: RelayImageTask
  }> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('image gateway response deadline exceeded'))
      }, this.imageResultTimeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    const request = async () => {
      const response = await this.fetchImpl(input, { ...init, signal: controller.signal })
      const text = await response.text()
      if (text.length > 4 * 1024 * 1024) throw new Error('image gateway response too large')
      let body: RelayImageTask = {}
      if (text) {
        try {
          body = JSON.parse(text) as RelayImageTask
        } catch {
          body = { message: '图片服务返回了无效数据' }
        }
      }
      return { response, body }
    }
    try {
      return await Promise.race([request(), timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  private operation(value: unknown): ImageOperation {
    const task = mediaTaskSchema.parse(value)
    if (task.kind !== 'image.generate' || !task.image_operation) {
      throw new ImageWorkbenchServiceError('图片操作记录无效', 500, 'IMAGE_OPERATION_CORRUPT')
    }
    return task as ImageOperation
  }

  private async referenceDataUrls(
    project: ImageWorkbenchProject,
    references: ImageWorkbenchProject['references'] = project.references,
  ): Promise<string[]> {
    const assets = new Map(this.referenceAssets(project).map(asset => [asset.id, asset]))
    return await Promise.all(references.map(async reference => {
      const asset = assets.get(reference.asset_id)
      if (!asset) throw new ImageWorkbenchServiceError('图片参考素材已经丢失', 409, 'REFERENCE_IMAGE_MISSING')
      const verified = await this.assets.providerUpload(asset)
      return `data:${verified.mime_type};base64,${verified.bytes.toString('base64')}`
    }))
  }

  private async imageSubmissionPayload(project: ImageWorkbenchProject, operation: ImageOperation): Promise<Record<string, unknown>> {
    const imageOperation = operation.image_operation
    if (imageOperation.kind === 'generate') {
      const providerReferences = project.references.filter(reference => reference.role !== 'logo' && reference.role !== 'qrcode')
      const references = await this.referenceDataUrls(project, providerReferences)
      return {
        mode: references.length > 0 ? 'edit' : 'generate',
        model: imageOperation.model,
        prompt: imageOperation.instruction ?? project.prompt,
        n: imageOperation.output_count,
        size: project.size,
        ...(imageOperation.model === 'doubao-seedream-4-5-251128' ? { response_format: 'b64_json' } : {}),
        ...(references.length > 0 ? { images: references } : {}),
      }
    }
    if (!imageOperation.instruction || (!imageOperation.base_version_id && !imageOperation.base_candidate_asset_id)) {
      throw new ImageWorkbenchServiceError('图片编辑操作缺少基础候选或编辑要求', 500, 'IMAGE_OPERATION_CORRUPT')
    }
    const candidateAsset = imageOperation.base_candidate_asset_id
      ? project.assets.find(asset => asset.id === imageOperation.base_candidate_asset_id && asset.role === 'result')
      : undefined
    const base = candidateAsset
      ? { asset: candidateAsset, verified: await this.assets.readVerified(candidateAsset) }
      : await this.imageVersionBytes(project, imageOperation.base_version_id!)
    let mask: string | undefined
    if (imageOperation.mask_asset_id) {
      const asset = project.assets.find(candidate => candidate.id === imageOperation.mask_asset_id && candidate.role === 'mask')
      if (!asset) throw new ImageWorkbenchServiceError('局部重绘蒙版已经丢失', 409, 'IMAGE_MASK_INVALID')
      const verified = await this.assets.providerUpload(asset)
      if (verified.mime_type !== 'image/png') throw new ImageWorkbenchServiceError('局部重绘蒙版格式无效', 409, 'IMAGE_MASK_INVALID')
      mask = `data:image/png;base64,${verified.bytes.toString('base64')}`
    }
    const providerBase = await this.assets.providerUpload(base.asset)
    return {
      mode: 'edit',
      model: imageOperation.model,
      prompt: imageOperation.instruction,
      n: imageOperation.output_count,
      size: project.size,
      ...(imageOperation.model === 'doubao-seedream-4-5-251128' ? { response_format: 'b64_json' } : {}),
      images: [`data:${providerBase.mime_type};base64,${providerBase.bytes.toString('base64')}`],
      ...(mask ? { mask } : {}),
    }
  }

  private async failOperation(
    operation: ImageOperation,
    errorCode: MediaSafeErrorCode,
    outcomeUnknown = false,
    providerReceiptHash?: string,
  ): Promise<ImageOperation> {
    const safe = mediaSafeError(errorCode)
    const next = this.operation({
      ...operation,
      status: 'failed',
      stage: '生成失败',
      error: safe.message,
      error_code: safe.code,
      outcome_unknown: outcomeUnknown,
      provider_receipt_hash: providerReceiptHash,
    })
    const project = await this.project(operation.project_id).catch(() => null)
    if (project?.task_id === operation.id) {
      return (await this.repository.saveProjectAndOperation({
        ...project,
        state: 'failed',
        error: safe.message,
        error_code: safe.code,
      }, next)).operation
    }
    return await this.repository.saveOperation(next)
  }

  private async fenceInterruptedSubmission(operation: ImageOperation): Promise<ImageOperation> {
    if (
      !operation.remote_task_id
      && operation.remote_submission_started_at
      && !operation.outcome_unknown
      && ['queued', 'running'].includes(operation.status)
      && !this.activeSubmissions.has(operation.id)
    ) {
      return await this.failOperation(operation, 'MEDIA_IMAGE_OUTCOME_UNKNOWN', true)
    }
    return operation
  }

  async recoverInterruptedOperations(): Promise<void> {
    const operations = await this.repository.listOperations()
    await Promise.all(operations.map(async operation => {
      const fenced = await this.fenceInterruptedSubmission(operation)
      // `committing` means CAS may have published while the SQLite project
      // transaction did not. Re-read the exact accepted remote task; do not
      // manufacture success from partial local files and never POST again.
      const recovered = fenced.status === 'committing'
        ? await this.refreshPersistedOperation(fenced)
        : fenced
      await this.acknowledgeRemoteResult(recovered)
      const generation = await this.repository.getGenerationOperationByTransportTask(recovered.id)
      if (generation) await this.syncGenerationOperationFromTransport(generation, recovered)
    }))
  }

  private legacyFile(root: string, locator: string): string | null {
    if (!locator || isAbsolute(locator)) return null
    const target = resolve(root, locator)
    const relation = relative(root, target)
    return relation && !relation.startsWith('..') && !isAbsolute(relation) ? target : null
  }

  private async legacyAssetBytes(projectId: string, asset: MediaAsset, sourceRoot = this.legacyMediaRoot): Promise<Buffer | null> {
    let path: string | null = null
    if (asset.storage.kind === 'cas') {
      const digest = /^sha256\/([a-f0-9]{64})$/.exec(asset.storage.locator)?.[1]
      path = digest ? join(sourceRoot, 'cas', 'sha256', digest) : null
    } else if (asset.storage.kind === 'managed') {
      path = this.legacyFile(join(sourceRoot, 'assets'), asset.storage.locator)
    }
    if (!path) return null
    return await readFile(path).catch(() => null)
  }

  private async legacyReferenceBytes(projectId: string, fileName: string, sourceRoot = this.legacyMediaRoot): Promise<Buffer | null> {
    if (!/^[a-z0-9][a-z0-9_.-]{2,120}$/.test(fileName)) return null
    return await readFile(join(sourceRoot, 'assets', projectId, 'references', fileName)).catch(() => null)
  }

  private async legacyOutputBytes(projectId: string, output: ImageWorkbenchProject['outputs'][number], sourceRoot = this.legacyMediaRoot): Promise<Buffer | null> {
    if (output.data_url) return (await this.assets.verifyDataUrl(output.data_url)).bytes
    const genericPrefix = `/api/media/assets/${projectId}/`
    if (output.asset_path?.startsWith(genericPrefix)) {
      const fileName = output.asset_path.slice(genericPrefix.length)
      if (!/^[a-z0-9][a-z0-9_.-]{2,120}$/.test(fileName)) return null
      return await readFile(join(sourceRoot, 'assets', projectId, fileName)).catch(() => null)
    }
    const currentPrefix = `/api/images/projects/${projectId}/outputs/`
    const currentAssetId = output.asset_path?.startsWith(currentPrefix)
      ? output.asset_path.slice(currentPrefix.length).replace(/\/content$/, '')
      : ''
    if (!/^[a-z0-9][a-z0-9_-]{7,79}$/.test(currentAssetId)) return null
    const mimeType = output.mime_type
    return await readFile(join(sourceRoot, 'assets', projectId, 'results', `${currentAssetId}.${extensionForMime(mimeType)}`)).catch(() => null)
  }

  /**
   * One-way, idempotent import from both former JSON layouts. It reads their
   * files directly and never asks MediaProjectService to keep owning an image
   * project. Missing/corrupt legacy assets remain in the old store and are not
   * invented as new candidate or version facts.
   */
  async migrateLegacyMediaStore(): Promise<{ migrated_project_ids: string[]; skipped_project_ids: string[] }> {
    const currentImageReader = new LegacyImageProjectReader(this.repository.paths().root)
    const [currentImageStore, genericMediaStore] = await Promise.all([
      currentImageReader.read(),
      this.legacyReader.read(),
    ])
    // A pre-15.1 ImageWorkbenchRepository wrote JSON below the current image
    // root. Read it first, but do not drop an older generic-media project that
    // was never copied there. A duplicate id is idempotently skipped after the
    // first (newer image-root) source has been imported.
    const legacySources = [
      { kind: 'image-workbench-json-v1', store: currentImageStore, root: this.repository.paths().root },
      ...(this.legacyMediaRoot === this.repository.paths().root ? [] : [{ kind: 'generic-media-json-v1', store: genericMediaStore, root: this.legacyMediaRoot }]),
    ]
    const migrationHash = `sha256:${createHash('sha256')
      .update(legacySources.map(source => source.store.source_hash).join('\0'))
      .digest('hex')}`

    const migratedProjectIds: string[] = []
    const skippedProjectIds: string[] = []
    for (const { kind: sourceKind, store: legacyStore, root: legacyRoot } of legacySources) {
      for (const legacy of legacyStore.projects) {
        const journal = legacyStore.journals.get(legacy.id)
        const projectOperations = legacyProjectOperations(legacyStore, legacy.id)
        const projectSourceHash = legacyProjectSourceHash(legacyStore, legacy)
        const receipt = await this.repository.projectMigrationReceipt(sourceKind, legacy.id)
        if (receipt?.status === 'complete' && receipt.source_hash === projectSourceHash) {
          skippedProjectIds.push(legacy.id)
          continue
        }
        const existing = await this.repository.getProject(legacy.id).catch(error => {
          if (error instanceof ImageWorkbenchRepositoryError && error.code === 'IMAGE_PROJECT_NOT_FOUND') return null
          throw error
        })
        const invalidation = await this.repository.projectMigrationInvalidation(sourceKind, legacy.id)
        if (existing && invalidation) {
          throw new ImageWorkbenchServiceError('旧图片迁移源已变化，需要重新核对后再迁移', 409, 'IMAGE_LEGACY_SOURCE_CHANGED')
        }
        if (existing && receipt) {
          // The SQLite project may now have user edits. It is unsafe to claim
          // that a changed legacy snapshot has been migrated by merely merging
          // a few Operations, so revoke completion and require resolution.
          await this.repository.invalidateProjectMigrationReceipt(sourceKind, legacy.id, receipt.source_hash, projectSourceHash)
          throw new ImageWorkbenchServiceError('旧图片迁移源已变化，需要重新核对后再迁移', 409, 'IMAGE_LEGACY_SOURCE_CHANGED')
        }

        if (!existing) {
          const now = this.iso()
          const assets: MediaAsset[] = []
          const references: ImageWorkbenchProject['references'] = []
          const referenceNames: string[] = []
          const seenReferenceIds = new Set<string>()
          const legacyAssets = new Map(legacy.assets.map(asset => [asset.id, asset]))
          const legacyReferenceRoles = new Map(legacy.references.map(reference => [reference.asset_id, reference.role]))
          const importReference = async (assetId: string, role: ImageWorkbenchProject['references'][number]['role'], bytes: Buffer): Promise<void> => {
            if (seenReferenceIds.has(assetId)) return
            const verified = await this.assets.verify(bytes)
            const stored = await this.assets.persist(legacy.id, assetId, 'reference', verified, legacy.id, now)
            seenReferenceIds.add(assetId)
            assets.push(stored.asset)
            references.push({ asset_id: assetId, role })
            referenceNames.push(stored.file_name)
          }
          for (const reference of legacy.references) {
            const asset = legacyAssets.get(reference.asset_id)
            const bytes = asset ? await this.legacyAssetBytes(legacy.id, asset, legacyRoot) : null
            if (bytes) await importReference(reference.asset_id, reference.role, bytes)
          }
          for (const fileName of legacy.reference_image_assets ?? []) {
            const assetId = fileName.slice(0, fileName.lastIndexOf('.'))
            if (!assetId) continue
            const bytes = await this.legacyReferenceBytes(legacy.id, fileName, legacyRoot)
            if (bytes) await importReference(assetId, legacyReferenceRoles.get(assetId) ?? 'unclassified', bytes)
          }
          for (const [index, dataUrl] of legacy.reference_images.entries()) {
            const assetId = id('ref')
            const verified = await this.assets.verifyDataUrl(dataUrl)
            await importReference(assetId, legacy.references[index]?.role ?? 'unclassified', verified.bytes)
          }

          const outputs: ImageWorkbenchProject['outputs'] = []
          const versions: ImageWorkbenchProject['versions'] = []
          const outputById = new Map(legacy.outputs.map(output => [output.id, output]))
          const storedResults = new Map<string, MediaAsset>()
          const storedOutputs = new Set<string>()
          const importResult = async (
            assetId: string,
            version: ImageWorkbenchProject['versions'][number],
            output?: ImageWorkbenchProject['outputs'][number],
          ): Promise<void> => {
            let stored = storedResults.get(assetId)
            if (!stored) {
              const asset = legacyAssets.get(assetId)
              const bytes = (asset ? await this.legacyAssetBytes(legacy.id, asset, legacyRoot) : null)
                ?? (output ? await this.legacyOutputBytes(legacy.id, output, legacyRoot) : null)
              if (!bytes) throw new ImageWorkbenchServiceError('旧图片版本缺少可验证字节，迁移未完成', 409, 'IMAGE_LEGACY_VERSION_INCOMPLETE')
              const verified = await this.assets.verify(bytes)
              stored = (await this.assets.persist(legacy.id, assetId, 'result', verified, version.id, version.created_at)).asset
              storedResults.set(assetId, stored)
              assets.push(stored)
            }
            if (output && !storedOutputs.has(output.id)) {
              storedOutputs.add(output.id)
              outputs.push({
                ...output,
                id: assetId,
                version_id: version.id,
                data_url: undefined,
                url: undefined,
                asset_path: `/api/images/projects/${legacy.id}/outputs/${assetId}/content`,
              })
            }
          }
          for (const version of legacy.versions) {
            for (const assetId of version.asset_ids) {
              await importResult(assetId, version, outputById.get(assetId))
            }
            // Preserve the historical Version object exactly; storage ownership
            // is the only fact translated during the migration.
            versions.push(version)
          }
          for (const output of legacy.outputs) {
            if (storedOutputs.has(output.id)) continue
            const version = output.version_id
              ? legacy.versions.find(candidate => candidate.id === output.version_id)
              : undefined
            const outputVersion = version ?? {
              id: stableId('ver', legacy.id, 'legacy-output', output.id),
              parent_version_id: output.parent_version_id,
              project_revision: legacy.revision,
              asset_ids: [output.id],
              kind: output.version_kind ?? 'generated',
              operation_id: output.operation_id,
              width: output.width,
              height: output.height,
              text_layers: output.text_layers,
              image_layers: output.image_layers,
              created_at: legacy.updated_at,
            }
            await importResult(output.id, outputVersion, output)
            if (!version) versions.push(outputVersion)
          }
          if (!legacy.versions.every(version => versions.some(candidate => candidate.id === version.id))) {
            throw new ImageWorkbenchServiceError('旧图片版本未完整迁移', 409, 'IMAGE_LEGACY_VERSION_INCOMPLETE')
          }
          // Masks may be referenced by a persisted edit operation. They are not
          // visible candidates but retain the same verified project ownership.
          for (const asset of legacy.assets.filter(asset => asset.role === 'mask')) {
            const bytes = await this.legacyAssetBytes(legacy.id, asset, legacyRoot)
            if (!bytes) continue
            const verified = await this.assets.verify(bytes)
            assets.push((await this.assets.persist(legacy.id, asset.id, 'mask', verified, asset.version_id, asset.created_at)).asset)
          }

          const legacyTask = legacy.task_id ? projectOperations.find(operation => operation.id === legacy.task_id) : undefined
          const imported = imageWorkbenchProjectSchema.parse({
            ...legacy,
            owner: STANDALONE_IMAGE_OWNER,
            writer_fence: INITIAL_WRITER_FENCE,
            assets,
            versions,
            references,
            reference_images: [],
            reference_image_assets: referenceNames,
            reference_image_count: references.length,
            task_id: legacyTask?.id,
            outputs,
            current_version_id: legacy.current_version_id,
            updated_at: now,
          })
          const inserted = await this.repository.importLegacyProject(imported)
          if (inserted) this.injectCrash('after_project_migration_before_operations')
        }
        for (const legacyOperation of projectOperations) await this.repository.importLegacyOperation(legacyOperation)
        if (journal) {
          for (const event of journal.events) {
            await this.repository.importLegacyOperation(event.task as ImageOperation)
            await this.repository.importLegacyEvent(event)
          }
          await this.repository.preserveLegacyJournalCursor(legacy.id, journal.next_cursor)
        }
        await this.repository.recordProjectMigrationReceipt({
          source_kind: sourceKind,
          project_id: legacy.id,
          source_hash: projectSourceHash,
          operation_count: projectOperations.length,
          journal_next_cursor: journal?.next_cursor ?? null,
          version_count: legacy.versions.length,
          current_version_id: legacy.current_version_id ?? null,
        })
        migratedProjectIds.push(legacy.id)
      }
    }
    await this.repository.recordMigrationReceipt('image-legacy-json-v1', migrationHash)
    await this.repository.reconcileCasAfterLegacyMigration()
    return { migrated_project_ids: migratedProjectIds, skipped_project_ids: skippedProjectIds }
  }

  private submitPersistedOperation(project: ImageWorkbenchProject, operation: ImageOperation): Promise<ImageOperation> {
    const active = this.activeSubmissions.get(operation.id)
    if (active) return active
    const submission = this.performSubmission(project, operation)
      .finally(() => this.activeSubmissions.delete(operation.id))
    this.activeSubmissions.set(operation.id, submission)
    return submission
  }

  private async performSubmission(project: ImageWorkbenchProject, original: ImageOperation): Promise<ImageOperation> {
    if (!productGatewayConfigured()) {
      throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'GATEWAY_NOT_CONFIGURED')
    }
    const idempotencyKey = original.idempotency_key
    if (!idempotencyKey) {
      throw new ImageWorkbenchServiceError('图片操作缺少幂等凭据', 500, 'IMAGE_OPERATION_CORRUPT')
    }
    const target = productGatewayTarget()
    if (!target) throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'GATEWAY_NOT_CONFIGURED')
    const payload = await this.imageSubmissionPayload(project, original)
    let operation = await this.repository.saveOperation(this.operation({
      ...original,
      status: 'queued',
      progress: Math.max(original.progress, 1),
      stage: original.outcome_unknown ? '正在确认上次提交' : '正在提交图片任务',
      remote_submission_started_at: original.remote_submission_started_at ?? this.iso(),
      outcome_unknown: false,
      error: undefined,
      error_code: undefined,
    }))
    try {
      const { response, body } = await this.fetchGatewayJson(`${target.baseUrl}/v1/images/tasks`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
        },
        body: JSON.stringify(payload),
      })
      if (!response.ok || !body.task_id) {
        const refusal = relayPolicyRefusal(body)
        if (refusal) {
          const safe = mediaSafeError('MEDIA_IMAGE_POLICY_BLOCKED')
          return await this.repository.saveOperation(this.operation({
            ...operation,
            status: 'failed',
            progress: 0,
            stage: '图片请求未通过内容策略',
            result: { policy_refusal: refusal },
            error: safe.message,
            error_code: safe.code,
            provider_receipt_hash: body.provider_receipt_hash,
          }))
        }
        return await this.failOperation(
          operation,
          response.status >= 500 || response.status === 0 ? 'MEDIA_IMAGE_OUTCOME_UNKNOWN' : 'MEDIA_IMAGE_UNAVAILABLE',
          response.status >= 500 || response.status === 0,
          body.provider_receipt_hash,
        )
      }
      const next = this.operation({
        ...operation,
        status: body.status === 'running' ? 'running' : 'queued',
        progress: body.status === 'running' ? 10 : 2,
        stage: body.reused ? '已复用同一图片任务' : '已进入图片队列',
        remote_task_id: body.task_id,
        poll_after_seconds: relayPollAfterSeconds(body.poll_after_seconds, body.status === 'running' ? 3 : 15),
        provider_receipt_hash: body.provider_receipt_hash,
      })
      const latest = await this.project(project.id)
      if (latest.task_id === operation.id) {
        operation = (await this.repository.saveProjectAndOperation({
          ...latest,
          state: next.status === 'running' ? 'generating' : 'queued',
          error: undefined,
          error_code: undefined,
        }, next)).operation
      } else {
        operation = await this.repository.saveOperation(next)
      }
      return operation
    } catch {
      return await this.failOperation(operation, 'MEDIA_IMAGE_OUTCOME_UNKNOWN', true)
    }
  }

  private refreshPersistedOperation(operation: ImageOperation): Promise<ImageOperation> {
    const active = this.activeRefreshes.get(operation.id)
    if (active) return active
    const refresh = this.refreshOperation(operation)
      .finally(() => this.activeRefreshes.delete(operation.id))
    this.activeRefreshes.set(operation.id, refresh)
    return refresh
  }

  private async readRemoteResult(target: { baseUrl: string; token: string }, body: RelayImageTask): Promise<RelayImageTask> {
    if (body.data?.length) return body
    const handoffUrls = body.result_urls ?? (body.result_url ? [body.result_url] : [])
    if (handoffUrls.length === 0) return body
    if (handoffUrls.length > 4) throw new ImageWorkbenchServiceError('远程图片结果数量异常', 502, 'IMAGE_RESULT_INVALID')
    const trusted = handoffUrls.map(value => trustedResultUrl(value, target.baseUrl))
    if (trusted.some(value => !value)) throw new ImageWorkbenchServiceError('远程图片结果地址不可信', 502, 'IMAGE_RESULT_INVALID')
    const results = await Promise.all(trusted.map(url => this.fetchGatewayJson(url!, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    })))
    const failure = results.find(result => !result.response.ok)
    if (failure) throw new ImageWorkbenchServiceError(
      boundedMessage(failure.body.error ?? failure.body.message),
      failure.response.status || 502,
      'IMAGE_RESULT_UNAVAILABLE',
    )
    return { ...body, data: results.flatMap(result => result.body.data ?? []) }
  }

  private async acknowledgeGenerationRemoteResult(operation: ImageOperationV2, transport: ImageOperation): Promise<ImageOperation> {
    if (!transport.remote_task_id || !transport.provider_receipt_hash || transport.remote_result_acknowledged_at || !operation.result) return transport
    const target = productGatewayTarget()
    if (!target) return transport
    try {
      const { response, body } = await this.fetchGatewayJson(
        `${target.baseUrl}/v1/images/tasks/${encodeURIComponent(transport.remote_task_id)}/ack`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${target.token}`,
            [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
          },
        },
      )
      if (!response.ok || body.result_acknowledged !== true) return transport
      return await this.repository.saveOperation(this.operation({
        ...transport,
        remote_result_acknowledged_at: this.iso(),
      }))
    } catch {
      // Candidate metadata is already committed. Only ACK is retried.
      return transport
    }
  }

  private async acknowledgeRemoteResult(operation: ImageOperation): Promise<ImageOperation> {
    const generation = await this.repository.getGenerationOperationByTransportTask(operation.id)
    if (generation) return await this.acknowledgeGenerationRemoteResult(generation, operation)
    if (!operation.remote_task_id || !operation.provider_receipt_hash || operation.remote_result_acknowledged_at) return operation
    const result = imageGenerationTaskResultSchema.safeParse(operation.result)
    if (!result.success || result.data.outputs.length === 0) return operation
    const project = await this.project(operation.project_id).catch(() => null)
    if (!project) return operation
    for (const output of result.data.outputs) {
      if (!output.version_id) return operation
      try {
        const version = await this.imageVersionBytes(project, output.version_id)
        if (version.asset.id !== output.id) return operation
      } catch {
        return operation
      }
    }
    const target = productGatewayTarget()
    if (!target) return operation
    try {
      const { response, body } = await this.fetchGatewayJson(
        `${target.baseUrl}/v1/images/tasks/${encodeURIComponent(operation.remote_task_id)}/ack`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${target.token}`,
            [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
          },
        },
      )
      if (!response.ok || body.result_acknowledged !== true) return operation
      return await this.repository.saveOperation(this.operation({
        ...operation,
        remote_result_acknowledged_at: this.iso(),
      }))
    } catch {
      // The local project is already durable. Keep the relay result until a
      // later status read can acknowledge it; never resubmit generation here.
      return operation
    }
  }

  private async persistGenerationRemoteResults(operation: ImageOperationV2, transport: ImageOperation, body: RelayImageTask): Promise<ImageOperation> {
    const project = await this.project(transport.project_id)
    await this.ensureGenerationReceiptForTransport(operation, transport)
    const expectedCount = transport.image_operation.output_count
    const round = await this.repository.generationRoundForOperation(project.id, operation.id)
    const direction = round.direction_operations.find(item => item.operation_id === operation.id)
    if (!direction) throw new ImageWorkbenchServiceError('生成操作缺少创作方向', 500, 'IMAGE_OPERATION_CORRUPT')
    const receipt = await this.repository.getExecutionReceipt(project.id, operation.execution_receipt_id!)
    let committingTransport = await this.repository.saveOperation(this.operation({
      ...transport,
      status: 'committing',
      progress: 90,
      stage: '正在保存候选组',
      provider_receipt_hash: body.provider_receipt_hash ?? transport.provider_receipt_hash,
    }))
    let committingOperation = await this.repository.updateGenerationOperation({
      ...operation,
      status: 'committing',
      remote_task_id: committingTransport.remote_task_id,
      cost_state: 'submitted_charge_possible',
      updated_at: this.iso(),
    })
    const rawCandidates = body.data ?? []
    const invalid: Array<{ index: number; safe_error_code: string }> = []
    const saved: Array<{ candidate: ImageCandidate; asset: MediaAsset }> = []
    const groupId = stableId('grp', project.id, operation.id)
    const now = this.iso()
    for (let index = 0; index < expectedCount; index += 1) {
      const remote = rawCandidates[index]
      if (!remote?.b64_json || remote.url || !/^[A-Za-z0-9+/=]+$/.test(remote.b64_json)) {
        invalid.push({ index, safe_error_code: remote ? 'IMAGE_RESULT_INVALID' : 'IMAGE_RESULT_MISSING' })
        continue
      }
      try {
        const verified = await this.assets.verify(Buffer.from(remote.b64_json, 'base64'))
        const assetId = stableId('out', project.id, operation.id, String(index))
        const candidateId = stableId('cand', project.id, operation.id, String(index))
        const persisted = await this.assets.persist(project.id, assetId, 'result', verified, candidateId, now)
        saved.push({
          asset: persisted.asset,
          candidate: {
            id: candidateId,
            asset_id: assetId,
            candidate_index: index,
            ...(operation.base_candidate_id ? { derived_from_candidate_id: operation.base_candidate_id } : {}),
            creative_direction_id: direction.direction_id,
            content_hash: verified.content_hash,
            width: verified.width,
            height: verified.height,
            mime_type: verified.mime_type,
            created_at: now,
          },
        })
      } catch (error) {
        if (error instanceof ImageAssetStoreError) {
          invalid.push({ index, safe_error_code: error.code })
          continue
        }
        throw error
      }
    }
    if (rawCandidates.length > expectedCount) {
      invalid.push({ index: expectedCount - 1, safe_error_code: 'IMAGE_RESULT_COUNT_INVALID' })
    }
    if (saved.length === 0) {
      const failed = await this.failOperation(committingTransport, 'MEDIA_IMAGE_UNAVAILABLE', false, body.provider_receipt_hash)
      await this.syncGenerationOperationFromTransport(committingOperation, failed)
      return failed
    }
    const group: ImageCandidateGroup = {
      id: groupId,
      project_id: project.id,
      operation_id: operation.id,
      brief_snapshot_hash: operation.input_refs.brief_snapshot_hash!,
      creative_plan_id: round.creative_plan_id,
      creative_direction_id: direction.direction_id,
      generation_round_id: round.id,
      candidate_ids: saved.map(item => item.candidate.id),
      created_at: now,
    }
    committingOperation = {
      ...committingOperation,
      status: 'succeeded',
      result: {
        kind: 'candidate_group',
        candidate_group_id: group.id,
        expected_count: expectedCount,
        valid_count: saved.length,
        invalid,
      },
      cost_state: 'usage_recorded',
      completion_freshness: 'current',
      completed_at: now,
      updated_at: now,
    }
    const otherActive = (await this.repository.listGenerationOperations(project.id))
      .some(candidate => candidate.id !== operation.id && ['queued', 'running', 'cancelling', 'committing', 'outcome_unknown'].includes(candidate.status))
    const committed = await this.repository.commitCandidateGroup({
      project: {
        ...project,
        state: otherActive ? 'generating' : 'ready',
        error: undefined,
        error_code: undefined,
      },
      transport_operation: this.operation({
        ...committingTransport,
        status: 'succeeded',
        progress: 100,
        stage: '候选组已保存，等待用户采纳',
        provider_receipt_hash: body.provider_receipt_hash ?? committingTransport.provider_receipt_hash,
        result: { output_count: saved.length, outputs: [] },
      }),
      operation: committingOperation,
      receipt,
      group,
      candidates: saved.map(item => item.candidate),
      assets: saved.map(item => item.asset),
    })
    this.injectCrash('after_db_commit_before_relay_ack')
    return await this.acknowledgeGenerationRemoteResult(committed.operation, committed.transport_operation)
  }

  private async persistRemoteResults(operation: ImageOperation, body: RelayImageTask): Promise<ImageOperation> {
    const generation = await this.repository.getGenerationOperationByTransportTask(operation.id)
    if (generation) return await this.persistGenerationRemoteResults(generation, operation, body)
    const project = await this.project(operation.project_id)
    if (project.task_id !== operation.id) {
      return await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'succeeded',
        progress: 100,
        stage: '远程生成完成，但结果不再属于当前项目版本',
        provider_receipt_hash: body.provider_receipt_hash,
        result: { output_count: 0 },
      }))
    }
    const candidates = body.data ?? []
    const expectedCount = operation.image_operation.output_count
    if (candidates.length === 0 || candidates.length > expectedCount || candidates.some(candidate => !candidate.b64_json || candidate.url)) {
      return await this.failOperation(operation, 'MEDIA_IMAGE_UNAVAILABLE', false, body.provider_receipt_hash)
    }
    const persistedOutputs = project.outputs.filter(output => output.operation_id === operation.operation_id)
    if (persistedOutputs.length > 0) {
      if (persistedOutputs.length > expectedCount) {
        return await this.failOperation(operation, 'MEDIA_IMAGE_OUTCOME_UNKNOWN', true, body.provider_receipt_hash)
      }
      const recovered = await this.repository.saveOperation(this.operation({
        ...operation,
        status: 'succeeded',
        progress: 100,
        stage: '已恢复已提交图片候选',
        provider_receipt_hash: body.provider_receipt_hash,
        result: imageGenerationTaskResultSchema.parse({ output_count: persistedOutputs.length, outputs: persistedOutputs }),
      }))
      return await this.acknowledgeRemoteResult(recovered)
    }
    let committing = await this.repository.saveOperation(this.operation({
      ...operation,
      status: 'committing',
      progress: 90,
      stage: '正在保存图片候选',
      provider_receipt_hash: body.provider_receipt_hash,
    }))
    const now = this.iso()
    const parentVersionId = committing.image_operation.kind === 'generate'
      ? undefined
      : committing.image_operation.base_version_id
    const versionKind = committing.image_operation.kind === 'generate'
      ? 'generated' as const
      : committing.image_operation.kind
    const saved: Array<{ asset: MediaAsset; output: ImageWorkbenchProject['outputs'][number]; version: ImageWorkbenchProject['versions'][number] }> = []
    try {
      for (const candidate of candidates) {
        const bytes = Buffer.from(candidate.b64_json!, 'base64')
        const verified = await this.assets.verify(bytes)
        const outputId = id('out')
        const versionId = stableId('ver', project.id, committing.operation_id ?? committing.id, outputId)
        const persisted = await this.assets.persist(project.id, outputId, 'result', verified, versionId, now)
        saved.push({
          asset: persisted.asset,
          output: {
            id: outputId,
            operation_id: committing.operation_id,
            version_id: versionId,
            version_kind: versionKind,
            parent_version_id: parentVersionId,
            width: verified.width,
            height: verified.height,
            mime_type: verified.mime_type,
            asset_path: `/api/images/projects/${project.id}/outputs/${outputId}/content`,
            revised_prompt: candidate.revised_prompt,
          },
          version: {
            id: versionId,
            parent_version_id: parentVersionId,
            project_revision: project.revision + 1,
            asset_ids: [outputId],
            kind: versionKind,
            operation_id: committing.operation_id,
            width: verified.width,
            height: verified.height,
            created_at: now,
          },
        })
      }
    } catch (error) {
      if (error instanceof ImageAssetStoreError) {
        return await this.failOperation(committing, 'MEDIA_IMAGE_UNAVAILABLE', false, body.provider_receipt_hash)
      }
      throw error
    }
    const outputs = saved.map(candidate => candidate.output)
    const parsedResult = imageGenerationTaskResultSchema.parse({
      output_count: outputs.length,
      outputs,
      ...(body.input_fidelity_requested ? { input_fidelity_requested: body.input_fidelity_requested } : {}),
      ...(body.input_fidelity_status ? { input_fidelity_status: body.input_fidelity_status } : {}),
      ...(body.input_fidelity_risk ? { input_fidelity_risk: boundedMessage(body.input_fidelity_risk) } : {}),
    })
    const savedProject = imageWorkbenchProjectSchema.parse({
      ...project,
      state: 'ready',
      assets: [...project.assets, ...saved.map(candidate => candidate.asset)],
      versions: [...project.versions, ...saved.map(candidate => candidate.version)],
      outputs: [...project.outputs, ...outputs],
      current_version_id: operation.image_operation.kind === 'generate'
        ? project.current_version_id
        : outputs[0]?.version_id ?? project.current_version_id,
      notice: body.input_fidelity_risk
        ? boundedMessage(body.input_fidelity_risk)
        : undefined,
      error: undefined,
      error_code: undefined,
    })
    committing = (await this.repository.saveProjectAndOperation(savedProject, this.operation({
      ...committing,
      status: 'succeeded',
      progress: 100,
      stage: '图片候选已保存',
      provider_receipt_hash: body.provider_receipt_hash,
      result: parsedResult,
    }))).operation
    // The project write above is intentionally before success/ACK. An ACK is
    // only legal when every candidate is an owned, verified project asset.
    void savedProject
    this.injectCrash('after_db_commit_before_relay_ack')
    return await this.acknowledgeRemoteResult(committing)
  }

  private async refreshOperation(original: ImageOperation): Promise<ImageOperation> {
    if (!original.remote_task_id || !productGatewayConfigured()) return original
    const target = productGatewayTarget()
    if (!target) return original
    let response: Response
    let body: RelayImageTask
    try {
      const result = await this.fetchGatewayJson(
        `${target.baseUrl}/v1/images/tasks/${encodeURIComponent(original.remote_task_id)}`,
        {
          headers: {
            Authorization: `Bearer ${target.token}`,
            [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
            [MEDIA_RESULT_HANDOFF_HEADER]: MEDIA_RESULT_HANDOFF_DIRECT_V1,
          },
        },
      )
      response = result.response
      body = result.body
      if (response.ok && body.status === 'succeeded') body = await this.readRemoteResult(target, body)
    } catch {
      // A status-read failure says nothing about a remote operation which has
      // already been accepted. Preserve its current recoverable state.
      return original
    }
    if (!response.ok) {
      if (response.status >= 500) return original
      return await this.failOperation(
        original,
        body.status === 'failed_unknown' ? 'MEDIA_IMAGE_OUTCOME_UNKNOWN' : 'MEDIA_IMAGE_UNAVAILABLE',
        body.status === 'failed_unknown',
        body.provider_receipt_hash,
      )
    }
    const refusal = relayPolicyRefusal(body)
    if (refusal) {
      const safe = mediaSafeError('MEDIA_IMAGE_POLICY_BLOCKED')
      return await this.repository.saveOperation(this.operation({
        ...original,
        status: 'failed',
        progress: 0,
        stage: '图片请求未通过内容策略',
        result: { policy_refusal: refusal },
        error: safe.message,
        error_code: safe.code,
        provider_receipt_hash: body.provider_receipt_hash ?? original.provider_receipt_hash,
      }))
    }
    if (body.status === 'cancelled') return await this.failOperation(original, 'MEDIA_IMAGE_CANCELLED')
    if (body.status === 'failed' || body.status === 'failed_unknown') {
      return await this.failOperation(
        original,
        body.status === 'failed_unknown' ? 'MEDIA_IMAGE_OUTCOME_UNKNOWN' : 'MEDIA_IMAGE_UNAVAILABLE',
        body.status === 'failed_unknown',
        body.provider_receipt_hash,
      )
    }
    if (body.status === 'succeeded') return await this.persistRemoteResults(original, body)
    const next = this.operation({
      ...original,
      status: body.status === 'running' ? 'running' : 'queued',
      progress: body.status === 'running' ? Math.max(original.progress, 35) : Math.max(original.progress, 5),
      stage: body.status === 'running' ? '正在生成图片' : '等待图片生成',
      poll_after_seconds: relayPollAfterSeconds(body.poll_after_seconds, body.status === 'running' ? 3 : 15),
    })
    const project = await this.project(next.project_id).catch(() => null)
    if (project?.task_id === next.id) {
      return (await this.repository.saveProjectAndOperation({
        ...project,
        state: next.status === 'running' ? 'generating' : 'queued',
      }, next)).operation
    }
    return await this.repository.saveOperation(next)
  }

  private async markOperationCancelled(operation: ImageOperation): Promise<ImageOperation> {
    const safe = mediaSafeError('MEDIA_IMAGE_CANCELLED')
    const next = this.operation({
      ...operation,
      status: 'cancelled',
      progress: 0,
      stage: '已取消',
      error: safe.message,
      error_code: safe.code,
      outcome_unknown: false,
    })
    const project = await this.project(operation.project_id).catch(() => null)
    if (project?.task_id === operation.id) {
      return (await this.repository.saveProjectAndOperation({
        ...project,
        state: 'failed',
        error: safe.message,
        error_code: safe.code,
      }, next)).operation
    }
    return await this.repository.saveOperation(next)
  }

  async cancelOperation(operationId: string): Promise<ImageOperation> {
    const operation = await this.repository.getOperation(operationId)
    if (operation.status !== 'queued' || !operation.remote_task_id) {
      throw new ImageWorkbenchServiceError('当前图片操作不能安全取消', 409, 'IMAGE_OPERATION_NOT_CANCELLABLE')
    }
    const target = productGatewayTarget()
    if (!target) {
      throw new ImageWorkbenchServiceError(mediaSafeError('MEDIA_IMAGE_CANCEL_UNKNOWN').message, 503, 'IMAGE_CANCEL_UNKNOWN')
    }
    try {
      const { response, body } = await this.fetchGatewayJson(
        `${target.baseUrl}/v1/images/tasks/${encodeURIComponent(operation.remote_task_id)}/cancel`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${target.token}`,
            [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
          },
        },
      )
      if (!response.ok || body.status !== 'cancelled') {
        throw new ImageWorkbenchServiceError(mediaSafeError('MEDIA_IMAGE_CANCEL_UNKNOWN').message, response.status || 409, 'IMAGE_CANCEL_UNKNOWN')
      }
      return await this.markOperationCancelled(operation)
    } catch (error) {
      if (error instanceof ImageWorkbenchServiceError) throw error
      throw new ImageWorkbenchServiceError(mediaSafeError('MEDIA_IMAGE_CANCEL_UNKNOWN').message, 502, 'IMAGE_CANCEL_UNKNOWN')
    }
  }

  async submitProject(projectId: string, raw: SubmitImageProjectInput = {}): Promise<ImageOperation> {
    const input = submitImageProjectInputSchema.parse(raw)
    const project = await this.project(projectId)
    // Legacy `/submit` has no caller-provided idempotency field.  Its stable
    // identity is therefore the effective paid input, not the mutable Project
    // revision (which the Round itself advances) and not only the prompt.
    const compatibilityKey = `bb-image-legacy-${sha256({
      project_id: project.id,
      brief: project.brief,
      size: project.size,
      delivery_spec: {
        id: project.current_delivery_spec_id,
        revision: project.current_delivery_spec_revision,
      },
      policy_revision: IMAGE_PROVIDER_POLICY_REVISION,
      references: this.generationReferences(project).map(reference => ({
        asset_id: reference.asset_id,
        content_hash: reference.content_hash,
        role: reference.role,
        influence_strength: reference.influence_strength,
        preservation: reference.preservation,
        priority: reference.priority,
      })),
    }).slice('sha256:'.length)}`
    const plan = await this.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: `${compatibilityKey}-plan`,
    })
    const estimate = await this.estimateGenerationRound(project.id, {
      base_revision: project.revision,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
    })
    const created = await this.createGenerationRound(project.id, {
      base_revision: project.revision,
      idempotency_key: compatibilityKey,
      creative_plan_id: plan.id,
      direction_ids: [plan.directions[0]!.id],
      estimate_hash: estimate.estimate_hash,
      confirm: true,
    })
    const operation = created.operations[0]
    if (!operation?.transport_task_id) throw new ImageWorkbenchServiceError('兼容生成轮次缺少传输任务', 500, 'IMAGE_OPERATION_CORRUPT')
    return await this.repository.getOperation(operation.transport_task_id)
  }

  async startOperation(projectId: string, raw: StartImageOperationInput): Promise<ImageOperation> {
    const input = startImageOperationInputSchema.parse(raw)
    const project = await this.project(projectId)
    this.assertRevision(project, input.revision, '图片项目已更新，请刷新后再编辑')
    await this.assertNoActiveOperation(project, input.confirm_unknown_retry)
    if (!productGatewayConfigured()) {
      throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'GATEWAY_NOT_CONFIGURED')
    }
    const base = await this.imageVersionBytes(project, input.base_version_id)
    const model = this.resolveGenerationPolicy({
      user_request: input.instruction,
      size: project.size,
      operation_mode: input.kind,
      references: this.generationReferences(project),
      preferred_model: input.kind === 'inpaint' ? 'gpt-image-2' : undefined,
    }).model_id
    const now = this.iso()
    let maskAsset: MediaAsset | undefined
    if (input.mask_data_url) {
      const mask = await this.assets.verifyDataUrl(input.mask_data_url)
      if (mask.mime_type !== 'image/png' || mask.width !== base.verified.width || mask.height !== base.verified.height) {
        throw new ImageWorkbenchServiceError('局部重绘蒙版必须与基础版本尺寸一致', 400, 'IMAGE_MASK_DIMENSIONS_MISMATCH')
      }
      const maskId = id('mask')
      maskAsset = (await this.assets.persist(project.id, maskId, 'mask', mask, input.base_version_id, now)).asset
    }
    const providerInstruction = [
      `编辑要求：${input.instruction}`,
      project.brief?.must_preserve.length ? `必须保留：${project.brief.must_preserve.join('；')}` : '',
      '除编辑要求明确指定的区域外，不得改变基础版本中的主体、品牌、Logo、二维码或已确认事实。',
      '不得编造价格、日期、地址、联系方式、品牌或活动规则。',
      project.brief?.exact_text.length ? '不要重新绘制可读文字，保留供确定性文字图层使用的区域。' : '',
    ].filter(Boolean).join('\n')
    const operationId = stableId('op', project.id, input.kind, String(project.revision), input.base_version_id, input.instruction)
    const operation = this.operation({
      schema_version: 1,
      id: id('task'),
      project_id: project.id,
      operation_id: operationId,
      owner: project.owner,
      kind: 'image.generate',
      status: 'queued',
      progress: 0,
      stage: input.kind === 'inpaint' ? '等待提交局部重绘' : '等待提交图片编辑',
      idempotency_key: `bb-image-${createHash('sha256').update(operationId).digest('hex')}`,
      image_operation: {
        kind: input.kind,
        base_version_id: input.base_version_id,
        instruction: providerInstruction,
        mask_asset_id: maskAsset?.id,
        model,
        output_count: 1,
      },
      created_at: now,
      updated_at: now,
    })
    const committed = await this.repository.saveProjectAndOperation({
      ...project,
      assets: maskAsset ? [...project.assets, maskAsset] : project.assets,
      state: 'queued',
      task_id: operation.id,
      revision: project.revision + 1,
      error: undefined,
      error_code: undefined,
      notice: undefined,
    }, operation)
    return await this.submitPersistedOperation(committed.project, committed.operation)
  }
}
