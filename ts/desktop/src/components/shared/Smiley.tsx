// 产品品牌标记。双色浅蓝背景随主题切换，白色表情保持稳定可见。
import { useId } from 'react'

interface SmileyProps {
  size?: number
  className?: string
  variant?: 'solid' | 'glow'
}

export function Smiley({ size = 24, className, variant = 'solid' }: SmileyProps) {
  const uid = useId().replace(/:/g, '')
  const gradientId = `smiley-gradient-${uid}`
  const glowId = `smiley-glow-${uid}`
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-smiley-a)" />
          <stop offset="1" stopColor="var(--color-smiley-b)" />
        </linearGradient>
        {variant === 'glow' && (
          <radialGradient id={glowId} cx="0.7" cy="0.28" r="0.7">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.32" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
        )}
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="7.5" fill={`url(#${gradientId})`} />
      {variant === 'glow' && <rect x="1" y="1" width="30" height="30" rx="7.5" fill={`url(#${glowId})`} />}
      <circle cx="11.6" cy="13.4" r="2.05" fill="#ffffff" />
      <circle cx="20.4" cy="13.4" r="2.05" fill="#ffffff" />
      <path
        d="M10.4 19.2c1.35 2.15 3.25 3.2 5.6 3.2s4.25-1.05 5.6-3.2"
        stroke="#ffffff"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
