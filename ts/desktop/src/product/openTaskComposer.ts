import { useTabStore } from '../stores/tabStore'

/** Opens the dedicated product-owned page for creating a task. */
export function openProductTaskComposer(workDir?: string): void {
  useTabStore.getState().openNewProductTask(workDir)
}
