import { SCHEDULED_TAB_ID, useTabStore } from '../stores/tabStore'
import {
  installDesktopNotificationClickListener,
  type DesktopNotificationTarget,
} from './desktopNotifications'

const SCHEDULED_TAB_TITLE = 'Scheduled Tasks'

export function openDesktopNotificationTarget(_target: DesktopNotificationTarget): void {
  useTabStore.getState().openTab(SCHEDULED_TAB_ID, SCHEDULED_TAB_TITLE, 'scheduled')
}

export function installDesktopNotificationNavigation(): Promise<() => void> {
  return installDesktopNotificationClickListener(openDesktopNotificationTarget)
}
