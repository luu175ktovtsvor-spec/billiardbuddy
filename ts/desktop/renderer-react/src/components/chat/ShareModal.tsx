// 分享弹窗:把整段对话复制成文字,店主可直接粘贴到微信/备忘录。
// 全本地单用户软件没有可分享的在线链接;此前的「只读链接」是凭空占位域名,店主真会复制发人 → 恶性误导,已废弃。
import { useMemo, useState } from 'react'
import { Modal } from '../shared/Modal'
import { IconCopy, IconShareUp } from '../shared/icons'
import { useChatStore } from '../../stores/chatStore'
import { t } from '../../i18n'

/** 把当前会话的可读内容(我/管家的对话正文)拼成纯文本;思考过程/工具过程/系统提示不进分享稿。
 *  也供顶栏「···」菜单的「复制整段对话」复用(对齐 Codex threadHeader.copyConversationMarkdown)。 */
export function composeConversationText(title: string | undefined): string {
  const blocks = useChatStore.getState().blocks
  const lines: string[] = []
  if (title) lines.push(`【${title}】`, '')
  for (const b of blocks) {
    if (b.kind === 'user' && b.text.trim()) lines.push(`我:${b.text.trim()}`, '')
    else if (b.kind === 'assistant' && !b.streaming && b.text.trim()) lines.push(`管家:${b.text.trim()}`, '')
  }
  return lines.join('\n').trim()
}

export function ShareModal({ open, onClose, title }: { open: boolean; onClose: () => void; title?: string }) {
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => (open ? composeConversationText(title) : ''), [open, title])
  const empty = !text

  const copy = () => {
    if (empty) return
    try {
      void navigator.clipboard?.writeText(text)
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

        {/* 分享稿预览(让店主知道复制的是什么) */}
        <div className="max-h-[180px] overflow-y-auto whitespace-pre-wrap rounded-lg px-3 py-2 text-[12.5px] leading-relaxed" style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)', color: 'var(--color-text-secondary)' }}>
          {empty ? '这段对话还没有可分享的内容。' : text}
        </div>

        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={copy}
            disabled={empty}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-opacity hover:opacity-90"
            style={{ background: 'var(--color-brand)', color: 'var(--color-on-primary)', opacity: empty ? 0.5 : 1 }}
          >
            <IconCopy size={13} /> {copied ? t('actions.copied') : t('share.copy')}
          </button>
        </div>

        <p className="mt-3 text-[12px] leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{t('share.note')}</p>
      </div>
    </Modal>
  )
}
