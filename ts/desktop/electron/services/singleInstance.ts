// 单实例聚焦:同一时刻只允许一个应用实例。第二次点图标/命令行再启一个时,不新开窗口,而是把已开的老窗口拉到前台。
// 移植自 cc-haha desktop/electron/services/singleInstance.ts;把"拉前台"抽成回调,复用本壳自带的 showMainWindow(能在窗口已关时重建)。
import type { App } from 'electron'

// 返回 true = 拿到锁,可继续启动;返回 false = 已有实例在跑(本函数已触发 app.quit()),调用方应停止后续启动流程。
export function acquireSingleInstanceLock(
  app: App,
  focusExistingWindow: () => void,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // 逃生开关:E2E/多开调试时可置 1 关掉单实例限制。
  if (env.QF_DESKTOP_DISABLE_SINGLE_INSTANCE_LOCK === '1') {
    return true
  }

  const hasLock = app.requestSingleInstanceLock()
  if (!hasLock) {
    app.quit()
    return false
  }

  // 第二个实例被启动时,系统把事件转发到这个已持锁的实例:把老窗口拉回前台。
  app.on('second-instance', () => {
    focusExistingWindow()
  })

  return true
}
