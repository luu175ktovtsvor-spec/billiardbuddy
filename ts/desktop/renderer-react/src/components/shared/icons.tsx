// 图标集 —— 全 inline SVG 单色线性图标(不引 lucide/图标库,吃 currentColor 跟随主题)。
// 几何按通用 24x24 网格手写,线宽默认 1.7,圆角端点。用在侧栏/顶栏/输入框/消息操作条。
import type { SVGProps } from 'react'

interface IconProps extends SVGProps<SVGSVGElement> {
  size?: number
}

function Svg({ size = 16, strokeWidth = 1.7, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export const IconPanelLeft = (p: IconProps) => (
  <Svg {...p}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M9 3v18" /></Svg>
)
export const IconPanelRight = (p: IconProps) => (
  <Svg {...p}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M15 3v18" /></Svg>
)
export const IconSearch = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" /></Svg>
)
export const IconFilter = (p: IconProps) => (
  <Svg {...p}>
    <line x1="21" x2="14" y1="4" y2="4" /><line x1="10" x2="3" y1="4" y2="4" />
    <line x1="21" x2="12" y1="12" y2="12" /><line x1="8" x2="3" y1="12" y2="12" />
    <line x1="21" x2="16" y1="20" y2="20" /><line x1="12" x2="3" y1="20" y2="20" />
    <line x1="14" x2="14" y1="2" y2="6" /><line x1="8" x2="8" y1="10" y2="14" /><line x1="16" x2="16" y1="18" y2="22" />
  </Svg>
)
export const IconPlusCircle = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M8 12h8" /><path d="M12 8v8" /></Svg>
)
export const IconPlus = (p: IconProps) => (
  <Svg {...p}><path d="M5 12h14" /><path d="M12 5v14" /></Svg>
)
export const IconUser = (p: IconProps) => (
  <Svg {...p}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></Svg>
)
export const IconBranch = (p: IconProps) => (
  <Svg {...p}><line x1="6" x2="6" y1="3" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" /></Svg>
)
export const IconSparkles = (p: IconProps) => (
  <Svg {...p}><path d="M9.9 15.5A2 2 0 0 0 8.5 14.1l-6.1-1.6a.5.5 0 0 1 0-1L8.5 9.9A2 2 0 0 0 9.9 8.5l1.6-6.1a.5.5 0 0 1 1 0L14.1 8.5A2 2 0 0 0 15.5 9.9l6.1 1.6a.5.5 0 0 1 0 1L15.5 14.1a2 2 0 0 0-1.4 1.4l-1.6 6.1a.5.5 0 0 1-1 0z" /></Svg>
)
export const IconZap = (p: IconProps) => (
  <Svg {...p}><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z" /></Svg>
)
export const IconGrid = (p: IconProps) => (
  <Svg {...p}><rect width="18" height="18" x="3" y="3" rx="2" /><path d="M3 9h18" /><path d="M3 15h18" /><path d="M9 3v18" /><path d="M15 3v18" /></Svg>
)
export const IconChevronDown = (p: IconProps) => (
  <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>
)
export const IconChevronRight = (p: IconProps) => (
  <Svg {...p}><path d="m9 18 6-6-6-6" /></Svg>
)
export const IconBell = (p: IconProps) => (
  <Svg {...p}><path d="M10.3 21a2 2 0 0 0 3.4 0" /><path d="M3.3 15.3A1 1 0 0 0 4 17h16a1 1 0 0 0 .7-1.7C19.4 14 18 12.5 18 8A6 6 0 0 0 6 8c0 4.5-1.4 6-2.7 7.3" /></Svg>
)
export const IconShareUp = (p: IconProps) => (
  <Svg {...p}><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" /><path d="m8 6 4-4 4 4" /><path d="M12 2v13" /></Svg>
)
export const IconClock = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>
)
export const IconShield = (p: IconProps) => (
  <Svg {...p}><path d="M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.7 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.5 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1z" /></Svg>
)
export const IconMic = (p: IconProps) => (
  <Svg {...p}><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" /><path d="M19 10v2a7 7 0 0 1-14 0v-2" /><line x1="12" x2="12" y1="19" y2="22" /></Svg>
)
export const IconArrowUp = (p: IconProps) => (
  <Svg {...p}><path d="m5 12 7-7 7 7" /><path d="M12 19V5" /></Svg>
)
export const IconSun = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.9 4.9 1.4 1.4" /><path d="m17.7 17.7 1.4 1.4" /><path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.3 17.7-1.4 1.4" /><path d="m19.1 4.9-1.4 1.4" /></Svg>
)
export const IconMoon = (p: IconProps) => (
  <Svg {...p}><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" /></Svg>
)
export const IconCopy = (p: IconProps) => (
  <Svg {...p}><rect width="13" height="13" x="9" y="8" rx="2" /><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" /></Svg>
)
export const IconThumbsUp = (p: IconProps) => (
  <Svg {...p}><path d="M7 10v12" /><path d="M15 5.9 14 10h5.8a2 2 0 0 1 2 2.6l-2.3 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.8a2 2 0 0 0 1.8-1.1L12 2a3.1 3.1 0 0 1 3 3.9Z" /></Svg>
)
export const IconThumbsDown = (p: IconProps) => (
  <Svg {...p}><path d="M17 14V2" /><path d="M9 18.1 10 14H4.2a2 2 0 0 1-2-2.6l2.3-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.8a2 2 0 0 0-1.8 1.1L12 22a3.1 3.1 0 0 1-3-3.9Z" /></Svg>
)
export const IconVolume = (p: IconProps) => (
  <Svg {...p}><path d="M11 5 6 9H2v6h4l5 4V5z" /><path d="M15.5 8.5a5 5 0 0 1 0 7" /><path d="M18.5 6a9 9 0 0 1 0 12" /></Svg>
)
export const IconMoreHorizontal = ({ size = 16, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false" {...rest}>
    <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
  </svg>
)
export const IconAt = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" /></Svg>
)
export const IconSlash = (p: IconProps) => (
  <Svg {...p}><path d="M9 20 15 4" /></Svg>
)
export const IconSpinner = ({ size = 16, className, ...rest }: IconProps) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true" className={`qf-spin ${className ?? ''}`} {...rest}>
    <path d="M12 3a9 9 0 1 0 9 9" />
  </svg>
)
