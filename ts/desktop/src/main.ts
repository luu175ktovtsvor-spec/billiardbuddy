import {
  createElectronImageWorkbenchClient,
  createImageWorkbenchShell,
} from './image-workbench/index.js'
import type { ImageWorkbenchViewStateStorage } from './image-workbench/index.js'

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

const shell = createImageWorkbenchShell({
  root,
  client: createElectronImageWorkbenchClient(window.billiardBuddyNative.media.images),
  view_state_storage: viewStateStorage,
})
shell.mount()
