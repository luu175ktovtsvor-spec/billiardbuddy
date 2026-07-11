// 分享弹窗(照 Codex/ChatGPT「分享对话」:生成只读链接 + 复制)。前端壳:链接为占位,
// 后端就绪后换成真实分享 API 返回的 URL。复制走浏览器剪贴板(纯前端可用)。
import { useState } from 'react'
import { Modal } from '../shared/Modal'
import { IconCopy, IconShareUp } from '../shared/icons'
import { t } from '../../i18n'

export function ShareModal({ open, onClose, title }: { open: boolean; onClose: () => void; title?: string }) {
  const [copied, setCopied] = useState(false)
  // 占位链接(后端就绪前用固定域 + 短 id 展示形态)。
  const link = `https://球房管家.app/s/${(title || 'chat').slice(0, 8)}-preview`

  const copy = () => {
    try {
      void navigator.clipboard?.writeText(link)
      setCopied(true)
      setTimeout(() => setCopied(false), 1400)
    } catch {
      /* noop */
    }
  }

  return (
    <Modal open={open} onClose={onClose} title={t('share.title')} maxWidth={480} testId="share-modal">
      <div className="px-5 py-4">
        <div className="mb-3 flex items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: 'var(--color-surface-container)', color: 'var(--color-brand)' }}>
            <IconShareUp size={18} />
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>{title || t('sidebar.newChat')}</div>
            <div className="text-[12px]" style={{ color: 'var(--color-text-tertiary)' }}>{t('share.hint')}</div>
          </div>
        </div>

        <div className="flex items-center gap-2 rounded-lg px-3 py-2" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)' }}>
          <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>{link}</span>
          <button
            type="button"
            onClick={copy}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12.5px] font-medium text-white transition-opacity hover:opacity-90"
            style={{ background: 'var(--color-brand)' }}
          >
            <IconCopy size={13} /> {copied ? t('actions.copied') : t('share.copy')}
          </button>
        </div>

        <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{t('share.note')}</p>
      </div>
    </Modal>
  )
}
