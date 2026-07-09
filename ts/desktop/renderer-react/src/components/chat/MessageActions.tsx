// 消息操作条(对标真机 WorkBuddy:助手消息下方一排单色线性图标 复制/赞/踩/朗读/分享/更多,
// 后接 muted「共消耗 ◇ {cost}」+ 时间戳「7月5日 15:15」)。悬停消息组时淡入(qf-msg-actions)。
import { useState, type ReactNode } from 'react'
import { IconCopy, IconThumbsUp, IconThumbsDown, IconVolume, IconShareUp, IconMoreHorizontal } from '../shared/icons'
import { t } from '../../i18n'

function fmtStamp(ts: number): string {
  try {
    const d = new Date(ts)
    const hh = String(d.getHours()).padStart(2, '0')
    const mm = String(d.getMinutes()).padStart(2, '0')
    return `${d.getMonth() + 1}月${d.getDate()}日 ${hh}:${mm}`
  } catch {
    return ''
  }
}

function ActBtn({ label, active, onClick, children }: { label: string; active?: boolean; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: active ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)' }}
    >
      {children}
    </button>
  )
}

export function MessageActions({ text, ts, tokens, pinned }: { text: string; ts?: number; tokens?: number; pinned?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [vote, setVote] = useState<null | 'up' | 'down'>(null)

  function copy() {
    try {
      void navigator.clipboard?.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* noop */
    }
  }
  function speak() {
    try {
      const u = new SpeechSynthesisUtterance(text)
      u.lang = 'zh-CN'
      window.speechSynthesis?.cancel()
      window.speechSynthesis?.speak(u)
    } catch {
      /* noop */
    }
  }

  return (
    <div className={`${pinned ? '' : 'qf-msg-actions'} mt-1 flex items-center gap-0.5`} data-testid="message-actions">
      <ActBtn label={copied ? t('actions.copied') : t('actions.copy')} onClick={copy}>
        <IconCopy size={14} />
      </ActBtn>
      <ActBtn label={t('actions.like')} active={vote === 'up'} onClick={() => setVote((v) => (v === 'up' ? null : 'up'))}>
        <IconThumbsUp size={14} />
      </ActBtn>
      <ActBtn label={t('actions.dislike')} active={vote === 'down'} onClick={() => setVote((v) => (v === 'down' ? null : 'down'))}>
        <IconThumbsDown size={14} />
      </ActBtn>
      <ActBtn label={t('actions.speak')} onClick={speak}>
        <IconVolume size={14} />
      </ActBtn>
      <ActBtn label={t('actions.share')}>
        <IconShareUp size={14} />
      </ActBtn>
      <ActBtn label={t('actions.more')}>
        <IconMoreHorizontal size={14} />
      </ActBtn>
      {(typeof tokens === 'number' || typeof ts === 'number') && (
        <span className="ml-2 flex items-center gap-2 text-xs tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
          {typeof tokens === 'number' && <span>{t('chat.consumed')} {tokens.toLocaleString()} tokens</span>}
          {typeof ts === 'number' && <span>{fmtStamp(ts)}</span>}
        </span>
      )}
    </div>
  )
}
