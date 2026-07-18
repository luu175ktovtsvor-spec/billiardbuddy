import { useTranslation } from '../../i18n'

/**
 * Product-facing Skills surface. The Agent selects private Skill instructions
 * from the user's business goal; this page never enumerates their names or
 * implementation files.
 */
export function SkillList() {
  const t = useTranslation()

  return (
    <section className="rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[var(--color-text-tertiary)]">
        {t('settings.skills.browserEyebrow')}
      </div>
      <div className="mt-2 flex items-center gap-3">
        <span className="material-symbols-outlined text-[22px] text-[var(--color-brand)]">auto_awesome</span>
        <h3 className="text-lg font-semibold text-[var(--color-text-primary)]">
          {t('settings.skills.browserTitle')}
        </h3>
      </div>
      <p className="mt-3 max-w-3xl text-sm leading-6 text-[var(--color-text-secondary)]">
        {t('settings.skills.browserDescription')}
      </p>
      <div className="mt-5 rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text-secondary)]">
        {t('settings.skills.ready')}
      </div>
    </section>
  )
}
