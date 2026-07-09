// 品牌笑脸吉祥物(球房管家)。三分法白标落点:去绿风格里唯一的绿 = 这个笑脸。
// 绿取自真机 WorkBuddy logo-workbuddy.svg 的渐变(#0EC7A8→#00C885);用主题 token --color-smiley-*,
// 暗色自动提亮。造型是我们自己的圆角方 + 友好笑脸(不搬 WorkBuddy 的商标 mascot),用在品牌行/底部头像/欢迎屏/favicon。
import { useId } from 'react'

interface SmileyProps {
  size?: number
  className?: string
  /** 'solid'(默认)= 绿渐变圆角方 + 白脸;'glow' 额外加柔光,用于欢迎屏 hero。 */
  variant?: 'solid' | 'glow'
}

export function Smiley({ size = 24, className, variant = 'solid' }: SmileyProps) {
  const uid = useId().replace(/:/g, '')
  const gid = `sm-grad-${uid}`
  const fid = `sm-glow-${uid}`
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
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="var(--color-smiley-a)" />
          <stop offset="1" stopColor="var(--color-smiley-b)" />
        </linearGradient>
        {variant === 'glow' && (
          <radialGradient id={fid} cx="0.7" cy="0.28" r="0.7">
            <stop offset="0" stopColor="#FFE255" stopOpacity="0.45" />
            <stop offset="1" stopColor="#FFE255" stopOpacity="0" />
          </radialGradient>
        )}
      </defs>
      <rect x="1" y="1" width="30" height="30" rx="7.5" fill={`url(#${gid})`} />
      {variant === 'glow' && <rect x="1" y="1" width="30" height="30" rx="7.5" fill={`url(#${fid})`} />}
      {/* 友好笑脸:两只圆眼 + 上扬嘴角(白) */}
      <circle cx="11.6" cy="13.4" r="2.05" fill="#FFFFFF" />
      <circle cx="20.4" cy="13.4" r="2.05" fill="#FFFFFF" />
      <path
        d="M10.4 19.2c1.35 2.15 3.25 3.2 5.6 3.2s4.25-1.05 5.6-3.2"
        stroke="#FFFFFF"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
