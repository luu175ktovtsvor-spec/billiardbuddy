import {
  createElectronImageWorkbenchClient,
  createImageWorkbenchShell,
} from './image-workbench/index.js'
import type { ImageWorkbenchViewStateStorage } from './image-workbench/index.js'
import {
  VideoWorkbenchProductController,
  createDesktopVideoWorkbenchInputs,
  createVideoWorkbenchElectronBridge,
  mountVideoWorkbenchProduct,
} from './videoWorkbench/index.js'
// Keep the shared Preload shape under the production TypeScript build.
import './videoWorkbenchPreloadContract.js'

const root = document.getElementById('root')

if (!root) {
  throw new Error('BILLIARDBUDDY_RENDERER_ROOT_MISSING')
}

const viewStateStorage: ImageWorkbenchViewStateStorage = {
  read: () => {
    try {
      return window.localStorage.getItem('billiardbuddy.image-workbench.view-state')
    } catch {
      return null
    }
  },
  write: serialized => {
    try {
      window.localStorage.setItem('billiardbuddy.image-workbench.view-state', serialized)
    } catch {
      // A renderer storage failure must not block the image workflow.
    }
  },
  remove: () => {
    try {
      window.localStorage.removeItem('billiardbuddy.image-workbench.view-state')
    } catch {
      // A renderer storage failure must not block the image workflow.
    }
  },
}

/** Image and video render into isolated roots. Each domain owns its state,
 * bridge and lifecycle; neither surface can reuse the other domain's data. */
const imageRoot = document.createElement('section')
imageRoot.dataset.workbench = 'image'
const videoRoot = document.createElement('section')
videoRoot.dataset.workbench = 'video'
root.replaceChildren(imageRoot, videoRoot)

const shell = createImageWorkbenchShell({
  root: imageRoot,
  client: createElectronImageWorkbenchClient(window.billiardBuddyNative.media.images),
  view_state_storage: viewStateStorage,
})
shell.mount()

const videoWorkbench = new VideoWorkbenchProductController(
  createVideoWorkbenchElectronBridge(),
  createDesktopVideoWorkbenchInputs(),
)
const dispose = mountVideoWorkbenchProduct(videoRoot, videoWorkbench)

let disposed = false
let eventPollTimer: number | undefined

const scheduleOperationPoll = () => {
  if (disposed) return
  eventPollTimer = window.setTimeout(async () => {
    if (videoWorkbench.getState().workspace) await videoWorkbench.perform('poll_operations')
    scheduleOperationPoll()
  }, 5_000)
}

void videoWorkbench.start().finally(scheduleOperationPoll)
window.addEventListener('beforeunload', () => {
  disposed = true
  if (eventPollTimer !== undefined) window.clearTimeout(eventPollTimer)
  dispose()
  shell.unmount()
}, { once: true })
