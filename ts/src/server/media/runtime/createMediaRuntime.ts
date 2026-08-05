import {
  createImageApplicationRuntime,
  type ImageWorkbenchApplications,
} from '../image/runtime/createImageApplicationRuntime.js'
import type { ImageWorkbenchRuntimeOptions } from '../../services/imageWorkbenchRuntime.js'

export type MediaRuntime = {
  imageApplications: ImageWorkbenchApplications
}

export type CreateMediaRuntimeOptions = {
  imageWorkbench?: ImageWorkbenchRuntimeOptions
}

/** Composition root for media-domain services; it never mixes image state with Video or Agent state. */
export function createMediaRuntime(options: CreateMediaRuntimeOptions = {}): MediaRuntime {
  const composition = createImageApplicationRuntime(options.imageWorkbench)
  return {
    imageApplications: composition.applications,
  }
}
