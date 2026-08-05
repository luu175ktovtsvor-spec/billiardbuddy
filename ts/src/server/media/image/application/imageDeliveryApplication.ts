import { createHash } from 'node:crypto'
import {
  imageExportInputSchema,
  type ImageDeliverySet,
  type ImageExportInput,
  type ImageExportReceipt,
  type ImageOperationV2,
} from '../../../../../shared/contracts/imageGeneration.js'
import { ImageApplication } from './imageApplication.js'
import type { ImageDeliveryApplicationPort } from '../runtime/imageApplicationPorts.js'
import type { ImageExportDeliveryRuntimePort } from '../../../services/imageWorkbenchRuntime.js'

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

function stableId(prefix: 'op', ...parts: string[]): string {
  return `${prefix}_${createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)}`
}

type ExportDeliveryResult = {
  operation: ImageOperationV2
  export_receipts?: ImageExportReceipt[]
  delivery_set?: ImageDeliverySet
  project_revision: number
}

/** Delivery specifications, immutable exports, Library reuse and Campaign orchestration. */
export class ImageDeliveryApplication extends ImageApplication<ImageDeliveryApplicationPort> {
  readonly #exportDelivery: ImageExportDeliveryRuntimePort

  readonly listProjectLibrary = this.bind('listProjectLibrary')
  readonly listCampaigns = this.bind('listCampaigns')
  readonly getCampaign = this.bind('getCampaign')
  readonly createCampaign = this.bind('createCampaign')
  readonly replaceCampaignItems = this.bind('replaceCampaignItems')
  readonly estimateCampaign = this.bind('estimateCampaign')
  readonly confirmCampaign = this.bind('confirmCampaign')
  readonly confirmCampaignRetry = this.bind('confirmCampaignRetry')
  readonly startCampaign = this.bind('startCampaign')
  readonly cancelCampaign = this.bind('cancelCampaign')
  readonly retryCampaignItem = this.bind('retryCampaignItem')
  readonly createDeliverySpecRevision = this.bind('createDeliverySpecRevision')
  readonly currentDeliverySpec = this.bind('currentDeliverySpec')
  readonly getDeliverySet = this.bind('getDeliverySet')
  readonly getExportReceipt = this.bind('getExportReceipt')
  readonly readMediaAsset = this.bind('readMediaAsset')
  readonly readVersionAsset = this.bind('readVersionAsset')
  /** Persist the accepted local Export before Runtime begins CAS/encoder work. */
  readonly exportDelivery = async (projectId: string, raw: ImageExportInput): Promise<ExportDeliveryResult> => {
    const input = imageExportInputSchema.parse(raw)
    const project = await this.#exportDelivery.loadProject(projectId)
    const requestHash = sha256(input)
    // An accepted Export is replayable even after its eventual DB commit has
    // advanced the Project revision. Check immutable command identity before
    // deciding whether a new command may use the caller's base revision.
    const replay = await this.#exportDelivery.findAccepted(projectId, input.idempotency_key, requestHash)
    if (replay) {
      if (replay.status === 'queued') {
        this.#exportDelivery.schedule({ projectId, input, operationId: replay.id })
      }
      return { operation: replay, project_revision: project.revision }
    }
    if (project.revision !== input.base_revision) throw this.#exportDelivery.revisionConflict()
    const operation: ImageOperationV2 = {
      id: stableId('op', projectId, 'export', input.idempotency_key),
      project_id: projectId,
      owner: project.owner,
      kind: 'export',
      status: 'queued',
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
      logical_attempt: 1,
      input_refs: {
        project_revision: input.base_revision,
        delivery_spec_revision: project.current_delivery_spec_revision,
        execution_policy_revision: 'local-export-v1',
        asset_hashes: [],
      },
      cost_state: 'not_submitted',
      local_delivery: { kind: 'export', version_ids_by_artboard: input.version_ids_by_artboard },
      created_at: this.#exportDelivery.iso(),
      updated_at: this.#exportDelivery.iso(),
    }
    const accepted = await this.#exportDelivery.accept({
      project_id: projectId,
      base_revision: input.base_revision,
      operation,
    })
    // A racing caller may miss the pre-read but lose the atomic acceptance
    // race. Its already-queued Operation belongs to the first caller, so do
    // not start a second encoder/CAS worker here.
    if (accepted.operation.status === 'queued' && !accepted.replayed) {
      this.#exportDelivery.schedule({ projectId, input, operationId: accepted.operation.id })
    }
    return { operation: accepted.operation, project_revision: accepted.project_revision }
  }
  readonly selectVersion = this.bind('selectVersion')
  readonly commitVersion = this.bind('commitVersion')
  readonly saveOutput = this.bind('saveOutput')

  constructor(port: ImageDeliveryApplicationPort) {
    super(port)
    this.#exportDelivery = port.exportDelivery
  }
}
