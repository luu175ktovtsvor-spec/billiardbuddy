// 共享按钮原语。
import type { ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'ghost' | 'danger'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
}

const base = 'inline-flex items-center justify-center gap-1.5 rounded-lg text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed px-3 py-1.5'

const styles: Record<Variant, string> = {
  primary: '',
  ghost: 'hover:bg-[var(--color-surface-hover)] text-[var(--color-text-secondary)]',
  danger: 'text-[var(--color-error)] hover:bg-[var(--color-surface-hover)]',
}

export function Button({ variant = 'ghost', className = '', style, ...rest }: ButtonProps) {
  const merged =
    variant === 'primary'
      ? { background: 'var(--color-primary)', color: 'var(--color-on-primary)', ...style }
      : style
  return <button className={`${base} ${styles[variant]} ${className}`} style={merged} {...rest} />
}
