import {
  ImageWorkbenchRuntime,
  type ImageWorkbenchRuntimeOptions,
} from './imageWorkbenchRuntime.js'
import { ImageCanvasApplication } from '../media/image/application/imageCanvasApplication.js'
import { ImageDeliveryApplication } from '../media/image/application/imageDeliveryApplication.js'
import { ImageGenerationApplication } from '../media/image/application/imageGenerationApplication.js'
import { createImageApplicationPorts } from '../media/image/runtime/imageApplicationPorts.js'
import { ImageProjectApplication } from '../media/image/application/imageProjectApplication.js'
import { ImageRecoveryApplication } from '../media/image/application/imageRecoveryApplication.js'

export {
  ImageWorkbenchServiceError,
} from './imageWorkbenchRuntime.js'
export type {
  ImageWorkbenchCrashPoint,
  ImageWorkbenchProjectProjectionData,
  ImageWorkbenchRuntimeOptions,
} from './imageWorkbenchRuntime.js'

export type ImageWorkbenchApplications = {
  project: ImageProjectApplication
  generation: ImageGenerationApplication
  canvas: ImageCanvasApplication
  delivery: ImageDeliveryApplication
  recovery: ImageRecoveryApplication
}

export type ImageWorkbenchComposition = {
  applications: ImageWorkbenchApplications
  facade: ImageWorkbenchService
}

function createImageWorkbenchApplications(runtime: ImageWorkbenchRuntime): ImageWorkbenchApplications {
  const ports = createImageApplicationPorts(runtime)
  return Object.freeze({
    project: new ImageProjectApplication(ports.project),
    generation: new ImageGenerationApplication(ports.generation),
    canvas: new ImageCanvasApplication(ports.canvas),
    delivery: new ImageDeliveryApplication(ports.delivery),
    recovery: new ImageRecoveryApplication(ports.recovery),
  })
}

/**
 * Compatibility-facing composition root for the image workbench.
 *
 * It intentionally contains no image business behavior. Existing API callers
 * can keep their stable `ImageWorkbenchService` surface while new runtime
 * consumers use the five explicit Applications. They all delegate to the same
 * internal runtime, so there is one SQLite/CAS writer and one recovery path.
 */
class ImageWorkbenchFacade {
  /** @internal Test-only inspection hook. It is not installed in production. */
  declare readonly repository: ImageWorkbenchRuntime['repository']
  /** @internal Test-only inspection hook. It is not installed in production. */
  declare readonly assets: ImageWorkbenchRuntime['assets']
  readonly applications: ImageWorkbenchApplications
  readonly projectApplication: ImageProjectApplication
  readonly generationApplication: ImageGenerationApplication
  readonly canvasApplication: ImageCanvasApplication
  readonly deliveryApplication: ImageDeliveryApplication
  readonly recoveryApplication: ImageRecoveryApplication

  constructor(options: ImageWorkbenchRuntimeOptions = {}, composition?: {
    runtime: ImageWorkbenchRuntime
    applications: ImageWorkbenchApplications
  }) {
    const runtime = composition?.runtime ?? new ImageWorkbenchRuntime(options)
    const applications = composition?.applications ?? createImageWorkbenchApplications(runtime)
    // Old tests deliberately inspect persisted state and inject storage
    // failures. Do not make those raw infrastructure handles part of the
    // production façade or MediaRuntime API.
    if (process.env.NODE_ENV === 'test') {
      Object.defineProperties(this, {
        repository: { value: runtime.repository, enumerable: false },
        assets: { value: runtime.assets, enumerable: false },
      })
    }
    this.projectApplication = applications.project
    this.generationApplication = applications.generation
    this.canvasApplication = applications.canvas
    this.deliveryApplication = applications.delivery
    this.recoveryApplication = applications.recovery
    this.applications = applications

    // Maintain the pre-15.5 service contract without carrying a second set of
    // handlers or state. Application fields are already bound to this runtime.
    Object.assign(
      this,
      this.projectApplication,
      this.generationApplication,
      this.canvasApplication,
      this.deliveryApplication,
      this.recoveryApplication,
    )
  }
}

/**
 * Stable compatibility surface for existing API and test callers. The value
 * remains constructible as `new ImageWorkbenchService(options)`.
 */
export type ImageWorkbenchService = ImageWorkbenchFacade
  & ImageProjectApplication
  & ImageGenerationApplication
  & ImageCanvasApplication
  & ImageDeliveryApplication
  & ImageRecoveryApplication

export const ImageWorkbenchService: new (options?: ImageWorkbenchRuntimeOptions) => ImageWorkbenchService =
  ImageWorkbenchFacade as unknown as new (options?: ImageWorkbenchRuntimeOptions) => ImageWorkbenchService

/**
 * MediaRuntime uses this composition root so the façade is not the owner of
 * application construction. The legacy constructor above remains available
 * for existing API/tests, but both paths create exactly one runtime.
 */
export function createImageWorkbenchComposition(options: ImageWorkbenchRuntimeOptions = {}): ImageWorkbenchComposition {
  const runtime = new ImageWorkbenchRuntime(options)
  const applications = createImageWorkbenchApplications(runtime)
  const facade = new ImageWorkbenchFacade({}, { runtime, applications }) as ImageWorkbenchService
  return { applications, facade }
}
