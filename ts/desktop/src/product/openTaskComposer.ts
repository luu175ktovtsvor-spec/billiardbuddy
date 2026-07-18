import { PRODUCT_TASKS_TAB_ID, useTabStore } from '../stores/tabStore'
import { useProductTaskStore } from './stores/productTaskStore'

/** Opens the one product-owned entry point for creating a task. */
export function openProductTaskComposer(workDir?: string): void {
  useProductTaskStore.getState().requestTaskComposer(workDir)
  useTabStore.getState().openTab(PRODUCT_TASKS_TAB_ID, '任务中心', 'product-tasks')
}
