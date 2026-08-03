import { ImageWorkbenchRepository } from '../../../services/imageWorkbenchRepository.js'

/**
 * Canonical 15.1 image metadata store. The retained repository export is a
 * compatibility name for existing API callers; it is no longer a JSON writer.
 */
export class SqliteImageMetadataStore extends ImageWorkbenchRepository {}
