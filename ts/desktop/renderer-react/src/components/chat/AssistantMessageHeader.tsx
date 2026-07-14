// Agent 活动分隔行。当前 Codex 只折叠思考/工具等过程，最终回复始终留在正文流中。
import { IconChevronDown } from '../shared/icons'
import { t } from '../../i18n'

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return remaining > 0 ? `${minutes}m ${remaining}s` : `${minutes}m`
}

export function AssistantMessageHeader({
  active,
  elapsedSec,
  durationSec,
  collapsed,
  onToggle,
}: {
  active: boolean
  elapsedSec?: number
  durationSec?: number
  collapsed: boolean
  onToggle: () => void
}) {
  const seconds = active ? elapsedSec : durationSec
  const statusText = `${active ? t('chat.working') : t('chat.processed')}${typeof seconds === 'number' && seconds > 0 ? ` ${formatElapsed(seconds)}` : ''}`

  return (
    <div className="mb-2 mt-3" data-block="assistant-header">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex items-center gap-1 rounded-md border border-transparent py-0.5 pr-1 text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ color: 'var(--color-text-secondary)' }}
      >
        <span className={active ? 'qf-shimmer-text' : undefined}>{statusText}</span>
        <IconChevronDown size={11} style={{ transform: collapsed ? 'rotate(-90deg)' : undefined, transition: 'transform .15s ease' }} />
      </button>
      <div className="mt-1.5 w-full border-t" style={{ borderColor: 'var(--color-border)' }} />
    </div>
  )
}
