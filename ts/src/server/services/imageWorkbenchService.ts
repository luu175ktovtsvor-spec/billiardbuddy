import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import {
  addImageProjectReferencesInputSchema,
  commitImageVersionInputSchema,
  createImageProjectInputSchema,
  imageGenerationModelSchema,
  imageGenerationTaskResultSchema,
  imageSizeSupportedByModel,
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
import { providerRegistryEntriesForCapability } from '../../../../gateway/providerRegistry.js'
import {
  MEDIA_RESULT_HANDOFF_DIRECT_V1,
  MEDIA_RESULT_HANDOFF_HEADER,
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
} from '../../../shared/product/providerGateway.js'
import { productGatewayConfigured, productGatewayTarget } from '../product/productGatewayRuntime.js'
import { applyImageBriefOverrides, compileImageBrief, providerPromptForImageBrief } from './imageBrief.js'
import { assessImageCandidates } from './imageReasoning.js'
import {
  ImageAssetStore,
  ImageAssetStoreError,
  type SupportedImageMime,
  type VerifiedImageBytes,
} from './imageAssetStore.js'
import {
  ImageWorkbenchRepository,
  ImageWorkbenchRepositoryError,
  type ImageOperation,
  type ImageOperationEvent,
} from './imageWorkbenchRepository.js'

const STANDALONE_IMAGE_OWNER: MediaOwner = {
  kind: 'standalone',
  owner_id: 'local_workbench',
}
const INITIAL_WRITER_FENCE = `fence_${'0'.repeat(32)}`

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

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
  result_acknowledged?: boolean
  result_url?: string
  result_urls?: string[]
}

function id(prefix: 'img' | 'ref' | 'mask' | 'out' | 'task'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function stableId(prefix: 'op' | 'ver', ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
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
  readonly repository: ImageWorkbenchRepository
  readonly assets: ImageAssetStore
  private readonly now: () => Date
  private readonly fetchImpl: FetchLike
  private readonly imageResultTimeoutMs: number
  private readonly legacyMediaRoot: string
  private readonly activeSubmissions = new Map<string, Promise<ImageOperation>>()
  private readonly activeRefreshes = new Map<string, Promise<ImageOperation>>()

  constructor(options: {
    root?: string
    now?: () => Date
    fetchImpl?: FetchLike
    imageResultTimeoutMs?: number
    legacyMediaRoot?: string
  } = {}) {
    this.now = options.now ?? (() => new Date())
    this.fetchImpl = options.fetchImpl ?? fetch
    this.imageResultTimeoutMs = Math.max(1_000, Math.min(120_000, options.imageResultTimeoutMs ?? 30_000))
    this.legacyMediaRoot = options.legacyMediaRoot
      ?? join(process.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'media')
    this.repository = new ImageWorkbenchRepository({ root: options.root, now: this.now })
    this.assets = new ImageAssetStore(this.repository.paths())
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private imageModel(
    userRequest: string,
    size: ImageWorkbenchProject['size'],
    hasSubjectReference: boolean,
  ): ImageWorkbenchProject['model'] {
    const candidates = providerRegistryEntriesForCapability('ImageGeneration')
      .map(entry => imageGenerationModelSchema.safeParse(entry.model_id))
      .flatMap(result => result.success ? [result.data] : [])
      .filter(model => imageSizeSupportedByModel(model, size))
    if (candidates.length === 0) {
      throw new ImageWorkbenchServiceError('当前图片能力不支持这个画布尺寸', 400, 'IMAGE_SIZE_UNSUPPORTED')
    }
    if (candidates.length === 1) return candidates[0]!
    if (!hasSubjectReference && /中文|海报|宣传图|活动图|招聘图|朋友圈|易拉宝/u.test(userRequest)) {
      const seedream = candidates.find(model => model === 'doubao-seedream-4-5-251128')
      if (seedream) return seedream
    }
    return candidates.find(model => model === 'gpt-image-2') ?? candidates[0]!
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
      model: this.imageModel(input.user_request, input.size, persisted.references.some(reference => reference.role === 'subject')),
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
      return await this.repository.saveProject(project)
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
    return await this.repository.saveProject(imageWorkbenchProjectSchema.parse({
      ...project,
      state: 'draft',
      task_id: undefined,
      title: titleForRequest(input.user_request, project.title),
      mode: nextReferences.length > 0 ? 'edit' : 'generate',
      model: this.imageModel(input.user_request, input.size, nextReferences.some(reference => reference.role === 'subject')),
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
      asset_path: `/api/media/images/projects/${project.id}/outputs/${outputId}/content`,
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
    const page = await this.listOperationEvents(projectId, after, limit)
    if (page.events.length > 0 || page.reset_required || waitMs <= 0) return page
    await this.repository.waitForOperationEvent(projectId, after, waitMs)
    return await this.listOperationEvents(projectId, after, limit)
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

  private async referenceDataUrls(project: ImageWorkbenchProject): Promise<string[]> {
    const assets = new Map(this.referenceAssets(project).map(asset => [asset.id, asset]))
    return await Promise.all(project.references.map(async reference => {
      const asset = assets.get(reference.asset_id)
      if (!asset) throw new ImageWorkbenchServiceError('图片参考素材已经丢失', 409, 'REFERENCE_IMAGE_MISSING')
      const verified = await this.assets.readVerified(asset)
      return `data:${verified.mime_type};base64,${verified.bytes.toString('base64')}`
    }))
  }

  private async imageSubmissionPayload(project: ImageWorkbenchProject, operation: ImageOperation): Promise<Record<string, unknown>> {
    const imageOperation = operation.image_operation
    if (imageOperation.kind === 'generate') {
      const references = project.mode === 'edit' ? await this.referenceDataUrls(project) : []
      return {
        mode: project.mode,
        model: imageOperation.model,
        prompt: project.prompt,
        n: imageOperation.output_count,
        size: project.size,
        ...(imageOperation.model === 'doubao-seedream-4-5-251128' ? { response_format: 'b64_json' } : {}),
        ...(references.length > 0 ? { images: references } : {}),
      }
    }
    if (!imageOperation.base_version_id || !imageOperation.instruction) {
      throw new ImageWorkbenchServiceError('图片编辑操作缺少基础版本或编辑要求', 500, 'IMAGE_OPERATION_CORRUPT')
    }
    const base = await this.imageVersionBytes(project, imageOperation.base_version_id)
    let mask: string | undefined
    if (imageOperation.mask_asset_id) {
      const asset = project.assets.find(candidate => candidate.id === imageOperation.mask_asset_id && candidate.role === 'mask')
      if (!asset) throw new ImageWorkbenchServiceError('局部重绘蒙版已经丢失', 409, 'IMAGE_MASK_INVALID')
      const verified = await this.assets.readVerified(asset)
      if (verified.mime_type !== 'image/png') throw new ImageWorkbenchServiceError('局部重绘蒙版格式无效', 409, 'IMAGE_MASK_INVALID')
      mask = `data:image/png;base64,${verified.bytes.toString('base64')}`
    }
    return {
      mode: 'edit',
      model: imageOperation.model,
      prompt: imageOperation.instruction,
      n: imageOperation.output_count,
      size: project.size,
      ...(imageOperation.model === 'doubao-seedream-4-5-251128' ? { response_format: 'b64_json' } : {}),
      images: [`data:${base.verified.mime_type};base64,${base.verified.bytes.toString('base64')}`],
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
    const failed = await this.repository.saveOperation(this.operation({
      ...operation,
      status: 'failed',
      stage: '生成失败',
      error: safe.message,
      error_code: safe.code,
      outcome_unknown: outcomeUnknown,
      provider_receipt_hash: providerReceiptHash,
    }))
    const project = await this.project(operation.project_id).catch(() => null)
    if (project?.task_id === operation.id) {
      await this.repository.saveProject({
        ...project,
        state: 'failed',
        error: safe.message,
        error_code: safe.code,
      })
    }
    return failed
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
      await this.fenceInterruptedSubmission(operation)
    }))
  }

  private legacyFile(root: string, locator: string): string | null {
    if (!locator || isAbsolute(locator)) return null
    const target = resolve(root, locator)
    const relation = relative(root, target)
    return relation && !relation.startsWith('..') && !isAbsolute(relation) ? target : null
  }

  private async legacyAssetBytes(projectId: string, asset: MediaAsset): Promise<Buffer | null> {
    let path: string | null = null
    if (asset.storage.kind === 'cas') {
      const digest = /^sha256\/([a-f0-9]{64})$/.exec(asset.storage.locator)?.[1]
      path = digest ? join(this.legacyMediaRoot, 'cas', 'sha256', digest) : null
    } else if (asset.storage.kind === 'managed') {
      path = this.legacyFile(join(this.legacyMediaRoot, 'assets'), asset.storage.locator)
    }
    if (!path) return null
    return await readFile(path).catch(() => null)
  }

  private async legacyReferenceBytes(projectId: string, fileName: string): Promise<Buffer | null> {
    if (!/^[a-z0-9][a-z0-9_.-]{2,120}$/.test(fileName)) return null
    return await readFile(join(this.legacyMediaRoot, 'assets', projectId, 'references', fileName)).catch(() => null)
  }

  private async legacyOutputBytes(projectId: string, output: ImageWorkbenchProject['outputs'][number]): Promise<Buffer | null> {
    if (output.data_url) return (await this.assets.verifyDataUrl(output.data_url)).bytes
    const prefix = `/api/media/assets/${projectId}/`
    if (!output.asset_path?.startsWith(prefix)) return null
    const fileName = output.asset_path.slice(prefix.length)
    if (!/^[a-z0-9][a-z0-9_.-]{2,120}$/.test(fileName)) return null
    return await readFile(join(this.legacyMediaRoot, 'assets', projectId, fileName)).catch(() => null)
  }

  /**
   * One-way, idempotent import from the former generic media store. It reads
   * its files directly and never asks MediaProjectService to keep owning an
   * image project. Missing/corrupt legacy assets remain in the old store and
   * are not invented as new candidate or version facts.
   */
  async migrateLegacyMediaStore(): Promise<{ migrated_project_ids: string[]; skipped_project_ids: string[] }> {
    const projectsDir = join(this.legacyMediaRoot, 'projects')
    const tasksDir = join(this.legacyMediaRoot, 'tasks')
    const taskNames = await readdir(tasksDir).catch(() => [])
    const legacyTasks = new Map<string, ImageOperation>()
    for (const name of taskNames.filter(name => name.endsWith('.json'))) {
      const raw = await readFile(join(tasksDir, name), 'utf8').catch(() => null)
      if (!raw) continue
      const parsed = mediaTaskSchema.safeParse(JSON.parse(raw))
      if (!parsed.success || parsed.data.kind !== 'image.generate' || !parsed.data.image_operation) continue
      legacyTasks.set(parsed.data.id, parsed.data as ImageOperation)
    }

    const migratedProjectIds: string[] = []
    const skippedProjectIds: string[] = []
    const projectNames = await readdir(projectsDir).catch(() => [])
    for (const name of projectNames.filter(name => name.endsWith('.json')).sort()) {
      const raw = await readFile(join(projectsDir, name), 'utf8').catch(() => null)
      if (!raw) continue
      const parsed = imageWorkbenchProjectSchema.safeParse(JSON.parse(raw))
      if (!parsed.success) continue
      const legacy = parsed.data
      const existing = await this.repository.getProject(legacy.id).catch(error => {
        if (error instanceof ImageWorkbenchRepositoryError && error.code === 'IMAGE_PROJECT_NOT_FOUND') return null
        throw error
      })
      if (existing) {
        skippedProjectIds.push(legacy.id)
        continue
      }

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
        const bytes = asset ? await this.legacyAssetBytes(legacy.id, asset) : null
        if (bytes) await importReference(reference.asset_id, reference.role, bytes)
      }
      for (const fileName of legacy.reference_image_assets ?? []) {
        const assetId = fileName.slice(0, fileName.lastIndexOf('.'))
        if (!assetId) continue
        const bytes = await this.legacyReferenceBytes(legacy.id, fileName)
        if (bytes) await importReference(assetId, legacyReferenceRoles.get(assetId) ?? 'unclassified', bytes)
      }
      for (const [index, dataUrl] of legacy.reference_images.entries()) {
        const assetId = id('ref')
        const verified = await this.assets.verifyDataUrl(dataUrl)
        await importReference(assetId, legacy.references[index]?.role ?? 'unclassified', verified.bytes)
      }

      const outputs: ImageWorkbenchProject['outputs'] = []
      const versions: ImageWorkbenchProject['versions'] = []
      const seenResultIds = new Set<string>()
      const outputById = new Map(legacy.outputs.map(output => [output.id, output]))
      const importResult = async (
        assetId: string,
        versionId: string,
        output: ImageWorkbenchProject['outputs'][number],
        version: ImageWorkbenchProject['versions'][number],
        bytes: Buffer | null,
      ): Promise<void> => {
        if (seenResultIds.has(assetId) || !bytes) return
        const verified = await this.assets.verify(bytes)
        const stored = await this.assets.persist(legacy.id, assetId, 'result', verified, versionId, version.created_at)
        seenResultIds.add(assetId)
        assets.push(stored.asset)
        versions.push({ ...version, asset_ids: [assetId], width: verified.width, height: verified.height })
        outputs.push({
          ...output,
          id: assetId,
          version_id: versionId,
          width: verified.width,
          height: verified.height,
          mime_type: verified.mime_type,
          data_url: undefined,
          url: undefined,
          asset_path: `/api/media/images/projects/${legacy.id}/outputs/${assetId}/content`,
        })
      }
      for (const version of legacy.versions) {
        const asset = version.asset_ids
          .map(assetId => legacyAssets.get(assetId))
          .find((candidate): candidate is MediaAsset => candidate?.role === 'result')
        if (!asset) continue
        const output = outputById.get(asset.id) ?? legacy.outputs.find(candidate => candidate.version_id === version.id)
        const bytes = (await this.legacyAssetBytes(legacy.id, asset)) ?? (output ? await this.legacyOutputBytes(legacy.id, output) : null)
        await importResult(asset.id, version.id, output ?? {
          id: asset.id,
          version_id: version.id,
          version_kind: version.kind ?? 'generated',
          mime_type: 'image/png',
          asset_path: `/api/media/images/projects/${legacy.id}/outputs/${asset.id}/content`,
        }, version, bytes)
      }
      for (const output of legacy.outputs) {
        if (seenResultIds.has(output.id)) continue
        const versionId = output.version_id ?? stableId('ver', legacy.id, 'legacy-output', output.id)
        await importResult(output.id, versionId, output, {
          id: versionId,
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
        }, await this.legacyOutputBytes(legacy.id, output))
      }
      // Masks may be referenced by a persisted edit operation. They are not
      // visible candidates but retain the same verified project ownership.
      for (const asset of legacy.assets.filter(asset => asset.role === 'mask')) {
        const bytes = await this.legacyAssetBytes(legacy.id, asset)
        if (!bytes) continue
        const verified = await this.assets.verify(bytes)
        assets.push((await this.assets.persist(legacy.id, asset.id, 'mask', verified, asset.version_id, asset.created_at)).asset)
      }

      const legacyTask = legacy.task_id ? legacyTasks.get(legacy.task_id) : undefined
      const fallbackState = legacyTask ? legacy.state : versions.length > 0 ? 'ready' : 'draft'
      const imported = imageWorkbenchProjectSchema.parse({
        ...legacy,
        owner: STANDALONE_IMAGE_OWNER,
        writer_fence: INITIAL_WRITER_FENCE,
        assets,
        versions,
        state: fallbackState,
        references,
        reference_images: [],
        reference_image_assets: referenceNames,
        reference_image_count: references.length,
        task_id: legacyTask?.id,
        outputs,
        current_version_id: legacy.current_version_id && versions.some(version => version.id === legacy.current_version_id)
          ? legacy.current_version_id
          : versions.at(-1)?.id,
        updated_at: now,
      })
      await this.repository.saveProject(imported)
      if (legacyTask) await this.repository.saveOperation(legacyTask)
      migratedProjectIds.push(legacy.id)
    }
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
        return await this.failOperation(
          operation,
          response.status >= 500 || response.status === 0 ? 'MEDIA_IMAGE_OUTCOME_UNKNOWN' : 'MEDIA_IMAGE_UNAVAILABLE',
          response.status >= 500 || response.status === 0,
          body.provider_receipt_hash,
        )
      }
      operation = await this.repository.saveOperation(this.operation({
        ...operation,
        status: body.status === 'running' ? 'running' : 'queued',
        progress: body.status === 'running' ? 10 : 2,
        stage: body.reused ? '已复用同一图片任务' : '已进入图片队列',
        remote_task_id: body.task_id,
        poll_after_seconds: relayPollAfterSeconds(body.poll_after_seconds, body.status === 'running' ? 3 : 15),
        provider_receipt_hash: body.provider_receipt_hash,
      }))
      const latest = await this.project(project.id)
      if (latest.task_id === operation.id) {
        await this.repository.saveProject({
          ...latest,
          state: operation.status === 'running' ? 'generating' : 'queued',
          error: undefined,
          error_code: undefined,
        })
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

  private async acknowledgeRemoteResult(operation: ImageOperation): Promise<ImageOperation> {
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

  private async persistRemoteResults(operation: ImageOperation, body: RelayImageTask): Promise<ImageOperation> {
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
            asset_path: `/api/media/images/projects/${project.id}/outputs/${outputId}/content`,
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
    let outputs = saved.map(candidate => candidate.output)
    let qualityAvailable = false
    if (project.brief) {
      try {
        const assessments = await assessImageCandidates({
          brief: project.brief,
          candidates: await Promise.all(saved.map(async (candidate, candidateIndex) => {
            const verified = await this.assets.readVerified(candidate.asset)
            return {
              candidate_index: candidateIndex,
              data_url: `data:${verified.mime_type};base64,${verified.bytes.toString('base64')}`,
            }
          })),
        }, {
          operationId: stableId('op', committing.operation_id ?? committing.id, 'quality'),
          fetchImpl: this.fetchImpl as typeof fetch,
        })
        outputs = outputs.map((output, candidateIndex) => {
          const assessment = assessments.find(candidate => candidate.candidate_index === candidateIndex)
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
        qualityAvailable = true
      } catch {
        // Candidate bytes and project ownership are already established. A
        // reasoning outage must not turn a real image into a fictitious
        // failure; the project explicitly records that quality is pending.
      }
    }
    const parsedResult = imageGenerationTaskResultSchema.parse({
      output_count: outputs.length,
      outputs,
      ...(body.input_fidelity_requested ? { input_fidelity_requested: body.input_fidelity_requested } : {}),
      ...(body.input_fidelity_status ? { input_fidelity_status: body.input_fidelity_status } : {}),
      ...(body.input_fidelity_risk ? { input_fidelity_risk: boundedMessage(body.input_fidelity_risk) } : {}),
    })
    const savedProject = await this.repository.saveProject(imageWorkbenchProjectSchema.parse({
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
        : project.brief && !qualityAvailable
          ? '候选已保存；视觉质检暂时不可用，可稍后继续编辑或重新生成。'
          : undefined,
      error: undefined,
      error_code: undefined,
    }))
    committing = await this.repository.saveOperation(this.operation({
      ...committing,
      status: 'succeeded',
      progress: 100,
      stage: '图片候选已保存',
      provider_receipt_hash: body.provider_receipt_hash,
      result: parsedResult,
    }))
    // The project write above is intentionally before success/ACK. An ACK is
    // only legal when every candidate is an owned, verified project asset.
    void savedProject
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
    const operation = await this.repository.saveOperation(this.operation({
      ...original,
      status: body.status === 'running' ? 'running' : 'queued',
      progress: body.status === 'running' ? Math.max(original.progress, 35) : Math.max(original.progress, 5),
      stage: body.status === 'running' ? '正在生成图片' : '等待图片生成',
      poll_after_seconds: relayPollAfterSeconds(body.poll_after_seconds, body.status === 'running' ? 3 : 15),
    }))
    const project = await this.project(operation.project_id).catch(() => null)
    if (project?.task_id === operation.id) {
      await this.repository.saveProject({ ...project, state: operation.status === 'running' ? 'generating' : 'queued' })
    }
    return operation
  }

  private async markOperationCancelled(operation: ImageOperation): Promise<ImageOperation> {
    const safe = mediaSafeError('MEDIA_IMAGE_CANCELLED')
    const cancelled = await this.repository.saveOperation(this.operation({
      ...operation,
      status: 'cancelled',
      progress: 0,
      stage: '已取消',
      error: safe.message,
      error_code: safe.code,
      outcome_unknown: false,
    }))
    const project = await this.project(operation.project_id).catch(() => null)
    if (project?.task_id === operation.id) {
      await this.repository.saveProject({
        ...project,
        state: 'failed',
        error: safe.message,
        error_code: safe.code,
      })
    }
    return cancelled
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
    await this.assertNoActiveOperation(project, input.confirm_unknown_retry)
    if (!productGatewayConfigured()) {
      throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'GATEWAY_NOT_CONFIGURED')
    }
    await this.referenceDataUrls(project)
    const operationId = stableId('op', project.id, 'generate', String(project.revision), project.brief?.user_request ?? project.prompt)
    const digest = createHash('sha256').update(operationId).digest('hex')
    const now = this.iso()
    const operation = this.operation({
      schema_version: 1,
      id: id('task'),
      project_id: project.id,
      operation_id: operationId,
      owner: project.owner,
      kind: 'image.generate',
      status: 'queued',
      progress: 0,
      stage: '等待提交图片任务',
      idempotency_key: `bb-image-${digest}`,
      image_operation: {
        kind: 'generate',
        model: project.model,
        output_count: 3,
      },
      created_at: now,
      updated_at: now,
    })
    const persisted = await this.repository.saveOperation(operation)
    const attached = await this.repository.saveProject({
      ...project,
      state: 'queued',
      task_id: persisted.id,
      revision: project.revision + 1,
      error: undefined,
      error_code: undefined,
      notice: undefined,
    })
    return await this.submitPersistedOperation(attached, persisted)
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
    const model = input.kind === 'inpaint'
      ? 'gpt-image-2' as const
      : this.imageModel(input.instruction, project.size, true)
    if (!imageSizeSupportedByModel(model, project.size)) {
      throw new ImageWorkbenchServiceError('当前图片能力不支持基础版本尺寸', 400, 'IMAGE_SIZE_UNSUPPORTED')
    }
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
    const persisted = await this.repository.saveOperation(operation)
    const attached = await this.repository.saveProject({
      ...project,
      assets: maskAsset ? [...project.assets, maskAsset] : project.assets,
      state: 'queued',
      task_id: persisted.id,
      revision: project.revision + 1,
      error: undefined,
      error_code: undefined,
      notice: undefined,
    })
    return await this.submitPersistedOperation(attached, persisted)
  }
}
