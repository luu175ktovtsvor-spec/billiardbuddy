// Computer-use 宿主公共常量/能力探测。对齐 cc-haha src/utils/computerUse/common.ts,
// 去掉 cc 的 analytics/env 依赖,只留平台判定 + 能力矩阵。

/** 本机控制能力的内部标识(工具分组用,不面向用户)。 */
export const COMPUTER_USE_SERVER_NAME = 'computer-use'

/**
 * 宿主进程的"占位 bundleId"。我们的内核 sidecar 无窗口,永远不会匹配到真实的
 * NSWorkspace.frontmostApplication —— 于是 vendor 里"宿主自己是前台"的分支
 * (鼠标点透豁免、键盘安全网)对我们是死代码,行为安全。
 */
export const HOST_BUNDLE_ID = 'com.billiardbuddy.desktop.headless'

export function isComputerUseSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): platform is 'darwin' | 'win32' {
  return platform === 'darwin' || platform === 'win32'
}

/**
 * 按平台给出本机控制能力。`hostBundleId` 不在这里 —— 由 executor.ts 补进
 * ComputerExecutor.capabilities。
 *
 * - darwin:截图走 SCContentFilter,能在合成层把未授权 app 抠掉(native 过滤)。
 * - win32:截图不过滤(所有窗口都可见),靠输入动作的前台闸拦住未授权 app。
 */
export function getComputerUseCapabilities(
  platform: NodeJS.Platform = process.platform,
): { screenshotFiltering: 'native' | 'none'; platform: 'darwin' | 'win32' } {
  if (platform === 'darwin') {
    return { screenshotFiltering: 'native', platform: 'darwin' }
  }
  if (platform !== 'win32') {
    throw new Error(`本机控制仅支持 macOS 与 Windows(收到 ${platform})。`)
  }
  return { screenshotFiltering: 'none', platform: 'win32' }
}
