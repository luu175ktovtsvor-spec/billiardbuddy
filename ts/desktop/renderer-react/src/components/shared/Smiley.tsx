// 产品品牌标记。颜色随浅色和深色主题切换，不承担界面强调色职责。

interface SmileyProps {
  size?: number
  className?: string
}

export function Smiley({ size = 24, className }: SmileyProps) {
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
      <rect x="1" y="1" width="30" height="30" rx="7.5" fill="var(--color-smiley-a)" />
      <circle cx="11.6" cy="13.4" r="2.05" fill="var(--color-smiley-face)" />
      <circle cx="20.4" cy="13.4" r="2.05" fill="var(--color-smiley-face)" />
      <path
        d="M10.4 19.2c1.35 2.15 3.25 3.2 5.6 3.2s4.25-1.05 5.6-3.2"
        stroke="var(--color-smiley-face)"
        strokeWidth="2.2"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  )
}
