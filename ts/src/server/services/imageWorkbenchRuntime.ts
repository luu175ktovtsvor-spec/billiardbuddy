import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import sharp from 'sharp'
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
  type ImageCanvasSize,
  type ImageGenerationModel,
  type ImageWorkbenchProject,
  type ImageBriefOverrides,
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
  imageCanvasCommandInputSchema,
  imageCanvasCreateInputSchema,
  imageCanvasPreflightInputSchema,
  imageCanvasRenderInputSchema,
  imageArtboardSelectVersionInputSchema,
  imageBrandKitRevisionSchema,
  imageDeliverySpecRevisionInputSchema,
  imageExportInputSchema,
  imageUnderstandingInputSchema,
  imageVisualAssessmentInputSchema,
  createGenerationRoundInputSchema,
  decideImageCandidateInputSchema,
  deriveImageCandidateInputSchema,
  deriveImageVersionInputSchema,
  estimateDeriveImageCandidateInputSchema,
  estimateDeriveImageVersionInputSchema,
  estimateGenerationRoundInputSchema,
  imageDerivationSourceSchema,
  imageTemplateRevisionSchema,
  type AdoptImageCandidateInput,
  type CreateCreativePlanInput,
  type CreateGenerationRoundInput,
  type DecideImageCandidateInput,
  type DeriveImageCandidateInput,
  type DeriveImageVersionInput,
  type EstimateGenerationRoundInput,
  type EstimateDeriveImageCandidateInput,
  type EstimateDeriveImageVersionInput,
  type ImageBriefSnapshot,
  type ImageCanvasCommandInput,
  type ImageCanvasDocument,
  type ImageCanvasPreflightInput,
  type ImageCanvasPreflight,
  type ImageCanvasRevision,
  type ImageBrandKitRevision,
  type ImageCanvasRenderInput,
  type ImageDeliverySpecRevisionInput,
  type ImageExportInput,
  type ImageUnderstandingInput,
  type ImageUnderstandingSuggestion,
  type ImageVisualAssessmentInput,
  type ImageVisualAssessment,
  type ImageCandidateAdoption,
  type ImageCandidateDecision,
  type ImageCandidateGroup,
  type ImageCandidate,
  type ImageCreativeDirection,
  type ImageCreativePlan,
  type ImageDeliverySpec,
  type ImageDerivationSource,
  type ImageGenerationRound,
  type ImageGenerationEstimate,
  type ImageOperationV2,
  type ImageRenderReceipt,
  type ImageReleaseCheckResult,
  type ImageExportReceipt,
  type ImageDeliverySet,
  type ImageReferenceV2,
  type ImageTemplateRevision,
  type ProviderExecutionReceipt,
} from '../../../shared/contracts/imageGeneration.js'
import {
  addImageWorkflowReferencesInputSchema,
  applyImageBriefOverridesInputSchema,
  createImageAssetGrantInputSchema,
  createImageBrandKitInputSchema,
  createImageCampaignInputSchema,
  createImageTemplateInputSchema,
  cancelImageCampaignInputSchema,
  confirmImageCampaignInputSchema,
  deleteImageReusableAggregateInputSchema,
  estimateImageCampaignInputSchema,
  imageCampaignConfirmationReceiptSchema,
  imageCampaignEstimateSchema,
  imageCampaignItemSchema,
  imageCampaignProjectIntentSchema,
  imageCampaignSchema,
  imageBrandKitSchema,
  imageInspirationBoardSchema,
  imageQuickCreateInputSchema,
  imageTemplateSchema,
  promoteImageInspirationItemInputSchema,
  removeImageWorkflowReferenceInputSchema,
  replaceImageCampaignItemsInputSchema,
  reviseImageBrandKitInputSchema,
  reviseImageTemplateInputSchema,
  revokeImageAssetGrantInputSchema,
  retryImageCampaignItemInputSchema,
  startImageCampaignInputSchema,
  upsertImageInspirationItemsInputSchema,
  type AddImageWorkflowReferencesInput,
  type ApplyImageBriefOverridesInput,
  type CreateImageAssetGrantInput,
  type CreateImageBrandKitInput,
  type CreateImageCampaignInput,
  type CreateImageTemplateInput,
  type ConfirmImageCampaignInput,
  type EstimateImageCampaignInput,
  type ImageAssetGrant,
  type ImageCampaign,
  type ImageCampaignConfirmationReceipt,
  type ImageCampaignEstimate,
  type ImageCampaignItem,
  type ImageCampaignProjectIntent,
  type ImageInspirationBoard,
  type ImageProjectLibrary,
  type ImageQuickCreateInput,
  type PromoteImageInspirationItemInput,
  type RemoveImageWorkflowReferenceInput,
  type ReplaceImageCampaignItemsInput,
  type ReviseImageBrandKitInput,
  type ReviseImageTemplateInput,
  type RetryImageCampaignItemInput,
  type UpsertImageInspirationItemsInput,
} from '../../../shared/contracts/imageWorkflow.js'
import { providerRegistryEntry } from '../../../../gateway/providerRegistry.js'
import {
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
  PROVIDER_OPERATION_ACK_PATH,
  PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER,
  PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER,
  PROVIDER_OPERATION_RESULT_ID_HEADER,
} from '../../../shared/product/providerGateway.js'
import {
  IMAGE_RELAY_RESULTS_PATH,
  IMAGE_RELAY_RESULT_HANDOFF_DIRECT_V1,
  IMAGE_RELAY_RESULT_HANDOFF_HEADER,
  IMAGE_RELAY_TASKS_PATH,
  imageRelayIdempotencyLookupPath,
  isImageRelayQuotaErrorCode,
} from '../../../shared/product/imageRelayProtocol.js'
import { IMAGE_PRODUCT_OUTPUT_COUNT } from '../../../shared/product/imageGenerationPolicy.js'
import { productGatewayTarget, productImageRelayConfigured, productImageRelayTarget } from '../product/productGatewayRuntime.js'
import { applyImageBriefOverrides, compileImageBrief, providerPromptForImageBrief } from './imageBrief.js'
import { QwenImageReasoningError, requestQwenImageReasoning } from './qwenImageReasoningAdapter.js'
import { IMAGE_PROVIDER_POLICY_REVISION, ImageProviderPolicyError, resolveImageProviderModel, resolveImageProviderPolicy } from './imageProviderPolicy.js'
import {
  ImageAssetStore,
  ImageAssetStoreError,
  type SupportedImageMime,
  type VerifiedImageBytes,
} from './imageAssetStore.js'
import { assertDeterministicTextLayout, assertFormalTextLayer, DeterministicImageCanvasRenderer, ImageCanvasRendererError, renderedTextBounds, renderedTransformBounds, verifyRenderedQrManifest } from './imageCanvasRenderer.js'
import {
  ImageWorkbenchRepositoryError,
  type ImageOperation,
  type ImageOperationEvent,
  type ImageCampaignSnapshot,
} from './imageWorkbenchRepository.js'
import {
  LegacyImageProjectReader,
  legacyProjectOperations,
  legacyProjectSourceHash,
} from '../media/image/infrastructure/legacyImageProjectReader.js'
import { SqliteImageMetadataStore } from '../media/image/infrastructure/sqliteImageMetadataStore.js'
import { createCreativePlanCommand } from '../media/image/application/imageGenerationApplication.js'

const IMAGE_RELAY_CONTROL_JSON_MAX_BYTES = 256 * 1024
const IMAGE_RELAY_DIRECT_RESULT_JSON_MAX_BYTES = Math.ceil((32 * 1024 * 1024) / 3) * 4 + 64 * 1024

async function readImageRelayResponseText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const declaredRaw = response.headers.get('content-length')?.trim()
  const declared = declaredRaw && /^\d+$/.test(declaredRaw) ? Number(declaredRaw) : undefined
  if (declared !== undefined && (!Number.isSafeInteger(declared) || declared > maxBytes)) {
    void response.body?.cancel().catch(() => {})
    throw new Error('image relay response too large')
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let detachAbort = () => {}
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => {})
      reject(new Error('image relay response deadline exceeded'))
    }
    if (signal.aborted) onAbort()
    else {
      signal.addEventListener('abort', onAbort, { once: true })
      detachAbort = () => signal.removeEventListener('abort', onAbort)
    }
  })
  try {
    while (true) {
      const next = await Promise.race([reader.read(), aborted])
      if (next.done) break
      const value = next.value
      if (!value || value.byteLength === 0) continue
      if (total + value.byteLength > maxBytes) {
        void reader.cancel().catch(() => {})
        throw new Error('image relay response too large')
      }
      chunks.push(value)
      total += value.byteLength
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  } finally {
    detachAbort()
    try { reader.releaseLock() } catch {}
  }
}

const STANDALONE_IMAGE_OWNER: MediaOwner = {
  kind: 'standalone',
  owner_id: 'local_workbench',
}
const INITIAL_WRITER_FENCE = `fence_${'0'.repeat(32)}`
const IMAGE_GENERATION_ESTIMATE_TTL_MS = 5 * 60 * 1000
const MAX_CAMPAIGN_PAID_OPERATIONS = 256
const IMAGE_QWEN_MAX_INPUT_BYTES = 16 * 1024 * 1024

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

type DerivationSourceRecord =
  | {
    kind: 'candidate'
    candidate: ImageCandidate
    asset: MediaAsset
    verified: VerifiedImageBytes
  }
  | {
    kind: 'version'
    version_id: string
    asset: MediaAsset
    verified: VerifiedImageBytes
  }

export type ImageWorkbenchCrashPoint =
  | 'after_cas_publish_before_db_commit'
  | 'after_db_commit_before_relay_ack'
  | 'after_generation_round_persisted_before_post'
  | 'after_campaign_cancel_item_before_completion'
  | 'after_project_migration_before_operations'
  | 'after_canvas_render_cas_before_db_commit'
  | 'after_export_cas_before_db_commit'

type RelayImageTask = {
  task_id?: string
  status?: string
  poll_after_seconds?: number
  data?: Array<{
    candidate_index?: number
    b64_json?: string
    url?: string
    revised_prompt?: string
    mime_type?: SupportedImageMime
  }>
  error?: string
  message?: string
  code?: string
  capability?: string
  scope?: string
  resets_at?: string
  reused?: boolean
  input_fidelity_requested?: string
  input_fidelity_status?: 'accepted' | 'unsupported'
  input_fidelity_risk?: string
  provider_receipt_hash?: string
  expected_count?: number
  valid_count?: number
  invalid?: Array<{ index?: number; safe_error_code?: string }>
  partial_outcome_unknown?: boolean
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

/** A deterministic aggregate id used by a recoverable human-workflow command. */
function workflowId(prefix: string, ...parts: string[]): string {
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

function canvasRenderRequestHash(canvasId: string, input: ImageCanvasRenderInput): `sha256:${string}` {
  return sha256({
    canvas_id: canvasId,
    base_revision: input.base_revision,
    idempotency_key: input.idempotency_key,
    canvas_revision: input.canvas_revision,
    ...(input.expected_current_version_id ? { expected_current_version_id: input.expected_current_version_id } : {}),
    activate_on_success: input.activate_on_success,
  })
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

/** A 429 is not automatically a quota error: admission backpressure is still
 * retryable. Only the Relay's allow-listed quota codes disable the hosted
 * image capability for this UTC period. */
function imageRelayFailureCode(status: number, body: RelayImageTask): MediaSafeErrorCode {
  if (status === 429 && isImageRelayQuotaErrorCode(body.code)) return 'MEDIA_IMAGE_QUOTA_EXHAUSTED'
  return body.status === 'failed_unknown' ? 'MEDIA_IMAGE_OUTCOME_UNKNOWN' : 'MEDIA_IMAGE_UNAVAILABLE'
}

function trustedResultUrl(value: unknown, imageRelayBaseUrl: string): string | null {
  if (typeof value !== 'string') return null
  try {
    const result = new URL(value)
    const imageRelay = new URL(imageRelayBaseUrl)
    const resultPrefix = `${imageRelay.pathname.replace(/\/+$/, '')}${IMAGE_RELAY_RESULTS_PATH}/`
    if (
      result.protocol !== 'https:'
      || result.origin !== imageRelay.origin
      || result.username
      || result.password
      || result.search
      || result.hash
      || !result.pathname.startsWith(resultPrefix)
    ) return null
    const grant = result.pathname.slice(resultPrefix.length)
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

/** Internal source facts that the HTTP layer converts to the public projection. */
export type ImageWorkbenchProjectProjectionData = {
  project: ImageWorkbenchProject
  inspiration_board: ImageInspirationBoard | null
  creative_plans: ImageCreativePlan[]
  generation_rounds: ImageGenerationRound[]
  operations: ImageOperationV2[]
  latest_understanding_suggestion: ImageUnderstandingSuggestion | null
  candidate_groups: Array<{ group: ImageCandidateGroup; candidates: ImageCandidate[] }>
  canvases: ImageCanvasRevision[]
  delivery_spec: ImageDeliverySpec | null
  library: ImageProjectLibrary
  campaign_intent: ImageCampaignProjectIntent | null
}

/**
 * Narrow internal infrastructure boundary for the Project Application's
 * Reference Control command.  It deliberately excludes the rest of the
 * runtime so that command ownership remains with ImageProjectApplication.
 */
export type ImageReferenceControlRuntimePort = {
  loadProject(projectId: string): Promise<ImageWorkbenchProject>
  findCommand(
    projectId: string,
    idempotencyKey: string,
    requestHash: `sha256:${string}`,
  ): Promise<ImageWorkbenchProject | null>
  assertNoActiveOperation(project: ImageWorkbenchProject): Promise<void>
  assertNoActiveGenerationOperation(project: ImageWorkbenchProject): Promise<void>
  save(input: {
    project: ImageWorkbenchProject
    base_revision: number
    idempotency_key: string
    request_hash: `sha256:${string}`
  }): Promise<{ project: ImageWorkbenchProject; replayed: boolean }>
  refreshGenerationHeader(result: { project: ImageWorkbenchProject; replayed: boolean }): Promise<ImageWorkbenchProject>
}

/** Narrow persistence/Brief boundary for the Generation Application's plan command. */
export type ImageCreativePlanRuntimePort = {
  loadProject(projectId: string): Promise<ImageWorkbenchProject>
  /** Read-only advice lookup used by the public command; it never starts a paid model call. */
  latestPlanningSuggestion(project: ImageWorkbenchProject): Promise<ImageUnderstandingSuggestion | null>
  /** Compatibility-only fallback for internal flows that explicitly own planning. */
  ensurePlanningSuggestion(project: ImageWorkbenchProject): Promise<ImageUnderstandingSuggestion | null>
  compileBrief(project: ImageWorkbenchProject): Promise<ImageBriefSnapshot>
  findPlan(projectId: string, planId: string): Promise<ImageCreativePlan | null>
  savePlan(plan: ImageCreativePlan, requestHash: `sha256:${string}`): Promise<ImageCreativePlan>
  iso(): string
  revisionConflict(): Error
  adviceConfirmationRequired(): Error
}

/**
 * Narrow durable boundary for ImageCanvasApplication's public Canvas command.
 * Repository owns the per-project fence and SQLite transaction; the
 * Application owns parsing, replay ordering, revision checks and pinned
 * delivery geometry.
 */
export type ImageCanvasCommandRuntimePort = {
  loadProject(projectId: string): Promise<ImageWorkbenchProject>
  canvasCommandResult(input: {
    project_id: string
    canvas_id: string
    idempotency_key: string
    request_hash: `sha256:${string}`
  }): Promise<{ project: ImageWorkbenchProject; canvas: ImageCanvasRevision } | null>
  getCanvasRevision(projectId: string, canvasId: string, revision?: number): Promise<ImageCanvasRevision>
  getDeliverySpecRevision(projectId: string, deliverySpecId: string, revision: number): Promise<ImageDeliverySpec>
  applyCanvasCommand(input: {
    project_id: string
    canvas_id: string
    base_project_revision: number
    command: ImageCanvasCommandInput
    request_hash: `sha256:${string}`
    created_at: string
    delivery_artboard?: {
      width: number
      height: number
      safe_area?: { top: number; right: number; bottom: number; left: number }
    }
  }): Promise<{ project: ImageWorkbenchProject; canvas: ImageCanvasRevision; replayed: boolean }>
  iso(): string
}

/**
 * Narrow durable/execution boundary for ImageDeliveryApplication's export
 * command. Acceptance happens before asynchronous CAS/encoder work; the
 * persisted local_delivery payload remains the recovery source of truth.
 */
export type ImageExportDeliveryRuntimePort = {
  loadProject(projectId: string): Promise<ImageWorkbenchProject>
  currentDeliverySpec(projectId: string): Promise<ImageDeliverySpec | null>
  findAccepted(
    projectId: string,
    idempotencyKey: string,
    requestHash: `sha256:${string}`,
  ): Promise<ImageOperationV2 | null>
  accept(input: {
    project_id: string
    base_revision: number
    operation: ImageOperationV2
  }): Promise<{ operation: ImageOperationV2; project_revision: number; replayed: boolean }>
  schedule(input: { projectId: string; input: ImageExportInput; operationId: string }): void
  iso(): string
  revisionConflict(): Error
  deliverySpecRequired(): Error
}

/**
 * Narrow restart-recovery primitives for ImageRecoveryApplication.  The
 * Runtime retains storage, Relay and renderer mechanics; the Application
 * owns the durable recovery sequence across those independently recoverable
 * domains.
 */
export type ImageRecoveryRuntimePort = {
  recoverPreparedCampaignCancellations(): Promise<void>
  listTransportOperations(): Promise<ImageOperation[]>
  fenceInterruptedSubmission(operation: ImageOperation): Promise<ImageOperation>
  findGenerationOperationByTransportTask(transportOperationId: string): Promise<ImageOperationV2 | null>
  resumeUnpostedGenerationOperation(operation: ImageOperation, generation: ImageOperationV2): Promise<ImageOperation>
  recoverOutcomeUnknownOperation(operation: ImageOperation): Promise<ImageOperation>
  refreshPersistedOperation(operation: ImageOperation): Promise<ImageOperation>
  acknowledgeRemoteResult(operation: ImageOperation): Promise<ImageOperation>
  syncGenerationOperationFromTransport(operation: ImageOperationV2, transport: ImageOperation): Promise<ImageOperationV2>
  listRecoverableLocalDeliveryOperations(): Promise<ImageOperationV2[]>
  resumeCanvasRender(operation: ImageOperationV2): Promise<void>
  resumeExportDelivery(operation: ImageOperationV2): Promise<void>
  listUnacknowledgedGatewayAdviceReceipts(): Promise<ProviderExecutionReceipt[]>
  acknowledgeQwenGatewayResult(receipt: ProviderExecutionReceipt): Promise<ProviderExecutionReceipt>
  recoverCampaigns(): Promise<void>
}

type QuickCreateLifecycle = {
  /** Public API uses `prepare`; internal Campaign/compatibility flows opt into `start`. */
  mode?: 'prepare' | 'start'
  /** Called after the Round/Operation transaction, before the first paid POST. */
  on_generation_round_persisted?: (value: {
    project: ImageWorkbenchProject
    round: ImageGenerationRound
    operations: ImageOperationV2[]
  }) => Promise<void>
}

export type ImageWorkbenchRuntimeOptions = {
  root?: string
  now?: () => Date
  fetchImpl?: FetchLike
  imageResultTimeoutMs?: number
  imageReasoningTimeoutMs?: number
  legacyMediaRoot?: string
  casOrphanRetentionMs?: number
  canvasRenderer?: DeterministicImageCanvasRenderer
  /** Deliberate crash boundaries used by recovery verification only. */
  crashInjector?: (point: ImageWorkbenchCrashPoint) => void
}

/**
 * The image workbench owns image project state, bytes, versions and operation
 * records. It deliberately has no dependency on MediaProjectService, video
 * state, or an Agent session. Remote image execution is attached to the
 * persisted ImageOperation record in a later section of this same service.
 */
/**
 * Internal image runtime. It owns the single Repository/CAS/transaction and
 * recovery implementation used by every image Application. It is deliberately
 * not an HTTP or desktop-facing service.
 */
export class ImageWorkbenchRuntime {
  readonly repository: SqliteImageMetadataStore
  readonly assets: ImageAssetStore
  private readonly now: () => Date
  private readonly fetchImpl: FetchLike
  private readonly imageResultTimeoutMs: number
  /**
   * Optional caller-side transport guard for Qwen advice.  Production does
   * not use a fixed client deadline: Gateway owns the provider deadline and
   * its durable operation-result fence.  A timeout here is only an explicit
   * embedding/test choice and is never a reason to submit the same advice or
   * image task again.
   */
  private readonly imageReasoningTimeoutMs: number | undefined
  private readonly legacyMediaRoot: string
  private readonly legacyReader: LegacyImageProjectReader
  private readonly crashInjector?: (point: ImageWorkbenchCrashPoint) => void
  private readonly activeSubmissions = new Map<string, Promise<ImageOperation>>()
  private readonly activeRefreshes = new Map<string, Promise<ImageOperation>>()
  private readonly activeAdviceRequests = new Map<string, Promise<ImageUnderstandingSuggestion>>()
  private readonly activeVisualAssessments = new Map<string, Promise<ImageVisualAssessment>>()
  private readonly activeLocalDeliveries = new Map<string, Promise<void>>()
  private readonly canvasRenderer: DeterministicImageCanvasRenderer

  constructor(options: ImageWorkbenchRuntimeOptions = {}) {
    this.now = options.now ?? (() => new Date())
    this.fetchImpl = options.fetchImpl ?? fetch
    this.imageResultTimeoutMs = Math.max(1_000, Math.min(120_000, options.imageResultTimeoutMs ?? 30_000))
    // Do not turn a guessed client-side duration into a business decision.
    // Gateway returns a durable receipt/result or an explicit outcome-unknown
    // response; the local client may opt into a transport guard for tests or
    // an embedding that owns its own cancellation policy.
    this.imageReasoningTimeoutMs = options.imageReasoningTimeoutMs === undefined
      ? undefined
      : Math.max(1_000, Math.min(120_000, options.imageReasoningTimeoutMs))
    this.legacyMediaRoot = options.legacyMediaRoot
      ?? join(process.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'media')
    this.legacyReader = new LegacyImageProjectReader(this.legacyMediaRoot)
    const imageRoot = options.root
      ?? join(process.env.BILLIARDBUDDY_CONFIG_DIR ?? join(homedir(), '.BilliardBuddy'), 'billiardbuddy', 'images')
    this.repository = new SqliteImageMetadataStore({
      root: imageRoot,
      now: this.now,
      casOrphanRetentionMs: options.casOrphanRetentionMs,
      legacyMigrationSources: resolve(this.legacyMediaRoot) === resolve(imageRoot)
        ? []
        : [{ source_kind: 'generic-media-json-v1', root: this.legacyMediaRoot }],
    })
    this.crashInjector = options.crashInjector
    this.canvasRenderer = options.canvasRenderer ?? new DeterministicImageCanvasRenderer()
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
  private initialProjectionModel(
    userRequest: string,
    size: ImageWorkbenchProject['size'],
    modelSelection: ImageWorkbenchProject['generation_preferences']['model_selection'] = 'auto',
  ): ImageWorkbenchProject['model'] {
    return this.resolveGenerationPolicy({
      user_request: userRequest,
      size,
      operation_mode: 'generate',
      references: [],
      ...(modelSelection === 'auto' ? {} : { preferred_model: modelSelection }),
    }).model_id
  }

  /**
   * A small, stable set of human purposes maps to the native dimensions each
   * current model accepts.  Raw pixels remain durable execution data, never a
   * choice the ordinary image user has to make.
   */
  private resolvedOutputPreset(
    preset: ImageQuickCreateInput['output_preset'],
    userRequest: string,
  ): Exclude<ImageQuickCreateInput['output_preset'], 'auto' | 'landscape' | 'portrait'> {
    if (preset !== 'auto') {
      if (preset === 'landscape') return 'social_landscape'
      if (preset === 'portrait') return 'social_portrait'
      return preset
    }
    if (/横幅|横条|Banner|banner|店招|网页头图/u.test(userRequest)) return 'wide_banner'
    if (/演示|PPT|幻灯|电脑屏幕|投影|16[:：]9/u.test(userRequest)) return 'presentation'
    if (/故事|竖屏|短视频|视频封面|直播|抖音|快手|9[:：]16/u.test(userRequest)) return 'story'
    // An explicit orientation always wins over the generic “海报” noun.
    if (/公众号|头图|横版|横图|信息流/u.test(userRequest)) return 'social_landscape'
    if (/小红书|竖版|竖图|招贴|海报|传单/u.test(userRequest)) return 'social_portrait'
    return 'square'
  }

  private quickCreateSize(
    preset: ImageQuickCreateInput['output_preset'],
    model: ImageGenerationModel,
    userRequest: string,
  ): ImageCanvasSize {
    const resolved = this.resolvedOutputPreset(preset, userRequest)
    const sizes: Record<ImageGenerationModel, Record<Exclude<ImageQuickCreateInput['output_preset'], 'auto' | 'landscape' | 'portrait'>, ImageCanvasSize>> = {
      'gpt-image-2': {
        square: '1024x1024',
        social_landscape: '1536x1024',
        social_portrait: '1024x1536',
        story: '2160x3840',
        presentation: '2048x1152',
        wide_banner: '3840x2160',
      },
      'doubao-seedream-4-5-251128': {
        square: '2048x2048',
        social_landscape: '2304x1728',
        social_portrait: '1728x2304',
        story: '1600x2848',
        presentation: '2848x1600',
        wide_banner: '3136x1344',
      },
    }
    return sizes[model][resolved]
  }

  private provisionalReference(role: ImageReferenceV2['role'], index: number): ImageReferenceV2 {
    const highFidelity = role === 'subject' || role === 'product' || role === 'character'
    return {
      id: stableId('ref', 'provisional', role, String(index)),
      project_id: 'img_provisional000000000000000000000000',
      asset_id: `asset_${'0'.repeat(32)}`,
      role,
      content_hash: `sha256:${'0'.repeat(64)}`,
      influence_strength: highFidelity ? 'high' : 'medium',
      preservation: highFidelity ? 'must_preserve' : role === 'logo' || role === 'qrcode' ? 'exact' : 'prefer_preserve',
      priority: index,
      created_at: this.iso(),
    }
  }

  private resolveGenerationChoice(input: {
    user_request: string
    output_preset: ImageQuickCreateInput['output_preset']
    model_selection: ImageWorkbenchProject['generation_preferences']['model_selection']
    references: ImageReferenceV2[]
    operation_mode: 'generate' | 'edit'
  }): { model: ImageGenerationModel; size: ImageCanvasSize } {
    const model = this.resolveGenerationModel({
      user_request: input.user_request,
      operation_mode: input.operation_mode,
      references: input.references,
      ...(input.model_selection === 'auto' ? {} : { preferred_model: input.model_selection }),
    })
    return { model, size: this.quickCreateSize(input.output_preset, model, input.user_request) }
  }

  private resolveGenerationModel(input: Parameters<typeof resolveImageProviderModel>[0]): ImageGenerationModel {
    try {
      return resolveImageProviderModel(input)
    } catch (error) {
      if (error instanceof ImageProviderPolicyError) {
        throw new ImageWorkbenchServiceError(error.message, 422, error.gap.code)
      }
      throw error
    }
  }

  private selectedModel(project: ImageWorkbenchProject): ImageGenerationModel | undefined {
    return project.generation_preferences.model_selection === 'auto'
      ? undefined
      : project.generation_preferences.model_selection
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
    // Qwen can only add an explicit "needs confirmation" signal. It never
    // changes the user's facts, preserve rules, exact text, or provider prompt
    // without a later user command.
    const latestSuggestion = await this.repository.latestUnderstandingSuggestion(project.id)
    // Advice belongs to one immutable Project revision.  Older persisted
    // suggestions predate this field, so deliberately ignore them rather than
    // applying model output to a later user edit.
    const qwenSuggestion = latestSuggestion?.project_revision === project.revision
      ? latestSuggestion
      : null
    const { width, height } = sizeDimensions(project.size)
    const snapshot = {
      schema_version: 2 as const,
      id: id('brf'),
      project_id: project.id,
      user_request: legacy.user_request,
      confirmed_facts: legacy.confirmed_facts,
      must_preserve: legacy.must_preserve,
      may_change: legacy.may_change,
      missing_information: [...new Set([...legacy.missing_information, ...(qwenSuggestion?.missing_information ?? [])])].slice(0, 20),
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
      ...(qwenSuggestion ? { reasoning_receipt_id: qwenSuggestion.execution_receipt_id } : {}),
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
        reasoning_receipt_id: snapshot.reasoning_receipt_id ?? null,
      }),
    })
  }

  private async initializeGenerationHeader(project: ImageWorkbenchProject): Promise<ImageWorkbenchProject> {
    let current = project
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const delivery = await this.ensureDeliverySpec(current)
      const brief = await this.compileGenerationBrief(current)
      if (
        current.current_brief_id === brief.id
        && current.current_delivery_spec_id === delivery.id
        && current.current_delivery_spec_revision === delivery.revision
      ) return current
      try {
        return await this.repository.saveProject({
          ...current,
          current_brief_id: brief.id,
          current_delivery_spec_id: delivery.id,
          current_delivery_spec_revision: delivery.revision,
          revision: current.revision + 1,
        })
      } catch (error) {
        if (!(error instanceof ImageWorkbenchRepositoryError) || error.code !== 'IMAGE_WRITER_FENCE_CONFLICT') throw error
        // Another concurrent initializer won the header write. Re-read its
        // immutable result and retry only the header repair, never the user
        // command or a paid operation.
        current = await this.project(project.id)
      }
    }
    return await this.project(project.id)
  }

  private async qwenReferenceInputs(project: ImageWorkbenchProject): Promise<Array<{
    content_hash: `sha256:${string}`
    role: 'subject' | 'product' | 'character' | 'style' | 'composition' | 'environment' | 'brand' | 'logo' | 'qrcode'
    influence_strength: 'low' | 'medium' | 'high'
    preservation: 'may_change' | 'prefer_preserve' | 'must_preserve' | 'exact'
    priority: number
    data_url: string
  }>> {
    const references = this.generationReferences(project)
    let total = 0
    const values = await Promise.all(references.map(async reference => {
      if (reference.role === 'unclassified') throw new ImageWorkbenchServiceError('未分类参考图不能发送给 Qwen', 422, 'IMAGE_REFERENCE_UNCLASSIFIED')
      const asset = project.assets.find(candidate => candidate.id === reference.asset_id)
      if (!asset) throw new ImageWorkbenchServiceError('Qwen 参考素材不存在', 409, 'REFERENCE_IMAGE_MISSING')
      const verified = await this.assets.providerUpload(asset)
      total += verified.bytes.byteLength
      return {
        content_hash: verified.content_hash,
        role: reference.role,
        influence_strength: reference.influence_strength,
        preservation: reference.preservation,
        priority: reference.priority,
        data_url: `data:${verified.mime_type};base64,${verified.bytes.toString('base64')}`,
      }
    }))
    if (total > IMAGE_QWEN_MAX_INPUT_BYTES) throw new ImageWorkbenchServiceError('Qwen 图片理解输入超过资源上限', 413, 'IMAGE_QWEN_INPUT_TOO_LARGE')
    return values
  }

  private async qwenReasoning(request: Parameters<typeof requestQwenImageReasoning>[0], operationId: string): Promise<Awaited<ReturnType<typeof requestQwenImageReasoning>>> {
    try {
      const signal = this.imageReasoningTimeoutMs === undefined
        ? undefined
        : AbortSignal.timeout(this.imageReasoningTimeoutMs)
      return await requestQwenImageReasoning(request, {
        operationId,
        ...(signal ? { signal } : {}),
        fetchImpl: this.fetchImpl,
      })
    } catch (error) {
      if (error instanceof QwenImageReasoningError) {
        throw new ImageWorkbenchServiceError(error.message, error.status, error.code)
      }
      throw error
    }
  }

  /**
   * One idempotent prompt-planning attempt per Project revision.  It is
   * deliberately best-effort: a planning outage must not turn ordinary image
   * generation into an unavailable feature, and it never reaches the paid
   * image Provider without the normal deterministic Brief and quote checks.
   */
  private async ensurePlanningSuggestion(project: ImageWorkbenchProject): Promise<ImageUnderstandingSuggestion | null> {
    // A user-requested reference understanding already contains bounded visual
    // guidance for this project. Reuse it rather than create a second hidden
    // LLM call merely because the user proceeds to the normal Plan command.
    const existing = await this.repository.latestUnderstandingSuggestion(project.id)
    if (existing?.project_revision === project.revision) return existing
    const idempotencyKey = `bb-image-prompt-plan-${sha256({
      project_id: project.id,
      revision: project.revision,
      generation_preferences: project.generation_preferences,
      brief: project.brief?.user_request ?? project.title,
      reference_hashes: project.references.map(reference => reference.asset_id),
    }).slice('sha256:'.length)}`
    try {
      return await this.understandProject(project.id, {
        base_revision: project.revision,
        idempotency_key: idempotencyKey,
      })
    } catch {
      return null
    }
  }

  private async latestPlanningSuggestion(project: ImageWorkbenchProject): Promise<ImageUnderstandingSuggestion | null> {
    const existing = await this.repository.latestUnderstandingSuggestion(project.id)
    return existing?.project_revision === project.revision ? existing : null
  }

  /** Local receipt first, then tell Gateway it may retire its durable replay. */
  private async acknowledgeQwenGatewayResult(receipt: ProviderExecutionReceipt): Promise<ProviderExecutionReceipt> {
    if (receipt.gateway_result_acknowledged_at || !receipt.gateway_result_fingerprint) return receipt
    const target = productGatewayTarget()
    if (!target) return receipt
    try {
      const response = await this.fetchImpl(`${target.baseUrl}${PROVIDER_OPERATION_ACK_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.token}`,
          [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
          [PROVIDER_OPERATION_RESULT_ID_HEADER]: receipt.id,
          [PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER]: 'ImageAdvice',
          [PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER]: receipt.gateway_result_fingerprint,
        },
      })
      if (response.status !== 204) return receipt
      return await this.repository.saveExecutionReceipt({
        ...receipt,
        gateway_result_acknowledged_at: this.iso(),
      })
    } catch {
      // The local receipt and suggestion are already transactional.  Keep the
      // Gateway result for a later idempotent ACK rather than repeat advice.
      return receipt
    }
  }

  /** Optional understanding persists only bounded suggestions and its receipt. */
  async understandProject(projectId: string, raw: ImageUnderstandingInput): Promise<ImageUnderstandingSuggestion> {
    const input = imageUnderstandingInputSchema.parse(raw)
    const activeKey = `${projectId}:${input.base_revision}`
    const active = this.activeAdviceRequests.get(activeKey)
    if (active) return await active
    const task = this.understandProjectOnce(projectId, input)
    this.activeAdviceRequests.set(activeKey, task)
    try {
      return await task
    } finally {
      if (this.activeAdviceRequests.get(activeKey) === task) this.activeAdviceRequests.delete(activeKey)
    }
  }

  private async understandProjectOnce(projectId: string, input: ImageUnderstandingInput): Promise<ImageUnderstandingSuggestion> {
    const project = await this.project(projectId)
    const briefInput = {
      user_request: project.brief?.user_request ?? project.title,
      confirmed_facts: project.brief?.confirmed_facts ?? [],
      must_preserve: project.brief?.must_preserve ?? [],
    }
    const requestHash = sha256({
      kind: 'image_understanding', project_id: project.id, base_revision: input.base_revision, input: {
        ...briefInput,
        references: this.generationReferences(project).map(reference => ({
          content_hash: reference.content_hash,
          role: reference.role,
          influence_strength: reference.influence_strength,
          preservation: reference.preservation,
          priority: reference.priority,
        })),
      },
    })
    const replay = await this.repository.understandingSuggestionByIdempotency(project.id, input.idempotency_key)
    if (replay) {
      if (replay.request_hash !== requestHash) throw new ImageWorkbenchServiceError('Qwen 理解幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      await this.acknowledgeQwenGatewayResult(await this.repository.getExecutionReceipt(project.id, replay.suggestion.execution_receipt_id))
      return replay.suggestion
    }
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再请求理解建议')
    // The caller key is only a compatibility handle. The paid Qwen operation is
    // keyed by the immutable project revision so a retry with a fresh random key
    // cannot reserve another provider request for the same facts.
    const canonicalIdempotencyKey = `bb-image-advice-${sha256({ project_id: project.id, project_revision: project.revision }).slice('sha256:'.length)}`
    const latest = await this.repository.latestUnderstandingSuggestionRecord(project.id)
    if (latest?.suggestion.project_revision === project.revision) {
      if (latest.request_hash !== requestHash) throw new ImageWorkbenchServiceError('Qwen 理解幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      await this.acknowledgeQwenGatewayResult(await this.repository.getExecutionReceipt(project.id, latest.suggestion.execution_receipt_id))
      return latest.suggestion
    }
    const references = await this.qwenReferenceInputs(project)
    const receiptId = stableId('receipt', project.id, 'qwen-understanding', canonicalIdempotencyKey)
    const remote = await this.qwenReasoning({
      schema_version: 1, application_role: 'image_understanding', idempotency_key: canonicalIdempotencyKey,
      input: { ...briefInput, references },
    }, receiptId)
    const response = remote.response
    if (response.application_role !== 'image_understanding') throw new ImageWorkbenchServiceError('Qwen 理解返回角色不匹配', 502, 'IMAGE_QWEN_RESPONSE_INVALID')
    const now = this.iso()
    const receipt: ProviderExecutionReceipt = {
      id: receiptId, project_id: project.id, owner: project.owner, capability: 'image_understanding', registry_capability: 'VisualEvidence',
      provider: 'qwen', model_id: 'qwen3-vl-flash', policy_revision: 'qwen-image-reasoning-v2', prompt_compiler_version: 'qwen-image-reasoning-v2',
      idempotency_key: canonicalIdempotencyKey, request_hash: requestHash, input_asset_hashes: references.map(reference => reference.content_hash), submitted_at: now, completed_at: now,
      ...(response.provider_request_id ? { provider_request_id: response.provider_request_id } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
      gateway_result_fingerprint: remote.gateway_result.fingerprint,
    }
    const saved = await this.repository.saveUnderstandingSuggestionWithReceipt({
      id: stableId('receipt', project.id, 'understanding', canonicalIdempotencyKey), project_id: project.id, execution_receipt_id: receipt.id,
      project_revision: project.revision,
      ...response.output, created_at: now,
    }, receipt, requestHash)
    await this.acknowledgeQwenGatewayResult(receipt)
    return saved
  }

  /** Candidate assessment is immutable advice. It cannot adopt, delete, or publish pixels. */
  async assessCandidateVisual(projectId: string, candidateId: string, raw: ImageVisualAssessmentInput): Promise<ImageVisualAssessment> {
    const input = imageVisualAssessmentInputSchema.parse(raw)
    const project = await this.project(projectId)
    const candidate = await this.repository.getCandidate(project.id, candidateId)
    const briefInput = {
      user_request: project.brief?.user_request ?? project.title,
      confirmed_facts: project.brief?.confirmed_facts ?? [],
      must_preserve: project.brief?.must_preserve ?? [],
    }
    const requestHash = sha256({
      kind: 'image_visual_assessment', project_id: project.id, candidate_id: candidate.id, base_revision: input.base_revision,
      input: { ...briefInput, candidate_hash: candidate.content_hash },
    })
    const replay = await this.repository.visualAssessmentByIdempotency(project.id, input.idempotency_key)
    if (replay) {
      if (replay.request_hash !== requestHash) throw new ImageWorkbenchServiceError('Qwen 评估幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      await this.acknowledgeQwenGatewayResult(await this.repository.getExecutionReceipt(project.id, replay.assessment.execution_receipt_id))
      return replay.assessment
    }
    const canonicalKey = `bb-image-assessment-${sha256({ project_id: project.id, target: 'candidate', target_id: candidate.id, request_hash: requestHash }).slice('sha256:'.length)}`
    const active = this.activeVisualAssessments.get(canonicalKey)
    if (active) return await active
    const task = this.assessCandidateVisualOnce(project, candidate, input, briefInput, requestHash, canonicalKey)
    this.activeVisualAssessments.set(canonicalKey, task)
    try {
      return await task
    } finally {
      if (this.activeVisualAssessments.get(canonicalKey) === task) this.activeVisualAssessments.delete(canonicalKey)
    }
  }

  private async assessCandidateVisualOnce(
    project: ImageWorkbenchProject,
    candidate: ImageCandidate,
    input: ImageVisualAssessmentInput,
    briefInput: { user_request: string; confirmed_facts: string[]; must_preserve: string[] },
    requestHash: `sha256:${string}`,
    canonicalKey: string,
  ): Promise<ImageVisualAssessment> {
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再请求视觉评估')
    const latest = await this.repository.latestVisualAssessmentRecordForCandidate(project.id, candidate.id)
    if (latest?.request_hash === requestHash) {
      await this.acknowledgeQwenGatewayResult(await this.repository.getExecutionReceipt(project.id, latest.assessment.execution_receipt_id))
      return latest.assessment
    }
    const asset = project.assets.find(item => item.id === candidate.asset_id && item.role === 'result')
    if (!asset) throw new ImageWorkbenchServiceError('候选图片资产不存在', 409, 'IMAGE_ASSET_NOT_FOUND')
    const verified = await this.assets.providerUpload(asset)
    if (verified.bytes.byteLength > IMAGE_QWEN_MAX_INPUT_BYTES) throw new ImageWorkbenchServiceError('Qwen 视觉评估输入超过资源上限', 413, 'IMAGE_QWEN_INPUT_TOO_LARGE')
    const receiptId = stableId('receipt', project.id, 'qwen-assessment', canonicalKey)
    const remote = await this.qwenReasoning({
      schema_version: 1, application_role: 'image_visual_assessment', idempotency_key: canonicalKey,
      input: {
        ...briefInput,
        candidate: { content_hash: verified.content_hash, data_url: `data:${verified.mime_type};base64,${verified.bytes.toString('base64')}` },
      },
    }, receiptId)
    const response = remote.response
    if (response.application_role !== 'image_visual_assessment') throw new ImageWorkbenchServiceError('Qwen 评估返回角色不匹配', 502, 'IMAGE_QWEN_RESPONSE_INVALID')
    const now = this.iso()
    const receipt: ProviderExecutionReceipt = {
      id: receiptId, project_id: project.id, owner: project.owner, capability: 'image_visual_assessment', registry_capability: 'VisualEvidence',
      provider: 'qwen', model_id: 'qwen3-vl-flash', policy_revision: 'qwen-image-reasoning-v2', prompt_compiler_version: 'qwen-image-reasoning-v2',
      idempotency_key: canonicalKey, request_hash: requestHash, input_asset_hashes: [verified.content_hash], submitted_at: now, completed_at: now,
      ...(response.provider_request_id ? { provider_request_id: response.provider_request_id } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
      gateway_result_fingerprint: remote.gateway_result.fingerprint,
    }
    const saved = await this.repository.saveVisualAssessmentWithReceipt({
      id: stableId('receipt', project.id, 'assessment', canonicalKey), project_id: project.id, candidate_id: candidate.id, execution_receipt_id: receipt.id,
      ...response.output, created_at: now,
    }, receipt, requestHash)
    await this.acknowledgeQwenGatewayResult(receipt)
    return saved
  }

  /** A formal Version is assessed with the same advice-only contract as a Candidate. */
  async assessVersionVisual(projectId: string, versionId: string, raw: ImageVisualAssessmentInput): Promise<ImageVisualAssessment> {
    const input = imageVisualAssessmentInputSchema.parse(raw)
    const project = await this.project(projectId)
    const { version, asset } = this.imageVersion(project, versionId)
    const briefInput = {
      user_request: project.brief?.user_request ?? project.title,
      confirmed_facts: project.brief?.confirmed_facts ?? [],
      must_preserve: project.brief?.must_preserve ?? [],
    }
    const verified = await this.assets.providerUpload(asset)
    const requestHash = sha256({
      kind: 'image_visual_assessment', project_id: project.id, version_id: version.id, base_revision: input.base_revision,
      input: { ...briefInput, candidate_hash: verified.content_hash },
    })
    const replay = await this.repository.visualAssessmentByIdempotency(project.id, input.idempotency_key)
    if (replay) {
      if (replay.request_hash !== requestHash) throw new ImageWorkbenchServiceError('Qwen 评估幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      await this.acknowledgeQwenGatewayResult(await this.repository.getExecutionReceipt(project.id, replay.assessment.execution_receipt_id))
      return replay.assessment
    }
    const canonicalKey = `bb-image-assessment-${sha256({ project_id: project.id, target: 'version', target_id: version.id, request_hash: requestHash }).slice('sha256:'.length)}`
    const active = this.activeVisualAssessments.get(canonicalKey)
    if (active) return await active
    const task = this.assessVersionVisualOnce(project, version.id, asset, input, briefInput, requestHash, canonicalKey)
    this.activeVisualAssessments.set(canonicalKey, task)
    try {
      return await task
    } finally {
      if (this.activeVisualAssessments.get(canonicalKey) === task) this.activeVisualAssessments.delete(canonicalKey)
    }
  }

  private async assessVersionVisualOnce(
    project: ImageWorkbenchProject,
    versionId: string,
    asset: MediaAsset,
    input: ImageVisualAssessmentInput,
    briefInput: { user_request: string; confirmed_facts: string[]; must_preserve: string[] },
    requestHash: `sha256:${string}`,
    canonicalKey: string,
  ): Promise<ImageVisualAssessment> {
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再请求视觉评估')
    const latest = await this.repository.latestVisualAssessmentRecordForVersion(project.id, versionId)
    if (latest?.request_hash === requestHash) {
      await this.acknowledgeQwenGatewayResult(await this.repository.getExecutionReceipt(project.id, latest.assessment.execution_receipt_id))
      return latest.assessment
    }
    if (asset.role !== 'result') throw new ImageWorkbenchServiceError('图片版本资产不存在', 409, 'IMAGE_ASSET_NOT_FOUND')
    const verified = await this.assets.providerUpload(asset)
    if (verified.bytes.byteLength > IMAGE_QWEN_MAX_INPUT_BYTES) throw new ImageWorkbenchServiceError('Qwen 视觉评估输入超过资源上限', 413, 'IMAGE_QWEN_INPUT_TOO_LARGE')
    const receiptId = stableId('receipt', project.id, 'qwen-version-assessment', canonicalKey)
    const remote = await this.qwenReasoning({
      schema_version: 1, application_role: 'image_visual_assessment', idempotency_key: canonicalKey,
      input: {
        ...briefInput,
        candidate: { content_hash: verified.content_hash, data_url: `data:${verified.mime_type};base64,${verified.bytes.toString('base64')}` },
      },
    }, receiptId)
    const response = remote.response
    if (response.application_role !== 'image_visual_assessment') throw new ImageWorkbenchServiceError('Qwen 评估返回角色不匹配', 502, 'IMAGE_QWEN_RESPONSE_INVALID')
    const now = this.iso()
    const receipt: ProviderExecutionReceipt = {
      id: receiptId, project_id: project.id, owner: project.owner, capability: 'image_visual_assessment', registry_capability: 'VisualEvidence',
      provider: 'qwen', model_id: 'qwen3-vl-flash', policy_revision: 'qwen-image-reasoning-v2', prompt_compiler_version: 'qwen-image-reasoning-v2',
      idempotency_key: canonicalKey, request_hash: requestHash, input_asset_hashes: [verified.content_hash], submitted_at: now, completed_at: now,
      ...(response.provider_request_id ? { provider_request_id: response.provider_request_id } : {}),
      ...(response.usage ? { usage: response.usage } : {}),
      gateway_result_fingerprint: remote.gateway_result.fingerprint,
    }
    const saved = await this.repository.saveVisualAssessmentWithReceipt({
      id: stableId('receipt', project.id, 'version-assessment', canonicalKey), project_id: project.id, version_id: versionId, execution_receipt_id: receipt.id,
      ...response.output, created_at: now,
    }, receipt, requestHash)
    await this.acknowledgeQwenGatewayResult(receipt)
    return saved
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

  /**
   * The API catalog is intentionally semantic: it gives a front end enough
   * information to build a useful picker without exposing raw provider-size
   * parameters or the internal prompt-planning model.
   */
  generationPreferencesCatalog() {
    return {
      models: [
        { id: 'auto' as const, label: '智能推荐', description: '根据用途、语言和参考图控制要求自动选择最合适的图片模型。' },
        { id: 'gpt-image-2' as const, label: 'GPT Image', description: '适合主体、产品或角色需要严格保持，以及需要局部重绘的任务。' },
        { id: 'doubao-seedream-4-5-251128' as const, label: 'Seedream', description: '适合中文商业主视觉、海报和更高分辨率的常规创作。' },
      ],
      output_presets: [
        { id: 'square' as const, label: '方图', description: '主体聚焦、商品主图和通用封面。', use_cases: ['商品主图', '头像封面', '社媒方图'] },
        { id: 'social_landscape' as const, label: '社媒横图', description: '适合横向信息流与文章头图。', use_cases: ['公众号头图', '横向信息流', '活动主视觉'] },
        { id: 'social_portrait' as const, label: '社媒竖图', description: '适合竖版信息流和海报展示。', use_cases: ['竖版海报', '小红书配图', '传单'] },
        { id: 'story' as const, label: '故事竖屏', description: '适合全屏竖向内容与视频封面。', use_cases: ['短视频封面', '直播预告', '故事页'] },
        { id: 'presentation' as const, label: '演示横图', description: '适合屏幕展示、PPT 和投影画面。', use_cases: ['PPT', '大屏', '电脑壁纸'] },
        { id: 'wide_banner' as const, label: '横幅', description: '适合网页横幅、店招和长条展示位。', use_cases: ['网页横幅', '店招', 'Banner'] },
      ],
    }
  }

  async getProject(projectId: string): Promise<ImageWorkbenchProject> {
    return await this.project(projectId)
  }

  /** @internal Composition-only dependency for ImageProjectApplication. */
  createReferenceControlPort(): ImageReferenceControlRuntimePort {
    return Object.freeze({
      loadProject: async (projectId: string) => await this.project(projectId),
      findCommand: async (projectId: string, idempotencyKey: string, requestHash: `sha256:${string}`) =>
        await this.repository.findReferenceControlCommandResult(projectId, idempotencyKey, requestHash),
      assertNoActiveOperation: async (project: ImageWorkbenchProject) => await this.assertNoActiveOperation(project),
      assertNoActiveGenerationOperation: async (project: ImageWorkbenchProject) => await this.assertNoActiveGenerationOperation(project),
      save: async input => await this.repository.saveReferenceControlProject(input),
      refreshGenerationHeader: async result => await this.refreshWorkflowProject(result),
    })
  }

  /** @internal Composition-only dependency for ImageGenerationApplication. */
  createCreativePlanPort(): ImageCreativePlanRuntimePort {
    return Object.freeze({
      loadProject: async (projectId: string) => await this.project(projectId),
      latestPlanningSuggestion: async (project: ImageWorkbenchProject) => await this.latestPlanningSuggestion(project),
      ensurePlanningSuggestion: async (project: ImageWorkbenchProject) => await this.ensurePlanningSuggestion(project),
      compileBrief: async (project: ImageWorkbenchProject) => await this.compileGenerationBrief(project),
      findPlan: async (projectId: string, planId: string) => await this.repository.getCreativePlan(projectId, planId).catch(error => {
        if (error instanceof ImageWorkbenchRepositoryError && error.status === 404) return null
        throw error
      }),
      savePlan: async (plan: ImageCreativePlan, requestHash: `sha256:${string}`) =>
        await this.repository.saveCreativePlan(plan, requestHash),
      iso: () => this.iso(),
      revisionConflict: () => new ImageWorkbenchServiceError('图片项目已更新，请刷新后再创建创作方向', 409, 'IMAGE_REVISION_CONFLICT'),
      adviceConfirmationRequired: () => new ImageWorkbenchServiceError('请先阅读并确认当前 AI 建议，再创建创作方向', 409, 'IMAGE_ADVICE_CONFIRMATION_REQUIRED'),
    })
  }

  /** @internal Composition-only dependency for ImageCanvasApplication. */
  createCanvasCommandPort(): ImageCanvasCommandRuntimePort {
    return Object.freeze({
      loadProject: async (projectId: string) => await this.project(projectId),
      canvasCommandResult: async input => await this.repository.canvasCommandResult(input),
      getCanvasRevision: async (projectId: string, canvasId: string, revision?: number) =>
        await this.repository.getCanvasRevision(projectId, canvasId, revision),
      getDeliverySpecRevision: async (projectId: string, deliverySpecId: string, revision: number) =>
        await this.repository.getDeliverySpecRevision(projectId, deliverySpecId, revision),
      // The Repository repeats idempotency/revision checks while holding the
      // same project fence and BEGIN IMMEDIATE transaction as the write.
      applyCanvasCommand: async input => await this.repository.applyCanvasCommand(input),
      iso: () => this.iso(),
    })
  }

  /** @internal Composition-only dependency for ImageDeliveryApplication. */
  createExportDeliveryPort(): ImageExportDeliveryRuntimePort {
    return Object.freeze({
      loadProject: async (projectId: string) => await this.project(projectId),
      currentDeliverySpec: async (projectId: string) => await this.repository.currentDeliverySpec(projectId),
      findAccepted: async (projectId: string, idempotencyKey: string, requestHash: `sha256:${string}`) => {
        const operation = await this.repository.findGenerationOperation(stableId('op', projectId, 'export', idempotencyKey))
        if (!operation) return null
        if (operation.project_id !== projectId || operation.kind !== 'export' || operation.idempotency_key !== idempotencyKey) {
          throw new ImageWorkbenchServiceError('图片导出操作身份无效', 409, 'IMAGE_OPERATION_CORRUPT')
        }
        if (operation.request_hash !== requestHash) {
          throw new ImageWorkbenchServiceError('图片导出幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
        }
        return operation
      },
      accept: async input => {
        try {
          const accepted = await this.repository.acceptExportOperation(input)
          return { operation: accepted.operation, project_revision: accepted.project.revision, replayed: accepted.replayed }
        } catch (error) {
          if (error instanceof ImageWorkbenchRepositoryError) {
            throw new ImageWorkbenchServiceError(error.message, error.status, error.code)
          }
          throw error
        }
      },
      schedule: ({ projectId, input, operationId }) => {
        queueMicrotask(() => { void this.runLocalDelivery(operationId, async () => {
          await this.executeExportDelivery(projectId, input)
        }) })
      },
      iso: () => this.iso(),
      revisionConflict: () => new ImageWorkbenchServiceError('图片项目已更新，请刷新后再导出', 409, 'IMAGE_REVISION_CONFLICT'),
      deliverySpecRequired: () => new ImageWorkbenchServiceError('图片项目缺少可用交付规格', 409, 'IMAGE_DELIVERY_SPEC_REQUIRED'),
    })
  }

  /** @internal Composition-only dependency for ImageRecoveryApplication. */
  createRecoveryPort(): ImageRecoveryRuntimePort {
    return Object.freeze({
      recoverPreparedCampaignCancellations: async () => await this.recoverPreparedCampaignCancellations(),
      listTransportOperations: async () => await this.repository.listOperations(),
      fenceInterruptedSubmission: async operation => await this.fenceInterruptedSubmission(operation),
      findGenerationOperationByTransportTask: async transportOperationId =>
        await this.repository.getGenerationOperationByTransportTask(transportOperationId),
      resumeUnpostedGenerationOperation: async (operation, generation) =>
        await this.resumeUnpostedGenerationOperation(operation, generation),
      recoverOutcomeUnknownOperation: async operation => await this.recoverOutcomeUnknownOperation(operation),
      refreshPersistedOperation: async operation => await this.refreshPersistedOperation(operation),
      acknowledgeRemoteResult: async operation => await this.acknowledgeRemoteResult(operation),
      syncGenerationOperationFromTransport: async (operation, transport) =>
        await this.syncGenerationOperationFromTransport(operation, transport),
      listRecoverableLocalDeliveryOperations: async () => {
        const projects = await this.listProjects()
        return (await Promise.all(projects.map(async project =>
          (await this.repository.listGenerationOperations(project.id))
            .filter(operation => operation.local_delivery && ['queued', 'running', 'committing'].includes(operation.status)),
        ))).flat()
      },
      resumeCanvasRender: async operation => {
        await this.resumeLocalCanvasRender(operation)
      },
      resumeExportDelivery: async operation => {
        const local = operation.local_delivery
        if (!local || local.kind !== 'export') return
        await this.runLocalDelivery(operation.id, async () => {
          await this.executeExportDelivery(operation.project_id, {
            base_revision: operation.input_refs.project_revision,
            idempotency_key: operation.idempotency_key,
            version_ids_by_artboard: local.version_ids_by_artboard,
          })
        })
      },
      listUnacknowledgedGatewayAdviceReceipts: async () =>
        await this.repository.listUnacknowledgedGatewayAdviceReceipts(),
      acknowledgeQwenGatewayResult: async receipt => await this.acknowledgeQwenGatewayResult(receipt),
      recoverCampaigns: async () => await this.recoverCampaigns(),
    })
  }

  /** Shared Runtime-internal flow uses the same Application-owned command. */
  private async createCreativePlanForInternal(projectId: string, raw: CreateCreativePlanInput): Promise<ImageCreativePlan> {
    // Compatibility flows (Quick Create, Campaign and derivation estimates)
    // already represent an explicit higher-level command. They keep their
    // historical deterministic recovery path, while the public Creative Plan
    // command requires a same-revision advice receipt when Qwen advice exists.
    return await createCreativePlanCommand(this.createCreativePlanPort(), projectId, raw, { requireAdviceConfirmation: false })
  }

  /**
   * Rehydrates all renderer-visible image facts from durable stores.  The
   * renderer's own selection and drag state deliberately remains outside this
   * projection, so a restart cannot resurrect an uncommitted UI mutation.
   */
  async getProjectProjection(projectId: string): Promise<ImageWorkbenchProjectProjectionData> {
    const project = await this.assertProjectOwner(projectId)
    const [
      inspiration_board,
      creative_plans,
      generation_rounds,
      candidate_groups,
      canvases,
      delivery_spec,
      library,
      operations,
      latest_understanding_suggestion,
      campaign_intent,
    ] = await Promise.all([
      this.repository.getInspirationBoard(project.id),
      this.repository.listCreativePlans(project.id),
      this.repository.listGenerationRounds(project.id),
      this.repository.listCandidateGroups(project.id),
      this.repository.listCanvasRevisions(project.id),
      this.repository.currentDeliverySpec(project.id),
      this.repository.listProjectLibrary(project.id),
      this.listGenerationOperations(project.id),
      this.repository.latestUnderstandingSuggestion(project.id),
      this.campaignProjectIntent(project),
    ])
    return {
      project,
      inspiration_board,
      creative_plans,
      generation_rounds,
      operations,
      latest_understanding_suggestion,
      candidate_groups,
      canvases,
      delivery_spec,
      library,
      campaign_intent,
    }
  }

  /**
   * Campaign remains an orchestrator: this only exposes the immutable,
   * Canvas-ready intent carried by the ordinary child Project.  It never
   * injects per-item values into a Provider prompt or writes a Canvas.
   */
  private async campaignProjectIntent(project: ImageWorkbenchProject): Promise<ImageCampaignProjectIntent | null> {
    return await this.repository.campaignProjectIntentForProject(project.id, project.owner)
  }

  private async createCampaignProjectIntent(
    projectId: string,
    campaign: ImageCampaign,
    item: ImageCampaignItem,
  ): Promise<ImageCampaignProjectIntent> {
    let slot_bindings: ImageCampaignProjectIntent['slot_bindings'] = []
    if (campaign.template_id && campaign.template_revision_id) {
      // Historical lookup is deliberate. A prior Project remains explainable
      // after a Template is trashed; the normal apply_template command still
      // checks active state and grants before it can write a new Canvas revision.
      const template = await this.repository.templateRevision(
        campaign.template_id,
        campaign.template_revision_id,
        campaign.owner,
      )
      const slots = new Map(template.slots.map(slot => [slot.id, slot]))
      slot_bindings = item.variable_values.map(variable => {
        const slot = slots.get(variable.slot_id)
        if (!slot) {
          throw new ImageWorkbenchServiceError('Campaign 项目引用的 Template Slot 已不存在', 500, 'IMAGE_STORAGE_INVALID')
        }
        if (slot.kind === 'text') return { slot_id: slot.id, text: variable.value }
        if (slot.kind === 'qrcode') return { slot_id: slot.id, qr_payload: variable.value }
        throw new ImageWorkbenchServiceError('Campaign 项目变量不是可写入的文字或二维码 Slot', 500, 'IMAGE_STORAGE_INVALID')
      })
    } else if (item.variable_values.length > 0) {
      throw new ImageWorkbenchServiceError('Campaign 项目缺少变量对应的 Template', 500, 'IMAGE_STORAGE_INVALID')
    }
    return imageCampaignProjectIntentSchema.parse({
      project_id: projectId,
      campaign_id: campaign.id,
      campaign_revision: campaign.revision,
      item_id: item.id,
      attempt: item.attempt,
      ...(campaign.brand_kit_id ? {
        brand_kit_id: campaign.brand_kit_id,
        brand_kit_revision_id: campaign.brand_kit_revision_id,
      } : {}),
      ...(campaign.template_id ? {
        template_id: campaign.template_id,
        template_revision_id: campaign.template_revision_id,
      } : {}),
      slot_bindings,
    })
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
    assetIdForIndex: (index: number) => string = () => id('ref'),
  ): Promise<{ assets: MediaAsset[]; references: ImageWorkbenchProject['references']; fileNames: string[] }> {
    const records: Array<{ asset: MediaAsset; reference: ImageWorkbenchProject['references'][number]; fileName: string }> = []
    for (const [index, image] of images.entries()) {
      const verified = await this.assets.verifyDataUrl(image)
      const assetId = assetIdForIndex(index)
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
    const userRequest = input.user_request ?? input.prompt
    if (!userRequest) throw new ImageWorkbenchServiceError('图片项目缺少创作需求', 400, 'IMAGE_OPERATION_CORRUPT')
    if (!input.generation_preferences) return await this.createProjectWithId(input, id('img'))
    const choice = this.resolveGenerationChoice({
      user_request: userRequest,
      output_preset: input.generation_preferences.output_preset,
      model_selection: input.generation_preferences.model_selection,
      references: input.reference_roles.map((role, index) => this.provisionalReference(role, index)),
      operation_mode: input.reference_roles.length > 0 ? 'edit' : 'generate',
    })
    return await this.createProjectWithId({ ...input, size: choice.size }, id('img'), choice.model)
  }

  /** The id is supplied only by a durable workflow receipt, never by a client. */
  private async createProjectWithId(
    input: CreateImageProjectInput,
    projectId: string,
    initialModel?: ImageGenerationModel,
  ): Promise<ImageWorkbenchProject> {
    const existing = await this.repository.getProject(projectId).catch(error => {
      if (error instanceof ImageWorkbenchRepositoryError && error.status === 404) return null
      throw error
    })
    if (existing) return await this.initializeGenerationHeader(existing)
    const now = this.iso()
    const userRequest = input.user_request ?? input.prompt
    if (!userRequest) throw new ImageWorkbenchServiceError('图片项目缺少创作需求', 400, 'IMAGE_OPERATION_CORRUPT')
    const size = input.size ?? '1024x1024'
    const preferences = input.generation_preferences ?? { model_selection: 'auto' as const, output_preset: 'auto' as const }
    // Quick Create may be retried concurrently before its Project row exists.
    // Stable reference IDs keep both stacks on the same immutable assets so a
    // loser can replay the committed Project without leaving random sidecars.
    const persisted = await this.persistImages(
      projectId,
      input.reference_images ?? [],
      input.reference_roles ?? [],
      now,
      index => stableId('ref', projectId, String(index)),
    )
    const { brief, providerPrompt } = compileImageBrief(userRequest, persisted.references)
    const project = imageWorkbenchProjectSchema.parse({
      schema_version: 1,
      id: projectId,
      kind: 'image',
      title: input.title ?? titleForRequest(userRequest),
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
      generation_preferences: preferences,
      model: initialModel ?? this.initialProjectionModel(userRequest, size, preferences.model_selection),
      prompt: providerPrompt,
      size,
      count: IMAGE_PRODUCT_OUTPUT_COUNT,
      candidate_count: IMAGE_PRODUCT_OUTPUT_COUNT,
      ...(input.budget_limit ? { budget_limit: input.budget_limit } : {}),
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
      // Another request with the same durable workflow key may have won the
      // project fence while this stack was verifying the same references.
      // Re-read that committed aggregate instead of surfacing a transient 500.
      const committed = await this.repository.getProject(projectId).catch(() => null)
      if (committed) return await this.initializeGenerationHeader(committed)
      throw new ImageWorkbenchServiceError('无法创建图片项目', 500, mediaErrorCode(error))
    }
  }

  private async existingGenerationRound(projectId: string, roundId: string): Promise<ImageGenerationRound | null> {
    return await this.repository.getGenerationRound(projectId, roundId).catch(error => {
      if (error instanceof ImageWorkbenchRepositoryError && error.status === 404) return null
      throw error
    })
  }

  /**
   * Quick Create is intentionally only a shortcut into Project -> Plan ->
   * Estimate -> confirmed one-direction Round.  Its receipt is prepared
   * before the first durable Project or paid-operation action, so repeating a
   * command after a crash reconstructs the same IDs and never starts a new
   * paid attempt.
   */
  async quickCreate(raw: ImageQuickCreateInput, options: QuickCreateLifecycle = {}): Promise<{
    mode: 'started'
    project: ImageWorkbenchProject
    round: ImageGenerationRound
    operations: ImageOperationV2[]
  } | {
    mode: 'prepared'
    project: ImageWorkbenchProject
  }> {
    const input = imageQuickCreateInputSchema.parse(raw)
    const workflowMode = options.mode ?? 'start'
    const choice = this.resolveGenerationChoice({
      user_request: input.prompt,
      output_preset: input.output_preset,
      model_selection: input.model_selection,
      references: input.reference_inputs.map((reference, index) => this.provisionalReference(reference.role, index)),
      operation_mode: input.reference_inputs.length > 0 ? 'edit' : 'generate',
    })
    const briefOverrides = input.brief_overrides
    const requestHash = sha256({
      kind: 'quick_create',
      prompt: input.prompt,
      title: input.title ?? null,
      output_preset: input.output_preset,
      model_selection: input.model_selection,
      reference_inputs: input.reference_inputs,
      budget_limit: input.budget_limit ?? null,
      brief_overrides: briefOverrides ?? null,
      workflow_mode: workflowMode,
    })
    const projectId = workflowId('img', 'quick-create', input.idempotency_key)
    const roundId = stableId('rnd', projectId, input.idempotency_key)
    const receipt = await this.repository.prepareWorkflowCommand({
      scope: 'quick-create',
      aggregate_id: STANDALONE_IMAGE_OWNER.owner_id,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      result: { project_id: projectId, round_id: roundId, operation_ids: [] },
    })
    const replayQuickCreateRound = async (round: ImageGenerationRound): Promise<{
      mode: 'started'
      project: ImageWorkbenchProject
      round: ImageGenerationRound
      operations: ImageOperationV2[]
    }> => {
      const operations = await Promise.all(round.direction_operations.map(async direction =>
        await this.repository.getGenerationOperation(projectId, direction.operation_id)))
      await options.on_generation_round_persisted?.({ project: await this.project(projectId), round, operations })
      await this.repository.completeWorkflowCommand({
        scope: 'quick-create',
        aggregate_id: STANDALONE_IMAGE_OWNER.owner_id,
        idempotency_key: input.idempotency_key,
        request_hash: requestHash,
        result: { project_id: projectId, round_id: round.id, operation_ids: operations.map(operation => operation.id) },
      })
      return { mode: 'started', project: await this.project(projectId), round, operations }
    }
    const replayQuickCreatePreparation = async (): Promise<{
      mode: 'prepared'
      project: ImageWorkbenchProject
    }> => ({ mode: 'prepared', project: await this.project(projectId) })
    let project = await this.createProjectWithId({
      title: input.title,
      user_request: input.prompt,
      workspace_root: 'image-workbench',
      generation_preferences: { model_selection: input.model_selection, output_preset: input.output_preset },
      size: choice.size,
      ...(input.budget_limit ? { budget_limit: input.budget_limit } : {}),
      reference_images: input.reference_inputs.map(reference => reference.data_url),
      reference_roles: input.reference_inputs.map(reference => reference.role),
    }, projectId, choice.model)

    // A persisted Round is the durable boundary for Quick Create.  Recovery
    // must reach it before replaying any earlier project command, whose
    // original base revision is intentionally part of its idempotency hash.
    const existingRound = await this.existingGenerationRound(project.id, roundId)
    if (existingRound) {
      return await replayQuickCreateRound(existingRound)
    }

    try {
      if (briefOverrides && Object.keys(briefOverrides).length > 0) {
        const hasPersistedOverrides = Object.entries(briefOverrides).every(([key, value]) =>
          stableJson(project.brief_overrides[key as keyof ImageBriefOverrides]) === stableJson(value))
        if (!hasPersistedOverrides) {
          project = await this.applyBriefOverrides(project.id, {
            base_revision: project.revision,
            idempotency_key: `bb-image-quick-brief-${sha256({ project_id: project.id, key: input.idempotency_key }).slice('sha256:'.length)}`,
            overrides: briefOverrides,
          })
        }
      }
      if (receipt.status === 'complete') {
        if (workflowMode === 'prepare') return await replayQuickCreatePreparation()
        throw new ImageWorkbenchServiceError('快速创建回执缺少生成轮次', 500, 'IMAGE_OPERATION_CORRUPT')
      }

      if (workflowMode === 'prepare') {
        await this.repository.completeWorkflowCommand({
          scope: 'quick-create',
          aggregate_id: STANDALONE_IMAGE_OWNER.owner_id,
          idempotency_key: input.idempotency_key,
          request_hash: requestHash,
          result: { project_id: project.id, round_id: null, operation_ids: [] },
        })
        return await replayQuickCreatePreparation()
      }

      const planKey = `bb-image-quick-${sha256({ project_id: project.id, key: input.idempotency_key }).slice('sha256:'.length)}`
      const plan = await this.createCreativePlanForInternal(project.id, {
        base_revision: project.revision,
        idempotency_key: planKey,
      })
      const direction = plan.directions[0]
      if (!direction) throw new ImageWorkbenchServiceError('快速创建缺少创作方向', 500, 'IMAGE_OPERATION_CORRUPT')
      const estimate = await this.estimateGenerationRound(project.id, {
        base_revision: project.revision,
        creative_plan_id: plan.id,
        direction_ids: [direction.id],
      })
      const created = await this.createGenerationRound(project.id, {
        base_revision: project.revision,
        idempotency_key: input.idempotency_key,
        creative_plan_id: plan.id,
        direction_ids: [direction.id],
        estimate_hash: estimate.estimate_hash,
        confirm: true,
      }, {
        on_persisted: async persisted => {
          await options.on_generation_round_persisted?.({
            project: persisted.project,
            round: persisted.round,
            operations: persisted.operations,
          })
        },
      })
      await this.repository.completeWorkflowCommand({
        scope: 'quick-create',
        aggregate_id: STANDALONE_IMAGE_OWNER.owner_id,
        idempotency_key: input.idempotency_key,
        request_hash: requestHash,
        result: { project_id: project.id, round_id: created.round.id, operation_ids: created.operations.map(operation => operation.id) },
      })
      return { mode: 'started', project: await this.project(project.id), ...created }
    } catch (error) {
      // The other same-key stack may have committed the Round after this
      // stack's early replay check but before Plan/Estimate completed. Treat
      // that deterministic Round as the workflow result, not as a user edit
      // conflict; unrelated revision changes still propagate unchanged.
      if (error instanceof ImageWorkbenchServiceError && error.code === 'IMAGE_REVISION_CONFLICT') {
        const committed = await this.existingGenerationRound(project.id, roundId)
        if (committed) return await replayQuickCreateRound(committed)
      }
      throw error
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
    const preferences = input.generation_preferences ?? project.generation_preferences
    const choice = input.generation_preferences
      ? this.resolveGenerationChoice({
          user_request: input.user_request,
          output_preset: preferences.output_preset,
          model_selection: preferences.model_selection,
          references: this.generationReferences({
            ...project,
            assets: [...project.assets, ...added.assets],
            references: nextReferences,
          }),
          operation_mode: nextReferences.length > 0 ? 'edit' : 'generate',
        })
      : undefined
    const size = choice?.size ?? input.size ?? project.size
    const { brief: baseBrief } = compileImageBrief(input.user_request, nextReferences)
    const briefOverrides = input.brief_overrides ?? project.brief_overrides
    const brief = applyImageBriefOverrides(baseBrief, briefOverrides)
    const saved = await this.repository.saveProject(imageWorkbenchProjectSchema.parse({
      ...project,
      state: 'draft',
      task_id: undefined,
      title: titleForRequest(input.user_request, project.title),
      mode: nextReferences.length > 0 ? 'edit' : 'generate',
      generation_preferences: preferences,
      model: choice?.model ?? this.initialProjectionModel(input.user_request, size, preferences.model_selection),
      prompt: providerPromptForImageBrief(brief),
      size,
      count: IMAGE_PRODUCT_OUTPUT_COUNT,
      candidate_count: IMAGE_PRODUCT_OUTPUT_COUNT,
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

  private referenceAssetNames(project: ImageWorkbenchProject, references: ImageWorkbenchProject['references']): string[] {
    return references.map(reference => {
      const asset = project.assets.find(candidate => candidate.id === reference.asset_id)
      if (!asset?.mime_type || !isSupportedImageMime(asset.mime_type)) {
        throw new ImageWorkbenchServiceError('图片参考素材格式无效', 409, 'REFERENCE_IMAGE_MISSING')
      }
      return `${asset.id}.${extensionForMime(asset.mime_type)}`
    })
  }

  /** Public projection exposes the asset id; keep the older deterministic reference id readable too. */
  private matchesReference(project: ImageWorkbenchProject, reference: ImageWorkbenchProject['references'][number], value: string): boolean {
    return reference.asset_id === value || stableId('ref', project.id, reference.asset_id) === value
  }

  private async refreshWorkflowProject(result: { project: ImageWorkbenchProject; replayed: boolean }): Promise<ImageWorkbenchProject> {
    // A response can be lost after the command transaction but before the
    // header pointer update. Reloading on replay lets the normal, idempotent
    // header initializer finish local recovery without rerunning user work.
    return await this.initializeGenerationHeader(result.replayed ? await this.project(result.project.id) : result.project)
  }

  async compileBrief(projectId: string): Promise<{ project: ImageWorkbenchProject; brief: ImageBriefSnapshot }> {
    const project = await this.project(projectId)
    return { project, brief: await this.compileGenerationBrief(project) }
  }

  async applyBriefOverrides(projectId: string, raw: ApplyImageBriefOverridesInput): Promise<ImageWorkbenchProject> {
    const input = applyImageBriefOverridesInputSchema.parse(raw)
    const requestHash = sha256({
      kind: 'brief_overrides', project_id: projectId, base_revision: input.base_revision, overrides: input.overrides,
    })
    const project = await this.project(projectId)
    const replay = await this.repository.workflowProjectCommandResult(project.id, input.idempotency_key, requestHash)
    if (replay) return await this.refreshWorkflowProject({ project: replay, replayed: true })
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再确认 Brief')
    await this.assertNoActiveOperation(project)
    await this.assertNoActiveGenerationOperation(project)
    const userRequest = project.brief?.user_request ?? project.prompt
    const overrides = { ...project.brief_overrides, ...input.overrides }
    const brief = applyImageBriefOverrides(compileImageBrief(userRequest, project.references).brief, overrides)
    return await this.refreshWorkflowProject(await this.repository.saveWorkflowProjectCommand({
      project: imageWorkbenchProjectSchema.parse({
        ...project,
        state: 'draft',
        task_id: undefined,
        prompt: providerPromptForImageBrief(brief),
        brief,
        brief_overrides: overrides,
        revision: project.revision + 1,
        error: undefined,
        error_code: undefined,
        notice: undefined,
      }),
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      command_kind: 'brief_overrides',
    }))
  }

  async addWorkflowReferences(projectId: string, raw: AddImageWorkflowReferencesInput): Promise<ImageWorkbenchProject> {
    const input = addImageWorkflowReferencesInputSchema.parse(raw)
    const requestHash = sha256({
      kind: 'add_references', project_id: projectId, base_revision: input.base_revision, references: input.references,
    })
    const project = await this.project(projectId)
    const replay = await this.repository.workflowProjectCommandResult(project.id, input.idempotency_key, requestHash)
    if (replay) return await this.refreshWorkflowProject({ project: replay, replayed: true })
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再追加参考素材')
    await this.assertNoActiveOperation(project)
    await this.assertNoActiveGenerationOperation(project)
    if (project.references.length + input.references.length > 8) {
      throw new ImageWorkbenchServiceError('每个图片项目最多保留 8 张参考图片', 400, 'TOO_MANY_REFERENCE_IMAGES')
    }
    const now = this.iso()
    const persisted = await this.persistImages(
      project.id,
      input.references.map(reference => reference.data_url),
      input.references.map(reference => reference.role),
      now,
    )
    const addedReferences = persisted.references.map((reference, index) => ({
      ...reference,
      influence_strength: input.references[index]!.influence_strength,
      preservation: input.references[index]!.preservation,
      priority: input.references[index]!.priority,
      ...(input.references[index]!.label ? { label: input.references[index]!.label } : {}),
    }))
    const references = [...project.references, ...addedReferences]
    const assets = [...project.assets, ...persisted.assets]
    await this.assertReferenceSet({ ...project, assets }, references)
    const userRequest = project.brief?.user_request ?? project.prompt
    const brief = applyImageBriefOverrides(compileImageBrief(userRequest, references).brief, project.brief_overrides)
    return await this.refreshWorkflowProject(await this.repository.saveWorkflowProjectCommand({
      project: imageWorkbenchProjectSchema.parse({
        ...project,
        state: 'draft',
        task_id: undefined,
        mode: 'edit',
        prompt: providerPromptForImageBrief(brief),
        brief,
        assets,
        references,
        reference_image_assets: this.referenceAssetNames({ ...project, assets }, references),
        reference_image_count: references.length,
        revision: project.revision + 1,
        error: undefined,
        error_code: undefined,
        notice: undefined,
      }),
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      command_kind: 'add_references',
    }))
  }

  async removeWorkflowReference(projectId: string, referenceId: string, raw: RemoveImageWorkflowReferenceInput): Promise<ImageWorkbenchProject> {
    const input = removeImageWorkflowReferenceInputSchema.parse(raw)
    const requestHash = sha256({
      kind: 'remove_reference', project_id: projectId, base_revision: input.base_revision, reference_id: referenceId,
    })
    const project = await this.project(projectId)
    const replay = await this.repository.workflowProjectCommandResult(project.id, input.idempotency_key, requestHash)
    if (replay) return await this.refreshWorkflowProject({ project: replay, replayed: true })
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再移除参考素材')
    await this.assertNoActiveOperation(project)
    await this.assertNoActiveGenerationOperation(project)
    const references = project.references.filter(reference => !this.matchesReference(project, reference, referenceId))
    if (references.length === project.references.length) {
      throw new ImageWorkbenchServiceError('图片参考图不存在', 404, 'REFERENCE_IMAGE_MISSING')
    }
    const userRequest = project.brief?.user_request ?? project.prompt
    const brief = applyImageBriefOverrides(compileImageBrief(userRequest, references).brief, project.brief_overrides)
    return await this.refreshWorkflowProject(await this.repository.saveWorkflowProjectCommand({
      project: imageWorkbenchProjectSchema.parse({
        ...project,
        state: 'draft',
        task_id: undefined,
        mode: references.length > 0 ? 'edit' : 'generate',
        prompt: providerPromptForImageBrief(brief),
        brief,
        references,
        reference_image_assets: this.referenceAssetNames(project, references),
        reference_image_count: references.length,
        revision: project.revision + 1,
        error: undefined,
        error_code: undefined,
        notice: undefined,
      }),
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      command_kind: 'remove_reference',
    }))
  }

  async getInspirationBoard(projectId: string): Promise<ImageInspirationBoard | null> {
    await this.assertProjectOwner(projectId)
    return await this.repository.getInspirationBoard(projectId)
  }

  /** Unpromoted inspiration remains a local Project asset and is never a Provider reference. */
  async upsertInspirationItems(projectId: string, raw: UpsertImageInspirationItemsInput): Promise<{
    project: ImageWorkbenchProject
    board: ImageInspirationBoard
  }> {
    const input = upsertImageInspirationItemsInputSchema.parse(raw)
    const requestHash = sha256({
      kind: 'inspiration_upsert', project_id: projectId, base_revision: input.base_revision, items: input.items,
    })
    const project = await this.project(projectId)
    const replay = await this.repository.inspirationCommandResult(project.id, input.idempotency_key, requestHash)
    if (replay) return { project: await this.project(project.id), board: replay.board }
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再修改灵感板')
    const existing = await this.repository.getInspirationBoard(project.id)
    const now = this.iso()
    const items = [...(existing?.items ?? [])]
    const itemsById = new Map(items.map(item => [item.id, item]))
    const assets = [...project.assets]
    for (const [index, patch] of input.items.entries()) {
      if (patch.id) {
        if (patch.data_url) {
          throw new ImageWorkbenchServiceError('已有灵感项不能通过更新替换像素，请新建一项', 400, 'IMAGE_ASSET_INVALID')
        }
        const current = itemsById.get(patch.id)
        if (!current) throw new ImageWorkbenchServiceError('灵感项不存在', 404, 'IMAGE_ASSET_NOT_FOUND')
        const next = { ...current, ...(patch.note === undefined ? {} : { note: patch.note }), updated_at: now }
        itemsById.set(next.id, next)
        continue
      }
      if (!patch.data_url) throw new ImageWorkbenchServiceError('新灵感项缺少图片', 400, 'IMAGE_ASSET_INVALID')
      const verified = await this.assets.verifyDataUrl(patch.data_url)
      const assetId = workflowId('ref', 'inspiration', project.id, input.idempotency_key, String(index))
      const saved = await this.assets.persist(project.id, assetId, 'reference', verified, project.id, now)
      if (!assets.some(asset => asset.id === saved.asset.id)) assets.push(saved.asset)
      const item = {
        id: workflowId('inspire', project.id, input.idempotency_key, String(index)),
        board_id: existing?.id ?? workflowId('board', project.id),
        project_id: project.id,
        asset_id: saved.asset.id,
        ...(patch.note ? { note: patch.note } : {}),
        created_at: now,
        updated_at: now,
      }
      itemsById.set(item.id, item)
    }
    const board = imageInspirationBoardSchema.parse({
      id: existing?.id ?? workflowId('board', project.id),
      project_id: project.id,
      revision: (existing?.revision ?? -1) + 1,
      items: [...itemsById.values()].sort((left, right) => left.created_at.localeCompare(right.created_at) || left.id.localeCompare(right.id)),
      created_at: existing?.created_at ?? now,
      updated_at: now,
    })
    const saved = await this.repository.saveInspirationBoardCommand({
      project: imageWorkbenchProjectSchema.parse({
        ...project,
        assets,
        revision: project.revision + 1,
      }),
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      board,
    })
    return { project: saved.project, board: saved.board }
  }

  async promoteInspirationItem(projectId: string, itemId: string, raw: PromoteImageInspirationItemInput): Promise<{
    project: ImageWorkbenchProject
    board: ImageInspirationBoard
  }> {
    const input = promoteImageInspirationItemInputSchema.parse(raw)
    const requestHash = sha256({
      kind: 'inspiration_promote', project_id: projectId, base_revision: input.base_revision, item_id: itemId,
      role: input.role, influence_strength: input.influence_strength, preservation: input.preservation,
      priority: input.priority, label: input.label ?? null,
    })
    const project = await this.project(projectId)
    const replay = await this.repository.inspirationCommandResult(project.id, input.idempotency_key, requestHash)
    if (replay) return { project: await this.refreshWorkflowProject({ project: replay.project, replayed: true }), board: replay.board }
    this.assertRevision(project, input.base_revision, '图片项目已更新，请刷新后再提升灵感项')
    await this.assertNoActiveOperation(project)
    await this.assertNoActiveGenerationOperation(project)
    const existing = await this.repository.getInspirationBoard(project.id)
    if (!existing) throw new ImageWorkbenchServiceError('灵感板不存在', 404, 'IMAGE_ASSET_NOT_FOUND')
    const sourceItem = existing.items.find(item => item.id === itemId)
    if (!sourceItem) throw new ImageWorkbenchServiceError('灵感项不存在', 404, 'IMAGE_ASSET_NOT_FOUND')
    if (project.references.some(reference => reference.asset_id === sourceItem.asset_id)) {
      throw new ImageWorkbenchServiceError('该灵感项已经是项目参考图', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
    }
    if (project.references.length >= 8) {
      throw new ImageWorkbenchServiceError('每个图片项目最多保留 8 张参考图片', 400, 'TOO_MANY_REFERENCE_IMAGES')
    }
    const asset = project.assets.find(candidate => candidate.id === sourceItem.asset_id && candidate.role === 'reference')
    if (!asset) throw new ImageWorkbenchServiceError('灵感图片资产不存在', 409, 'IMAGE_ASSET_NOT_FOUND')
    await this.assets.readVerified(asset)
    const references = [...project.references, {
      asset_id: asset.id,
      role: input.role,
      influence_strength: input.influence_strength,
      preservation: input.preservation,
      priority: input.priority,
      ...(input.label ? { label: input.label } : {}),
    }]
    const userRequest = project.brief?.user_request ?? project.prompt
    const brief = applyImageBriefOverrides(compileImageBrief(userRequest, references).brief, project.brief_overrides)
    const now = this.iso()
    const board = imageInspirationBoardSchema.parse({
      ...existing,
      revision: existing.revision + 1,
      items: existing.items.map(item => item.id === itemId
        ? { ...item, promoted_reference_asset_id: asset.id, updated_at: now }
        : item),
      updated_at: now,
    })
    const saved = await this.repository.saveInspirationBoardCommand({
      project: imageWorkbenchProjectSchema.parse({
        ...project,
        state: 'draft',
        task_id: undefined,
        mode: 'edit',
        prompt: providerPromptForImageBrief(brief),
        brief,
        references,
        reference_image_assets: this.referenceAssetNames(project, references),
        reference_image_count: references.length,
        revision: project.revision + 1,
        error: undefined,
        error_code: undefined,
        notice: undefined,
      }),
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      board,
    })
    return { project: await this.refreshWorkflowProject(saved), board: saved.board }
  }

  async listProjectLibrary(projectId: string): Promise<ImageProjectLibrary> {
    await this.assertProjectOwner(projectId)
    return await this.repository.listProjectLibrary(projectId)
  }

  private async assertBrandRevisionAssetGrants(revision: ImageBrandKitRevision, initial = false): Promise<void> {
    const nonBuiltinFonts = revision.font_asset_ids.filter(assetId => assetId !== 'font_builtin_0001')
    if (nonBuiltinFonts.length > 0) {
      throw new ImageWorkbenchServiceError('当前图片工作台仅支持受控内置字体，其他品牌字体暂不可写入品牌包', 422, 'IMAGE_ASSET_NOT_FOUND')
    }
    if (initial && revision.logo_asset_ids.length > 0) {
      throw new ImageWorkbenchServiceError('新建品牌套件必须先创建空 revision，再对素材授权后写入 Logo', 409, 'IMAGE_REVISION_CONFLICT')
    }
    for (const assetId of revision.logo_asset_ids) {
      await this.repository.activeAssetGrant(assetId, { kind: 'brand_kit', id: revision.brand_kit_id }, ['render', 'template_use'])
    }
  }

  private templateReferencedAssetIds(revision: ImageTemplateRevision): string[] {
    const assetIds = new Set<string>()
    for (const layer of this.flattenCanvasLayers(revision.blueprint.layers)) {
      if (layer.kind === 'raster' || layer.kind === 'logo' || layer.kind === 'mask') assetIds.add(layer.source_asset_id)
      if (layer.kind === 'qrcode' && layer.source.kind === 'asset') assetIds.add(layer.source.asset_id)
    }
    return [...assetIds]
  }

  private async assertTemplateRevisionAssetGrants(revision: ImageTemplateRevision, initial = false): Promise<void> {
    const brand = revision.brand_kit_id && revision.brand_kit_revision_id
      ? await this.repository.activeBrandKitRevision(revision.brand_kit_id, revision.brand_kit_revision_id, revision.owner)
      : undefined
    if (brand) await this.assertBrandRevisionAssetGrants(brand)
    const brandAssets = new Set(brand?.logo_asset_ids ?? [])
    const brandFonts = new Set(brand?.font_asset_ids ?? [])
    for (const assetId of this.templateReferencedAssetIds(revision)) {
      if (brandAssets.has(assetId)) continue
      if (initial) {
        throw new ImageWorkbenchServiceError('新建模板只能从空蓝图或已绑定品牌素材开始；项目素材需先授权后写入 revision', 409, 'IMAGE_REVISION_CONFLICT')
      }
      await this.repository.activeAssetGrant(assetId, { kind: 'template', id: revision.template_id }, ['template_use'])
    }
    for (const layer of this.flattenCanvasLayers(revision.blueprint.layers)) {
      if (layer.kind !== 'text' || layer.font_asset_id === 'font_builtin_0001' || brandFonts.has(layer.font_asset_id)) continue
      throw new ImageWorkbenchServiceError('模板文字只能使用内置字体或已锁定的品牌字体', 422, 'IMAGE_ASSET_NOT_FOUND')
    }
  }

  async listBrandKits(includeTrashed = false) {
    return await this.repository.listBrandKits(STANDALONE_IMAGE_OWNER, includeTrashed)
  }

  async getBrandKit(brandKitId: string) {
    return await this.repository.getBrandKit(brandKitId, STANDALONE_IMAGE_OWNER)
  }

  async createBrandKit(raw: CreateImageBrandKitInput) {
    const input = createImageBrandKitInputSchema.parse(raw)
    const now = this.iso()
    const brandKitId = workflowId('brand', STANDALONE_IMAGE_OWNER.owner_id, input.idempotency_key)
    const requestHash = sha256({ kind: 'brand_kit_create', name: input.name, revision: input.revision })
    const replay = await this.repository.brandKitCommandResult(brandKitId, input.idempotency_key, requestHash)
    if (replay) return replay
    const revision = imageBrandKitRevisionSchema.parse({
      id: workflowId('brrev', brandKitId, '0'),
      brand_kit_id: brandKitId,
      revision: 0,
      owner: STANDALONE_IMAGE_OWNER,
      ...input.revision,
      created_at: now,
    })
    const brandKit = imageBrandKitSchema.parse({
      id: brandKitId,
      owner: STANDALONE_IMAGE_OWNER,
      name: input.name,
      revision: 0,
      current_revision_id: revision.id,
      state: 'active',
      created_at: now,
      updated_at: now,
    })
    const result = await this.repository.createBrandKitCommand({
      brand_kit: brandKit,
      revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    return { brand_kit: result.brand_kit, revision: result.revision }
  }

  async reviseBrandKit(brandKitId: string, raw: ReviseImageBrandKitInput) {
    const input = reviseImageBrandKitInputSchema.parse(raw)
    const requestHash = sha256({ kind: 'brand_kit_revise', brand_kit_id: brandKitId, base_revision: input.base_revision, revision: input.revision })
    const replay = await this.repository.brandKitCommandResult(brandKitId, input.idempotency_key, requestHash)
    if (replay) return replay
    const current = await this.repository.getBrandKit(brandKitId, STANDALONE_IMAGE_OWNER)
    const now = this.iso()
    const revision = imageBrandKitRevisionSchema.parse({
      id: workflowId('brrev', brandKitId, input.idempotency_key),
      brand_kit_id: brandKitId,
      revision: current.brand_kit.revision + 1,
      owner: STANDALONE_IMAGE_OWNER,
      ...input.revision,
      created_at: now,
    })
    const brandKit = imageBrandKitSchema.parse({
      ...current.brand_kit,
      revision: current.brand_kit.revision + 1,
      current_revision_id: revision.id,
      updated_at: now,
    })
    const result = await this.repository.reviseBrandKitCommand({
      brand_kit: brandKit,
      revision,
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    return { brand_kit: result.brand_kit, revision: result.revision }
  }

  async trashBrandKit(brandKitId: string, raw: { base_revision: number; idempotency_key: string }) {
    const input = deleteImageReusableAggregateInputSchema.parse(raw)
    const result = await this.repository.trashBrandKitCommand({
      brand_kit_id: brandKitId,
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: sha256({ kind: 'brand_kit_trash', brand_kit_id: brandKitId, base_revision: input.base_revision }),
      updated_at: this.iso(),
    })
    return { brand_kit: result.brand_kit, revision: result.revision }
  }

  async listTemplates(includeTrashed = false) {
    return await this.repository.listTemplates(STANDALONE_IMAGE_OWNER, includeTrashed)
  }

  async getTemplate(templateId: string) {
    return await this.repository.getTemplate(templateId, STANDALONE_IMAGE_OWNER)
  }

  async createTemplate(raw: CreateImageTemplateInput) {
    const input = createImageTemplateInputSchema.parse(raw)
    const now = this.iso()
    const templateId = workflowId('template', STANDALONE_IMAGE_OWNER.owner_id, input.idempotency_key)
    const requestHash = sha256({ kind: 'template_create', name: input.name, revision: input.revision })
    const replay = await this.repository.templateCommandResult(templateId, input.idempotency_key, requestHash)
    if (replay) return replay
    const revision = imageTemplateRevisionSchema.parse({
      id: workflowId('tmrev', templateId, '0'),
      template_id: templateId,
      revision: 0,
      owner: STANDALONE_IMAGE_OWNER,
      ...input.revision,
      created_at: now,
    })
    const template = imageTemplateSchema.parse({
      id: templateId,
      owner: STANDALONE_IMAGE_OWNER,
      name: input.name,
      revision: 0,
      current_revision_id: revision.id,
      state: 'active',
      created_at: now,
      updated_at: now,
    })
    const result = await this.repository.createTemplateCommand({
      template,
      revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    return { template: result.template, revision: result.revision }
  }

  async reviseTemplate(templateId: string, raw: ReviseImageTemplateInput) {
    const input = reviseImageTemplateInputSchema.parse(raw)
    const requestHash = sha256({ kind: 'template_revise', template_id: templateId, base_revision: input.base_revision, revision: input.revision })
    const replay = await this.repository.templateCommandResult(templateId, input.idempotency_key, requestHash)
    if (replay) return replay
    const current = await this.repository.getTemplate(templateId, STANDALONE_IMAGE_OWNER)
    const now = this.iso()
    const revision = imageTemplateRevisionSchema.parse({
      id: workflowId('tmrev', templateId, input.idempotency_key),
      template_id: templateId,
      revision: current.template.revision + 1,
      owner: STANDALONE_IMAGE_OWNER,
      ...input.revision,
      created_at: now,
    })
    const template = imageTemplateSchema.parse({
      ...current.template,
      revision: current.template.revision + 1,
      current_revision_id: revision.id,
      updated_at: now,
    })
    const result = await this.repository.reviseTemplateCommand({
      template,
      revision,
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    return { template: result.template, revision: result.revision }
  }

  async trashTemplate(templateId: string, raw: { base_revision: number; idempotency_key: string }) {
    const input = deleteImageReusableAggregateInputSchema.parse(raw)
    const result = await this.repository.trashTemplateCommand({
      template_id: templateId,
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: sha256({ kind: 'template_trash', template_id: templateId, base_revision: input.base_revision }),
      updated_at: this.iso(),
    })
    return { template: result.template, revision: result.revision }
  }

  async createAssetGrant(raw: CreateImageAssetGrantInput): Promise<ImageAssetGrant> {
    const input = createImageAssetGrantInputSchema.parse(raw)
    const provenance = await this.repository.getWorkflowAssetProvenance(input.asset_id)
    if (provenance.owner.kind !== 'project') {
      throw new ImageWorkbenchServiceError('当前只支持从图片项目授权素材', 422, 'IMAGE_ASSET_NOT_FOUND')
    }
    const grant = {
      id: workflowId('grant', input.idempotency_key),
      asset_id: input.asset_id,
      from_owner: provenance.owner,
      to_owner: input.to_owner,
      purpose: input.purpose,
      granted_by: STANDALONE_IMAGE_OWNER,
      created_at: this.iso(),
    } as const
    const result = await this.repository.createWorkflowAssetGrant({
      grant,
      owner: STANDALONE_IMAGE_OWNER,
      idempotency_key: input.idempotency_key,
      request_hash: sha256({ kind: 'asset_grant_create', asset_id: input.asset_id, to_owner: input.to_owner, purpose: input.purpose }),
    })
    return result.grant
  }

  async revokeAssetGrant(grantId: string, raw: { idempotency_key: string }): Promise<ImageAssetGrant> {
    const input = revokeImageAssetGrantInputSchema.parse(raw)
    const result = await this.repository.revokeWorkflowAssetGrant({
      grant_id: grantId,
      owner: STANDALONE_IMAGE_OWNER,
      idempotency_key: input.idempotency_key,
      request_hash: sha256({ kind: 'asset_grant_revoke', grant_id: grantId }),
      revoked_at: this.iso(),
    })
    return result.grant
  }

  async listAssetGrants(includeRevoked = false): Promise<ImageAssetGrant[]> {
    return await this.repository.listWorkflowAssetGrants(STANDALONE_IMAGE_OWNER, includeRevoked)
  }

  private campaignItemQuickCreateKey(campaign: ImageCampaign, item: ImageCampaignItem): string {
    return `bb-image-campaign-${campaign.id}-${item.id}-attempt-${item.attempt}`
  }

  private campaignItemProjectId(campaign: ImageCampaign, item: ImageCampaignItem): string {
    return workflowId('img', 'quick-create', this.campaignItemQuickCreateKey(campaign, item))
  }

  private campaignBriefOverrides(campaign: ImageCampaign): ImageBriefOverrides {
    return {
      confirmed_facts: campaign.shared_brief.confirmed_facts,
      must_preserve: campaign.shared_brief.must_preserve,
    }
  }

  /** Campaign values stay as typed Template-slot data and never become raw prompt suffixes. */
  private async assertCampaignConfiguration(campaign: ImageCampaign, items: readonly ImageCampaignItem[]): Promise<void> {
    if (campaign.brand_kit_id && campaign.brand_kit_revision_id) {
      const brand = await this.repository.activeBrandKitRevision(
        campaign.brand_kit_id,
        campaign.brand_kit_revision_id,
        campaign.owner,
      )
      await this.assertBrandRevisionAssetGrants(brand)
    }
    const template = campaign.template_id && campaign.template_revision_id
      ? await this.repository.activeTemplateRevision(campaign.template_id, campaign.template_revision_id, campaign.owner)
      : undefined
    if (!template) {
      if (items.some(item => item.variable_values.length > 0)) {
        throw new ImageWorkbenchServiceError('Campaign 变量必须绑定到已锁定的 Template Slot', 409, 'IMAGE_REVISION_CONFLICT')
      }
      return
    }
    await this.assertTemplateRevisionAssetGrants(template)
    if (campaign.brand_kit_id && (
      template.brand_kit_id !== campaign.brand_kit_id || template.brand_kit_revision_id !== campaign.brand_kit_revision_id
    )) {
      throw new ImageWorkbenchServiceError('Campaign Brand Kit 必须与 Template 锁定的 revision 一致', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const slots = new Map(template.slots.map(slot => [slot.id, slot]))
    for (const item of items) {
      const seen = new Set<string>()
      for (const variable of item.variable_values) {
        const slot = slots.get(variable.slot_id)
        if (!slot || seen.has(variable.slot_id)) {
          throw new ImageWorkbenchServiceError('Campaign 变量引用了不存在或重复的 Template Slot', 409, 'IMAGE_REVISION_CONFLICT')
        }
        if (slot.kind !== 'text' && slot.kind !== 'qrcode') {
          throw new ImageWorkbenchServiceError('Campaign 字符串变量只能填充文字或二维码 Template Slot', 422, 'IMAGE_CAPABILITY_GAP')
        }
        seen.add(variable.slot_id)
      }
      for (const slot of template.slots) {
        if (!slot.required || seen.has(slot.id)) continue
        if (slot.kind !== 'text' && slot.kind !== 'qrcode') {
          throw new ImageWorkbenchServiceError('Campaign 不能为必填的图片或标志 Slot 提供未授权素材', 422, 'IMAGE_CAPABILITY_GAP')
        }
        throw new ImageWorkbenchServiceError('Campaign 项目缺少必填 Template Slot 的变量值', 409, 'IMAGE_REVISION_CONFLICT')
      }
    }
  }

  private campaignRequestHash(kind: string, campaignId: string, value: unknown): `sha256:${string}` {
    return sha256({ kind, campaign_id: campaignId, value })
  }

  private campaignItemState(operation: ImageOperationV2): ImageCampaignItem['state'] {
    if (operation.status === 'running') return 'running'
    if (operation.status === 'succeeded') return 'ready'
    if (operation.status === 'cancelled') return 'cancelled'
    if (operation.status === 'failed' || operation.status === 'blocked_by_policy') return 'failed'
    return 'queued'
  }

  private async campaignItemBudget(campaign: ImageCampaign, item: ImageCampaignItem): Promise<{ currency: string; amount_minor: number } | undefined> {
    if (item.attempt > 1) {
      if (!item.retry_estimate_hash || !item.retry_confirmation_receipt_id) {
        throw new ImageWorkbenchServiceError('Campaign 重试缺少已确认的费用回执', 409, 'IMAGE_REVISION_CONFLICT')
      }
      const [confirmation, estimate] = await Promise.all([
        this.repository.getCampaignConfirmation(campaign.id, item.retry_confirmation_receipt_id, campaign.owner),
        this.repository.getCampaignEstimate(campaign.id, item.retry_estimate_hash, campaign.owner),
      ])
      if (
        confirmation.purpose !== 'retry'
        || confirmation.estimate_hash !== item.retry_estimate_hash
        || confirmation.item_id !== item.id
        || confirmation.attempt !== item.attempt
        || estimate.purpose !== 'retry'
        || estimate.item_id !== item.id
        || estimate.attempt !== item.attempt
      ) {
        throw new ImageWorkbenchServiceError('Campaign 重试费用确认回执损坏', 500, 'IMAGE_OPERATION_CORRUPT')
      }
      return {
        currency: estimate.price_upper_bound.currency,
        amount_minor: estimate.price_upper_bound.amount_minor,
      }
    }
    if (!campaign.estimate_hash) return undefined
    const estimate = await this.repository.getCampaignEstimate(campaign.id, campaign.estimate_hash, campaign.owner)
    if (estimate.purpose !== 'start' || estimate.paid_operation_count < 1 || estimate.price_upper_bound.amount_minor % estimate.paid_operation_count !== 0) {
      throw new ImageWorkbenchServiceError('Campaign 初始费用估算损坏', 500, 'IMAGE_OPERATION_CORRUPT')
    }
    return {
      currency: estimate.price_upper_bound.currency,
      amount_minor: estimate.price_upper_bound.amount_minor / estimate.paid_operation_count,
    }
  }

  /** Sum only durable user-confirmed quotes, so a policy drift cannot undercharge a new retry. */
  private async confirmedCampaignBudgetAmount(campaign: ImageCampaign): Promise<{ currency: string; amount_minor: number }> {
    if (!campaign.estimate_hash) {
      throw new ImageWorkbenchServiceError('Campaign 缺少初始费用估算', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const start = await this.repository.getCampaignEstimate(campaign.id, campaign.estimate_hash, campaign.owner)
    if (start.purpose !== 'start') throw new ImageWorkbenchServiceError('Campaign 初始费用估算损坏', 500, 'IMAGE_OPERATION_CORRUPT')
    const retries = await this.repository.listCampaignRetryConfirmations(campaign.id, campaign.owner)
    const usedRetryReceipts = new Set((await this.getCampaign(campaign.id)).items
      .map(item => item.retry_confirmation_receipt_id)
      .filter((receipt): receipt is string => Boolean(receipt)))
    let amount = start.price_upper_bound.amount_minor
    for (const retry of retries) {
      // An unconsumed retry receipt expires with its quote. Once an attempt is
      // queued it remains a real committed cost even if dispatch resumes later.
      if (!usedRetryReceipts.has(retry.confirmation.id) && Date.parse(retry.estimate.expires_at) <= this.now().getTime()) continue
      if (retry.estimate.price_upper_bound.currency !== start.price_upper_bound.currency) {
        throw new ImageWorkbenchServiceError('Campaign 重试报价币种不一致', 422, 'IMAGE_BUDGET_EXCEEDED')
      }
      amount += retry.estimate.price_upper_bound.amount_minor
    }
    return { currency: start.price_upper_bound.currency, amount_minor: amount }
  }

  private async assertCampaignEstimateBudget(campaign: ImageCampaign, estimate: ImageCampaignEstimate): Promise<void> {
    if (!campaign.budget_limit) return
    if (estimate.price_upper_bound.currency !== campaign.budget_limit.currency) {
      throw new ImageWorkbenchServiceError('Campaign 预算币种与报价币种不一致', 422, 'IMAGE_BUDGET_EXCEEDED')
    }
    const alreadyConfirmed = estimate.purpose === 'start'
      ? 0
      : (await this.confirmedCampaignBudgetAmount(campaign)).amount_minor
    if (alreadyConfirmed + estimate.price_upper_bound.amount_minor > campaign.budget_limit.amount_minor) {
      throw new ImageWorkbenchServiceError('Campaign 预计费用超过预算上限', 422, 'IMAGE_BUDGET_EXCEEDED')
    }
  }

  /** Campaign discovery is a local, bounded index. Detail reads own remote synchronization. */
  async listCampaigns(input: { cursor?: number; limit?: number } = {}): Promise<{
    campaigns: ImageCampaign[]
    next_cursor?: number
  }> {
    return await this.repository.listCampaignSummaries(STANDALONE_IMAGE_OWNER, input)
  }

  async getCampaign(campaignId: string): Promise<ImageCampaignSnapshot> {
    const snapshot = await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
    for (const item of snapshot.items) {
      if (!item.project_id || !['queued', 'running'].includes(item.state)) continue
      const attempt = await this.repository.campaignAttempt(campaignId, item.id, item.attempt, STANDALONE_IMAGE_OWNER)
      if (attempt?.generation_operation_id) await this.synchronizeCampaignItem(campaignId, item.id)
    }
    return await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
  }

  async createCampaign(raw: CreateImageCampaignInput): Promise<ImageCampaignSnapshot> {
    const input = createImageCampaignInputSchema.parse(raw)
    const campaignId = workflowId('campaign', STANDALONE_IMAGE_OWNER.owner_id, input.idempotency_key)
    const requestHash = this.campaignRequestHash('campaign_create', campaignId, {
      name: input.name,
      brand_kit_id: input.brand_kit_id ?? null,
      brand_kit_revision_id: input.brand_kit_revision_id ?? null,
      template_id: input.template_id ?? null,
      template_revision_id: input.template_revision_id ?? null,
      shared_brief: input.shared_brief,
      output_preset: input.output_preset,
      model_selection: input.model_selection,
      budget_limit: input.budget_limit ?? null,
      items: input.items,
    })
    const now = this.iso()
    const campaign = imageCampaignSchema.parse({
      id: campaignId,
      owner: STANDALONE_IMAGE_OWNER,
      name: input.name,
      revision: 0,
      state: 'draft',
      ...(input.brand_kit_id ? { brand_kit_id: input.brand_kit_id, brand_kit_revision_id: input.brand_kit_revision_id } : {}),
      ...(input.template_id ? { template_id: input.template_id, template_revision_id: input.template_revision_id } : {}),
      shared_brief: input.shared_brief,
      output_preset: input.output_preset,
      model_selection: input.model_selection,
      planned_item_count: input.items.length,
      estimated_paid_operations: input.items.length,
      ...(input.budget_limit ? { budget_limit: input.budget_limit } : {}),
      created_at: now,
      updated_at: now,
    })
    const items = input.items.map((item, ordinal) => imageCampaignItemSchema.parse({
      id: workflowId('campaign-item', campaignId, String(ordinal)),
      campaign_id: campaignId,
      ordinal,
      variable_values: item.variable_values,
      state: 'draft',
      attempt: 1,
      created_at: now,
      updated_at: now,
    }))
    const replay = await this.repository.findCampaignCommandResult(
      campaignId,
      STANDALONE_IMAGE_OWNER,
      input.idempotency_key,
      requestHash,
    )
    if (replay) return replay
    await this.assertCampaignConfiguration(campaign, items)
    const result = await this.repository.createCampaignCommand({
      owner: STANDALONE_IMAGE_OWNER,
      campaign,
      items,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    return { campaign: result.campaign, items: result.items }
  }

  async replaceCampaignItems(campaignId: string, raw: ReplaceImageCampaignItemsInput): Promise<ImageCampaignSnapshot> {
    const input = replaceImageCampaignItemsInputSchema.parse(raw)
    const requestHash = this.campaignRequestHash('campaign_replace_items', campaignId, {
      base_revision: input.base_revision,
      items: input.items,
    })
    const replay = await this.repository.campaignCommandResult(campaignId, STANDALONE_IMAGE_OWNER, input.idempotency_key, requestHash)
    if (replay) return replay
    const current = await this.getCampaign(campaignId)
    const now = this.iso()
    const campaign = imageCampaignSchema.parse({
      ...current.campaign,
      revision: current.campaign.revision + 1,
      planned_item_count: input.items.length,
      estimated_paid_operations: input.items.length,
      updated_at: now,
    })
    const items = input.items.map((item, ordinal) => imageCampaignItemSchema.parse({
      id: workflowId('campaign-item', campaignId, input.idempotency_key, String(ordinal)),
      campaign_id: campaignId,
      ordinal,
      variable_values: item.variable_values,
      state: 'draft',
      attempt: 1,
      created_at: now,
      updated_at: now,
    }))
    await this.assertCampaignConfiguration(campaign, items)
    const result = await this.repository.replaceCampaignItemsCommand({
      owner: STANDALONE_IMAGE_OWNER,
      campaign,
      items,
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    return { campaign: result.campaign, items: result.items }
  }

  async estimateCampaign(campaignId: string, raw: EstimateImageCampaignInput): Promise<{ campaign: ImageCampaign; estimate: ImageCampaignEstimate }> {
    const input = estimateImageCampaignInputSchema.parse(raw)
    const snapshot = await this.getCampaign(campaignId)
    await this.assertCampaignConfiguration(snapshot.campaign, snapshot.items)
    const retryItem = input.item_id
      ? snapshot.items.find(item => item.id === input.item_id)
      : undefined
    const purpose = retryItem ? 'retry' as const : 'start' as const
    if (
      snapshot.campaign.revision !== input.base_revision
      || (purpose === 'start' && snapshot.campaign.state !== 'draft')
      || (purpose === 'retry' && (
        !['running', 'completed', 'cancelled'].includes(snapshot.campaign.state)
        || !retryItem
        || !['failed', 'cancelled'].includes(retryItem.state)
      ))
    ) {
      throw new ImageWorkbenchServiceError('Campaign 已更新，不能估算该付费尝试', 409, 'IMAGE_REVISION_CONFLICT')
    }
    if (purpose === 'retry' && snapshot.campaign.estimated_paid_operations >= MAX_CAMPAIGN_PAID_OPERATIONS) {
      throw new ImageWorkbenchServiceError('Campaign 已达到可确认的付费尝试上限，不能再创建重试报价', 422, 'IMAGE_BUDGET_EXCEEDED')
    }
    const choice = this.resolveGenerationChoice({
      user_request: snapshot.campaign.shared_brief.user_request,
      output_preset: snapshot.campaign.output_preset,
      model_selection: snapshot.campaign.model_selection,
      references: [],
      operation_mode: 'generate',
    })
    const policy = this.resolveGenerationPolicy({
      user_request: snapshot.campaign.shared_brief.user_request,
      size: choice.size,
      operation_mode: 'generate',
      references: [],
      ...(snapshot.campaign.model_selection === 'auto' ? {} : { preferred_model: snapshot.campaign.model_selection }),
    })
    const perOperation = policy.price_upper_bound.per_output_amount_minor * IMAGE_PRODUCT_OUTPUT_COUNT
    const paidOperationCount = purpose === 'retry' ? 1 : snapshot.items.length
    const amount = perOperation * paidOperationCount
    const createdAt = this.iso()
    const expiresAt = new Date(this.now().getTime() + IMAGE_GENERATION_ESTIMATE_TTL_MS).toISOString()
    const requestHash = this.campaignRequestHash('campaign_estimate', campaignId, {
      revision: snapshot.campaign.revision,
      purpose,
      ...(retryItem ? { item_id: retryItem.id, attempt: retryItem.attempt + 1 } : {
        items: snapshot.items.map(item => ({ id: item.id, attempt: item.attempt, variable_values: item.variable_values })),
      }),
      policy_revision: policy.policy_revision,
      price_upper_bound: policy.price_upper_bound,
    })
    const estimate = imageCampaignEstimateSchema.parse({
      id: workflowId('campaign-estimate', campaignId, requestHash, expiresAt),
      campaign_id: campaignId,
      campaign_revision: snapshot.campaign.revision,
      purpose,
      ...(retryItem ? { item_id: retryItem.id, attempt: retryItem.attempt + 1 } : {}),
      estimate_hash: sha256({ kind: 'campaign_estimate', request_hash: requestHash, expires_at: expiresAt }),
      paid_operation_count: paidOperationCount,
      concurrency: Math.min(2, paidOperationCount),
      price_upper_bound: {
        currency: policy.price_upper_bound.currency,
        amount_minor: amount,
        pricing_revision: policy.price_upper_bound.pricing_revision,
        usage_upper_bound: {
          requests: paidOperationCount,
          input_bytes: 0,
          output_images: paidOperationCount * IMAGE_PRODUCT_OUTPUT_COUNT,
        },
      },
      expires_at: expiresAt,
      created_at: createdAt,
    })
    await this.assertCampaignEstimateBudget(snapshot.campaign, estimate)
    const saved = await this.repository.saveCampaignEstimate({ owner: STANDALONE_IMAGE_OWNER, estimate })
    return { campaign: saved.campaign, estimate: saved.estimate }
  }

  async confirmCampaign(campaignId: string, raw: { base_revision: number; idempotency_key: string; estimate_hash: string }): Promise<{
    campaign: ImageCampaign
    items: ImageCampaignItem[]
    confirmation: ImageCampaignConfirmationReceipt
  }> {
    const input = confirmImageCampaignInputSchema.parse(raw)
    const requestHash = this.campaignRequestHash('campaign_confirm', campaignId, {
      base_revision: input.base_revision,
      estimate_hash: input.estimate_hash,
    })
    const replay = await this.repository.campaignCommandResult(campaignId, STANDALONE_IMAGE_OWNER, input.idempotency_key, requestHash)
    if (replay) {
      if (!replay.campaign.confirmation_receipt_id) throw new ImageWorkbenchServiceError('Campaign 确认回执损坏', 500, 'IMAGE_OPERATION_CORRUPT')
      return {
        ...replay,
        confirmation: await this.repository.getCampaignConfirmation(campaignId, replay.campaign.confirmation_receipt_id, STANDALONE_IMAGE_OWNER),
      }
    }
    const current = await this.getCampaign(campaignId)
    const estimate = await this.repository.getCampaignEstimate(campaignId, input.estimate_hash, STANDALONE_IMAGE_OWNER)
    if (
      current.campaign.revision !== input.base_revision
      || current.campaign.state !== 'draft'
      || estimate.purpose !== 'start'
      || estimate.item_id !== undefined
      || estimate.attempt !== undefined
      || estimate.campaign_revision !== current.campaign.revision
      || Date.parse(estimate.expires_at) <= this.now().getTime()
    ) {
      throw new ImageWorkbenchServiceError('Campaign 费用估算已过期，请重新确认', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const confirmedAt = this.iso()
    const confirmation = imageCampaignConfirmationReceiptSchema.parse({
      id: workflowId('campaign-confirmation', campaignId, input.idempotency_key),
      campaign_id: campaignId,
      campaign_revision: current.campaign.revision,
      estimate_hash: input.estimate_hash,
      confirmed_at: confirmedAt,
    })
    const campaign = imageCampaignSchema.parse({
      ...current.campaign,
      revision: current.campaign.revision + 1,
      state: 'confirmed',
      estimate_hash: input.estimate_hash,
      confirmation_receipt_id: confirmation.id,
      confirmed_at: confirmedAt,
      updated_at: confirmedAt,
    })
    const result = await this.repository.confirmCampaignCommand({
      owner: STANDALONE_IMAGE_OWNER,
      campaign,
      confirmation,
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    return { campaign: result.campaign, items: result.items, confirmation: result.confirmation }
  }

  /** A retry is a distinct paid attempt and therefore gets its own receipt. */
  async confirmCampaignRetry(campaignId: string, itemId: string, raw: ConfirmImageCampaignInput): Promise<{
    campaign: ImageCampaign
    items: ImageCampaignItem[]
    confirmation: ImageCampaignConfirmationReceipt
  }> {
    const input = confirmImageCampaignInputSchema.parse(raw)
    const requestHash = this.campaignRequestHash('campaign_retry_confirm', campaignId, {
      base_revision: input.base_revision,
      item_id: itemId,
      estimate_hash: input.estimate_hash,
    })
    const confirmationId = workflowId('campaign-retry-confirmation', campaignId, itemId, input.idempotency_key)
    const replay = await this.repository.campaignCommandResult(campaignId, STANDALONE_IMAGE_OWNER, input.idempotency_key, requestHash)
    if (replay) {
      return {
        ...replay,
        confirmation: await this.repository.getCampaignConfirmation(campaignId, confirmationId, STANDALONE_IMAGE_OWNER),
      }
    }
    const current = await this.getCampaign(campaignId)
    const item = current.items.find(candidate => candidate.id === itemId)
    const estimate = await this.repository.getCampaignEstimate(campaignId, input.estimate_hash, STANDALONE_IMAGE_OWNER)
    if (
      current.campaign.revision !== input.base_revision
      || !['running', 'completed', 'cancelled'].includes(current.campaign.state)
      || !item
      || !['failed', 'cancelled'].includes(item.state)
      || estimate.purpose !== 'retry'
      || estimate.campaign_revision !== current.campaign.revision
      || estimate.item_id !== item.id
      || estimate.attempt !== item.attempt + 1
      || Date.parse(estimate.expires_at) <= this.now().getTime()
    ) {
      throw new ImageWorkbenchServiceError('Campaign 重试费用估算已过期，请重新确认', 409, 'IMAGE_REVISION_CONFLICT')
    }
    await this.assertCampaignEstimateBudget(current.campaign, estimate)
    const confirmation = imageCampaignConfirmationReceiptSchema.parse({
      id: confirmationId,
      campaign_id: campaignId,
      campaign_revision: current.campaign.revision,
      purpose: 'retry',
      item_id: item.id,
      attempt: item.attempt + 1,
      estimate_hash: input.estimate_hash,
      confirmed_at: this.iso(),
    })
    const result = await this.repository.confirmCampaignRetryCommand({
      owner: STANDALONE_IMAGE_OWNER,
      campaign_id: campaignId,
      item_id: itemId,
      confirmation,
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    return { campaign: result.campaign, items: result.items, confirmation: result.confirmation }
  }

  private async confirmedCampaignQuote(campaign: ImageCampaign): Promise<{
    estimate: ImageCampaignEstimate
    confirmation: ImageCampaignConfirmationReceipt
  }> {
    if (!campaign.estimate_hash || !campaign.confirmation_receipt_id) {
      throw new ImageWorkbenchServiceError('Campaign 尚未确认当前费用估算', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const confirmation = await this.repository.getCampaignConfirmation(
      campaign.id,
      campaign.confirmation_receipt_id,
      campaign.owner,
    )
    const estimate = await this.repository.getCampaignEstimate(campaign.id, campaign.estimate_hash, campaign.owner)
    if (
      confirmation.purpose !== 'start'
      || confirmation.item_id !== undefined
      || confirmation.attempt !== undefined
      || estimate.purpose !== 'start'
      || estimate.item_id !== undefined
      || estimate.attempt !== undefined
      || confirmation.estimate_hash !== campaign.estimate_hash
      || estimate.campaign_revision !== confirmation.campaign_revision
      || Date.parse(estimate.expires_at) <= this.now().getTime()
    ) {
      throw new ImageWorkbenchServiceError('Campaign 确认的费用估算已过期或不一致', 409, 'IMAGE_REVISION_CONFLICT')
    }
    return { estimate, confirmation }
  }

  private async assertCampaignConfirmation(campaign: ImageCampaign, estimateHash: string, confirmationId: string): Promise<void> {
    if (campaign.state !== 'confirmed' || campaign.estimate_hash !== estimateHash || campaign.confirmation_receipt_id !== confirmationId) {
      throw new ImageWorkbenchServiceError('Campaign 尚未确认当前费用估算', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const { confirmation } = await this.confirmedCampaignQuote(campaign)
    if (confirmation.campaign_revision !== campaign.revision - 1) {
      throw new ImageWorkbenchServiceError('Campaign 确认收据与当前状态不一致', 409, 'IMAGE_REVISION_CONFLICT')
    }
  }

  private async bindCampaignItemProject(
    campaignId: string,
    itemId: string,
    expectedAttempt: number,
    projectId: string,
    round: ImageGenerationRound,
    operation: ImageOperationV2,
  ): Promise<{ snapshot: ImageCampaignSnapshot; suppressed: boolean }> {
    const snapshot = await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
    const attempt = await this.repository.campaignAttempt(campaignId, itemId, expectedAttempt, STANDALONE_IMAGE_OWNER)
    if (attempt?.state === 'cancelled') return { snapshot, suppressed: true }
    const item = snapshot.items.find(candidate => candidate.id === itemId)
    if (!item || item.attempt !== expectedAttempt) {
      return { snapshot, suppressed: true }
    }
    if (item.project_id === projectId) return { snapshot, suppressed: false }
    if (item.state !== 'queued' || item.project_id) {
      return { snapshot, suppressed: true }
    }
    if (round.project_id !== projectId || !round.direction_operations.some(direction => direction.operation_id === operation.id)) {
      throw new ImageWorkbenchServiceError('Campaign 尝试与持久化的生成 Round 不一致', 500, 'IMAGE_OPERATION_CORRUPT')
    }
    const intent = await this.createCampaignProjectIntent(projectId, snapshot.campaign, item)
    const requestHash = this.campaignRequestHash('campaign_item_bind_project', campaignId, {
      item_id: item.id,
      attempt: item.attempt,
      project_id: projectId,
      intent,
    })
    const result = await this.repository.recordCampaignItemProjectCommand({
      campaign_id: campaignId,
      owner: STANDALONE_IMAGE_OWNER,
      base_revision: snapshot.campaign.revision,
      item_id: item.id,
      expected_attempt: expectedAttempt,
      project_id: projectId,
      generation_round_id: round.id,
      generation_operation_id: operation.id,
      intent,
      item_state: 'queued',
      idempotency_key: `bb-image-campaign-bind-${campaignId}-${item.id}-${item.attempt}`,
      request_hash: requestHash,
      updated_at: this.iso(),
    })
    return { snapshot: { campaign: result.campaign, items: result.items }, suppressed: result.suppressed }
  }

  /**
   * Recovery-only use case for an already-created Campaign child Project.
   * It reconstructs the persisted Round/Operation pair instead of accepting
   * caller-supplied transient objects, then reuses the same fenced command.
   */
  async reconcileCampaignItemProjectBinding(
    campaignId: string,
    itemId: string,
    expectedAttempt: number,
    projectId: string,
  ): Promise<{ snapshot: ImageCampaignSnapshot; suppressed: boolean }> {
    const snapshot = await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
    const item = snapshot.items.find(candidate => candidate.id === itemId)
    if (!item || item.attempt !== expectedAttempt) return { snapshot, suppressed: true }
    if (item.project_id === projectId) return { snapshot, suppressed: false }
    const rounds = await this.repository.listGenerationRounds(projectId)
    for (const round of rounds) {
      const operationId = round.direction_operations[0]?.operation_id
      if (!operationId) continue
      const operation = await this.repository.getGenerationOperation(projectId, operationId)
      return await this.bindCampaignItemProject(campaignId, itemId, expectedAttempt, projectId, round, operation)
    }
    throw new ImageWorkbenchServiceError('Campaign 恢复缺少已持久化的生成 Round', 409, 'IMAGE_OPERATION_CORRUPT')
  }

  private async settleCampaignIfTerminal(campaignId: string): Promise<ImageCampaignSnapshot> {
    const snapshot = await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
    if (snapshot.campaign.state !== 'running' || snapshot.items.some(item => ['draft', 'queued', 'running'].includes(item.state))) {
      return snapshot
    }
    const requestHash = this.campaignRequestHash('campaign_complete', campaignId, {
      base_revision: snapshot.campaign.revision,
      items: snapshot.items.map(item => ({ id: item.id, state: item.state, attempt: item.attempt })),
    })
    const result = await this.repository.updateCampaignWithItemsCommand({
      owner: STANDALONE_IMAGE_OWNER,
      campaign: imageCampaignSchema.parse({
        ...snapshot.campaign,
        revision: snapshot.campaign.revision + 1,
        state: 'completed',
        updated_at: this.iso(),
      }),
      items: snapshot.items,
      base_revision: snapshot.campaign.revision,
      idempotency_key: `bb-image-campaign-complete-${campaignId}-${snapshot.campaign.revision}`,
      request_hash: requestHash,
    })
    return { campaign: result.campaign, items: result.items }
  }

  private async synchronizeCampaignItem(campaignId: string, itemId: string): Promise<ImageCampaignSnapshot> {
    const snapshot = await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
    const item = snapshot.items.find(candidate => candidate.id === itemId)
    if (!item || item.state === 'cancelled' || !item.project_id) return snapshot
    const attempt = await this.repository.campaignAttempt(campaignId, item.id, item.attempt, STANDALONE_IMAGE_OWNER)
    if (!attempt?.generation_operation_id) return snapshot
    const stored = await this.repository.getGenerationOperation(item.project_id, attempt.generation_operation_id).catch(() => null)
    if (!stored) return snapshot
    const operation = await this.refreshGenerationOperation(item.project_id, stored.id).catch(() => stored)
    const nextState = this.campaignItemState(operation)
    if (nextState === item.state) return await this.settleCampaignIfTerminal(campaignId)
    const requestHash = this.campaignRequestHash('campaign_item_state', campaignId, {
      item_id: item.id,
      attempt: item.attempt,
      project_id: item.project_id,
      state: nextState,
      operation_id: operation.id,
    })
    const result = await this.repository.updateCampaignItemStateCommand({
      campaign_id: campaignId,
      owner: STANDALONE_IMAGE_OWNER,
      base_revision: snapshot.campaign.revision,
      item_id: item.id,
      item_state: nextState,
      ...(nextState === 'failed' && operation.safe_error ? { safe_error_code: operation.safe_error.code } : {}),
      idempotency_key: `bb-image-campaign-state-${campaignId}-${item.id}-${item.attempt}-${nextState}`,
      request_hash: requestHash,
      updated_at: this.iso(),
    })
    return await this.settleCampaignIfTerminal(result.campaign.id)
  }

  private async failCampaignItem(campaignId: string, itemId: string, safeErrorCode: string, projectId?: string): Promise<ImageCampaignSnapshot> {
    const snapshot = await this.getCampaign(campaignId)
    const item = snapshot.items.find(candidate => candidate.id === itemId)
    if (!item || item.state === 'cancelled' || item.state === 'ready' || item.state === 'failed') return snapshot
    const requestHash = this.campaignRequestHash('campaign_item_failed', campaignId, {
      item_id: item.id,
      attempt: item.attempt,
      ...(projectId ? { project_id: projectId } : {}),
      safe_error_code: safeErrorCode,
    })
    const result = await this.repository.updateCampaignItemStateCommand({
      campaign_id: campaignId,
      owner: STANDALONE_IMAGE_OWNER,
      base_revision: snapshot.campaign.revision,
      item_id: item.id,
      item_state: 'failed',
      ...(projectId ? { project_id: projectId } : {}),
      safe_error_code: safeErrorCode,
      idempotency_key: `bb-image-campaign-failed-${campaignId}-${item.id}-${item.attempt}`,
      request_hash: requestHash,
      updated_at: this.iso(),
    })
    return await this.settleCampaignIfTerminal(result.campaign.id)
  }

  private async reserveCampaignAttempt(campaign: ImageCampaign, item: ImageCampaignItem) {
    return await this.repository.ensureCampaignAttemptReservation({
      campaign_id: campaign.id,
      item_id: item.id,
      attempt: item.attempt,
      expected_project_id: this.campaignItemProjectId(campaign, item),
      owner: STANDALONE_IMAGE_OWNER,
      created_at: this.iso(),
    })
  }

  /** A pre-POST Campaign cancellation is one atomic local state change. */
  private async suppressUnpostedCampaignAttempt(
    campaignId: string,
    itemId: string,
    attempt: number,
    operation: ImageOperationV2,
  ): Promise<boolean> {
    const cancelled = await this.repository.cancelCampaignAttemptBeforeSubmission({
      campaign_id: campaignId,
      item_id: itemId,
      attempt,
      expected_project_id: operation.project_id,
      generation_operation_id: operation.id,
      owner: STANDALONE_IMAGE_OWNER,
      updated_at: this.iso(),
    })
    return cancelled.cancelled
  }

  private campaignRoundOperation(round: ImageGenerationRound, operations: readonly ImageOperationV2[]): ImageOperationV2 {
    if (round.direction_operations.length !== 1 || operations.length !== 1) {
      throw new ImageWorkbenchServiceError('Campaign 尝试必须精确对应一个生成操作', 500, 'IMAGE_OPERATION_CORRUPT')
    }
    const operation = operations[0]
    if (!operation || round.direction_operations[0]?.operation_id !== operation.id) {
      throw new ImageWorkbenchServiceError('Campaign 尝试的生成操作映射损坏', 500, 'IMAGE_OPERATION_CORRUPT')
    }
    return operation
  }

  private async dispatchCampaignItem(campaignId: string, itemId: string): Promise<ImageCampaignSnapshot> {
    const snapshot = await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
    const item = snapshot.items.find(candidate => candidate.id === itemId)
    if (!item || item.state !== 'queued') return snapshot
    const reservation = await this.reserveCampaignAttempt(snapshot.campaign, item)
    if (reservation.state === 'cancelled') {
      return await this.transitionCampaignItemToCancelled(snapshot, item, `bb-image-campaign-recover-cancel-${campaignId}`)
    }
    const key = this.campaignItemQuickCreateKey(snapshot.campaign, item)
    const projectId = this.campaignItemProjectId(snapshot.campaign, item)
    let created: Awaited<ReturnType<ImageWorkbenchRuntime['quickCreate']>>
    try {
      created = await this.quickCreate({
        idempotency_key: key,
        title: `${snapshot.campaign.name} ${item.ordinal + 1}`,
        prompt: snapshot.campaign.shared_brief.user_request,
        output_preset: snapshot.campaign.output_preset,
        model_selection: snapshot.campaign.model_selection,
        budget_limit: await this.campaignItemBudget(snapshot.campaign, item),
        reference_inputs: [],
        brief_overrides: this.campaignBriefOverrides(snapshot.campaign),
      }, {
        mode: 'start',
        // The Campaign item must point at its ordinary Project before the
        // persisted Round is allowed to cross the paid submission boundary.
        on_generation_round_persisted: async ({ project, round, operations }) => {
          const operation = this.campaignRoundOperation(round, operations)
          const bound = await this.bindCampaignItemProject(campaignId, itemId, item.attempt, project.id, round, operation)
          if (bound.suppressed) {
            const cancelled = await this.suppressUnpostedCampaignAttempt(campaignId, itemId, item.attempt, operation)
            if (!cancelled) {
              throw new ImageWorkbenchServiceError('Campaign 项目在取消期间已开始执行', 409, 'IMAGE_OPERATION_NOT_CANCELLABLE')
            }
          }
        },
      })
    } catch (error) {
      const existingRound = await this.existingGenerationRound(projectId, stableId('rnd', projectId, key)).catch(() => null)
      if (existingRound) {
        const operations = await Promise.all(existingRound.direction_operations.map(async direction =>
          await this.repository.getGenerationOperation(projectId, direction.operation_id)))
        const operation = this.campaignRoundOperation(existingRound, operations)
        try {
          const bound = await this.bindCampaignItemProject(campaignId, itemId, item.attempt, projectId, existingRound, operation)
          if (bound.suppressed) {
            const cancelled = await this.suppressUnpostedCampaignAttempt(campaignId, itemId, item.attempt, operation)
            if (!cancelled) throw new ImageWorkbenchServiceError('Campaign 项目在取消期间已开始执行', 409, 'IMAGE_OPERATION_NOT_CANCELLABLE')
          }
        } catch (error) {
          // A stale caller is allowed to observe the Campaign's durable newer
          // state, but cannot revive or bind its prior Project attempt.
          if (error instanceof ImageWorkbenchServiceError && (error.code === 'IMAGE_REVISION_CONFLICT' || error.code === 'IMAGE_OPERATION_NOT_CANCELLABLE')) {
            return await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
          }
          throw error
        }
        return await this.synchronizeCampaignItem(campaignId, itemId)
      }
      return await this.failCampaignItem(campaignId, itemId, mediaErrorCode(error), await this.project(projectId).then(project => project.id).catch(() => undefined))
    }
    if (created.mode !== 'started') {
      throw new ImageWorkbenchServiceError('Campaign 快速创建未产生生成轮次', 500, 'IMAGE_OPERATION_CORRUPT')
    }
    const operation = this.campaignRoundOperation(created.round, created.operations)
    const bound = await this.bindCampaignItemProject(campaignId, itemId, item.attempt, created.project.id, created.round, operation)
    if (bound.suppressed) {
      const cancelled = await this.suppressUnpostedCampaignAttempt(campaignId, itemId, item.attempt, operation)
      if (!cancelled) return await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
    }
    return await this.synchronizeCampaignItem(campaignId, itemId)
  }

  async startCampaign(campaignId: string, raw: { base_revision: number; idempotency_key: string; estimate_hash: string; confirmation_receipt_id: string }): Promise<ImageCampaignSnapshot> {
    const input = startImageCampaignInputSchema.parse(raw)
    const requestHash = this.campaignRequestHash('campaign_start', campaignId, {
      base_revision: input.base_revision,
      estimate_hash: input.estimate_hash,
      confirmation_receipt_id: input.confirmation_receipt_id,
    })
    const replay = await this.repository.campaignCommandResult(campaignId, STANDALONE_IMAGE_OWNER, input.idempotency_key, requestHash)
    if (replay) return await this.resumeCampaign(campaignId)
    const current = await this.getCampaign(campaignId)
    if (current.campaign.revision !== input.base_revision) {
      throw new ImageWorkbenchServiceError('Campaign 已更新，请刷新后再开始', 409, 'IMAGE_REVISION_CONFLICT')
    }
    await this.assertCampaignConfirmation(current.campaign, input.estimate_hash, input.confirmation_receipt_id)
    const now = this.iso()
    const started = await this.repository.updateCampaignWithItemsCommand({
      owner: STANDALONE_IMAGE_OWNER,
      campaign: imageCampaignSchema.parse({
        ...current.campaign,
        revision: current.campaign.revision + 1,
        state: 'running',
        updated_at: now,
      }),
      items: current.items.map(item => imageCampaignItemSchema.parse({ ...item, state: 'queued', updated_at: now })),
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      attempt_reservations: current.items.map(item => ({
        item_id: item.id,
        attempt: item.attempt,
        expected_project_id: this.campaignItemProjectId(current.campaign, item),
      })),
    })
    void started
    return await this.resumeCampaign(campaignId)
  }

  private async cancelCampaignItem(
    campaignId: string,
    itemId: string,
    expectedAttempt: number,
    cancelKey: string,
  ): Promise<ImageCampaignSnapshot> {
    const snapshot = await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
    const item = snapshot.items.find(candidate => candidate.id === itemId)
    if (!item || item.attempt !== expectedAttempt || ['ready', 'failed', 'cancelled'].includes(item.state)) return snapshot
    const expectedProjectId = this.campaignItemProjectId(snapshot.campaign, item)
    const attempt = await this.repository.campaignAttempt(campaignId, item.id, item.attempt, STANDALONE_IMAGE_OWNER)
    if (item.state === 'draft' || !item.project_id) {
      await this.repository.markCampaignAttemptCancelled({
        campaign_id: campaignId,
        item_id: item.id,
        attempt: item.attempt,
        expected_project_id: expectedProjectId,
        owner: STANDALONE_IMAGE_OWNER,
        updated_at: this.iso(),
      })
      return await this.transitionCampaignItemToCancelled(snapshot, item, cancelKey, expectedAttempt)
    }
    if (attempt?.state === 'cancelled') return await this.transitionCampaignItemToCancelled(snapshot, item, cancelKey, expectedAttempt)
    if (!attempt?.generation_operation_id) {
      await this.repository.markCampaignAttemptCancelled({
        campaign_id: campaignId,
        item_id: item.id,
        attempt: item.attempt,
        expected_project_id: expectedProjectId,
        owner: STANDALONE_IMAGE_OWNER,
        updated_at: this.iso(),
      })
      return await this.transitionCampaignItemToCancelled(snapshot, item, cancelKey, expectedAttempt)
    }
    const stored = await this.repository.getGenerationOperation(item.project_id, attempt.generation_operation_id)
    const operation = await this.refreshGenerationOperation(item.project_id, stored.id).catch(() => stored)
    if (operation.status !== 'queued') {
      await this.synchronizeCampaignItem(campaignId, itemId)
      if (['running', 'cancelling', 'committing', 'outcome_unknown'].includes(operation.status)) {
        await this.repository.markCampaignAttemptCancellationTooLate({
          campaign_id: campaignId,
          item_id: item.id,
          attempt: item.attempt,
          owner: STANDALONE_IMAGE_OWNER,
          updated_at: this.iso(),
        })
        throw new ImageWorkbenchServiceError('Campaign 项目已开始执行，不能断言取消成功', 409, 'IMAGE_OPERATION_NOT_CANCELLABLE')
      }
      return await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
    }
    try {
      if (!operation.transport_task_id) throw new ImageWorkbenchServiceError('Campaign 尝试缺少传输操作', 500, 'IMAGE_OPERATION_CORRUPT')
      const transport = await this.repository.getOperation(operation.transport_task_id)
      if (!transport.remote_task_id && !transport.remote_submission_started_at) {
        const cancelled = await this.suppressUnpostedCampaignAttempt(campaignId, item.id, item.attempt, operation)
        if (!cancelled) throw new ImageWorkbenchServiceError('Campaign 项目在取消期间已开始执行', 409, 'IMAGE_OPERATION_NOT_CANCELLABLE')
      } else {
        const cancelled = await this.cancelGenerationOperation(operation.id)
        if (cancelled.status !== 'cancelled') return await this.synchronizeCampaignItem(campaignId, itemId)
        await this.repository.markCampaignAttemptCancelled({
          campaign_id: campaignId,
          item_id: item.id,
          attempt: item.attempt,
          expected_project_id: expectedProjectId,
          owner: STANDALONE_IMAGE_OWNER,
          updated_at: this.iso(),
        })
      }
      const current = await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
      const currentItem = current.items.find(candidate => candidate.id === item.id)
      return currentItem
        ? await this.transitionCampaignItemToCancelled(current, currentItem, cancelKey, expectedAttempt)
        : current
    } catch (error) {
      if (error instanceof ImageWorkbenchServiceError && error.status === 409) {
        // The queued task may have started between polling and cancellation.
        // Preserve the observed state instead of claiming cancellation worked.
        await this.synchronizeCampaignItem(campaignId, itemId)
        await this.repository.markCampaignAttemptCancellationTooLate({
          campaign_id: campaignId,
          item_id: item.id,
          attempt: item.attempt,
          owner: STANDALONE_IMAGE_OWNER,
          updated_at: this.iso(),
        })
        throw new ImageWorkbenchServiceError('Campaign 项目在取消期间已开始执行', 409, 'IMAGE_OPERATION_NOT_CANCELLABLE')
      }
      // A local persistence failure must remain observable. Swallowing it
      // would turn a prepared cancellation receipt into a false 409 outcome,
      // while the queued paid operation is still eligible for recovery POST.
      throw error
    }
  }

  private async transitionCampaignItemToCancelled(
    snapshot: ImageCampaignSnapshot,
    item: ImageCampaignItem,
    cancelKey: string,
    expectedAttempt = item.attempt,
  ): Promise<ImageCampaignSnapshot> {
    const current = snapshot.items.find(candidate => candidate.id === item.id)
    if (!current || current.attempt !== expectedAttempt || ['ready', 'failed', 'cancelled'].includes(current.state)) return snapshot
    const requestHash = this.campaignRequestHash('campaign_item_cancel', snapshot.campaign.id, {
      item_id: current.id,
      attempt: current.attempt,
    })
    const result = await this.repository.updateCampaignItemStateCommand({
      campaign_id: snapshot.campaign.id,
      owner: STANDALONE_IMAGE_OWNER,
      base_revision: snapshot.campaign.revision,
      item_id: current.id,
      item_state: 'cancelled',
      idempotency_key: `${cancelKey}-${current.id}`,
      request_hash: requestHash,
      updated_at: this.iso(),
    })
    return { campaign: result.campaign, items: result.items }
  }

  async cancelCampaign(campaignId: string, raw: { base_revision: number; idempotency_key: string }): Promise<ImageCampaignSnapshot> {
    const input = cancelImageCampaignInputSchema.parse(raw)
    const requestHash = this.campaignRequestHash('campaign_cancel', campaignId, { base_revision: input.base_revision })
    const replay = await this.repository.campaignCommandResult(campaignId, STANDALONE_IMAGE_OWNER, input.idempotency_key, requestHash)
    if (replay) {
      await this.repository.completeWorkflowCommand({
        scope: 'campaign-cancel',
        aggregate_id: campaignId,
        idempotency_key: input.idempotency_key,
        request_hash: requestHash,
        result: replay,
      }).catch(() => undefined)
      return replay
    }
    const prepared = await this.repository.prepareCampaignCancellation({
      campaign_id: campaignId,
      owner: STANDALONE_IMAGE_OWNER,
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    if (prepared.outcome === 'cancellation_too_late') {
      throw new ImageWorkbenchServiceError('Campaign 项目已开始执行，不能断言取消成功', 409, 'IMAGE_OPERATION_NOT_CANCELLABLE')
    }
    try {
      for (const target of prepared.intent.targets) {
        const itemSnapshot = await this.cancelCampaignItem(
          campaignId,
          target.item_id,
          target.attempt,
          `bb-image-campaign-cancel-${campaignId}-${input.idempotency_key}`,
        )
        const item = itemSnapshot.items.find(candidate => candidate.id === target.item_id)
        if (!item || item.attempt !== target.attempt || item.state !== 'cancelled') {
          await this.repository.markCampaignAttemptCancellationTooLate({
            campaign_id: campaignId,
            item_id: target.item_id,
            attempt: target.attempt,
            owner: STANDALONE_IMAGE_OWNER,
            updated_at: this.iso(),
          })
          throw new ImageWorkbenchServiceError('Campaign 项目已开始执行，不能断言取消成功', 409, 'IMAGE_OPERATION_NOT_CANCELLABLE')
        }
        this.injectCrash('after_campaign_cancel_item_before_completion')
      }
    } catch (error) {
      if (error instanceof ImageWorkbenchServiceError && error.code === 'IMAGE_OPERATION_NOT_CANCELLABLE') {
        await this.repository.completeCampaignCancellationTooLate({
          campaign_id: campaignId,
          owner: STANDALONE_IMAGE_OWNER,
          idempotency_key: input.idempotency_key,
          request_hash: requestHash,
          intent: prepared.intent,
        })
      }
      throw error
    }
    const current = await this.repository.getCampaign(campaignId, STANDALONE_IMAGE_OWNER)
    const allTerminal = current.items.every(item => ['ready', 'failed', 'cancelled'].includes(item.state))
    const state = allTerminal ? 'cancelled' : current.campaign.state
    const result = await this.repository.updateCampaignWithItemsCommand({
      owner: STANDALONE_IMAGE_OWNER,
      campaign: imageCampaignSchema.parse({
        ...current.campaign,
        revision: current.campaign.revision + 1,
        state,
        updated_at: this.iso(),
      }),
      items: current.items,
      base_revision: current.campaign.revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    })
    const snapshot = { campaign: result.campaign, items: result.items }
    await this.repository.completeWorkflowCommand({
      scope: 'campaign-cancel',
      aggregate_id: campaignId,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      result: snapshot,
    })
    return snapshot
  }

  async retryCampaignItem(campaignId: string, itemId: string, raw: RetryImageCampaignItemInput): Promise<ImageCampaignSnapshot> {
    const input = retryImageCampaignItemInputSchema.parse(raw)
    const requestHash = this.campaignRequestHash('campaign_retry_item', campaignId, {
      base_revision: input.base_revision,
      item_id: itemId,
      estimate_hash: input.estimate_hash,
      confirmation_receipt_id: input.confirmation_receipt_id,
    })
    const replay = await this.repository.campaignCommandResult(campaignId, STANDALONE_IMAGE_OWNER, input.idempotency_key, requestHash)
    if (replay) return await this.resumeCampaign(campaignId)
    const current = await this.getCampaign(campaignId)
    if (current.campaign.revision !== input.base_revision) {
      throw new ImageWorkbenchServiceError('Campaign 已更新或缺少费用确认，不能重试', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const item = current.items.find(candidate => candidate.id === itemId)
    if (!item || (item.state !== 'failed' && item.state !== 'cancelled')) {
      throw new ImageWorkbenchServiceError('只有失败或已取消的 Campaign 项目可以创建新付费尝试', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const confirmation = await this.repository.getCampaignConfirmation(
      campaignId,
      input.confirmation_receipt_id,
      STANDALONE_IMAGE_OWNER,
    )
    const estimate = await this.repository.getCampaignEstimate(campaignId, input.estimate_hash, STANDALONE_IMAGE_OWNER)
    if (
      confirmation.purpose !== 'retry'
      || confirmation.estimate_hash !== input.estimate_hash
      || confirmation.campaign_id !== campaignId
      || confirmation.campaign_revision !== current.campaign.revision
      || confirmation.item_id !== item.id
      || confirmation.attempt !== item.attempt + 1
      || estimate.purpose !== 'retry'
      || estimate.campaign_id !== campaignId
      || estimate.campaign_revision !== current.campaign.revision
      || estimate.item_id !== item.id
      || estimate.attempt !== item.attempt + 1
      || Date.parse(estimate.expires_at) <= this.now().getTime()
    ) {
      throw new ImageWorkbenchServiceError('Campaign 重试缺少匹配的新费用确认', 409, 'IMAGE_REVISION_CONFLICT')
    }
    if (current.campaign.estimated_paid_operations >= MAX_CAMPAIGN_PAID_OPERATIONS) {
      throw new ImageWorkbenchServiceError('Campaign 已达到可确认的付费尝试上限，不能再创建重试', 422, 'IMAGE_BUDGET_EXCEEDED')
    }
    const nextItem = imageCampaignItemSchema.parse({
      ...item,
      // The new Project is deterministic from this attempt, but must not be
      // fabricated before Quick Create has committed it. Recovery derives the
      // same idempotency key from `attempt` and binds the real Project later.
      project_id: undefined,
      state: 'queued',
      attempt: item.attempt + 1,
      retry_estimate_hash: input.estimate_hash,
      retry_confirmation_receipt_id: input.confirmation_receipt_id,
      updated_at: this.iso(),
    })
    const next = await this.repository.updateCampaignWithItemsCommand({
      owner: STANDALONE_IMAGE_OWNER,
      campaign: imageCampaignSchema.parse({
        ...current.campaign,
        revision: current.campaign.revision + 1,
        state: 'running',
        estimated_paid_operations: current.campaign.estimated_paid_operations + 1,
        updated_at: this.iso(),
      }),
      items: current.items.map(candidate => candidate.id === itemId ? nextItem : candidate),
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      attempt_reservations: [{
        item_id: nextItem.id,
        attempt: nextItem.attempt,
        expected_project_id: this.campaignItemProjectId(current.campaign, nextItem),
      }],
    })
    void next
    return await this.resumeCampaign(campaignId)
  }

  /** Resume only durable queued Campaign items, using their original attempt key. */
  private async resumeCampaign(campaignId: string): Promise<ImageCampaignSnapshot> {
    const snapshot = await this.getCampaign(campaignId)
    if (snapshot.campaign.state !== 'running') return snapshot
    for (const item of snapshot.items) {
      if (item.state === 'queued') await this.dispatchCampaignItem(campaignId, item.id)
      else if (item.state === 'running') await this.synchronizeCampaignItem(campaignId, item.id)
    }
    return await this.settleCampaignIfTerminal(campaignId)
  }

  private async recoverPreparedCampaignCancellations(): Promise<void> {
    const cancellations = await this.repository.listPreparedCampaignCancellations(STANDALONE_IMAGE_OWNER)
    for (const cancellation of cancellations) {
      await this.cancelCampaign(cancellation.campaign_id, {
        base_revision: cancellation.base_revision,
        idempotency_key: cancellation.idempotency_key,
      }).catch(() => undefined)
    }
  }

  private async recoverCampaigns(): Promise<void> {
    const campaigns = await this.repository.listCampaigns(STANDALONE_IMAGE_OWNER)
    for (const snapshot of campaigns) {
      if (snapshot.campaign.state !== 'running') continue
      await this.resumeCampaign(snapshot.campaign.id)
    }
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

  private generationEstimateRequestHash(
    project: ImageWorkbenchProject,
    plan: ImageCreativePlan,
    brief: ImageBriefSnapshot,
    delivery: ImageDeliverySpec,
    directions: ImageCreativeDirection[],
    policies: Array<{
      policy_revision: string
      provider: string
      model_id: string
      price_upper_bound: { currency: string; per_output_amount_minor: number; pricing_revision: string }
    }>,
  ): `sha256:${string}` {
    return sha256({
      project_id: project.id,
      base_revision: project.revision,
      plan_id: plan.id,
      brief_snapshot_hash: brief.snapshot_hash,
      delivery_spec: { id: delivery.id, revision: delivery.revision },
      directions: directions.map(direction => direction.id),
      policies,
      candidate_count_per_operation: IMAGE_PRODUCT_OUTPUT_COUNT,
    })
  }

  /** Exact maximum input bytes in the provider payload, counted once per CAS asset. */
  private inputByteUpperBound(project: ImageWorkbenchProject, references: ImageReferenceV2[], additionalAssets: MediaAsset[] = []): number {
    const assetIds = new Set([...references.map(reference => reference.asset_id), ...additionalAssets.map(asset => asset.id)])
    return [...assetIds].reduce((total, assetId) => total + (project.assets.find(asset => asset.id === assetId)?.byte_size ?? 0), 0)
  }

  private estimatePriceUpperBound(
    policies: Array<{ price_upper_bound: { currency: string; per_output_amount_minor: number; pricing_revision: string } }>,
    inputBytes: number,
  ): ImageGenerationEstimate['price_upper_bound'] {
    if (policies.length === 0) throw new ImageWorkbenchServiceError('没有可计价的图片 Provider', 422, 'IMAGE_CAPABILITY_GAP')
    const currency = policies[0]!.price_upper_bound.currency
    if (policies.some(policy => policy.price_upper_bound.currency !== currency)) {
      throw new ImageWorkbenchServiceError('本次生成包含无法合并的计价币种', 422, 'IMAGE_CAPABILITY_GAP')
    }
    const charges = policies.map(policy => policy.price_upper_bound.per_output_amount_minor * IMAGE_PRODUCT_OUTPUT_COUNT)
    return {
      currency,
      amount_minor: charges.reduce((total, amount) => total + amount, 0),
      per_operation_amount_minor: Math.max(...charges),
      pricing_revision: policies.map(policy => policy.price_upper_bound.pricing_revision).sort().join('+'),
      usage_upper_bound: { requests: policies.length, input_bytes: inputBytes, output_images: policies.length * IMAGE_PRODUCT_OUTPUT_COUNT },
    }
  }

  private async assertBudgetAllows(project: ImageWorkbenchProject, quote: ImageGenerationEstimate['price_upper_bound']): Promise<void> {
    if (!project.budget_limit) return
    if (project.budget_limit.currency !== quote.currency) {
      throw new ImageWorkbenchServiceError('项目预算币种与当前 Provider 计价币种不一致', 422, 'IMAGE_BUDGET_EXCEEDED')
    }
    const committed = (await this.repository.listGenerationOperations(project.id))
      .filter(operation => operation.cost_state === 'submitted_charge_possible' || operation.cost_state === 'usage_recorded')
      .reduce((total, operation) => total + (operation.price_upper_bound?.amount_minor ?? 0), 0)
    if (committed + quote.amount_minor > project.budget_limit.amount_minor) {
      throw new ImageWorkbenchServiceError('本次付费操作会超过项目预算上限', 422, 'IMAGE_BUDGET_EXCEEDED')
    }
  }

  private async saveGenerationRoundEstimate(
    project: ImageWorkbenchProject,
    plan: ImageCreativePlan,
    brief: ImageBriefSnapshot,
    delivery: ImageDeliverySpec,
    directions: ImageCreativeDirection[],
    policies: Array<{ policy_revision: string; provider: string; model_id: string; price_upper_bound: { currency: string; per_output_amount_minor: number; pricing_revision: string } }>,
  ): Promise<ImageGenerationEstimate> {
    const createdAt = this.iso()
    const expiresAt = new Date(this.now().getTime() + IMAGE_GENERATION_ESTIMATE_TTL_MS).toISOString()
    const requestHash = this.generationEstimateRequestHash(project, plan, brief, delivery, directions, policies)
    return await this.repository.saveGenerationEstimate({
      id: stableId('receipt', 'estimate', project.id, requestHash, expiresAt),
      project_id: project.id,
      kind: 'generation_round',
      creative_plan_id: plan.id,
      direction_ids: directions.map(direction => direction.id),
      request_hash: requestHash,
      estimate_hash: sha256({ kind: 'generation_round', request_hash: requestHash, expires_at: expiresAt }),
      project_revision: project.revision,
      paid_operation_count: directions.length,
      candidate_count_per_operation: IMAGE_PRODUCT_OUTPUT_COUNT,
      concurrency: Math.min(2, directions.length),
      price_upper_bound: this.estimatePriceUpperBound(policies, this.inputByteUpperBound(project, this.providerReferences(this.generationReferences(project)))),
      expires_at: expiresAt,
      created_at: createdAt,
    })
  }

  async estimateGenerationRound(projectId: string, raw: EstimateGenerationRoundInput): Promise<{
    estimate_hash: `sha256:${string}`
    direction_count: number
    paid_operation_count: number
    candidate_count_per_operation: number
    concurrency: number
    price_upper_bound: ImageGenerationEstimate['price_upper_bound']
    expires_at: string
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
      ...(this.selectedModel(project) ? { preferred_model: this.selectedModel(project) } : {}),
    }))
    const estimate = await this.saveGenerationRoundEstimate(project, plan, brief, delivery, directions, policies)
    return {
      estimate_hash: estimate.estimate_hash as `sha256:${string}`,
      direction_count: directions.length,
      paid_operation_count: estimate.paid_operation_count,
      candidate_count_per_operation: estimate.candidate_count_per_operation,
      concurrency: estimate.concurrency,
      price_upper_bound: estimate.price_upper_bound,
      expires_at: estimate.expires_at,
    }
  }

  private generationRequestHash(input: {
    project: ImageWorkbenchProject
    brief: ImageBriefSnapshot
    delivery: ImageDeliverySpec
    references: ImageReferenceV2[]
    direction: ImageCreativeDirection
    model: string
    price_upper_bound: { currency: string; per_output_amount_minor: number; pricing_revision: string }
  }): `sha256:${string}` {
    return sha256({
      project_id: input.project.id,
      owner: input.project.owner,
      kind: 'generate',
      project_revision: input.project.revision,
      brief_snapshot_hash: input.brief.snapshot_hash,
      delivery_spec_revision: input.delivery.revision,
      execution_policy_revision: IMAGE_PROVIDER_POLICY_REVISION,
      asset_hashes: this.providerReferences(input.references).map(reference => reference.content_hash),
      direction: input.direction,
      model: input.model,
      price_upper_bound: input.price_upper_bound,
      logical_attempt: 1,
    })
  }

  async createGenerationRound(
    projectId: string,
    raw: CreateGenerationRoundInput,
    lifecycle: {
      on_persisted?: (value: {
        project: ImageWorkbenchProject
        round: ImageGenerationRound
        operations: ImageOperationV2[]
      }) => Promise<void>
    } = {},
  ): Promise<{
    round: ImageGenerationRound
    operations: ImageOperationV2[]
  }> {
    const input = createGenerationRoundInputSchema.parse(raw)
    const project = await this.project(projectId)
    const roundId = stableId('rnd', project.id, input.idempotency_key)
    const roundCommandHash = sha256({
      kind: 'generation_round',
      project_id: project.id,
      base_revision: input.base_revision,
      creative_plan_id: input.creative_plan_id,
      direction_ids: input.direction_ids,
      estimate_hash: input.estimate_hash,
      confirm: input.confirm,
    })
    const existingRound = await this.repository.getGenerationRound(project.id, roundId).catch(error => {
      if (error instanceof ImageWorkbenchRepositoryError && error.status === 404) return null
      throw error
    })
    const replayRound = async (round: ImageGenerationRound): Promise<{ round: ImageGenerationRound; operations: ImageOperationV2[] }> => {
      const storedRequestHash = await this.repository.generationRoundRequestHash(project.id, roundId)
      if (storedRequestHash !== '' && storedRequestHash !== roundCommandHash) {
        throw new ImageWorkbenchServiceError('生成轮次幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
      if (storedRequestHash === '') await this.repository.bindLegacyGenerationRoundRequestHash(project.id, roundId, roundCommandHash)
      const operations = await Promise.all(round.direction_operations.map(async direction => await this.repository.getGenerationOperation(project.id, direction.operation_id)))
      await lifecycle.on_persisted?.({ project: await this.project(project.id), round, operations })
      return { round, operations }
    }
    if (existingRound) {
      return await replayRound(existingRound)
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
      ...(this.selectedModel(project) ? { preferred_model: this.selectedModel(project) } : {}),
    }) }))
    const estimate = await this.repository.getGenerationEstimate(project.id, input.estimate_hash)
    const expectedEstimateRequestHash = this.generationEstimateRequestHash(project, plan, brief, delivery, directions, policies.map(item => item.policy))
    if (
      estimate.kind !== 'generation_round'
      || estimate.creative_plan_id !== plan.id
      || estimate.project_revision !== input.base_revision
      || estimate.request_hash !== expectedEstimateRequestHash
      || estimate.direction_ids.length !== directions.length
      || estimate.direction_ids.some((directionId, index) => directionId !== directions[index]!.id)
      || Date.parse(estimate.expires_at) <= this.now().getTime()
    ) {
      throw new ImageWorkbenchServiceError('费用估算已过期或不属于当前输入，请重新确认', 409, 'IMAGE_REVISION_CONFLICT')
    }
    await this.assertBudgetAllows(project, estimate.price_upper_bound)
    if (!productImageRelayConfigured()) {
      throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'IMAGE_RELAY_NOT_CONFIGURED')
    }
    // Reject a missing or corrupt Provider reference before accepting paid work.
    // The final data URIs and per-image controls are rebuilt from the same CAS
    // assets immediately before the remote submission.
    await this.providerReferenceInputs(project, this.providerReferences(references))
    const now = this.iso()
    const operationPairs = policies.map(({ direction, policy }) => {
      const operationId = stableId('op', project.id, roundId, direction.id)
      const requestHash = this.generationRequestHash({
        project,
        brief,
        delivery,
        references,
        direction,
        model: policy.model_id,
        price_upper_bound: policy.price_upper_bound,
      })
      const idempotencyKey = `bb-image-${requestHash.slice('sha256:'.length)}`
      const taskId = id('task')
      const operation: ImageOperationV2 = {
        id: operationId,
        project_id: project.id,
        owner: project.owner,
        kind: 'generate',
        status: 'queued',
        progress: 0,
        stage: '等待提交创作方向',
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
        price_upper_bound: {
          currency: policy.price_upper_bound.currency,
          amount_minor: policy.price_upper_bound.per_output_amount_minor * IMAGE_PRODUCT_OUTPUT_COUNT,
          pricing_revision: policy.price_upper_bound.pricing_revision,
        },
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
          output_count: IMAGE_PRODUCT_OUTPUT_COUNT,
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
      estimate_hash: estimate.estimate_hash as `sha256:${string}`,
      confirmed_at: now,
      created_at: now,
    }
    let persisted: {
      project: ImageWorkbenchProject
      round: ImageGenerationRound
      operations: ImageOperationV2[]
      transport_operations: ImageOperation[]
    }
    try {
      persisted = await this.repository.createGenerationRoundWithOperations({
        project,
        base_revision: input.base_revision,
        request_hash: roundCommandHash,
        round,
        operations: operationPairs.map(pair => pair.operation),
        transport_operations: operationPairs.map(pair => pair.transport),
      })
    } catch (error) {
      // A concurrent retry may have committed this deterministic Round after
      // both callers passed the preflight checks. Re-read that Round and
      // replay it; only a different request hash remains a true conflict.
      if (!(error instanceof ImageWorkbenchRepositoryError) || error.code !== 'IMAGE_REVISION_CONFLICT') throw error
      const committed = await this.repository.getGenerationRound(project.id, roundId).catch(replayError => {
        if (replayError instanceof ImageWorkbenchRepositoryError && replayError.status === 404) return null
        throw replayError
      })
      if (!committed) throw error
      return await replayRound(committed)
    }
    await lifecycle.on_persisted?.({
      project: persisted.project,
      round: persisted.round,
      operations: persisted.operations,
    })
    this.injectCrash('after_generation_round_persisted_before_post')
    const submitted: ImageOperationV2[] = []
    for (const pair of operationPairs) {
      // A Campaign cancellation can linearize after its pre-POST binding.
      // Re-read both durable records so a locally cancelled queued operation
      // never gets revived by this stale creation stack.
      const currentOperation = await this.repository.getGenerationOperation(persisted.project.id, pair.operation.id)
      const currentTransport = await this.repository.getOperation(pair.transport.id)
      if (
        currentOperation.status !== 'queued'
        || currentTransport.status !== 'queued'
        || Boolean(currentTransport.remote_task_id)
        || Boolean(currentTransport.remote_submission_started_at)
      ) {
        submitted.push(currentOperation)
        continue
      }
      submitted.push(await this.submitGenerationTransport(persisted.project, currentOperation, currentTransport, pair.policy.provider, pair.policy.model_id))
    }
    return { round: persisted.round, operations: submitted }
  }

  private derivationOperationRequestHash(input: {
    project: ImageWorkbenchProject
    source: DerivationSourceRecord
    brief: ImageBriefSnapshot
    delivery: ImageDeliverySpec
    direction: ImageCreativeDirection
    references: ImageReferenceV2[]
    instruction: string
    kind: 'edit' | 'inpaint'
    mask_content_hash?: `sha256:${string}`
    model: string
    policyRevision: string
    price_upper_bound: { currency: string; per_output_amount_minor: number; pricing_revision: string }
  }): `sha256:${string}` {
    const assetHashes = [...new Set([
      input.source.kind === 'candidate' ? input.source.candidate.content_hash : input.source.verified.content_hash,
      ...this.providerReferences(input.references).map(reference => reference.content_hash),
      ...(input.mask_content_hash ? [input.mask_content_hash] : []),
    ])]
    return sha256({
      project_id: input.project.id,
      owner: input.project.owner,
      kind: input.kind,
      ...(input.source.kind === 'candidate'
        ? { base_candidate_id: input.source.candidate.id }
        : this.versionDerivationHashFields(input.source)),
      instruction: input.instruction,
      project_revision: input.project.revision,
      brief_snapshot_hash: input.brief.snapshot_hash,
      delivery_spec_revision: input.delivery.revision,
      creative_direction_id: input.direction.id,
      execution_policy_revision: input.policyRevision,
      asset_hashes: assetHashes,
      mask_content_hash: input.mask_content_hash ?? null,
      model: input.model,
      price_upper_bound: input.price_upper_bound,
      logical_attempt: 1,
    })
  }

  private versionDerivationHashFields(source: Extract<DerivationSourceRecord, { kind: 'version' }>): {
    candidate_id: string | null
    base_version_id: string | null
    base_asset_hash: `sha256:${string}`
  } {
    return { candidate_id: null, base_version_id: source.version_id, base_asset_hash: source.verified.content_hash }
  }

  private derivationSourceId(source: DerivationSourceRecord): string {
    return source.kind === 'candidate' ? source.candidate.id : source.version_id
  }

  private derivationSourceLabel(source: DerivationSourceRecord): '候选' | '正式版本' {
    return source.kind === 'candidate' ? '候选' : '正式版本'
  }

  private async resolveDerivationSource(project: ImageWorkbenchProject, raw: ImageDerivationSource): Promise<DerivationSourceRecord> {
    const source = imageDerivationSourceSchema.parse(raw)
    if (source.candidate_id) {
      const candidate = await this.repository.getCandidate(project.id, source.candidate_id)
      const asset = project.assets.find(item => item.id === candidate.asset_id && item.role === 'result')
      if (!asset?.content_hash) throw new ImageWorkbenchServiceError('候选资产不存在', 409, 'IMAGE_ASSET_NOT_FOUND')
      return { kind: 'candidate', candidate, asset, verified: await this.assets.readVerified(asset) }
    }
    const version = await this.imageVersionBytes(project, source.version_id!)
    return { kind: 'version', version_id: version.version.id, asset: version.asset, verified: version.verified }
  }

  private async verifyDerivationMask(source: DerivationSourceRecord, input: { kind: 'edit' | 'inpaint'; mask_data_url?: string }): Promise<VerifiedImageBytes | undefined> {
    if (input.kind === 'edit') return undefined
    if (!input.mask_data_url) throw new ImageWorkbenchServiceError('局部重绘需要 PNG 蒙版', 400, 'IMAGE_MASK_INVALID')
    const verified = await this.assets.verifyDataUrl(input.mask_data_url)
    if (verified.mime_type !== 'image/png') throw new ImageWorkbenchServiceError('局部重绘蒙版必须是 PNG', 400, 'IMAGE_MASK_INVALID')
    if (verified.width !== source.verified.width || verified.height !== source.verified.height) {
      throw new ImageWorkbenchServiceError(`局部重绘蒙版尺寸必须与${this.derivationSourceLabel(source)}图片一致`, 400, 'IMAGE_MASK_INVALID')
    }
    return verified
  }

  private derivationEstimateRequestHash(
    project: ImageWorkbenchProject,
    source: DerivationSourceRecord,
    input: { instruction: string; kind: 'edit' | 'inpaint' },
    mask: VerifiedImageBytes | undefined,
    operationRequestHash: `sha256:${string}`,
  ): `sha256:${string}` {
    if (source.kind === 'candidate') {
      return sha256({
        kind: 'derivation', project_id: project.id, candidate_id: source.candidate.id,
        instruction: input.instruction, operation_kind: input.kind, mask_content_hash: mask?.content_hash ?? null,
        operation_request_hash: operationRequestHash,
      })
    }
    return sha256({
      kind: 'derivation',
      project_id: project.id,
      ...this.versionDerivationHashFields(source),
      instruction: input.instruction,
      operation_kind: input.kind,
      mask_content_hash: mask?.content_hash ?? null,
      operation_request_hash: operationRequestHash,
    })
  }

  private derivationCommandHash(
    project: ImageWorkbenchProject,
    source: DerivationSourceRecord,
    input: { base_revision: number; instruction: string; kind: 'edit' | 'inpaint'; estimate_hash: string; confirm: true },
    mask: VerifiedImageBytes | undefined,
  ): `sha256:${string}` {
    if (source.kind === 'candidate') {
      return sha256({
        kind: 'derivation', project_id: project.id, candidate_id: source.candidate.id,
        base_revision: input.base_revision,
        instruction: input.instruction, operation_kind: input.kind, mask_content_hash: mask?.content_hash ?? null,
        estimate_hash: input.estimate_hash, confirm: input.confirm,
      })
    }
    return sha256({
      kind: 'derivation',
      project_id: project.id,
      ...this.versionDerivationHashFields(source),
      base_revision: input.base_revision,
      instruction: input.instruction,
      operation_kind: input.kind,
      mask_content_hash: mask?.content_hash ?? null,
      estimate_hash: input.estimate_hash,
      confirm: input.confirm,
    })
  }

  async estimateDerivation(projectId: string, candidateId: string, raw: EstimateDeriveImageCandidateInput): Promise<{
    estimate_hash: `sha256:${string}`
    paid_operation_count: number
    candidate_count_per_operation: number
    concurrency: number
    price_upper_bound: ImageGenerationEstimate['price_upper_bound']
    expires_at: string
  }> {
    return await this.estimateDerivationForSource(projectId, { candidate_id: candidateId }, raw)
  }

  async estimateVersionDerivation(projectId: string, versionId: string, raw: EstimateDeriveImageVersionInput): Promise<{
    estimate_hash: `sha256:${string}`
    paid_operation_count: number
    candidate_count_per_operation: number
    concurrency: number
    price_upper_bound: ImageGenerationEstimate['price_upper_bound']
    expires_at: string
  }> {
    return await this.estimateDerivationForSource(projectId, { version_id: versionId }, estimateDeriveImageVersionInputSchema.parse(raw))
  }

  private async estimateDerivationForSource(projectId: string, sourceInput: ImageDerivationSource, raw: EstimateDeriveImageCandidateInput): Promise<{
    estimate_hash: `sha256:${string}`
    paid_operation_count: number
    candidate_count_per_operation: number
    concurrency: number
    price_upper_bound: ImageGenerationEstimate['price_upper_bound']
    expires_at: string
  }> {
    const input = estimateDeriveImageCandidateInputSchema.parse(raw)
    const project = await this.project(projectId)
    this.assertRevision(project, input.base_revision, '图片项目已更新，请重新估算派生费用')
    const source = await this.resolveDerivationSource(project, sourceInput)
    const mask = await this.verifyDerivationMask(source, input)
    const planBrief = await this.compileGenerationBrief(project)
    const planKey = `bb-image-derive-estimate-${sha256({
      project_id: project.id,
      ...(source.kind === 'candidate'
        ? { candidate_id: source.candidate.id }
        : this.versionDerivationHashFields(source)),
      instruction: input.instruction,
      kind: input.kind,
      mask_content_hash: mask?.content_hash ?? null,
      project_revision: project.revision,
      brief_snapshot_hash: planBrief.snapshot_hash,
    }).slice('sha256:'.length)}`
    const plan = await this.createCreativePlanForInternal(project.id, {
      base_revision: project.revision,
      idempotency_key: planKey,
    })
    const { brief, delivery, references } = await this.creativePlanForGeneration(project, plan.id)
    const direction = plan.directions[0]!
    const policy = this.resolveGenerationPolicy({
      user_request: input.instruction,
      size: project.size,
      operation_mode: input.kind,
      references,
      transparent_output: this.deliveryRequiresTransparency(delivery),
      preferred_model: 'gpt-image-2',
    })
    const providerReferences = this.providerReferences(references)
    const provider = providerRegistryEntry(policy.model_id)
    if (!provider?.image_generation || providerReferences.length + 1 > provider.image_generation.max_reference_images) {
      throw new ImageWorkbenchServiceError('派生的基础候选与参考图数量超过 Provider 能力上限', 422, 'IMAGE_CAPABILITY_GAP')
    }
    const operationRequestHash = this.derivationOperationRequestHash({
      project, source, brief, delivery, direction, references, instruction: input.instruction,
      kind: input.kind, mask_content_hash: mask?.content_hash,
      model: policy.model_id, policyRevision: policy.policy_revision, price_upper_bound: policy.price_upper_bound,
    })
    const requestHash = this.derivationEstimateRequestHash(project, source, input, mask, operationRequestHash)
    const createdAt = this.iso()
    const expiresAt = new Date(this.now().getTime() + IMAGE_GENERATION_ESTIMATE_TTL_MS).toISOString()
    const estimate = await this.repository.saveGenerationEstimate({
      id: stableId('receipt', 'derive-estimate', project.id, requestHash, expiresAt),
      project_id: project.id,
      kind: 'derivation',
      creative_plan_id: plan.id,
      ...(source.kind === 'candidate' ? { candidate_id: source.candidate.id } : { version_id: source.version_id }),
      direction_ids: [direction.id],
      request_hash: requestHash,
      estimate_hash: sha256({ kind: 'derivation', request_hash: requestHash, expires_at: expiresAt }),
      project_revision: project.revision,
      paid_operation_count: 1,
      candidate_count_per_operation: IMAGE_PRODUCT_OUTPUT_COUNT,
      concurrency: 1,
      price_upper_bound: this.estimatePriceUpperBound(
        [policy],
        this.inputByteUpperBound(project, providerReferences, [source.asset]) + (mask?.bytes.byteLength ?? 0),
      ),
      expires_at: expiresAt,
      created_at: createdAt,
    })
    return {
      estimate_hash: estimate.estimate_hash as `sha256:${string}`,
      paid_operation_count: estimate.paid_operation_count,
      candidate_count_per_operation: estimate.candidate_count_per_operation,
      concurrency: estimate.concurrency,
      price_upper_bound: estimate.price_upper_bound,
      expires_at: estimate.expires_at,
    }
  }

  /**
   * Derivation is a normal paid edit Operation whose source is exactly one
   * immutable Candidate or formal Version. It deliberately creates another
   * one-direction Round and Candidate Group instead of mutating the source.
   */
  async deriveCandidate(projectId: string, candidateId: string, raw: DeriveImageCandidateInput): Promise<{
    round: ImageGenerationRound
    operation: ImageOperationV2
  }> {
    return await this.deriveForSource(projectId, { candidate_id: candidateId }, raw)
  }

  async deriveVersion(projectId: string, versionId: string, raw: DeriveImageVersionInput): Promise<{
    round: ImageGenerationRound
    operation: ImageOperationV2
  }> {
    return await this.deriveForSource(projectId, { version_id: versionId }, deriveImageVersionInputSchema.parse(raw))
  }

  private async deriveForSource(projectId: string, sourceInput: ImageDerivationSource, raw: DeriveImageCandidateInput): Promise<{
    round: ImageGenerationRound
    operation: ImageOperationV2
  }> {
    const input = deriveImageCandidateInputSchema.parse(raw)
    const project = await this.project(projectId)
    const source = await this.resolveDerivationSource(project, sourceInput)
    const mask = await this.verifyDerivationMask(source, input)
    const roundId = stableId('rnd', project.id, 'derive', input.idempotency_key)
    const derivationCommandHash = this.derivationCommandHash(project, source, input, mask)
    const existing = await this.repository.getGenerationRound(project.id, roundId).catch(error => {
      if (error instanceof ImageWorkbenchRepositoryError && error.status === 404) return null
      throw error
    })
    if (existing) {
      if (await this.repository.generationRoundRequestHash(project.id, roundId) !== derivationCommandHash) {
        throw new ImageWorkbenchServiceError(`${this.derivationSourceLabel(source)}派生幂等键对应的请求内容不一致`, 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
      const operationId = existing.direction_operations[0]?.operation_id
      if (!operationId) throw new ImageWorkbenchServiceError(`${this.derivationSourceLabel(source)}派生轮次缺少操作`, 500, 'IMAGE_OPERATION_CORRUPT')
      return { round: existing, operation: await this.repository.getGenerationOperation(project.id, operationId) }
    }
    this.assertRevision(project, input.base_revision, `图片项目已更新，请刷新后再派生${this.derivationSourceLabel(source)}`)
    await this.assertNoActiveOperation(project)
    await this.assertNoActiveGenerationOperation(project)
    const estimate = await this.repository.getGenerationEstimate(project.id, input.estimate_hash)
    if (
      estimate.kind !== 'derivation'
      || (source.kind === 'candidate'
        ? estimate.candidate_id !== source.candidate.id || Boolean(estimate.version_id)
        : estimate.version_id !== source.version_id || Boolean(estimate.candidate_id))
      || estimate.project_revision !== input.base_revision
      || Date.parse(estimate.expires_at) <= this.now().getTime()
      || !estimate.creative_plan_id
      || estimate.direction_ids.length !== 1
    ) {
      throw new ImageWorkbenchServiceError('派生费用估算已过期或不属于当前输入，请重新确认', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const { plan, brief, delivery, references } = await this.creativePlanForGeneration(project, estimate.creative_plan_id)
    const direction = plan.directions.find(item => item.id === estimate.direction_ids[0])
    if (!direction) throw new ImageWorkbenchServiceError('派生费用估算缺少创作方向', 409, 'IMAGE_REVISION_CONFLICT')
    const policy = this.resolveGenerationPolicy({
      user_request: input.instruction,
      size: project.size,
      operation_mode: input.kind,
      references,
      transparent_output: this.deliveryRequiresTransparency(delivery),
      preferred_model: 'gpt-image-2',
    })
    const providerReferences = this.providerReferences(references)
    const provider = providerRegistryEntry(policy.model_id)
    if (!provider?.image_generation || providerReferences.length + 1 > provider.image_generation.max_reference_images) {
      throw new ImageWorkbenchServiceError('派生的基础候选与参考图数量超过 Provider 能力上限', 422, 'IMAGE_CAPABILITY_GAP')
    }
    await this.providerReferenceInputs(project, providerReferences)
    const requestHash = this.derivationOperationRequestHash({
      project, source, brief, delivery, direction, references, instruction: input.instruction,
      kind: input.kind, mask_content_hash: mask?.content_hash,
      model: policy.model_id, policyRevision: policy.policy_revision, price_upper_bound: policy.price_upper_bound,
    })
    const estimateRequestHash = this.derivationEstimateRequestHash(project, source, input, mask, requestHash)
    if (estimate.request_hash !== estimateRequestHash) {
      throw new ImageWorkbenchServiceError('派生费用估算已过期或不属于当前输入，请重新确认', 409, 'IMAGE_REVISION_CONFLICT')
    }
    await this.assertBudgetAllows(project, estimate.price_upper_bound)
    if (!productImageRelayConfigured()) throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'IMAGE_RELAY_NOT_CONFIGURED')
    const now = this.iso()
    const operationId = stableId('op', project.id, roundId, this.derivationSourceId(source))
    const savedMask = mask
      ? await this.assets.persist(project.id, workflowId('mask', project.id, operationId), 'mask', mask, operationId, now)
      : undefined
    const projectForOperation = savedMask && !project.assets.some(asset => asset.id === savedMask.asset.id)
      ? imageWorkbenchProjectSchema.parse({ ...project, assets: [...project.assets, savedMask.asset] })
      : project
    const assetHashes = [...new Set([
      source.kind === 'candidate' ? source.candidate.content_hash : source.verified.content_hash,
      ...providerReferences.map(reference => reference.content_hash),
      ...(savedMask?.asset.content_hash ? [savedMask.asset.content_hash as `sha256:${string}`] : []),
    ])]
    const taskId = id('task')
    const operation: ImageOperationV2 = {
      id: operationId,
      project_id: projectForOperation.id,
      owner: projectForOperation.owner,
      kind: input.kind,
      status: 'queued',
      progress: 0,
      stage: `等待提交${this.derivationSourceLabel(source)}派生`,
      idempotency_key: `bb-image-${requestHash.slice('sha256:'.length)}`,
      request_hash: requestHash,
      logical_attempt: 1,
      ...(source.kind === 'candidate' ? { base_candidate_id: source.candidate.id } : { base_version_id: source.version_id }),
      ...(savedMask ? { mask_asset_id: savedMask.asset.id } : {}),
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
      price_upper_bound: {
        currency: policy.price_upper_bound.currency,
        amount_minor: policy.price_upper_bound.per_output_amount_minor * IMAGE_PRODUCT_OUTPUT_COUNT,
        pricing_revision: policy.price_upper_bound.pricing_revision,
      },
      created_at: now,
      updated_at: now,
    }
    const transport = this.operation({
      schema_version: 1,
      id: taskId,
      project_id: projectForOperation.id,
      operation_id: operationId,
      owner: project.owner,
      kind: 'image.generate',
      status: 'queued',
      progress: 0,
      stage: `等待提交${this.derivationSourceLabel(source)}派生`,
      idempotency_key: operation.idempotency_key,
      image_operation: {
        kind: input.kind,
        ...(source.kind === 'candidate' ? { base_candidate_asset_id: source.asset.id } : { base_version_id: source.version_id }),
        ...(savedMask ? { mask_asset_id: savedMask.asset.id } : {}),
        instruction: `${this.providerPromptForDirection(brief, direction)}\n编辑要求：${input.instruction}`,
        model: policy.model_id,
        output_count: IMAGE_PRODUCT_OUTPUT_COUNT,
      },
      created_at: now,
      updated_at: now,
    })
    const round: ImageGenerationRound = {
      id: roundId,
      project_id: projectForOperation.id,
      creative_plan_id: plan.id,
      direction_operations: [{ direction_id: direction.id, operation_id: operation.id }],
      estimate_hash: estimate.estimate_hash,
      confirmed_at: now,
      created_at: now,
    }
    const persisted = await this.repository.createGenerationRoundWithOperations({
      project: projectForOperation,
      base_revision: input.base_revision,
      request_hash: derivationCommandHash,
      round,
      operations: [operation],
      transport_operations: [transport],
    })
    this.injectCrash('after_generation_round_persisted_before_post')
    // A cancellation may linearize after this derivation was durably accepted
    // but before this stack reaches its first POST. Re-read both records so a
    // stale derive call cannot revive an explicitly cancelled queued task.
    const currentOperation = await this.repository.getGenerationOperation(persisted.project.id, operation.id)
    const currentTransport = await this.repository.getOperation(transport.id)
    if (
      currentOperation.status !== 'queued'
      || currentTransport.status !== 'queued'
      || Boolean(currentTransport.remote_task_id)
      || Boolean(currentTransport.remote_submission_started_at)
    ) {
      return { round: persisted.round, operation: currentOperation }
    }
    return {
      round: persisted.round,
      operation: await this.submitGenerationTransport(persisted.project, currentOperation, currentTransport, policy.provider, policy.model_id),
    }
  }

  private async submitGenerationTransport(
    project: ImageWorkbenchProject,
    operation: ImageOperationV2,
    transport: ImageOperation,
    provider: string,
    modelId: ImageWorkbenchProject['model'],
  ): Promise<ImageOperationV2> {
    if (!productImageRelayConfigured()) {
      throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'IMAGE_RELAY_NOT_CONFIGURED')
    }
    // Build and verify the exact Provider payload before claiming a paid
    // submission. A missing CAS asset is a local, definitive failure and must
    // never leave the durable operation in submitted_charge_possible.
    const payload = await this.imageSubmissionPayload(project, transport)
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
    const claim = await this.repository.claimGenerationSubmission({
      operation,
      transport,
      submitted_at: submittedAt,
    })
    if (!claim.claimed) {
      return claim.operation
    }
    const refreshedTransport = await this.submitPersistedOperation(project, claim.transport, payload)
    const refusal = relayPolicyRefusal((refreshedTransport.result ?? {}) as RelayImageTask)
    await this.repository.saveExecutionReceipt({
      ...receipt,
      ...(refreshedTransport.remote_task_id ? { provider_request_id: refreshedTransport.remote_task_id } : {}),
      ...(refusal ? { refusal, completed_at: this.iso() } : {}),
    })
    return await this.syncGenerationOperationFromTransport(claim.operation, refreshedTransport)
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
    // A local Campaign cancellation is authoritative until a remote task id
    // exists. This also repairs records from an interrupted older writer that
    // happened to persist the formal cancellation before its transport row.
    const locallyCancelled = current.status === 'cancelled'
      && !transport.remote_task_id
    if (locallyCancelled) {
      if (transport.status !== 'cancelled') {
        const safe = mediaSafeError('MEDIA_IMAGE_CANCELLED')
        await this.repository.saveOperation(this.operation({
          ...transport,
          status: 'cancelled',
          progress: 0,
          stage: '已取消',
          error: safe.message,
          error_code: safe.code,
          outcome_unknown: false,
        }))
      }
      return current
    }
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
    const transportResult = imageGenerationTaskResultSchema.safeParse(transport.result)
    const partialOutcomeUnknown = (current.result?.kind === 'candidate_group' && current.result.partial_outcome_unknown === true)
      || (transportResult.success && transportResult.data.partial_outcome_unknown === true)
    // A Relay-declared hosted-quota refusal is definitive: the Relay did not
    // hand the task to a Provider, so retaining "charge possible" would make
    // a retry look like a potentially billable duplicate. A terminal failure
    // or queued cancellation without a remote receipt is equally definitive;
    // only a receipt or an unknown outcome keeps the recovery fence reserved.
    const definitivelyNotSubmitted = refusal
      || transport.error_code === 'MEDIA_IMAGE_QUOTA_EXHAUSTED'
      || ((transport.status === 'failed' || transport.status === 'cancelled')
        && !transport.outcome_unknown
        && !transport.provider_receipt_hash)
    return await this.repository.updateGenerationOperation({
      ...current,
      status,
      progress: transport.progress,
      stage: transport.stage,
      remote_task_id: transport.remote_task_id,
      cost_state: status === 'succeeded'
        ? partialOutcomeUnknown ? 'submitted_charge_possible' : 'usage_recorded'
        : definitivelyNotSubmitted ? 'not_submitted' : current.cost_state,
      ...(status === 'succeeded' || status === 'failed' || status === 'cancelled' || status === 'blocked_by_policy' || status === 'outcome_unknown'
        ? { completed_at: current.completed_at ?? this.iso() }
        : {}),
      ...(safeError ? { safe_error: safeError } : {}),
      updated_at: this.iso(),
    })
  }

  private async refreshGenerationOperation(projectId: string, operationId: string): Promise<ImageOperationV2> {
    const operation = await this.repository.getGenerationOperation(projectId, operationId)
    if (!operation.transport_task_id) return operation
    const storedTransport = await this.repository.getOperation(operation.transport_task_id)
    const transport = (operation.status === 'outcome_unknown' && storedTransport.remote_task_id)
      || (operation.status === 'cancelled' && operation.cancellation?.late_result_policy === 'retain_as_unadopted' && storedTransport.remote_task_id)
      ? await this.refreshPersistedOperation(storedTransport)
      : await this.getOperation(operation.transport_task_id)
    return await this.syncGenerationOperationFromTransport(operation, transport)
  }

  /** A transport poll also advances the one Campaign attempt that owns it. */
  private async synchronizeCampaignAttemptForOperation(operation: ImageOperationV2): Promise<void> {
    const attempt = await this.repository.campaignAttemptForGenerationOperation(operation.id, STANDALONE_IMAGE_OWNER)
    if (!attempt) return
    const snapshot = await this.repository.getCampaign(attempt.campaign_id, STANDALONE_IMAGE_OWNER)
    const item = snapshot.items.find(candidate => candidate.id === attempt.item_id)
    if (!item || item.attempt !== attempt.attempt || item.project_id !== operation.project_id) return
    await this.synchronizeCampaignItem(attempt.campaign_id, item.id)
  }

  async getGenerationOperation(projectId: string, operationId: string): Promise<ImageOperationV2> {
    const operation = await this.refreshGenerationOperation(projectId, operationId)
    await this.synchronizeCampaignAttemptForOperation(operation)
    return operation
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
    const transport = await this.repository.getOperation(operation.transport_task_id)
    if (!transport.remote_task_id && !transport.remote_submission_started_at) {
      const local = await this.repository.cancelGenerationBeforeSubmission({
        project_id: operation.project_id,
        operation_id: operation.id,
        updated_at: this.iso(),
      })
      if (local.cancelled) return local.operation
      throw new ImageWorkbenchServiceError('图片操作在取消期间已开始执行', 409, 'IMAGE_OPERATION_NOT_CANCELLABLE')
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
    const requestHash = sha256({ candidate_id: candidateId, decision: input.decision, base_revision: input.base_revision })
    const now = this.iso()
    return await this.repository.decideCandidate({
      id: stableId('adopt', projectId, candidateId, input.idempotency_key, 'decision'),
      project_id: projectId,
      candidate_id: candidateId,
      decision: input.decision,
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      created_at: now,
    })
  }

  private initialCanvasRevision(input: {
    project: ImageWorkbenchProject
    delivery: ImageDeliverySpec
    artboard: ImageDeliverySpec['artboards'][number]
    candidate: ImageCandidate
    asset_id: string
    adoption: ImageCandidateAdoption
    created_at: string
  }): ImageCanvasRevision {
    const { artboard, candidate, adoption } = input
    const scale = adoption.placement.fit === 'cover'
      ? Math.max(artboard.width / candidate.width, artboard.height / candidate.height)
      : Math.min(artboard.width / candidate.width, artboard.height / candidate.height)
    const width = candidate.width * scale
    const height = candidate.height * scale
    const document: ImageCanvasDocument = {
      schema_version: 1,
      id: adoption.canvas_id,
      project_id: input.project.id,
      artboard_id: artboard.id,
      delivery_spec_id: input.delivery.id,
      delivery_spec_revision: input.delivery.revision,
      width: artboard.width,
      height: artboard.height,
      color_space: 'srgb',
      background: (artboard.output.format === 'png' || artboard.output.format === 'webp') && artboard.output.transparent
        ? { kind: 'transparent' }
        : { kind: 'solid', color: artboard.output.format === 'jpeg' ? artboard.output.background_color : '#ffffff' },
      layers: [{
        id: stableId('canvas', adoption.canvas_id, 'candidate-raster'),
        kind: 'raster',
        source_asset_id: input.asset_id,
        transform: {
          x: (artboard.width - width) * adoption.placement.focus_x,
          y: (artboard.height - height) * adoption.placement.focus_y,
          width,
          height,
          rotation_degrees: 0,
          scale_x: 1,
          scale_y: 1,
        },
        opacity: 1,
        blend_mode: 'normal',
        clip_to_artboard: true,
      }],
      created_at: input.created_at,
    }
    return {
      canvas_id: adoption.canvas_id,
      revision: 0,
      document_hash: sha256(document),
      document,
      created_at: input.created_at,
    }
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
      artboard_id: adoption.artboard_id,
      canvas_id: adoption.canvas_id,
      canvas_revision: adoption.canvas_revision,
      width: candidate.width,
      height: candidate.height,
      created_at: now,
    }))
    const canvases = adoptions.map(adoption => this.initialCanvasRevision({
      project,
      delivery,
      artboard: artboards.get(adoption.artboard_id)!,
      candidate,
      asset_id: asset.id,
      adoption,
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
      canvases,
    })
  }

  async getCanvas(projectId: string, canvasId: string, revision?: number): Promise<ImageCanvasRevision> {
    return await this.repository.getCanvasRevision(projectId, canvasId, revision)
  }

  async listCanvases(projectId: string): Promise<ImageCanvasRevision[]> {
    return await this.repository.listCanvasRevisions(projectId)
  }

  async createCanvas(projectId: string, raw: { artboard_id: string; base_revision: number; idempotency_key: string; background?: ImageCanvasDocument['background'] }): Promise<{ project: ImageWorkbenchProject; canvas: ImageCanvasRevision }> {
    const input = imageCanvasCreateInputSchema.parse(raw)
    const project = await this.project(projectId)
    const delivery = await this.ensureDeliverySpec(project)
    const artboard = delivery.artboards.find(candidate => candidate.id === input.artboard_id)
    if (!artboard) throw new ImageWorkbenchServiceError('画板不属于当前交付规格', 400, 'IMAGE_OPERATION_CORRUPT')
    const now = this.iso()
    const canvasId = stableId('canvas', projectId, input.artboard_id, 'blank-canvas')
    const document: ImageCanvasDocument = {
      schema_version: 1, id: canvasId, project_id: projectId, artboard_id: artboard.id,
      delivery_spec_id: delivery.id, delivery_spec_revision: delivery.revision,
      width: artboard.width, height: artboard.height, color_space: 'srgb',
      background: input.background ?? ((artboard.output.format === 'png' || artboard.output.format === 'webp') && artboard.output.transparent
        ? { kind: 'transparent' }
        : { kind: 'solid', color: artboard.output.format === 'jpeg' ? artboard.output.background_color : '#ffffff' }),
      layers: [], created_at: now,
    }
    const result = await this.repository.createCanvas({
      project_id: projectId, base_project_revision: input.base_revision, idempotency_key: input.idempotency_key,
      request_hash: sha256(input),
      canvas: { canvas_id: canvasId, revision: 0, document_hash: sha256(document), document, created_at: now },
    })
    return { project: result.project, canvas: result.canvas }
  }

  /** 15.3 application seam used by the owner-scoped Brand/Template editors. */
  async saveBrandKitRevision(revision: ImageBrandKitRevision): Promise<ImageBrandKitRevision> {
    if (revision.owner.kind !== STANDALONE_IMAGE_OWNER.kind || revision.owner.owner_id !== STANDALONE_IMAGE_OWNER.owner_id) {
      throw new ImageWorkbenchServiceError('品牌 revision 不属于当前本地工作台', 403, 'IMAGE_PROJECT_FORBIDDEN')
    }
    return await this.repository.saveBrandKitRevision(revision)
  }

  /** 15.3 application seam used by the owner-scoped Brand/Template editors. */
  async saveTemplateRevision(revision: ImageTemplateRevision): Promise<ImageTemplateRevision> {
    if (revision.owner.kind !== STANDALONE_IMAGE_OWNER.kind || revision.owner.owner_id !== STANDALONE_IMAGE_OWNER.owner_id) {
      throw new ImageWorkbenchServiceError('模板 revision 不属于当前本地工作台', 403, 'IMAGE_PROJECT_FORBIDDEN')
    }
    const brand = revision.brand_kit_id && revision.brand_kit_revision_id
      ? await this.repository.brandKitRevision(revision.brand_kit_id, revision.brand_kit_revision_id, revision.owner)
      : undefined
    const referencedAssets = this.flattenCanvasLayers(revision.blueprint.layers).flatMap(layer => {
      if (layer.kind === 'logo' || layer.kind === 'raster' || layer.kind === 'mask') return [layer.source_asset_id]
      return layer.kind === 'qrcode' && layer.source.kind === 'asset' ? [layer.source.asset_id] : []
    })
    if (referencedAssets.some(assetId => !brand?.logo_asset_ids.includes(assetId))) {
      throw new ImageWorkbenchServiceError('模板蓝图只能引用同一品牌的受控 Logo 或未绑定 Slot', 409, 'IMAGE_ASSET_NOT_FOUND')
    }
    return await this.repository.saveTemplateRevision(revision)
  }

  async createDeliverySpecRevision(projectId: string, raw: ImageDeliverySpecRevisionInput): Promise<{ project: ImageWorkbenchProject; spec: ImageDeliverySpec }> {
    const input = imageDeliverySpecRevisionInputSchema.parse(raw)
    const project = await this.project(projectId)
    const current = await this.ensureDeliverySpec(project)
    const spec: ImageDeliverySpec = {
      schema_version: 1,
      id: stableId('dsp', projectId, input.idempotency_key, String(current.revision + 1)),
      project_id: projectId,
      revision: current.revision + 1,
      purpose: input.purpose,
      artboards: input.artboards,
      created_at: this.iso(),
    }
    const result = await this.repository.createDeliverySpecRevision({
      project_id: projectId,
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: sha256({ base_revision: input.base_revision, purpose: input.purpose, artboards: input.artboards }),
      spec,
    })
    return { project: result.project, spec: result.spec }
  }

  private flattenCanvasLayers(layers: ImageCanvasDocument['layers']): ImageCanvasDocument['layers'] {
    return layers.flatMap(layer => layer.kind === 'group' ? this.flattenCanvasLayers(layer.children) : [layer])
  }

  private canvasCommandAssetIds(raw: unknown): string[] {
    const command = imageCanvasCommandInputSchema.parse(raw)
    const sourceIds = (layers: ImageCanvasDocument['layers']): string[] => this.flattenCanvasLayers(layers).flatMap(layer => {
      if (layer.kind === 'raster' || layer.kind === 'logo' || layer.kind === 'mask') return [layer.source_asset_id]
      return layer.kind === 'qrcode' && layer.source.kind === 'asset' ? [layer.source.asset_id] : []
    })
    if (command.kind === 'add_layer' || command.kind === 'replace_layer') return sourceIds([command.payload.layer])
    return []
  }

  private async assertCanvasCommandAsset(project: ImageWorkbenchProject, assetId: string): Promise<void> {
    // A locked Template/Brand revision authorizes its own application only.
    // A later direct add/replace remains a new Project write and therefore
    // needs a live grant addressed to that Project.
    await this.repository.assetForProjectInput(project.id, assetId)
  }

  private async canvasInputAssets(project: ImageWorkbenchProject, document: ImageCanvasDocument): Promise<Array<{ id: string; verified: VerifiedImageBytes }>> {
    const assetIds = new Set<string>()
    for (const layer of this.flattenCanvasLayers(document.layers)) {
      if (layer.kind === 'raster' || layer.kind === 'logo' || layer.kind === 'mask') assetIds.add(layer.source_asset_id)
      if (layer.kind === 'qrcode' && layer.source.kind === 'asset') assetIds.add(layer.source.asset_id)
    }
    const assets: Array<{ id: string; verified: VerifiedImageBytes }> = []
    for (const assetId of assetIds) {
      // New commands prove a grant before the Canvas revision is persisted.
      // Historical canvases deliberately retain that resolved source so a later
      // revoke/trash does not make an accepted render or export unrecoverable.
      const asset = project.assets.find(candidate => candidate.id === assetId) ?? await this.repository.getWorkflowAsset(assetId)
      if (!asset) throw new ImageWorkbenchServiceError('画布引用的素材不存在', 409, 'IMAGE_ASSET_NOT_FOUND')
      assets.push({ id: assetId, verified: await this.assets.readVerified(asset) })
    }
    return assets
  }

  async preflightCanvas(projectId: string, canvasId: string, raw: ImageCanvasPreflightInput): Promise<ImageCanvasPreflight> {
    const input = imageCanvasPreflightInputSchema.parse(raw)
    const [project, canvas] = await Promise.all([this.project(projectId), this.repository.getCanvasRevision(projectId, canvasId, input.revision)])
    const delivery = await this.repository.getDeliverySpecRevision(projectId, canvas.document.delivery_spec_id, canvas.document.delivery_spec_revision)
    const artboard = delivery.artboards.find(candidate => candidate.id === canvas.document.artboard_id)
    if (!artboard) throw new ImageWorkbenchServiceError('画布引用的交付规格没有对应画板', 409, 'IMAGE_OPERATION_CORRUPT')
    const checks: ImageCanvasPreflight['checks'] = []
    checks.push({
      id: 'artboard-dimensions', status: canvas.document.width === artboard.width && canvas.document.height === artboard.height ? 'pass' : 'fail',
      evidence: `canvas=${canvas.document.width}x${canvas.document.height};delivery=${artboard.width}x${artboard.height}`, waivable: false,
    })
    try {
      await this.canvasInputAssets(project, canvas.document)
      checks.push({ id: 'dependency-assets', status: 'pass', evidence: '全部引用素材通过 CAS 内容校验', waivable: false })
    } catch (error) {
      checks.push({ id: 'dependency-assets', status: 'fail', evidence: error instanceof Error ? error.message.slice(0, 500) : '素材校验失败', waivable: false })
    }
    const textLayers = this.flattenCanvasLayers(canvas.document.layers).filter((layer): layer is Extract<typeof layer, { kind: 'text' }> => layer.kind === 'text')
    const brief = await this.repository.latestGenerationBrief(projectId)
    const missingExact = (brief?.exact_text ?? []).filter(requirement => requirement.required && !textLayers.some(layer => layer.text === requirement.text && layer.requirement_id === requirement.id))
    checks.push({
      id: 'exact-text', status: missingExact.length === 0 ? 'pass' : 'fail',
      evidence: missingExact.length === 0 ? '所有必需精确文字已绑定到正式文本图层' : `缺少精确文字：${missingExact.map(item => item.id).join(',')}`,
      waivable: false,
    })
    const textFrames = new Map<string, Awaited<ReturnType<typeof renderedTextBounds>>>()
    let invalidGlyph = false
    try {
      for (const layer of textLayers) {
        assertFormalTextLayer(layer)
        assertDeterministicTextLayout(layer)
        textFrames.set(layer.id, await renderedTextBounds(layer))
      }
    } catch { invalidGlyph = true }
    const invalidText = textLayers.find(layer => {
      const frame = textFrames.get(layer.id)
      return layer.overflow === 'clip' || !frame || frame.left < 0 || frame.top < 0
        || frame.right > canvas.document.width || frame.bottom > canvas.document.height
        || layer.font_asset_id !== 'font_builtin_0001'
    })
    checks.push({
      id: 'font-and-text-bounds', status: invalidText || invalidGlyph ? 'fail' : 'pass',
      evidence: invalidText || invalidGlyph ? '正式文字必须使用受控字体、具备全部字形且不得裁切或越界' : '正式文字字体、字形、边界和溢出策略有效', waivable: false,
    })
    const canvasLayers = this.flattenCanvasLayers(canvas.document.layers)
    const hasBrandToken = (canvas.document.background.kind === 'solid' && canvas.document.background.color.startsWith('brand.'))
      || canvasLayers.some(layer => (layer.kind === 'text' || layer.kind === 'shape')
        && [layer.fill, layer.stroke].some(color => color?.startsWith('brand.')))
    if (!canvas.document.brand_kit_revision_id && hasBrandToken) {
      checks.push({ id: 'brand-revision', status: 'fail', waivable: false, evidence: '画布使用 brand.* 色彩 Token，但未锁定品牌 revision' })
    } else if (canvas.document.brand_kit_revision_id) {
      try {
        const brand = await this.repository.brandKitRevisionById(canvas.document.brand_kit_revision_id, project.owner)
        const layers = canvasLayers
        const requiredText = brand.required_text.filter(item => !textLayers.some(layer => layer.text === item.value))
        const requiredLogos = brand.logo_asset_ids.filter(assetId => !layers.some(layer => layer.kind === 'logo' && layer.source_asset_id === assetId))
        const invalidBrandFonts = brand.font_asset_ids.length > 0 && textLayers.some(layer => !brand.font_asset_ids.includes(layer.font_asset_id))
        const unresolvedBackground = canvas.document.background.kind === 'solid'
          && canvas.document.background.color.startsWith('brand.')
          && !brand.color_tokens[canvas.document.background.color.slice('brand.'.length)]
        const unresolvedColors = unresolvedBackground || layers.some(layer => (layer.kind === 'text' || layer.kind === 'shape')
          && [layer.fill, layer.stroke].some(color => color?.startsWith('brand.') && !brand.color_tokens[color.slice('brand.'.length)]))
        const failed = requiredText.length > 0 || requiredLogos.length > 0 || invalidBrandFonts || unresolvedColors
        checks.push({
          id: 'brand-revision', status: failed ? 'fail' : 'pass', waivable: false,
          evidence: failed ? `品牌约束未满足：文字=${requiredText.map(item => item.id).join(',') || '无'}；Logo=${requiredLogos.join(',') || '无'}；字体=${invalidBrandFonts ? '不匹配' : '匹配'}；色彩=${unresolvedColors ? 'Token 未定义' : '有效'}` : `已锁定并满足品牌 revision ${brand.id}`,
        })
      } catch (error) {
        checks.push({ id: 'brand-revision', status: 'fail', waivable: false, evidence: error instanceof Error ? error.message.slice(0, 500) : '品牌 revision 无效' })
      }
    }
    const safe = artboard.safe_area
    if (safe) {
      const protectedLayers = this.flattenCanvasLayers(canvas.document.layers).filter((layer): layer is Extract<ImageCanvasDocument['layers'][number], { kind: 'text' | 'logo' | 'qrcode' }> => layer.kind === 'text' || layer.kind === 'logo' || layer.kind === 'qrcode')
      const protectedFrames = await Promise.all(protectedLayers.map(async layer => ({
        id: layer.id,
        // A failed font/layout check must make preflight fail rather than
        // throw while attempting a second layout for the safe-area evidence.
        frame: layer.kind === 'text' ? textFrames.get(layer.id) : await renderedTransformBounds(layer.transform),
      })))
      const outside = protectedFrames.filter(({ frame }) => !frame || frame.left < safe.left || frame.top < safe.top
        || frame.right > canvas.document.width - safe.right || frame.bottom > canvas.document.height - safe.bottom)
      const evidence = outside.length > 0
        ? `必填文字、Logo 或二维码越过交付安全区：${outside.map(({ id, frame }) => frame ? `${id}=${frame.left},${frame.top},${frame.width}×${frame.height}` : `${id}=文字布局无效`).join('；')}`
        : '文字、Logo 与二维码均位于交付安全区内'
      checks.push({ id: 'required-safe-area', status: outside.length > 0 ? 'fail' : 'pass', evidence, waivable: false })
    }
    const qrLayers = this.flattenCanvasLayers(canvas.document.layers).filter(layer => layer.kind === 'qrcode')
    checks.push({ id: 'qr-verification', status: qrLayers.every(layer => layer.verify_after_render) ? 'pass' : 'fail', evidence: '二维码层将在正式像素输出后再次解码', waivable: false })
    const preflight: ImageCanvasPreflight = {
      id: stableId('receipt', projectId, canvasId, String(canvas.revision), 'preflight'),
      project_id: projectId,
      canvas_id: canvasId,
      canvas_revision: canvas.revision,
      document_hash: canvas.document_hash,
      passed: checks.every(check => check.status !== 'fail'),
      checks,
      created_at: this.iso(),
    }
    return await this.repository.saveCanvasPreflight(preflight)
  }

  private async executeCanvasRender(
    projectId: string,
    canvasId: string,
    raw: ImageCanvasRenderInput,
    requestedExpectedCurrentVersionId: string | undefined,
  ): Promise<{ operation: ImageOperationV2; version_id: string; render_receipt: ImageRenderReceipt; release_check: ImageReleaseCheckResult }> {
    const input = imageCanvasRenderInputSchema.parse(raw)
    const preflight = await this.preflightCanvas(projectId, canvasId, { revision: input.canvas_revision })
    if (!preflight.passed) throw new ImageWorkbenchServiceError('画布预检未通过，不能生成正式版本', 409, 'IMAGE_CANVAS_PREFLIGHT_FAILED')
    const [project, canvas] = await Promise.all([this.project(projectId), this.repository.getCanvasRevision(projectId, canvasId, input.canvas_revision)])
    const delivery = await this.repository.getDeliverySpecRevision(projectId, canvas.document.delivery_spec_id, canvas.document.delivery_spec_revision)
    const artboard = delivery.artboards.find(candidate => candidate.id === canvas.document.artboard_id)
    if (!artboard) throw new ImageWorkbenchServiceError('交付画板不存在', 409, 'IMAGE_OPERATION_CORRUPT')
    let rendered
    try {
      const brandColors = canvas.document.brand_kit_revision_id
        ? (await this.repository.brandKitRevisionById(canvas.document.brand_kit_revision_id, project.owner)).color_tokens
        : {}
      rendered = await this.canvasRenderer.render(canvas.document, await this.canvasInputAssets(project, canvas.document), brandColors)
    } catch (error) {
      if (error instanceof ImageCanvasRendererError) throw new ImageWorkbenchServiceError(error.message, 409, error.code)
      throw error
    }
    const verified = await this.assets.verify(rendered.bytes)
    if (verified.mime_type !== 'image/png' || verified.width !== artboard.width || verified.height !== artboard.height) {
      throw new ImageWorkbenchServiceError('后端渲染结果未满足交付画板规格', 500, 'IMAGE_DIMENSIONS_MISMATCH')
    }
    const versionId = stableId('ver', projectId, canvasId, String(canvas.revision), input.idempotency_key)
    const outputId = stableId('out', projectId, versionId, 'canvas-render')
    const now = this.iso()
    const persisted = await this.assets.persist(projectId, outputId, 'result', verified, versionId, now)
    this.injectCrash('after_canvas_render_cas_before_db_commit')
    const receipt: ImageRenderReceipt = {
      id: stableId('receipt', projectId, versionId, 'render'),
      version_id: versionId,
      canvas_id: canvasId,
      canvas_revision: canvas.revision,
      document_hash: canvas.document_hash,
      delivery_spec_id: delivery.id,
      delivery_spec_revision: delivery.revision,
      ...(canvas.document.brand_kit_revision_id ? { brand_kit_revision_id: canvas.document.brand_kit_revision_id } : {}),
      ...(canvas.document.template_revision_id ? { template_revision_id: canvas.document.template_revision_id } : {}),
      renderer_version: rendered.renderer_version,
      text_layout_engine_version: rendered.text_layout_engine_version,
      dependency_asset_hashes: rendered.dependency_hashes,
      font_asset_hashes: rendered.font_hashes,
      output_hash: verified.content_hash,
      text_manifest_hash: rendered.text_manifest_hash,
      text_layout_manifest: rendered.text_layout_manifest,
      qr_manifest: rendered.qr_manifest,
      created_at: now,
    }
    const releaseChecks = preflight.checks.map(check => ({
      id: check.id,
      name: check.id,
      status: check.status,
      waivable: check.waivable,
      evidence: check.evidence,
      evidence_hash: sha256(check.evidence),
    }))
    const releaseCheck: ImageReleaseCheckResult = {
      id: stableId('receipt', projectId, versionId, 'release'),
      project_id: projectId,
      version_id: versionId,
      export_asset_id: outputId,
      checks: [...releaseChecks, { id: 'canonical-png', name: 'canonical-png', status: 'pass', waivable: false, evidence: verified.content_hash, evidence_hash: sha256(verified.content_hash) }],
      accepted_warning_receipt_ids: [],
      passed: true,
      created_at: now,
    }
    const operation: ImageOperationV2 = {
      id: stableId('op', projectId, 'canvas-render', canvasId, String(canvas.revision), input.idempotency_key),
      project_id: projectId,
      owner: project.owner,
      kind: 'canvas_render',
      status: 'committing',
      progress: 90,
      stage: '正在保存画布渲染结果',
      idempotency_key: input.idempotency_key,
      request_hash: (() => {
        const { expected_current_version_id: _acceptancePointer, ...requestWithoutAcceptancePointer } = input
        return canvasRenderRequestHash(canvasId, {
          ...requestWithoutAcceptancePointer,
          ...(requestedExpectedCurrentVersionId ? { expected_current_version_id: requestedExpectedCurrentVersionId } : {}),
        })
      })(),
      logical_attempt: 1,
      input_refs: { project_revision: input.base_revision, delivery_spec_revision: delivery.revision, canvas_revision: canvas.revision, execution_policy_revision: 'local-canvas-v1', asset_hashes: rendered.dependency_hashes.slice(0, 16) },
      cost_state: 'not_submitted',
      local_delivery: {
        kind: 'canvas_render', canvas_id: canvasId, canvas_revision: canvas.revision,
        expected_current_version_id: input.expected_current_version_id,
        ...(requestedExpectedCurrentVersionId ? { requested_expected_current_version_id: requestedExpectedCurrentVersionId } : {}),
        expected_current_version_id_source: requestedExpectedCurrentVersionId ? 'client' : 'acceptance',
        activate_on_success: input.activate_on_success,
      },
      created_at: now,
      updated_at: now,
    }
    const committed = await this.repository.commitCanvasRender({
      project_id: projectId,
      artboard_id: artboard.id,
      expected_current_version_id: input.expected_current_version_id,
      expected_canvas_current_revision: canvas.revision,
      activate_on_success: input.activate_on_success,
      operation,
      asset: persisted.asset,
      version: {
        id: versionId, project_revision: project.revision + 1, asset_ids: [outputId], kind: 'canvas',
        artboard_id: artboard.id, canvas_id: canvasId, canvas_revision: canvas.revision, canvas_document_hash: canvas.document_hash,
        render_receipt_id: receipt.id, content_hash: verified.content_hash, width: verified.width, height: verified.height, created_at: now,
      },
      receipt,
      release_check: releaseCheck,
    })
    return { operation: committed.operation, version_id: committed.version.id, render_receipt: receipt, release_check: releaseCheck }
  }

  /** Persist first and let the durable operation own local rendering.  A
   * renderer/HTTP disconnect therefore never needs the client to retry an
   * arbitrary Canvas write after pixels have reached CAS. */
  async renderCanvas(projectId: string, canvasId: string, raw: ImageCanvasRenderInput): Promise<{ operation: ImageOperationV2; version_id?: string; render_receipt?: ImageRenderReceipt; release_check?: ImageReleaseCheckResult }> {
    const input = imageCanvasRenderInputSchema.parse(raw)
    const requestHash = canvasRenderRequestHash(canvasId, input)
    const existing = await this.repository.findGenerationOperationByIdempotency(projectId, input.idempotency_key)
    if (existing) {
      if (existing.kind !== 'canvas_render' || existing.request_hash !== requestHash) {
        throw new ImageWorkbenchServiceError('画布渲染幂等键对应的请求内容不一致', 409, 'IMAGE_IDEMPOTENCY_CONFLICT')
      }
      if (existing.status === 'queued') {
        queueMicrotask(() => { void this.resumeLocalCanvasRender(existing) })
      }
      return { operation: existing }
    }
    const project = await this.project(projectId)
    if (project.revision !== input.base_revision) {
      throw new ImageWorkbenchServiceError('图片项目已更新，请刷新画布后重试', 409, 'IMAGE_REVISION_CONFLICT')
    }
    const preflight = await this.preflightCanvas(projectId, canvasId, { revision: input.canvas_revision })
    if (!preflight.passed) throw new ImageWorkbenchServiceError('画布预检未通过，不能生成正式版本', 409, 'IMAGE_CANVAS_PREFLIGHT_FAILED')
    const canvas = await this.repository.getCanvasRevision(projectId, canvasId, input.canvas_revision)
    const delivery = await this.repository.getDeliverySpecRevision(projectId, canvas.document.delivery_spec_id, canvas.document.delivery_spec_revision)
    // If the caller does not supply an explicit compare-and-swap pointer, the
    // request is still conditional: snapshot the pointer at acceptance. This
    // permits normal revision activation but never lets late pixels replace a
    // newer selection.
    const expectedCurrentVersionId = input.expected_current_version_id ?? project.current_versions_by_artboard[canvas.document.artboard_id]
    const operation: ImageOperationV2 = {
      id: stableId('op', projectId, 'canvas-render', canvasId, String(canvas.revision), input.idempotency_key),
      project_id: projectId, owner: project.owner, kind: 'canvas_render', status: 'queued', progress: 0, stage: '等待画布渲染',
      idempotency_key: input.idempotency_key, request_hash: requestHash, logical_attempt: 1,
      input_refs: { project_revision: input.base_revision, delivery_spec_revision: delivery.revision, canvas_revision: canvas.revision, execution_policy_revision: 'local-canvas-v1', asset_hashes: [] },
      cost_state: 'not_submitted',
      local_delivery: {
        kind: 'canvas_render', canvas_id: canvasId, canvas_revision: canvas.revision,
        ...(expectedCurrentVersionId ? { expected_current_version_id: expectedCurrentVersionId } : {}),
        ...(input.expected_current_version_id ? { requested_expected_current_version_id: input.expected_current_version_id } : {}),
        expected_current_version_id_source: input.expected_current_version_id ? 'client' : 'acceptance',
        activate_on_success: input.activate_on_success,
      },
      created_at: this.iso(), updated_at: this.iso(),
    }
    const queued = await this.repository.saveGenerationOperation(operation)
    if (queued.status === 'queued') {
      queueMicrotask(() => { void this.resumeLocalCanvasRender(queued) })
    }
    return { operation: queued }
  }

  private async executeExportDelivery(projectId: string, raw: ImageExportInput): Promise<{ operation: ImageOperationV2; export_receipts: ImageExportReceipt[]; delivery_set?: ImageDeliverySet; project_revision: number }> {
    const input = imageExportInputSchema.parse(raw)
    const project = await this.project(projectId)
    const accepted = await this.repository.findGenerationOperationByIdempotency(projectId, input.idempotency_key)
    const frozenDelivery = accepted?.local_delivery?.kind === 'export'
      && accepted.local_delivery.delivery_spec_id
      && accepted.local_delivery.delivery_spec_revision !== undefined
      ? await this.repository.getDeliverySpecRevision(
        projectId,
        accepted.local_delivery.delivery_spec_id,
        accepted.local_delivery.delivery_spec_revision,
      )
      : undefined
    // Export acceptance freezes both the Version map and delivery geometry.
    // Recovery must never silently switch to a newer format/size after a
    // project edit or process restart.
    const delivery = frozenDelivery ?? await this.ensureDeliverySpec(project)
    const requested = Object.entries(input.version_ids_by_artboard)
    if (requested.length === 0) throw new ImageWorkbenchServiceError('导出至少需要一个画板版本', 400, 'IMAGE_OPERATION_CORRUPT')
    const now = this.iso()
    const assets: MediaAsset[] = []
    const receipts: ImageExportReceipt[] = []
    for (const [artboardId, versionId] of requested) {
      const artboard = delivery.artboards.find(candidate => candidate.id === artboardId)
      if (!artboard) throw new ImageWorkbenchServiceError('导出包含不属于当前规格的画板', 400, 'IMAGE_OPERATION_CORRUPT')
      const { version, asset, verified } = await this.imageVersionBytes(project, versionId)
      if (version.kind !== 'canvas' || version.artboard_id !== artboardId || verified.width !== artboard.width || verified.height !== artboard.height) {
        throw new ImageWorkbenchServiceError('导出版本不是该画板的正式渲染版本', 409, 'IMAGE_VERSION_INVALID')
      }
      const release = version.render_receipt_id ? await this.repository.getReleaseCheckResult(projectId, stableId('receipt', projectId, versionId, 'release')) : null
      if (!release?.passed) throw new ImageWorkbenchServiceError('版本未通过发布检查', 409, 'IMAGE_RELEASE_CHECK_FAILED')
      const encoder = sharp(verified.bytes)
      const encoded = artboard.output.format === 'png'
        ? await encoder.png({ compressionLevel: 9, adaptiveFiltering: false, palette: false }).toBuffer()
        : artboard.output.format === 'jpeg'
          ? await encoder.flatten({ background: artboard.output.background_color }).jpeg({ quality: artboard.output.quality, chromaSubsampling: '4:4:4' }).toBuffer()
          : await encoder.webp({ quality: artboard.output.quality, alphaQuality: 100 }).toBuffer()
      const output = await this.assets.verify(encoded)
      if (output.width !== artboard.width || output.height !== artboard.height) throw new ImageWorkbenchServiceError('导出后的图片尺寸不一致', 500, 'IMAGE_DIMENSIONS_MISMATCH')
      const renderReceipt = version.render_receipt_id
        ? await this.repository.getRenderReceipt(projectId, version.render_receipt_id)
        : null
      if (!renderReceipt) throw new ImageWorkbenchServiceError('导出版本缺少正式渲染收据', 409, 'IMAGE_RELEASE_CHECK_FAILED')
      try {
        await verifyRenderedQrManifest(encoded, renderReceipt.qr_manifest)
      } catch (error) {
        if (error instanceof ImageCanvasRendererError) throw new ImageWorkbenchServiceError(error.message, 409, error.code)
        throw error
      }
      const outputId = stableId('out', projectId, versionId, input.idempotency_key, artboardId, artboard.output.format)
      const persisted = await this.assets.persist(projectId, outputId, 'export', output, versionId, now)
      await this.assets.readVerified(persisted.asset)
      assets.push(persisted.asset)
      receipts.push({
        id: stableId('receipt', projectId, outputId, 'export'), project_id: projectId, artboard_id: artboardId, version_id: versionId,
        source_hash: asset.content_hash!, output_asset_id: outputId, output_format: artboard.output.format, output_hash: output.content_hash,
        width: output.width, height: output.height, byte_size: output.bytes.byteLength, release_check_result_id: release.id, created_at: now,
      })
    }
    const requiredArtboards = delivery.artboards.filter(artboard => artboard.required).map(artboard => artboard.id)
    const deliverySet = requiredArtboards.every(artboardId => input.version_ids_by_artboard[artboardId])
      ? {
          id: stableId('dsp', projectId, input.idempotency_key, 'delivery-set'), project_id: projectId, delivery_spec_id: delivery.id, delivery_spec_revision: delivery.revision,
          version_ids_by_artboard: input.version_ids_by_artboard, export_receipt_ids_by_artboard: Object.fromEntries(receipts.map(receipt => [receipt.artboard_id, receipt.id])), created_at: now,
        } satisfies ImageDeliverySet
      : undefined
    const operation: ImageOperationV2 = {
      id: stableId('op', projectId, 'export', input.idempotency_key), project_id: projectId, owner: project.owner, kind: 'export', status: 'committing', progress: 90, stage: '正在编码导出',
      idempotency_key: input.idempotency_key, request_hash: sha256(input), logical_attempt: 1,
      input_refs: { project_revision: input.base_revision, delivery_spec_revision: delivery.revision, execution_policy_revision: 'local-export-v1', asset_hashes: receipts.map(receipt => receipt.source_hash).slice(0, 16) },
      cost_state: 'not_submitted', created_at: now, updated_at: now,
      local_delivery: {
        kind: 'export',
        version_ids_by_artboard: input.version_ids_by_artboard,
        delivery_spec_id: delivery.id,
        delivery_spec_revision: delivery.revision,
      },
    }
    this.injectCrash('after_export_cas_before_db_commit')
    const committed = await this.repository.commitExport({ project_id: projectId, operation, assets, export_receipts: receipts, delivery_set: deliverySet })
    return { operation: committed.operation, export_receipts: receipts, ...(deliverySet ? { delivery_set: deliverySet } : {}), project_revision: committed.project.revision }
  }

  /** Local delivery failures caused by a rejected Canvas/Export contract are
   * terminal.  Only infrastructure failures remain queued for crash recovery. */
  private runLocalDelivery(operationId: string, work: () => Promise<unknown>): Promise<void> {
    const active = this.activeLocalDeliveries.get(operationId)
    if (active) return active
    const running = this.performLocalDelivery(operationId, work).finally(() => {
      if (this.activeLocalDeliveries.get(operationId) === running) this.activeLocalDeliveries.delete(operationId)
    })
    this.activeLocalDeliveries.set(operationId, running)
    return running
  }

  /** Replays a Canvas operation from its accepted durable snapshot.  The
   * caller's retry payload is intentionally not used here: acceptance may
   * have captured a current-version pointer that is no longer in the retry
   * request or in the live Project projection. */
  private async resumeLocalCanvasRender(operation: ImageOperationV2): Promise<void> {
    const local = operation.local_delivery
    if (!local || local.kind !== 'canvas_render') return
    await this.runLocalDelivery(operation.id, async () => {
      await this.executeCanvasRender(operation.project_id, local.canvas_id, {
        base_revision: operation.input_refs.project_revision,
        idempotency_key: operation.idempotency_key,
        canvas_revision: local.canvas_revision,
        ...(local.expected_current_version_id ? { expected_current_version_id: local.expected_current_version_id } : {}),
        activate_on_success: local.activate_on_success,
      }, local.expected_current_version_id_source === 'acceptance'
        ? undefined
        : local.requested_expected_current_version_id ?? local.expected_current_version_id)
    })
  }

  private async performLocalDelivery(operationId: string, work: () => Promise<unknown>): Promise<void> {
    const current = await this.repository.findGenerationOperation(operationId)
    if (!current || ['succeeded', 'failed', 'cancelled'].includes(current.status)) return
    try {
      await work()
    } catch (error) {
      if (!(error instanceof ImageWorkbenchServiceError) || error.status >= 500) return
      const operation = await this.repository.findGenerationOperation(operationId)
      if (!operation || ['succeeded', 'failed', 'cancelled'].includes(operation.status)) return
      await this.repository.updateGenerationOperation({
        ...operation,
        status: 'failed',
        safe_error: { code: error.code, message: error.message },
        completed_at: this.iso(),
        updated_at: this.iso(),
      })
    }
  }

  async selectArtboardVersion(projectId: string, artboardId: string, raw: { base_revision: number; idempotency_key: string; version_id: string }): Promise<ImageWorkbenchProject> {
    const input = imageArtboardSelectVersionInputSchema.parse(raw)
    const project = await this.project(projectId)
    const version = project.versions.find(candidate => candidate.id === input.version_id)
    if (!version || version.artboard_id !== artboardId || version.kind !== 'canvas') {
      throw new ImageWorkbenchServiceError('版本不属于当前画板或不是正式渲染版本', 409, 'IMAGE_VERSION_INVALID')
    }
    await this.imageVersionBytes(project, version.id)
    return (await this.repository.selectArtboardVersion({
      project_id: projectId, artboard_id: artboardId, base_revision: input.base_revision, idempotency_key: input.idempotency_key,
      request_hash: sha256({ artboard_id: artboardId, ...input }), version_id: input.version_id,
    })).project
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
    // 15.3 makes the backend renderer the only formal-version pixel writer.
    // Retain the implementation below only as historical migration context;
    // no caller may promote a Renderer-supplied PNG through this path.
    throw new ImageWorkbenchServiceError('正式图片版本必须通过画布后端渲染生成', 410, 'IMAGE_LEGACY_RENDER_FORBIDDEN')
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
    saveImageOutputInputSchema.parse(raw)
    // A Sidecar is never allowed to resolve a Renderer-supplied destination.
    // Electron Main consumes the one-shot opaque grant and copies bytes through
    // its authenticated media channel.  Keep this former HTTP writer closed so
    // a future caller cannot accidentally reintroduce path authority here.
    throw new ImageWorkbenchServiceError('导出目标只能由桌面端不透明授权处理', 403, 'IMAGE_DESTINATION_GRANT_REQUIRED')
  }

  /**
   * Resolve and re-verify image bytes for the HTTP adapter. The application
   * layer returns a domain byte descriptor; only the API boundary constructs
   * a `Response`, so the image runtime remains transport-neutral.
   */
  async readMediaAsset(projectId: string, assetId: string, role: 'reference' | 'mask' | 'result' | 'export'): Promise<VerifiedImageBytes> {
    const project = await this.project(projectId)
    const asset = project.assets.find(candidate => candidate.id === assetId && candidate.role === role)
    if (!asset?.mime_type || !isSupportedImageMime(asset.mime_type)) {
      throw new ImageWorkbenchServiceError('图片资产不存在', 404, 'IMAGE_ASSET_NOT_FOUND')
    }
    return await this.assets.readVerified(asset)
  }

  async readVersionAsset(projectId: string, versionId: string): Promise<VerifiedImageBytes> {
    const project = await this.project(projectId)
    const { asset } = this.imageVersion(project, versionId)
    return await this.readMediaAsset(projectId, asset.id, 'result')
  }

  async readCandidateAsset(projectId: string, candidateId: string): Promise<VerifiedImageBytes> {
    const candidate = await this.repository.getCandidate(projectId, candidateId)
    return await this.readMediaAsset(projectId, candidate.asset_id, 'result')
  }

  async getCandidate(projectId: string, candidateId: string): Promise<ImageCandidate> {
    return await this.repository.getCandidate(projectId, candidateId)
  }

  async currentDeliverySpec(projectId: string): Promise<ImageDeliverySpec | null> {
    return await this.repository.currentDeliverySpec(projectId)
  }

  async getDeliverySet(projectId: string, deliverySetId: string): Promise<ImageDeliverySet> {
    return await this.repository.getDeliverySet(projectId, deliverySetId)
  }

  async getExportReceipt(projectId: string, receiptId: string): Promise<ImageExportReceipt> {
    return await this.repository.getExportReceipt(projectId, receiptId)
  }

  async getOperation(operationId: string): Promise<ImageOperation> {
    let operation = await this.repository.getOperation(operationId)
    operation = await this.fenceInterruptedSubmission(operation)
    // A lost submit response is not a reason to create another paid task.
    // Reconcile the original idempotency key before exposing the unknown state
    // to callers; only a durable Relay task/receipt may advance this operation.
    if (operation.outcome_unknown && !operation.remote_task_id) {
      operation = await this.recoverOutcomeUnknownOperation(operation)
    }
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
    if (!project) return null
    const transportCandidates: ImageOperation[] = []
    if (project.task_id) {
      const legacy = await this.repository.getOperation(project.task_id).catch(() => null)
      if (legacy) transportCandidates.push(legacy)
    }
    const formal = await this.repository.listGenerationOperations(projectId)
    for (const operation of formal) {
      if (!operation.transport_task_id || !['queued', 'running', 'outcome_unknown'].includes(operation.status)) continue
      const transport = await this.repository.getOperation(operation.transport_task_id).catch(() => null)
      if (transport) transportCandidates.push(transport)
    }
    const active = transportCandidates.filter(operation => ['queued', 'running'].includes(operation.status))
    if (active.length === 0) return null
    return Math.min(...active.map(operation => {
      const interval = (operation.poll_after_seconds ?? (operation.status === 'running' ? 3 : 15)) * 1_000
      return Math.max(0, interval - Math.max(0, this.now().getTime() - Date.parse(operation.updated_at)))
    }))
  }

  private async refreshActiveRemoteOperation(projectId: string): Promise<void> {
    const project = await this.project(projectId).catch(() => null)
    if (!project) return
    if (project.task_id) {
      const operation = await this.repository.getOperation(project.task_id).catch(() => null)
      if (operation && ['queued', 'running'].includes(operation.status)) await this.getOperation(operation.id)
    }
    const formal = await this.repository.listGenerationOperations(projectId)
    for (const operation of formal) {
      if (!operation.transport_task_id || !['queued', 'running', 'outcome_unknown'].includes(operation.status)) continue
      await this.refreshGenerationOperation(projectId, operation.id).catch(() => undefined)
    }
  }

  private async fetchImageRelayJson(
    input: RequestInfo | URL,
    init: RequestInit,
    maxBytes = IMAGE_RELAY_CONTROL_JSON_MAX_BYTES,
  ): Promise<{
    response: Response
    body: RelayImageTask
  }> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('image relay response deadline exceeded'))
      }, this.imageResultTimeoutMs)
      ;(timer as unknown as { unref?: () => void }).unref?.()
    })
    const request = async () => {
      const response = await this.fetchImpl(input, { ...init, signal: controller.signal })
      const text = await readImageRelayResponseText(response, maxBytes, controller.signal)
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

  /** Bind every uploaded Project reference to the exact control facts selected for this paid operation. */
  private async providerReferenceInputs(
    project: ImageWorkbenchProject,
    references: ImageReferenceV2[],
    imageIndexOffset = 0,
  ): Promise<{
    images: string[]
    reference_controls: Array<{
      image_index: number
      role: ImageReferenceV2['role']
      influence_strength: ImageReferenceV2['influence_strength']
      preservation: ImageReferenceV2['preservation']
      priority: number
      label?: string
    }>
  }> {
    const assets = new Map(this.referenceAssets(project).map(asset => [asset.id, asset]))
    const images = await Promise.all(references.map(async reference => {
      const asset = assets.get(reference.asset_id)
      if (!asset) throw new ImageWorkbenchServiceError('图片参考素材已经丢失', 409, 'REFERENCE_IMAGE_MISSING')
      const verified = await this.assets.providerUpload(asset)
      return `data:${verified.mime_type};base64,${verified.bytes.toString('base64')}`
    }))
    return {
      images,
      reference_controls: references.map((reference, index) => ({
        image_index: imageIndexOffset + index,
        role: reference.role,
        influence_strength: reference.influence_strength,
        preservation: reference.preservation,
        priority: reference.priority,
        ...(reference.label ? { label: reference.label } : {}),
      })),
    }
  }

  private async imageSubmissionPayload(project: ImageWorkbenchProject, operation: ImageOperation): Promise<Record<string, unknown>> {
    const imageOperation = operation.image_operation
    if (imageOperation.kind === 'generate') {
      const references = await this.providerReferenceInputs(project, this.providerReferences(this.generationReferences(project)))
      return {
        mode: references.images.length > 0 ? 'edit' : 'generate',
        model: imageOperation.model,
        prompt: imageOperation.instruction ?? project.prompt,
        n: imageOperation.output_count,
        size: project.size,
        ...(imageOperation.model === 'doubao-seedream-4-5-251128' ? { response_format: 'b64_json' } : {}),
        ...(references.images.length > 0 ? { images: references.images, reference_controls: references.reference_controls } : {}),
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
    const references = await this.providerReferenceInputs(project, this.providerReferences(this.generationReferences(project)), 1)
    return {
      mode: 'edit',
      model: imageOperation.model,
      prompt: imageOperation.instruction,
      n: imageOperation.output_count,
      size: project.size,
      ...(imageOperation.model === 'doubao-seedream-4-5-251128' ? { response_format: 'b64_json' } : {}),
      images: [`data:${providerBase.mime_type};base64,${providerBase.bytes.toString('base64')}`, ...references.images],
      ...(references.reference_controls.length > 0 ? { reference_controls: references.reference_controls } : {}),
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

  /**
   * A durable Round can exist before its first POST, and a process can die
   * after a POST begins without receiving the remote task id.  In both cases
   * the only lawful recovery is the original idempotency key; Image Relay either
   * returns the accepted task or treats it as the same logical submission.
   */
  private async reconcileCampaignReservationForOperation(
    operation: ImageOperation,
    generation: ImageOperationV2,
  ): Promise<ImageOperation> {
    const attempt = await this.repository.campaignAttemptForExpectedProject(operation.project_id, STANDALONE_IMAGE_OWNER)
    if (!attempt) return operation
    const snapshot = await this.repository.getCampaign(attempt.campaign_id, STANDALONE_IMAGE_OWNER)
    const item = snapshot.items.find(candidate => candidate.id === attempt.item_id)
    if (!item || item.attempt !== attempt.attempt) return operation
    const expectedRoundId = stableId('rnd', operation.project_id, this.campaignItemQuickCreateKey(snapshot.campaign, item))
    const round = await this.repository.generationRoundForOperation(operation.project_id, generation.id).catch(() => null)
    if (!round || round.id !== expectedRoundId) return operation
    const operations = await Promise.all(round.direction_operations.map(async direction =>
      await this.repository.getGenerationOperation(operation.project_id, direction.operation_id)))
    const exact = this.campaignRoundOperation(round, operations)
    if (attempt.state === 'cancelled') {
      await this.suppressUnpostedCampaignAttempt(attempt.campaign_id, attempt.item_id, attempt.attempt, exact)
      return await this.repository.getOperation(operation.id)
    }
    if (attempt.state !== 'reserved') return operation
    const bound = await this.bindCampaignItemProject(
      attempt.campaign_id,
      attempt.item_id,
      attempt.attempt,
      operation.project_id,
      round,
      exact,
    )
    if (bound.suppressed) {
      await this.suppressUnpostedCampaignAttempt(attempt.campaign_id, attempt.item_id, attempt.attempt, exact)
    }
    return await this.repository.getOperation(operation.id)
  }

  private async resumeUnpostedGenerationOperation(operation: ImageOperation, generation: ImageOperationV2): Promise<ImageOperation> {
    if (operation.remote_task_id || generation.status !== 'queued' || !generation.transport_task_id) return operation
    const neverPosted = operation.status === 'queued' && !operation.remote_submission_started_at
    // A remotely ambiguous operation is never safe to POST again, even when
    // its idempotency key is stable.  Recovery below asks Image Relay for the
    // existing owner-bound task; only a record which was durably created but
    // whose first POST never started may take its first submission here.
    if (!neverPosted) return operation
    const reconciled = await this.reconcileCampaignReservationForOperation(operation, generation)
    if (reconciled.status !== 'queued' || reconciled.remote_task_id || reconciled.remote_submission_started_at) return reconciled
    const currentGeneration = await this.repository.getGenerationOperation(operation.project_id, generation.id)
    if (currentGeneration.status !== 'queued') return reconciled
    if (!productImageRelayConfigured()) return operation
    const provider = providerRegistryEntry(operation.image_operation.model)
    if (!provider) throw new ImageWorkbenchServiceError('图片操作缺少已注册 Provider', 500, 'IMAGE_OPERATION_CORRUPT')
    await this.submitGenerationTransport(
      await this.project(operation.project_id),
      currentGeneration,
      operation,
      provider.provider,
      operation.image_operation.model,
    )
    return await this.repository.getOperation(operation.id)
  }

  /**
   * A timeout after the request leaves us unable to prove whether the provider
   * accepted paid work.  The relay lookup is deliberately read-only and bound
   * to the authenticated installation plus the original idempotency key.  A
   * 404 is not permission to submit again: it remains outcome_unknown until
   * an explicit user resolution path exists.
   */
  private async recoverOutcomeUnknownOperation(operation: ImageOperation): Promise<ImageOperation> {
    if (!operation.outcome_unknown || operation.remote_task_id || !operation.idempotency_key) return operation
    const target = productImageRelayTarget()
    if (!target) return operation
    try {
      const { response, body } = await this.fetchImageRelayJson(
        `${target.baseUrl}${imageRelayIdempotencyLookupPath(operation.idempotency_key)}`,
        { headers: { Authorization: `Bearer ${target.token}` } },
      )
      // No remotely confirmed record is still an unknown paid outcome. Never
      // turn a lookup miss into another POST.
      if (response.status === 404) return operation
      if (!response.ok || !body.task_id) return operation
      if (operation.provider_receipt_hash && body.provider_receipt_hash && operation.provider_receipt_hash !== body.provider_receipt_hash) {
        return await this.failOperation(operation, 'MEDIA_IMAGE_OUTCOME_UNKNOWN', true)
      }
      const restored = await this.repository.saveOperation(this.operation({
        ...operation,
        remote_task_id: body.task_id,
        provider_receipt_hash: body.provider_receipt_hash ?? operation.provider_receipt_hash,
        status: body.status === 'running' ? 'running' : 'queued',
        progress: body.status === 'running' ? Math.max(operation.progress, 10) : Math.max(operation.progress, 2),
        stage: '已确认上次图片任务',
        poll_after_seconds: relayPollAfterSeconds(body.poll_after_seconds, body.status === 'running' ? 3 : 15),
        outcome_unknown: false,
        error: undefined,
        error_code: undefined,
      }))
      // Once the same remote task is bound, ordinary status polling and result
      // recovery are safe.  This is a GET only; it cannot create paid work.
      return await this.refreshPersistedOperation(restored)
    } catch {
      return operation
    }
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
          // A legacy Version can contain the same reference asset IDs as the
          // generated result. Asset ownership is globally unique in SQLite,
          // so retain one verified CAS record per ID and let the Version keep
          // its historical asset_ids without inserting duplicate roles.
          const storedAssets = new Map<string, MediaAsset>()
          const legacyAssets = new Map(legacy.assets.map(asset => [asset.id, asset]))
          const legacyReferenceRoles = new Map(legacy.references.map(reference => [reference.asset_id, reference.role]))
          const importReference = async (assetId: string, role: ImageWorkbenchProject['references'][number]['role'], bytes: Buffer): Promise<void> => {
            if (seenReferenceIds.has(assetId)) return
            const verified = await this.assets.verify(bytes)
            const stored = await this.assets.persist(legacy.id, assetId, 'reference', verified, legacy.id, now)
            seenReferenceIds.add(assetId)
            storedAssets.set(assetId, stored.asset)
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
          const storedOutputs = new Set<string>()
          const importResult = async (
            assetId: string,
            version: ImageWorkbenchProject['versions'][number],
            output?: ImageWorkbenchProject['outputs'][number],
          ): Promise<void> => {
            let stored = storedAssets.get(assetId)
            if (!stored) {
              const asset = legacyAssets.get(assetId)
              const bytes = (asset ? await this.legacyAssetBytes(legacy.id, asset, legacyRoot) : null)
                ?? (output ? await this.legacyOutputBytes(legacy.id, output, legacyRoot) : null)
              if (!bytes) throw new ImageWorkbenchServiceError('旧图片版本缺少可验证字节，迁移未完成', 409, 'IMAGE_LEGACY_VERSION_INCOMPLETE')
              const verified = await this.assets.verify(bytes)
              stored = (await this.assets.persist(legacy.id, assetId, 'result', verified, version.id, version.created_at)).asset
              storedAssets.set(assetId, stored)
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
            if (storedAssets.has(asset.id)) continue
            const bytes = await this.legacyAssetBytes(legacy.id, asset, legacyRoot)
            if (!bytes) continue
            const verified = await this.assets.verify(bytes)
            const stored = (await this.assets.persist(legacy.id, asset.id, 'mask', verified, asset.version_id, asset.created_at)).asset
            storedAssets.set(asset.id, stored)
            assets.push(stored)
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

  private submitPersistedOperation(project: ImageWorkbenchProject, operation: ImageOperation, payload?: Record<string, unknown>): Promise<ImageOperation> {
    const active = this.activeSubmissions.get(operation.id)
    if (active) return active
    const submission = this.performSubmission(project, operation, payload)
      .finally(() => this.activeSubmissions.delete(operation.id))
    this.activeSubmissions.set(operation.id, submission)
    return submission
  }

  private async performSubmission(project: ImageWorkbenchProject, original: ImageOperation, preparedPayload?: Record<string, unknown>): Promise<ImageOperation> {
    if (!productImageRelayConfigured()) {
      throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'IMAGE_RELAY_NOT_CONFIGURED')
    }
    const idempotencyKey = original.idempotency_key
    if (!idempotencyKey) {
      throw new ImageWorkbenchServiceError('图片操作缺少幂等凭据', 500, 'IMAGE_OPERATION_CORRUPT')
    }
    const target = productImageRelayTarget()
    if (!target) throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'IMAGE_RELAY_NOT_CONFIGURED')
    const payload = preparedPayload ?? await this.imageSubmissionPayload(project, original)
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
      const { response, body } = await this.fetchImageRelayJson(`${target.baseUrl}${IMAGE_RELAY_TASKS_PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${target.token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
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
        const outcomeUnknown = response.status >= 500 || response.status === 0
        const failed = await this.failOperation(
          operation,
          outcomeUnknown ? 'MEDIA_IMAGE_OUTCOME_UNKNOWN' : imageRelayFailureCode(response.status, body),
          outcomeUnknown,
          body.provider_receipt_hash,
        )
        // A Relay 5xx can be returned after the durable task reservation (or
        // even after the Provider call) has happened. Treat it exactly like a
        // dropped response: reconcile the same idempotency key through a
        // read-only lookup, never create a new paid POST.
        return outcomeUnknown ? await this.recoverOutcomeUnknownOperation(failed) : failed
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
      const unknown = await this.failOperation(operation, 'MEDIA_IMAGE_OUTCOME_UNKNOWN', true)
      // The POST may have reached Relay even when its response did not. A
      // read-only idempotency lookup is the first recovery action; it can bind
      // the already-created task and continue polling, but it can never create
      // a second Provider request.
      return await this.recoverOutcomeUnknownOperation(unknown)
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
    const data: NonNullable<RelayImageTask['data']> = []
    // Direct candidates are intentionally fetched one at a time. A valid 32 MiB
    // image expands to ~43 MiB JSON; Promise.all would multiply that footprint.
    for (const url of trusted) {
      const result = await this.fetchImageRelayJson(url!, {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${target.token}`,
        },
      }, IMAGE_RELAY_DIRECT_RESULT_JSON_MAX_BYTES)
      if (!result.response.ok) throw new ImageWorkbenchServiceError(
        boundedMessage(result.body.error ?? result.body.message),
        result.response.status || 502,
        'IMAGE_RESULT_UNAVAILABLE',
      )
      data.push(...(result.body.data ?? []))
    }
    return { ...body, data }
  }

  private async acknowledgeGenerationRemoteResult(operation: ImageOperationV2, transport: ImageOperation): Promise<ImageOperation> {
    if (!transport.remote_task_id || !transport.provider_receipt_hash || transport.remote_result_acknowledged_at || !operation.result) return transport
    const target = productImageRelayTarget()
    if (!target) return transport
    try {
      const { response, body } = await this.fetchImageRelayJson(
        `${target.baseUrl}${IMAGE_RELAY_TASKS_PATH}/${encodeURIComponent(transport.remote_task_id)}/ack`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${target.token}`,
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
    const target = productImageRelayTarget()
    if (!target) return operation
    try {
      const { response, body } = await this.fetchImageRelayJson(
        `${target.baseUrl}${IMAGE_RELAY_TASKS_PATH}/${encodeURIComponent(operation.remote_task_id)}/ack`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${target.token}`,
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
    const invalidByIndex = new Map<number, string>()
    const addInvalid = (index: number, code: string) => {
      if (!Number.isInteger(index) || index < 0 || index >= expectedCount || invalidByIndex.has(index)) return
      invalidByIndex.set(index, /^[A-Z0-9_]{1,120}$/.test(code) ? code : 'IMAGE_RESULT_INVALID')
    }
    for (const item of body.invalid ?? []) addInvalid(item.index ?? -1, item.safe_error_code ?? 'IMAGE_RESULT_INVALID')
    const candidatesByIndex = new Map<number, NonNullable<RelayImageTask['data']>[number]>()
    for (let position = 0; position < rawCandidates.length; position += 1) {
      const remote = rawCandidates[position]!
      const index = Number.isInteger(remote.candidate_index) ? remote.candidate_index! : position
      if (index < 0 || index >= expectedCount || candidatesByIndex.has(index)) {
        addInvalid(Math.max(0, Math.min(expectedCount - 1, index)), 'IMAGE_RESULT_COUNT_INVALID')
        continue
      }
      candidatesByIndex.set(index, remote)
    }
    const saved: Array<{ candidate: ImageCandidate; asset: MediaAsset }> = []
    const groupId = stableId('grp', project.id, operation.id)
    const now = this.iso()
    for (let index = 0; index < expectedCount; index += 1) {
      const remote = candidatesByIndex.get(index)
      if (!remote?.b64_json || remote.url || !/^[A-Za-z0-9+/=]+$/.test(remote.b64_json)) {
        addInvalid(index, remote ? 'IMAGE_RESULT_INVALID' : 'IMAGE_RESULT_MISSING')
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
          addInvalid(index, error.code)
          continue
        }
        throw error
      }
    }
    // valid_count is aggregate Relay telemetry.  A local verification failure
    // cannot safely be attributed to another candidate index, so only the
    // per-candidate facts collected above may produce indexed invalid entries.
    const invalid = [...invalidByIndex.entries()]
      .map(([index, safe_error_code]) => ({ index, safe_error_code }))
      .sort((left, right) => left.index - right.index)
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
      ...(operation.base_version_id ? { base_version_id: operation.base_version_id } : {}),
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
        ...(body.partial_outcome_unknown ? { partial_outcome_unknown: true } : {}),
      },
      cost_state: body.partial_outcome_unknown ? 'submitted_charge_possible' : 'usage_recorded',
      completion_freshness: 'current',
      completed_at: now,
      updated_at: now,
    }
    const completedReceipt: ProviderExecutionReceipt = {
      ...receipt,
      output_asset_hashes: saved.map(item => item.candidate.content_hash),
      completed_at: now,
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
        result: {
          output_count: saved.length,
          outputs: [],
          ...(body.partial_outcome_unknown ? { partial_outcome_unknown: true } : {}),
        },
      }),
      operation: committingOperation,
      receipt: completedReceipt,
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
        result: imageGenerationTaskResultSchema.parse({
          output_count: persistedOutputs.length,
          outputs: persistedOutputs,
          ...(body.partial_outcome_unknown ? { partial_outcome_unknown: true } : {}),
        }),
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
      ...(body.partial_outcome_unknown ? { partial_outcome_unknown: true } : {}),
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
    if (!original.remote_task_id || !productImageRelayConfigured()) return original
    const target = productImageRelayTarget()
    if (!target) return original
    let response: Response
    let body: RelayImageTask
    try {
      const result = await this.fetchImageRelayJson(
        `${target.baseUrl}${IMAGE_RELAY_TASKS_PATH}/${encodeURIComponent(original.remote_task_id)}`,
        {
          headers: {
            Authorization: `Bearer ${target.token}`,
            [IMAGE_RELAY_RESULT_HANDOFF_HEADER]: IMAGE_RELAY_RESULT_HANDOFF_DIRECT_V1,
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
        imageRelayFailureCode(response.status, body),
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
        imageRelayFailureCode(response.status, body),
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
    const target = productImageRelayTarget()
    if (!target) {
      throw new ImageWorkbenchServiceError(mediaSafeError('MEDIA_IMAGE_CANCEL_UNKNOWN').message, 503, 'IMAGE_CANCEL_UNKNOWN')
    }
    try {
      const { response, body } = await this.fetchImageRelayJson(
        `${target.baseUrl}${IMAGE_RELAY_TASKS_PATH}/${encodeURIComponent(operation.remote_task_id)}/cancel`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${target.token}`,
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
    const existingRound = await this.repository.getGenerationRound(project.id, stableId('rnd', project.id, compatibilityKey)).catch(error => {
      if (error instanceof ImageWorkbenchRepositoryError && error.status === 404) return null
      throw error
    })
    if (existingRound) {
      const existingOperationId = existingRound.direction_operations[0]?.operation_id
      if (!existingOperationId) throw new ImageWorkbenchServiceError('兼容生成轮次缺少操作', 500, 'IMAGE_OPERATION_CORRUPT')
      const existingOperation = await this.repository.getGenerationOperation(project.id, existingOperationId)
      if (!existingOperation.transport_task_id) throw new ImageWorkbenchServiceError('兼容生成轮次缺少传输任务', 500, 'IMAGE_OPERATION_CORRUPT')
      return await this.repository.getOperation(existingOperation.transport_task_id)
    }
    const plan = await this.createCreativePlanForInternal(project.id, {
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
    if (!productImageRelayConfigured()) {
      throw new ImageWorkbenchServiceError('图片远程能力尚未配置', 503, 'IMAGE_RELAY_NOT_CONFIGURED')
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
        ...(maskAsset ? { mask_asset_id: maskAsset.id } : {}),
        model,
        output_count: IMAGE_PRODUCT_OUTPUT_COUNT,
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
