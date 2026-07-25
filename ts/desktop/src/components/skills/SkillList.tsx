import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '../../i18n'
import { productTaskCommandsApi, type ProductTaskSkillCommand } from '../../product/api/taskCommands'
import { useCurrentProductTaskContext } from '../../product/currentProductTaskContext'

export function SkillList() {
  const t = useTranslation()
  const { workDir } = useCurrentProductTaskContext()
  const [skills, setSkills] = useState<ProductTaskSkillCommand[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(false)

    productTaskCommandsApi.listSkills(workDir ?? '')
      .then(({ commands }) => {
        if (cancelled) return
        setSkills(commands)
        setLoading(false)
      })
      .catch(() => {
        if (cancelled) return
        setSkills([])
        setError(true)
        setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [workDir])

  const orderedSkills = useMemo(
    () => [...skills].sort((left, right) => left.displayName.localeCompare(right.displayName)),
    [skills],
  )

  return (
    <section className="overflow-hidden rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)]">
      <div className="p-5">
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
        <p className="mt-2 text-xs text-[var(--color-text-tertiary)]">
          {workDir ? t('settings.skills.currentProject') : t('settings.skills.defaultContext')}
        </p>
      </div>

      <div className="border-t border-[var(--color-border)]">
        {loading ? (
          <div className="px-5 py-8 text-center text-sm text-[var(--color-text-tertiary)]" role="status">
            {t('settings.skills.loading')}
          </div>
        ) : error ? (
          <div className="px-5 py-8 text-center text-sm text-[var(--color-error)]" role="alert">
            {t('settings.skills.loadFailed')}
          </div>
        ) : orderedSkills.length === 0 ? (
          <div className="px-5 py-8 text-center text-sm text-[var(--color-text-tertiary)]">
            {t('settings.skills.empty')}
          </div>
        ) : (
          orderedSkills.map((skill) => (
            <article key={skill.runtimeName} className="border-t border-[var(--color-border)] px-5 py-4 first:border-t-0">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h4 className="text-sm font-semibold text-[var(--color-text-primary)]">{skill.displayName}</h4>
                  <p className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">{skill.description}</p>
                </div>
                <span className="shrink-0 rounded-full border border-[var(--color-border)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-text-tertiary)]">
                  {t('settings.skills.ready')}
                </span>
              </div>
            </article>
          ))
        )}
      </div>
    </section>
  )
}
