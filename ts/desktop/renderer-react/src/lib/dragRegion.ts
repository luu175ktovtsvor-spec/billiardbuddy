// 无边框窗口拖拽区(macOS hiddenInset)。-webkit-app-region 非标准,csstype 不一定收录,故双 cast。
import type { CSSProperties } from 'react'

export const DRAG = { WebkitAppRegion: 'drag' } as unknown as CSSProperties
export const NODRAG = { WebkitAppRegion: 'no-drag' } as unknown as CSSProperties
