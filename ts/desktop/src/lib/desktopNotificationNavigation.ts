import { PRODUCT_TASKS_TAB_ID, SCHEDULED_TAB_ID, useTabStore } from '../stores/tabStore'
import {
  installDesktopNotificationClickListener,
  type DesktopNotificationTarget,
} from './desktopNotifications'

const SCHEDULED_TAB_TITLE = 'Scheduled Tasks'
const PRODUCT_TASKS_TAB_TITLE = '任务中心'

export function openDesktopNotificationTarget(target: DesktopNotificationTarget): void {
  if (target.type === 'scheduled') {
    useTabStore.getState().openTab(SCHEDULED_TAB_ID, SCHEDULED_TAB_TITLE, 'scheduled')
    return
  }

  useTabStore.getState().openTab(PRODUCT_TASKS_TAB_ID, PRODUCT_TASKS_TAB_TITLE, 'product-tasks')
}

export function installDesktopNotificationNavigation(): Promise<() => void> {
  return installDesktopNotificationClickListener(openDesktopNotificationTarget)
}
