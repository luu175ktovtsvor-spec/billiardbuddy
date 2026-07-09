// 空态 hero(对齐 cc EmptySession)。白标文案走 i18n zh-CN。
import { t } from '../i18n'

export function EmptyHero() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center" data-testid="empty-hero">
      <div
        className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl text-2xl"
        style={{ background: 'var(--color-brand-tint)', color: 'var(--color-brand)' }}
      >
        ✦
      </div>
      <h1 className="mb-2 text-xl font-semibold" style={{ color: 'var(--color-text-primary)' }}>{t('chat.emptyHero')}</h1>
      <p className="max-w-[420px] text-sm" style={{ color: 'var(--color-text-secondary)' }}>{t('chat.emptyHint')}</p>
    </div>
  )
}

export function EmptySession() {
  return <EmptyHero />
}
