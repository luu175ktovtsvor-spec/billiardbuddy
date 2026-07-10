// macOS TCC 权限归一化。逐字对齐 cc-haha src/utils/computerUse/permissions.ts。

export type RawOsPermissions = {
  accessibility: boolean
  screenRecording: boolean | null
}

export type NormalizedOsPermissions = {
  granted: boolean
  accessibility: boolean
  screenRecording: boolean
}

/**
 * macOS 的"屏幕录制"被动探测对 helper 子进程可能返回 "unknown",即便 app bundle
 * 已经授权。把该状态当作非阻断,让真正的截图路径成为最终判据。
 */
export function normalizeOsPermissions(perms: RawOsPermissions): NormalizedOsPermissions {
  const screenRecording = perms.screenRecording !== false
  return {
    granted: perms.accessibility && screenRecording,
    accessibility: perms.accessibility,
    screenRecording,
  }
}
