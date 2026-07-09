// 品牌笑脸(BilliardBuddy = 亲和的 Buddy)。inline SVG,不引外部资源;
// 用 currentColor 跟随主题墨色,和中性 WorkBuddy 皮协调。用在欢迎屏 hero、侧栏 logo 位、favicon 语义位。
interface SmileyProps {
  size?: number
  strokeWidth?: number
  className?: string
}

export function Smiley({ size = 24, strokeWidth = 1.7, className }: SmileyProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <circle cx="12" cy="12" r="9.3" stroke="currentColor" strokeWidth={strokeWidth} />
      <circle cx="9" cy="10" r="1.15" fill="currentColor" />
      <circle cx="15" cy="10" r="1.15" fill="currentColor" />
      <path
        d="M7.7 13.8c1.05 1.7 2.55 2.55 4.3 2.55s3.25-.85 4.3-2.55"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  )
}
