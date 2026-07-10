// 会话态(内存版)+ 默认授权策略。cc 把这些状态挂在 Electron 的 session store 上;
// 我们是单机、in-process 派发,所以用一个内存对象持有每个会话的:
//   授权 app 白名单 / 授权标志位 / 选中显示器 / 剪贴板 stash / 最近截图尺寸。
//
// 授权(request_access)默认策略 = 自动放行(把模型请求的 app 按 vendor 判定的
// tier 直接授予)。这是"接入骨架"的缺省:真正的用户确认弹窗留一个可插拔的
// requestAccessPolicy 接口,owner 后续接 UI 时替换即可。
// ⚠️ 注意:即便自动放行,vendor 的分级(tier)/策略黑名单/前台闸/命中测试闸/
// 系统热键黑名单等安全闸依旧全部生效 —— 授权对话框只是"人类在环"的那一层。

import type {
  AppGrant,
  ComputerUseSessionContext,
  CuGrantFlags,
  CuPermissionRequest,
  CuPermissionResponse,
  ScreenshotDims,
} from './vendor/types'
import { DEFAULT_GRANT_FLAGS } from './vendor/types'

export type RequestAccessPolicy = (
  req: CuPermissionRequest,
  signal: AbortSignal,
) => Promise<CuPermissionResponse>

/**
 * 默认授权策略:自动放行。
 * - 已解析到的 app → granted(bundleId/displayName/grantedAt/tier=proposedTier)。
 * - 未解析到的 app(未安装)→ denied: not_installed。
 * - TCC 未授权分支(req.tccState 存在、apps 为空)→ 返回空授予;handleToolCall 会
 *   复查 ensureOsPermissions 并让模型提示用户去系统设置里开"辅助功能/屏幕录制"。
 * - 授权标志位(clipboard/systemKeyCombos)→ 模型请求什么就给什么。
 */
export const autoGrantPolicy: RequestAccessPolicy = async req => {
  const now = Date.now()
  const granted: AppGrant[] = []
  const denied: Array<{ bundleId: string; reason: 'user_denied' | 'not_installed' }> = []

  for (const app of req.apps) {
    if (app.resolved) {
      granted.push({
        bundleId: app.resolved.bundleId,
        displayName: app.resolved.displayName,
        grantedAt: now,
        tier: app.proposedTier,
      })
    } else {
      denied.push({ bundleId: app.requestedName, reason: 'not_installed' })
    }
  }

  const flags: CuGrantFlags = {
    ...DEFAULT_GRANT_FLAGS,
    clipboardRead: req.requestedFlags.clipboardRead === true,
    clipboardWrite: req.requestedFlags.clipboardWrite === true,
    systemKeyCombos: req.requestedFlags.systemKeyCombos === true,
  }

  return { granted, denied, flags, userConsented: true }
}

export interface ComputerUseSessionOptions {
  /** 自定义授权策略(接 UI 弹窗)。缺省 = autoGrantPolicy。 */
  requestAccessPolicy?: RequestAccessPolicy
  /** 用户级永久拒绝的 bundleId(设置页黑名单)。缺省空。 */
  userDeniedBundleIds?: readonly string[]
  /** 用户中止信号(把 overlay Stop 透传给 vendor 的 mid-batch 检查)。 */
  isAborted?: () => boolean
}

export interface ComputerUseSession {
  context: ComputerUseSessionContext
  /** 清空本会话授予的所有 app / 标志位(会话结束或用户撤销时调)。 */
  reset(): void
}

interface MutableSessionState {
  allowedApps: AppGrant[]
  grantFlags: CuGrantFlags
  selectedDisplayId: number | undefined
  displayPinnedByModel: boolean
  displayResolvedForApps: string | undefined
  clipboardStash: string | undefined
  lastScreenshotDims: ScreenshotDims | undefined
}

export function createComputerUseSession(opts: ComputerUseSessionOptions = {}): ComputerUseSession {
  const policy = opts.requestAccessPolicy ?? autoGrantPolicy
  const userDenied = opts.userDeniedBundleIds ?? []

  const state: MutableSessionState = {
    allowedApps: [],
    grantFlags: { ...DEFAULT_GRANT_FLAGS },
    selectedDisplayId: undefined,
    displayPinnedByModel: false,
    displayResolvedForApps: undefined,
    clipboardStash: undefined,
    lastScreenshotDims: undefined,
  }

  const context: ComputerUseSessionContext = {
    getAllowedApps: () => state.allowedApps,
    getGrantFlags: () => state.grantFlags,
    getUserDeniedBundleIds: () => userDenied,
    getSelectedDisplayId: () => state.selectedDisplayId,
    getDisplayPinnedByModel: () => state.displayPinnedByModel,
    getDisplayResolvedForApps: () => state.displayResolvedForApps,
    getTeachModeActive: () => false,
    getLastScreenshotDims: () => state.lastScreenshotDims,

    onPermissionRequest: (req, signal) => policy(req, signal),

    onAllowedAppsChanged: (apps, flags) => {
      state.allowedApps = [...apps]
      state.grantFlags = flags
    },

    getClipboardStash: () => state.clipboardStash,
    onClipboardStashChanged: stash => {
      state.clipboardStash = stash
    },

    onResolvedDisplayUpdated: displayId => {
      state.selectedDisplayId = displayId
    },
    onDisplayPinned: displayId => {
      state.selectedDisplayId = displayId
      state.displayPinnedByModel = displayId !== undefined
    },
    onDisplayResolvedForApps: key => {
      state.displayResolvedForApps = key
    },

    onScreenshotCaptured: dims => {
      state.lastScreenshotDims = dims
    },

    isAborted: opts.isAborted,
  }

  return {
    context,
    reset: () => {
      state.allowedApps = []
      state.grantFlags = { ...DEFAULT_GRANT_FLAGS }
      state.selectedDisplayId = undefined
      state.displayPinnedByModel = false
      state.displayResolvedForApps = undefined
      state.clipboardStash = undefined
      state.lastScreenshotDims = undefined
    },
  }
}
