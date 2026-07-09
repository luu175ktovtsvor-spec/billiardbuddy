// 空态 hero(对标真机 WorkBuddy colleague-chat-empty:居中头像 + 标题[h1/500] + 描述[text-weak/body])。
// 头像 = 我们的绿色笑脸吉祥物(glow 变体);白标文案走 i18n。
import { t } from '../i18n'
import { Smiley } from '../components/shared/Smiley'

export function EmptyHero() {
  return (
    <div className="flex h-full flex-col items-center justify-center px-6 text-center" data-testid="empty-hero">
      <div className="mb-5">
        <Smiley size={56} variant="glow" />
      </div>
      <h1 className="mb-2 text-2xl font-medium" style={{ color: 'var(--color-text-primary)' }}>{t('chat.emptyHero')}</h1>
      <p className="max-w-[440px] text-sm leading-relaxed" style={{ color: 'var(--color-text-tertiary)' }}>{t('chat.emptyHint')}</p>
    </div>
  )
}

export function EmptySession() {
  return <EmptyHero />
}
