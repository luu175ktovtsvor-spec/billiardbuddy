import {
  forwardRef,
  type HTMLAttributes,
  type ReactNode,
} from 'react'

type ComposerFrameProps = {
  children: ReactNode
  className?: string
}

export function ComposerFrame({ children, className = '' }: ComposerFrameProps) {
  return (
    <div
      className={`relative mx-auto flex w-full flex-col ${className}`}
      style={{ maxWidth: 768 }}
    >
      {children}
    </div>
  )
}

export const ComposerSurface = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function ComposerSurface({ className = '', style, ...props }, ref) {
    return (
      <div
        ref={ref}
        className={`main-composer-surface composer-surface-chrome relative flex flex-col overflow-visible rounded-[20px] backdrop-blur-lg ${className}`}
        style={{
          background: 'color-mix(in srgb, var(--color-surface) 90%, transparent)',
          boxShadow: 'var(--shadow-input)',
          ...style,
        }}
        {...props}
      />
    )
  },
)

type ComposerToolbarProps = {
  start?: ReactNode
  middle?: ReactNode
  end?: ReactNode
  testId?: string
}

export function ComposerToolbar({ start, middle, end, testId }: ComposerToolbarProps) {
  return (
    <div
      data-testid={testId}
      className="mb-2 grid min-h-8 grid-cols-[minmax(0,auto)_auto_minmax(0,1fr)] items-center gap-x-[5px] px-2 select-none"
    >
      <div className="flex min-w-0 items-center">{start}</div>
      <div className="flex min-w-0 items-center">{middle}</div>
      <div className="flex min-w-0 items-center justify-end gap-1">{end}</div>
    </div>
  )
}
