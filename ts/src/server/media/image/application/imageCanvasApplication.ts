import { createHash } from 'node:crypto'
import type { ImageWorkbenchProject } from '../../../../../shared/contracts/media.js'
import {
  imageCanvasCommandInputSchema,
  type ImageCanvasCommandInput,
  type ImageCanvasRevision,
} from '../../../../../shared/contracts/imageGeneration.js'
import { ImageApplication } from './imageApplication.js'
import type { ImageCanvasApplicationPort } from '../runtime/imageApplicationPorts.js'
import {
  ImageWorkbenchServiceError,
  type ImageCanvasCommandRuntimePort,
} from '../../../services/imageWorkbenchRuntime.js'

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

/**
 * Canvas writes are deliberately coordinated here rather than in the shared
 * runtime.  The narrow port's final write re-checks this exact command under
 * the per-project SQLite transaction, so a stale pre-read can never commit.
 */
async function applyCanvasCommand(
  port: ImageCanvasCommandRuntimePort,
  projectId: string,
  canvasId: string,
  baseProjectRevision: number,
  raw: ImageCanvasCommandInput,
): Promise<{ project: ImageWorkbenchProject; canvas: ImageCanvasRevision }> {
  const command = imageCanvasCommandInputSchema.parse(raw)
  const project = await port.loadProject(projectId)
  const requestHash = sha256({ canvas_id: canvasId, base_project_revision: baseProjectRevision, command })
  const replay = await port.canvasCommandResult({
    project_id: project.id,
    canvas_id: canvasId,
    idempotency_key: command.idempotency_key,
    request_hash: requestHash,
  })
  if (replay) return replay
  if (project.revision !== baseProjectRevision) {
    throw new ImageWorkbenchServiceError('图片项目已更新，请刷新画布后重试', 409, 'IMAGE_REVISION_CONFLICT')
  }

  const currentCanvas = command.kind === 'sync_delivery_spec'
    ? await port.getCanvasRevision(project.id, canvasId, command.base_revision)
    : undefined
  // The selected delivery revision pins the geometry passed to the atomic
  // write. Aggregate/grant authorization is re-read by Repository while that
  // same transaction is held.
  const deliveryArtboard = command.kind === 'sync_delivery_spec' && currentCanvas
    ? (await port.getDeliverySpecRevision(
        project.id,
        command.payload.delivery_spec_id,
        command.payload.delivery_spec_revision,
      )).artboards.find(artboard => artboard.id === currentCanvas.document.artboard_id)
    : undefined
  if (command.kind === 'sync_delivery_spec' && !deliveryArtboard) {
    throw new ImageWorkbenchServiceError('交付规格不包含当前画板，不能同步', 409, 'IMAGE_REVISION_CONFLICT')
  }

  const result = await port.applyCanvasCommand({
    project_id: project.id,
    canvas_id: canvasId,
    base_project_revision: baseProjectRevision,
    command,
    request_hash: requestHash,
    created_at: port.iso(),
    ...(deliveryArtboard ? {
      delivery_artboard: {
        width: deliveryArtboard.width,
        height: deliveryArtboard.height,
        ...(deliveryArtboard.safe_area ? { safe_area: deliveryArtboard.safe_area } : {}),
      },
    } : {}),
  })
  return { project: result.project, canvas: result.canvas }
}

/** Canvas Command/revision handling, deterministic preflight and render. */
export class ImageCanvasApplication extends ImageApplication<ImageCanvasApplicationPort> {
  readonly #canvasCommand: ImageCanvasCommandRuntimePort

  readonly getCanvas = this.bind('getCanvas')
  readonly listCanvases = this.bind('listCanvases')
  readonly createCanvas = this.bind('createCanvas')
  readonly applyCanvasCommand = async (
    projectId: string,
    canvasId: string,
    baseProjectRevision: number,
    raw: ImageCanvasCommandInput,
  ): Promise<{ project: ImageWorkbenchProject; canvas: ImageCanvasRevision }> =>
    await applyCanvasCommand(this.#canvasCommand, projectId, canvasId, baseProjectRevision, raw)
  readonly preflightCanvas = this.bind('preflightCanvas')
  readonly renderCanvas = this.bind('renderCanvas')
  readonly selectArtboardVersion = this.bind('selectArtboardVersion')

  constructor(port: ImageCanvasApplicationPort) {
    super(port)
    this.#canvasCommand = port.canvasCommand
  }
}
