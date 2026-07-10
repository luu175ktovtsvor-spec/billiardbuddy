// 宿主适配器:把 executor + 权限探测 + 子闸 + 日志 组装成 vendor 需要的
// ComputerUseHostAdapter(进程级单例)。对齐 cc-haha src/utils/computerUse/hostAdapter.ts。

import type { ComputerUseHostAdapter, Logger } from './vendor/types'
import { COMPUTER_USE_SERVER_NAME } from './common'
import { createComputerExecutor } from './executor'
import { getComputerUseEnabled, getComputerUseSubGates } from './gates'
import { normalizeOsPermissions } from './permissions'
import { callPythonHelper } from './pythonBridge'
import { getLogger } from '../../utils/logger'

// 集中式日志(P0,审计 16-trace-errors.md #1.1):落 <stateRoot>/logs/debug.log,
// 默认只记 warn/error,env QF_DEBUG_LOG(或兼容 BILLIARDBUDDY_DEBUG/DEBUG)开 verbose。
const log = getLogger('computer-use')

class DebugLogger implements Logger {
  // vendor Logger 接口要 silly 这一级,我们没有更细的分级,并入 debug。
  silly(message: string): void {
    log.debug(message)
  }
  debug(message: string): void {
    log.debug(message)
  }
  info(message: string): void {
    log.info(message)
  }
  warn(message: string): void {
    log.warn(message)
  }
  error(message: string): void {
    log.error(message)
  }
}

let cached: ComputerUseHostAdapter | undefined

export function getComputerUseHostAdapter(): ComputerUseHostAdapter {
  if (cached) return cached
  cached = {
    serverName: COMPUTER_USE_SERVER_NAME,
    logger: new DebugLogger(),
    executor: createComputerExecutor(),
    ensureOsPermissions: async () => {
      const rawPerms = await callPythonHelper<{ accessibility: boolean; screenRecording: boolean | null }>(
        'check_permissions',
        {},
      )
      const perms = normalizeOsPermissions(rawPerms)
      return perms.granted
        ? { granted: true as const }
        : { granted: false as const, accessibility: perms.accessibility, screenRecording: perms.screenRecording }
    },
    isDisabled: () => !getComputerUseEnabled(),
    getSubGates: getComputerUseSubGates,
    getAutoUnhideEnabled: () => true,
    // 像素校验子闸默认关闭 → validateClickTarget 不会被调用,返回 null 是安全的。
    // (我们的 sidecar 无 Electron nativeImage,不做 JPEG 解码裁剪。)
    cropRawPatch: () => null,
  }
  return cached
}

/** 仅测试用:重置缓存的适配器(便于注入 fake executor 的测试)。 */
export function _resetHostAdapterForTest(): void {
  cached = undefined
}
