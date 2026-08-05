import { ImageApplication } from './imageApplication.js'
import type { ImageProjectApplicationPort } from '../runtime/imageApplicationPorts.js'

/** Project, Brief, reference, inspiration and reusable brand/template facts. */
export class ImageProjectApplication extends ImageApplication<ImageProjectApplicationPort> {
  readonly listProjects = this.bind('listProjects')
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
  }
}
