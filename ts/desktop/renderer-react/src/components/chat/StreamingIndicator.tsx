// 首个活动事件到达前的轻量等待行。思考、工具或正文一旦出现，状态由对应活动行接管。
import { useChatStore } from '../../stores/chatStore'
import type { ChatBlock } from '../../stores/chatStore'
import { t } from '../../i18n'

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}m${s}s`
}

export function StreamingIndicator() {
  const status = useChatStore((s) => s.status)
  const blocks = useChatStore((s) => s.blocks)
  const elapsedSeconds = useChatStore((s) => s.elapsedSeconds)
  if (!shouldShowInitialWaiting(status, blocks)) return null

  return (
    <div className="mb-2 mt-3" data-testid="streaming-indicator">
      <span className="qf-shimmer-text text-[12px]" style={{ color: 'var(--color-text-secondary)' }}>
        {t('chat.working')}{elapsedSeconds > 0 ? ` ${formatElapsed(elapsedSeconds)}` : ''}
      </span>
      <div className="mt-1.5 w-full border-t" style={{ borderColor: 'var(--color-border)' }} />
    </div>
  )
}

export function shouldShowInitialWaiting(status: 'idle' | 'running', blocks: ChatBlock[]): boolean {
  if (status !== 'running') return false
  let lastUserIndex = -1
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i]?.kind === 'user') {
      lastUserIndex = i
      break
    }
  }
  return !blocks.slice(lastUserIndex + 1).some((block) => block.kind !== 'note')
}
