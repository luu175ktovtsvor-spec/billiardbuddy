import type { ProductTaskBrowserPreviewMode } from '../stores/productTaskWorkspaceStore'

export type ProductTaskBrowserPreviewCapture = { mode: ProductTaskBrowserPreviewMode; dataUrl: string }
export type ProductTaskBrowserPreviewDockProps = { taskId: string; browserOpen: boolean; previewOpen: boolean; activeMode: ProductTaskBrowserPreviewMode | null; onActivate: (mode: ProductTaskBrowserPreviewMode) => void; onClose: (mode: ProductTaskBrowserPreviewMode) => void; onCapture: (capture: ProductTaskBrowserPreviewCapture) => void; workspaceAvailable?: boolean }
/** Native browser/preview is intentionally not a BB-02B consumer. */
export function ProductTaskBrowserPreviewDock(_props: ProductTaskBrowserPreviewDockProps) { return null }
