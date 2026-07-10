// 子闸(sub-gates)+ 坐标模式 + 总开关。对齐 cc-haha src/utils/computerUse/gates.ts,
// 但去掉 GrowthBook 远程配置,改为 env 覆盖 + 内置默认(单机产品无需远程 A/B)。

import type { CoordinateMode, CuSubGates } from './vendor/types'

/** 与 cc 的 DEFAULTS 一致的默认子闸(vendor subGates.ts ALL_SUB_GATES_ON 同款,pixelValidation 关)。 */
const DEFAULT_SUB_GATES: CuSubGates = {
  pixelValidation: false,
  clipboardPasteMultiline: true,
  mouseAnimation: true,
  hideBeforeAction: true,
  autoTargetDisplay: true,
  clipboardGuard: true,
}

function envFalsy(value: string | undefined): boolean {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v === '0' || v === 'false' || v === 'no' || v === 'off'
}

function envTruthy(value: string | undefined): boolean {
  if (value === undefined) return false
  const v = value.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes' || v === 'on'
}

/** 总开关:默认开;env BILLIARDBUDDY_COMPUTER_USE_ENABLED=0/false 关掉。 */
export function getComputerUseEnabled(): boolean {
  return !envFalsy(process.env.BILLIARDBUDDY_COMPUTER_USE_ENABLED)
}

/** 子闸:默认 DEFAULT_SUB_GATES;单项可用 env 覆盖(便于排障/回归)。 */
export function getComputerUseSubGates(): CuSubGates {
  return {
    pixelValidation: envTruthy(process.env.BILLIARDBUDDY_CU_PIXEL_VALIDATION) || DEFAULT_SUB_GATES.pixelValidation,
    clipboardPasteMultiline: envFalsy(process.env.BILLIARDBUDDY_CU_CLIPBOARD_PASTE)
      ? false
      : DEFAULT_SUB_GATES.clipboardPasteMultiline,
    mouseAnimation: envFalsy(process.env.BILLIARDBUDDY_CU_MOUSE_ANIMATION) ? false : DEFAULT_SUB_GATES.mouseAnimation,
    hideBeforeAction: envFalsy(process.env.BILLIARDBUDDY_CU_HIDE_BEFORE_ACTION)
      ? false
      : DEFAULT_SUB_GATES.hideBeforeAction,
    autoTargetDisplay: envFalsy(process.env.BILLIARDBUDDY_CU_AUTO_TARGET_DISPLAY)
      ? false
      : DEFAULT_SUB_GATES.autoTargetDisplay,
    clipboardGuard: envFalsy(process.env.BILLIARDBUDDY_CU_CLIPBOARD_GUARD) ? false : DEFAULT_SUB_GATES.clipboardGuard,
  }
}

// 坐标模式在首次读取时冻结:工具描述与 executor 的坐标缩放必须读同一个值,
// 否则模型看到的坐标约定和服务端的换算不一致 → 点错位置。
let frozenCoordinateMode: CoordinateMode | undefined
export function getComputerUseCoordinateMode(): CoordinateMode {
  frozenCoordinateMode ??=
    process.env.BILLIARDBUDDY_CU_COORDINATE_MODE === 'normalized_0_100' ? 'normalized_0_100' : 'pixels'
  return frozenCoordinateMode
}

/** 仅测试用:重置冻结的坐标模式。 */
export function _resetCoordinateModeForTest(): void {
  frozenCoordinateMode = undefined
}
