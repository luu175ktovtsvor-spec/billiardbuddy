import { ImageCanvasApplication } from '../application/imageCanvasApplication.js'
import { ImageDeliveryApplication } from '../application/imageDeliveryApplication.js'
import { ImageGenerationApplication } from '../application/imageGenerationApplication.js'
import { ImageProjectApplication } from '../application/imageProjectApplication.js'
import { ImageRecoveryApplication } from '../application/imageRecoveryApplication.js'
import {
  ImageWorkbenchRuntime,
  type ImageWorkbenchRuntimeOptions,
} from '../../../services/imageWorkbenchRuntime.js'
import { createImageApplicationPorts } from './imageApplicationPorts.js'

export type ImageWorkbenchApplications = {
  project: ImageProjectApplication
  generation: ImageGenerationApplication
  canvas: ImageCanvasApplication
  delivery: ImageDeliveryApplication
  recovery: ImageRecoveryApplication
}

export type ImageApplicationRuntime = {
  /** Internal infrastructure owner; never publish this from MediaRuntime. */
  runtime: ImageWorkbenchRuntime
  applications: ImageWorkbenchApplications
}

/**
 * The image composition root owns exactly one SQLite/CAS runtime and builds
 * its five application surfaces around it. Production callers receive only
 * the applications; the compatibility facade is constructed separately.
 */
export function createImageApplicationRuntime(
  options: ImageWorkbenchRuntimeOptions = {},
): ImageApplicationRuntime {
  const runtime = new ImageWorkbenchRuntime(options)
  const ports = createImageApplicationPorts(runtime)
  const applications = Object.freeze({
    project: new ImageProjectApplication(ports.project),
    generation: new ImageGenerationApplication(ports.generation),
    canvas: new ImageCanvasApplication(ports.canvas),
    delivery: new ImageDeliveryApplication(ports.delivery),
    recovery: new ImageRecoveryApplication(ports.recovery),
  })
  return { runtime, applications }
}
