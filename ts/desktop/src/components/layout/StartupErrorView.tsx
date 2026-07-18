import { RefreshCw } from 'lucide-react'
import { useTranslation } from '../../i18n'
import { Button } from '../shared/Button'
import { DoctorPanel } from '../doctor/DoctorPanel'

const SAFE_STARTUP_ERROR_CODE = 'BB_STARTUP_FAILED'

export function safeStartupErrorCode(error: string): string {
  return error === SAFE_STARTUP_ERROR_CODE ? error : SAFE_STARTUP_ERROR_CODE
}

type StartupErrorViewProps = {
  error: string
}

export function StartupErrorView({ error }: StartupErrorViewProps) {
  const t = useTranslation()
  const errorCode = safeStartupErrorCode(error)

  return (
    <div className="h-screen flex items-center justify-center bg-[var(--color-surface)] px-6">
      <section className="w-full max-w-3xl rounded-lg border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-6 shadow-[var(--shadow-md)]">
        <div className="flex flex-col gap-4">
          <div>
            <h1 className="text-lg font-semibold text-[var(--color-text-primary)]">
              {t('app.serverFailed')}
            </h1>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              {t('app.serverFailedHint')}
            </p>
          </div>

          <div className="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
            <div className="text-xs font-medium uppercase text-[var(--color-text-tertiary)]">
              {t('app.startupError')}
            </div>
            <p className="mt-2 text-sm text-[var(--color-text-secondary)]">
              {t('app.startupErrorCode', { code: errorCode })}
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              icon={<RefreshCw className="h-4 w-4" aria-hidden="true" />}
              onClick={() => window.location.reload()}
            >
              {t('common.retry')}
            </Button>
          </div>

          <DoctorPanel compact />
        </div>
      </section>
    </div>
  )
}
