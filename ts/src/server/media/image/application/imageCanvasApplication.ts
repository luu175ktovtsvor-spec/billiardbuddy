import { ImageApplication } from './imageApplication.js'
import type { ImageCanvasApplicationPort } from '../runtime/imageApplicationPorts.js'

/** Canvas Command/revision handling, deterministic preflight and render. */
export class ImageCanvasApplication extends ImageApplication<ImageCanvasApplicationPort> {
  readonly getCanvas = this.bind('getCanvas')
  readonly listCanvases = this.bind('listCanvases')
  readonly createCanvas = this.bind('createCanvas')
  readonly applyCanvasCommand = this.bind('applyCanvasCommand')
  readonly preflightCanvas = this.bind('preflightCanvas')
  readonly renderCanvas = this.bind('renderCanvas')
  readonly selectArtboardVersion = this.bind('selectArtboardVersion')

  constructor(port: ImageCanvasApplicationPort) {
    super(port)
  }
}
