import { ImageApplication } from './imageApplication.js'
import type { ImageProjectApplicationPort } from '../runtime/imageApplicationPorts.js'
import { createHash } from 'node:crypto'
import type { ImageWorkbenchProject } from '../../../../../shared/contracts/media.js'
import {
  updateImageReferenceControlInputSchema,
  type UpdateImageReferenceControlInput,
} from '../../../../../shared/contracts/imageGeneration.js'
import { ImageWorkbenchServiceError, type ImageReferenceControlRuntimePort } from '../../../services/imageWorkbenchRuntime.js'

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

function matchesReference(
  project: ImageWorkbenchProject,
  reference: ImageWorkbenchProject['references'][number],
  value: string,
): boolean {
  return reference.asset_id === value
    || `ref_${createHash('sha256').update([project.id, reference.asset_id].join('\0')).digest('hex').slice(0, 32)}` === value
}

/** Project, Brief, reference, inspiration and reusable brand/template facts. */
export class ImageProjectApplication extends ImageApplication<ImageProjectApplicationPort> {
  readonly #referenceControl: ImageReferenceControlRuntimePort

  readonly listProjects = this.bind('listProjects')
  readonly generationPreferencesCatalog = this.bind('generationPreferencesCatalog')
  readonly getProject = this.bind('getProject')
  readonly getProjectProjection = this.bind('getProjectProjection')
  readonly assertProjectOwner = this.bind('assertProjectOwner')
  readonly createProject = this.bind('createProject')
  readonly quickCreate = this.bind('quickCreate')
  readonly updateProject = this.bind('updateProject')
  readonly addReferences = this.bind('addReferences')
  readonly compileBrief = this.bind('compileBrief')
  readonly applyBriefOverrides = this.bind('applyBriefOverrides')
  readonly addWorkflowReferences = this.bind('addWorkflowReferences')
  readonly removeWorkflowReference = this.bind('removeWorkflowReference')
  /**
   * A Reference Control change is its own durable Project command.  Keep the
   * whole command here so the public Project Application, rather than the
   * shared runtime, owns its parsing, replay semantics and command guards.
   */
  readonly updateReferenceControl = async (
    projectId: string,
    referenceId: string,
    raw: UpdateImageReferenceControlInput,
  ): Promise<ImageWorkbenchProject> => {
    const input = updateImageReferenceControlInputSchema.parse(raw)
    const project = await this.#referenceControl.loadProject(projectId)
    const requestHash = sha256({
      kind: 'reference_control',
      project_id: project.id,
      base_revision: input.base_revision,
      reference_id: referenceId,
      role: input.role,
      influence_strength: input.influence_strength,
      preservation: input.preservation,
      priority: input.priority,
      label: input.label,
    })
    const replay = await this.#referenceControl.findCommand(project.id, input.idempotency_key, requestHash)
    if (replay) {
      return await this.#referenceControl.refreshGenerationHeader({ project: replay, replayed: true })
    }
    if (project.revision !== input.base_revision) {
      throw new ImageWorkbenchServiceError('图片项目已被另一写入者更新，请刷新后重试', 409, 'IMAGE_REVISION_CONFLICT')
    }
    await this.#referenceControl.assertNoActiveOperation(project)
    await this.#referenceControl.assertNoActiveGenerationOperation(project)

    const references = project.references.map(reference => matchesReference(project, reference, referenceId)
      ? {
          ...reference,
          role: input.role,
          influence_strength: input.influence_strength,
          preservation: input.preservation,
          priority: input.priority,
          ...(input.label === undefined ? {} : { label: input.label }),
        }
      : reference)
    if (references.every(reference => !matchesReference(project, reference, referenceId))) {
      throw new ImageWorkbenchServiceError('图片参考图不存在', 404, 'REFERENCE_IMAGE_MISSING')
    }

    return await this.#referenceControl.refreshGenerationHeader(await this.#referenceControl.save({
      project: {
        ...project,
        references,
        revision: project.revision + 1,
        error: undefined,
        error_code: undefined,
        notice: undefined,
      },
      base_revision: input.base_revision,
      idempotency_key: input.idempotency_key,
      request_hash: requestHash,
    }))
  }
  readonly getInspirationBoard = this.bind('getInspirationBoard')
  readonly upsertInspirationItems = this.bind('upsertInspirationItems')
  readonly promoteInspirationItem = this.bind('promoteInspirationItem')
  readonly listBrandKits = this.bind('listBrandKits')
  readonly getBrandKit = this.bind('getBrandKit')
  readonly createBrandKit = this.bind('createBrandKit')
  readonly reviseBrandKit = this.bind('reviseBrandKit')
  readonly trashBrandKit = this.bind('trashBrandKit')
  readonly listTemplates = this.bind('listTemplates')
  readonly getTemplate = this.bind('getTemplate')
  readonly createTemplate = this.bind('createTemplate')
  readonly reviseTemplate = this.bind('reviseTemplate')
  readonly trashTemplate = this.bind('trashTemplate')
  readonly createAssetGrant = this.bind('createAssetGrant')
  readonly revokeAssetGrant = this.bind('revokeAssetGrant')
  readonly listAssetGrants = this.bind('listAssetGrants')
  readonly saveBrandKitRevision = this.bind('saveBrandKitRevision')
  readonly saveTemplateRevision = this.bind('saveTemplateRevision')

  constructor(port: ImageProjectApplicationPort) {
    super(port)
    this.#referenceControl = port.referenceControl
  }
}
