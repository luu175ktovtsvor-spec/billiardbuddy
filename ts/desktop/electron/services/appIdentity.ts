// Windows 通知身份:显式设置 AppUserModelID,否则 Windows 原生通知(toast)不显示应用名/图标,甚至静默失败。
// 移植自 cc-haha desktop/electron/services/appIdentity.ts。
export type AppUserModelIdHost = {
  setAppUserModelId(id: string): void
}

// 必须与 electron-builder.yml 的 appId 保持一致(Windows 用它归属 toast 通知与任务栏固定);当前打包 appId = com.qiufang.assistant。
export const WINDOWS_APP_USER_MODEL_ID = 'com.qiufang.assistant'

export function applyWindowsAppUserModelId(
  app: AppUserModelIdHost,
  platform: NodeJS.Platform = process.platform,
  appUserModelId: string = WINDOWS_APP_USER_MODEL_ID,
): boolean {
  if (platform !== 'win32') return false
  app.setAppUserModelId(appUserModelId)
  return true
}
