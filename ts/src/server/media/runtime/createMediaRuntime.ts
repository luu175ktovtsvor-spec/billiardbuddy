import {
  createImageWorkbenchComposition,
  type ImageWorkbenchComposition,
  type ImageWorkbenchApplications,
  type ImageWorkbenchRuntimeOptions,
} from '../../services/imageWorkbenchService.js'

export type MediaRuntime = {
  imageApplications: ImageWorkbenchApplications
}

export type CreateMediaRuntimeOptions = {
  imageWorkbench?: ImageWorkbenchRuntimeOptions
}

/** Composition root for media-domain services; it never mixes image state with Video or Agent state. */
export function createMediaRuntime(options: CreateMediaRuntimeOptions = {}): MediaRuntime {
  const composition: ImageWorkbenchComposition = createImageWorkbenchComposition(options.imageWorkbench)
  return {
    imageApplications: composition.applications,
  }
}
