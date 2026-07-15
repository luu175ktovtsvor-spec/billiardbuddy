// Provider 原始 chain-of-thought 不是 Codex 的 reasoning summary，不在用户界面展开。
import { t } from '../../i18n'

export function ThinkingBlock({ content: _content, isActive }: { content: string; isActive: boolean }) {
  if (!isActive) return null
  return (
    <div className="mb-1.5 py-0.5 text-[12px]" data-block="thinking" style={{ color: 'var(--color-text-tertiary)' }}>
      <span className={isActive ? 'qf-shimmer-text' : undefined}>
        {t('thinking.active')}
      </span>
    </div>
  )
}
