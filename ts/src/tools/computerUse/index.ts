// "本机控制"(computer use)模块公开入口。
// 对齐 cc-haha 的 computer-use 整套:vendor 安全内核(截图/点击/键鼠/分级授权/
// 前台闸/系统热键黑名单)照搬,native 执行走 runtime/{mac,win}_helper.py 的 Python 边桥。
//
// 用法(在 buildGeneralRegistry 里通过 extraTools 挂入,或宿主直接 new):
//   import { createComputerUseTools } from './computerUse'
//   const tools = createComputerUseTools()   // 平台非 mac/win → []

export { createComputerUseTools, type ComputerUseToolsOptions } from './computerUseTools'
export { isComputerUseSupportedPlatform, COMPUTER_USE_SERVER_NAME } from './common'
export { getComputerUseEnabled } from './gates'
export {
  autoGrantPolicy,
  createComputerUseSession,
  type RequestAccessPolicy,
  type ComputerUseSession,
  type ComputerUseSessionOptions,
} from './sessionContext'
