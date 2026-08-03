/// <reference types="vite/client" />

import type { BilliardBuddyMediaPreloadBridge } from '../../shared/contracts/imageWorkbenchPreload.js'

declare global {
  interface Window {
    /** Typed product-owned Preload boundary; Agent APIs remain independently scoped. */
    billiardBuddyNative: Record<string, unknown> & {
      media: BilliardBuddyMediaPreloadBridge
    }
  }
}

export {}
