// 助手消息操作条(照 Codex 本地对话真实截图:复制 / 分享 + 右侧完成时刻小灰字,如「星期四05:10」)。
// 2026-07-12 对齐真图:删赞/踩/朗读——Codex 本地版没有这些(旧观察来自网页版);评分等 dataeye 重接再议。
// 2026-07-11 口径保留:不显示每条 token 消耗、不画底部虚线;分享 = 打开「复制整段对话」弹窗。
import { useState, type ReactNode } from 'react'
import { IconCopy, IconShareUp } from '../shared/icons'
import { ShareModal } from './ShareModal'
import { t } from '../../i18n'

/** 消息完成时刻(照 Codex「星期四05:10」口径):今天只显时间,昨天/本周带星期,更早带日期。 */
export function fmtMessageTime(ts?: number): string {
  if (!ts || Number.isNaN(ts)) return ''
  const d = new Date(ts)
  const now = new Date()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  const dayStart = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diffDays = Math.floor((dayStart(now) - dayStart(d)) / 86400000)
  if (diffDays <= 0) return hm
  if (diffDays === 1) return `昨天${hm}`
  if (diffDays < 7) return `${['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'][d.getDay()]}${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

function ActBtn({ label, onClick, children }: { label: string; onClick?: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--color-surface-hover)]"
      style={{ color: 'var(--color-text-tertiary)' }}
    >
      {children}
    </button>
  )
}

export function MessageActions({ text, pinned, ts }: { text: string; pinned?: boolean; ts?: number }) {
  const [copied, setCopied] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)

  function copy() {
    try {
      void navigator.clipboard?.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* noop */
    }
  }

  const timeLabel = fmtMessageTime(ts)
  return (
    <div className={pinned ? '' : 'qf-msg-actions'}>
      <div className="mt-1 flex items-center gap-0.5" data-testid="message-actions">
        <ActBtn label={copied ? t('actions.copied') : t('actions.copy')} onClick={copy}>
          <IconCopy size={14} />
        </ActBtn>
        <ActBtn label={t('actions.share')} onClick={() => setShareOpen(true)}>
          <IconShareUp size={14} />
        </ActBtn>
        {timeLabel && (
          <span className="ml-1 text-[11.5px]" style={{ color: 'var(--color-text-tertiary)' }}>{timeLabel}</span>
        )}
      </div>
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  )
}
