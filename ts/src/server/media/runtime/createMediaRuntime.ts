import { ImageWorkbenchService } from '../../services/imageWorkbenchService.js'

export type MediaRuntime = {
  imageWorkbench: ImageWorkbenchService
}

/** Composition root for media-domain services; it never mixes image state with Video or Agent state. */
export function createMediaRuntime(): MediaRuntime {
  return {
    imageWorkbench: new ImageWorkbenchService(),
  }
}
