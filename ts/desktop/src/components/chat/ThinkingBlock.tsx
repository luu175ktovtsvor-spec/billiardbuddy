import { useTranslation } from '../../i18n'

export function ThinkingBlock({ content: _content, isActive = false }: { content: string; isActive?: boolean }) {
  const t = useTranslation()

  if (!isActive) return null

  return (
    <div className="mb-1.5 py-0.5 text-[12px] text-[var(--color-text-tertiary)]" data-block="thinking">
      <span className="qf-shimmer-text">{t('thinking.label')}</span>
    </div>
  )
}
