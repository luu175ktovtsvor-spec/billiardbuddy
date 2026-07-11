// 助手消息操作条(照 Codex:悬停消息组时淡入一排单色线性图标 复制/赞/踩/朗读/分享)。
// 2026-07-11:去掉旧 WorkBuddy 残留——**不显示每条 token 消耗、不显示每条时间戳、不画底部虚线**
// (Codex 这几样都没有,且前端不甩 token 角标)。只保留纯图标行。
// 分享 = 打开「复制整段对话」弹窗;「更多」没有真动作可放,已删(死按钮不如不放)。
// 赞/踩暂为本地视觉态(无后端消费方,等 dataeye 上报重接时一并接)。
import { useState, type ReactNode } from 'react'
import { IconCopy, IconThumbsUp, IconThumbsDown, IconVolume, IconShareUp } from '../shared/icons'
import { ShareModal } from './ShareModal'
import { t } from '../../i18n'

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

export function MessageActions({ text, pinned }: { text: string; pinned?: boolean }) {
  const [copied, setCopied] = useState(false)
  const [vote, setVote] = useState<null | 'up' | 'down'>(null)
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
    <div className={pinned ? '' : 'qf-msg-actions'}>
      <div className="mt-1 flex items-center gap-0.5" data-testid="message-actions">
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
        <ActBtn label={t('actions.share')} onClick={() => setShareOpen(true)}>
          <IconShareUp size={14} />
        </ActBtn>
      </div>
      <ShareModal open={shareOpen} onClose={() => setShareOpen(false)} />
    </div>
  )
}
