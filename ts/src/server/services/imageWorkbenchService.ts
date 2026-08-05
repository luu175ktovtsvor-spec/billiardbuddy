import {
  ImageWorkbenchRuntime,
  type ImageWorkbenchRuntimeOptions,
} from './imageWorkbenchRuntime.js'
import {
  createImageApplicationRuntime,
  type ImageApplicationRuntime,
  type ImageWorkbenchApplications,
} from '../media/image/runtime/createImageApplicationRuntime.js'

export {
  ImageWorkbenchServiceError,
} from './imageWorkbenchRuntime.js'
export type {
  ImageWorkbenchCrashPoint,
  ImageWorkbenchProjectProjectionData,
  ImageWorkbenchRuntimeOptions,
} from './imageWorkbenchRuntime.js'

export type { ImageWorkbenchApplications } from '../media/image/runtime/createImageApplicationRuntime.js'

export type ImageWorkbenchComposition = {
  applications: ImageWorkbenchApplications
  facade: ImageWorkbenchService
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
  readonly projectApplication: ImageWorkbenchApplications['project']
  readonly generationApplication: ImageWorkbenchApplications['generation']
  readonly canvasApplication: ImageWorkbenchApplications['canvas']
  readonly deliveryApplication: ImageWorkbenchApplications['delivery']
  readonly recoveryApplication: ImageWorkbenchApplications['recovery']

  constructor(options: ImageWorkbenchRuntimeOptions = {}, composition?: ImageApplicationRuntime) {
    const applicationRuntime = composition ?? createImageApplicationRuntime(options)
    const { runtime, applications } = applicationRuntime
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
  & ImageWorkbenchApplications['project']
  & ImageWorkbenchApplications['generation']
  & ImageWorkbenchApplications['canvas']
  & ImageWorkbenchApplications['delivery']
  & ImageWorkbenchApplications['recovery']

export const ImageWorkbenchService: new (options?: ImageWorkbenchRuntimeOptions) => ImageWorkbenchService =
  ImageWorkbenchFacade as unknown as new (options?: ImageWorkbenchRuntimeOptions) => ImageWorkbenchService

/**
 * MediaRuntime uses this composition root so the façade is not the owner of
 * application construction. The legacy constructor above remains available
 * for existing API/tests, but both paths create exactly one runtime.
 */
export function createImageWorkbenchComposition(options: ImageWorkbenchRuntimeOptions = {}): ImageWorkbenchComposition {
  const applicationRuntime = createImageApplicationRuntime(options)
  const facade = new ImageWorkbenchFacade({}, applicationRuntime) as ImageWorkbenchService
  return { applications: applicationRuntime.applications, facade }
}
