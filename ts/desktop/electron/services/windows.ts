// 窗口状态持久化:记住上次的尺寸/位置/是否最大化,下次开窗恢复;窗口跑到屏幕外或换了显示器时校正回可见区。
// 移植自 cc-haha desktop/electron/services/windows.ts(只取状态持久化这块,不带"关窗即隐藏到托盘"的语义,保持本壳原有关窗行为)。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { App, BrowserWindow, Display } from 'electron'

export const WINDOW_STATE_FILE = 'window-state.json'
// 默认尺寸与本壳原 createWindow 保持一致(没有历史状态时用这个)。
export const DEFAULT_WINDOW_WIDTH = 1180
export const DEFAULT_WINDOW_HEIGHT = 760
export const MIN_WINDOW_WIDTH = 720
export const MIN_WINDOW_HEIGHT = 480
// 窗口至少要有这么多像素落在某块屏幕内,才算"看得见";否则判为漂到屏外。
const MIN_VISIBLE_PIXELS = 80

export type StoredWindowState = {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
}

export type WindowStateBounds = Pick<StoredWindowState, 'x' | 'y' | 'width' | 'height'>
export type WindowCreateBounds =
  & Partial<Pick<StoredWindowState, 'x' | 'y'>>
  & Pick<StoredWindowState, 'width' | 'height'>

// 落盘位置:优先自定义配置目录(QF_CONFIG_DIR),否则用系统给本 App 的 userData 目录。
export function windowStatePath(app: App, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.QF_CONFIG_DIR || app.getPath('userData'), WINDOW_STATE_FILE)
}

// 状态合法性:坐标是有限数、尺寸不小于最小值,才值得存/恢复。
export function isPersistableWindowState(state: StoredWindowState): boolean {
  return Number.isFinite(state.x)
    && Number.isFinite(state.y)
    && state.width >= MIN_WINDOW_WIDTH
    && state.height >= MIN_WINDOW_HEIGHT
}

// 窗口和某块屏幕是否有"有意义的重叠"(至少露出 MIN_VISIBLE_PIXELS,免得只有一角在屏内也算可见)。
export function hasMeaningfulIntersection(
  state: WindowStateBounds,
  displayBounds: WindowStateBounds,
): boolean {
  const stateRight = state.x + state.width
  const stateBottom = state.y + state.height
  const displayRight = displayBounds.x + displayBounds.width
  const displayBottom = displayBounds.y + displayBounds.height

  return stateRight > displayBounds.x + MIN_VISIBLE_PIXELS
    && stateBottom > displayBounds.y + MIN_VISIBLE_PIXELS
    && state.x < displayRight - MIN_VISIBLE_PIXELS
    && state.y < displayBottom - MIN_VISIBLE_PIXELS
}

// 记住的窗口在当前任一显示器上还看得见吗(拔掉外接屏后常需要这一判断)。
export function isWindowStateVisibleOnAnyDisplay(
  state: StoredWindowState,
  displays: Array<Pick<Display, 'bounds' | 'workArea'>>,
): boolean {
  if (displays.length === 0) return true
  return displays.some(display =>
    hasMeaningfulIntersection(state, display.workArea ?? display.bounds),
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

// 把窗口位置夹回它所在屏幕的可用工作区内(标题栏别顶到菜单栏/任务栏后面)。
export function clampWindowStateToVisibleWorkArea(
  state: StoredWindowState,
  displays: Array<Pick<Display, 'bounds' | 'workArea'>>,
): StoredWindowState {
  const display = displays.find(candidate =>
    hasMeaningfulIntersection(state, candidate.workArea ?? candidate.bounds),
  )
  if (!display) return state

  const workArea = display.workArea ?? display.bounds
  const maxX = workArea.x + Math.max(0, workArea.width - state.width)
  const maxY = workArea.y + Math.max(0, workArea.height - state.height)

  return {
    ...state,
    x: clamp(state.x, workArea.x, maxX),
    y: clamp(state.y, workArea.y, maxY),
  }
}

// 读回上次窗口状态:文件不存在/损坏/尺寸非法/漂到屏外都返回 null(交给调用方用默认尺寸)。
export function readWindowState(
  app: App,
  displays: Array<Pick<Display, 'bounds' | 'workArea'>>,
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
): StoredWindowState | null {
  const statePath = windowStatePath(app, env)
  if (!existsSync(statePath)) return null

  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf-8')) as StoredWindowState
    if (!isPersistableWindowState(parsed)) return null
    if (!isWindowStateVisibleOnAnyDisplay(parsed, displays)) return null
    return platform === 'darwin'
      ? clampWindowStateToVisibleWorkArea(parsed, displays)
      : parsed
  } catch (error) {
    console.error(`[desktop] 读取窗口状态失败 ${statePath}:`, error)
    return null
  }
}

// 写盘(自动建目录);非法状态直接跳过,不落坏数据。
export function writeWindowState(
  app: App,
  state: StoredWindowState,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (!isPersistableWindowState(state)) return
  const statePath = windowStatePath(app, env)
  mkdirSync(path.dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

// 从当前窗口取一份状态快照;最小化时取不到有意义的 bounds,返回 null 不覆盖已存的好状态。
export function captureWindowState(window: BrowserWindow): StoredWindowState | null {
  if (window.isMinimized()) return null
  const bounds = window.getBounds()
  const state = {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    maximized: window.isMaximized(),
  }
  return isPersistableWindowState(state) ? state : null
}

// 有历史状态就按它开窗,否则用默认尺寸(不指定 x/y 让系统居中)。
export function windowOptionsFromState(state: StoredWindowState | null): WindowCreateBounds {
  return state
    ? { x: state.x, y: state.y, width: state.width, height: state.height }
    : { width: DEFAULT_WINDOW_WIDTH, height: DEFAULT_WINDOW_HEIGHT }
}

// 上次是最大化的,这次也最大化(尺寸/位置已由 windowOptionsFromState 处理)。
export function restoreWindowMaximized(window: BrowserWindow, state: StoredWindowState | null) {
  if (state?.maximized) window.maximize()
}

// 立即存一次当前窗口状态(关窗时用,确保存到最终位置)。
export function saveWindowState(app: App, window: BrowserWindow) {
  const state = captureWindowState(window)
  if (state) writeWindowState(app, state)
}

// 挂上"移动/缩放/关闭时保存状态"。移动缩放做去抖(拖动过程中别狂写盘),关窗立即落一次。
// 不接管 close 语义(不做隐藏到托盘),本壳原有的关窗→退出流程保持不变。
export function installWindowStatePersistence(app: App, window: BrowserWindow): void {
  let timer: ReturnType<typeof setTimeout> | null = null
  const scheduleSave = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      saveWindowState(app, window)
    }, 400)
  }
  window.on('move', scheduleSave)
  window.on('resize', scheduleSave)
  window.on('close', () => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    saveWindowState(app, window)
  })
}
