import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react'

import {
  desktopUiPreferencesApi,
  getProfileAvatarUrl,
  type DesktopProfilePreferences,
} from '../api/desktopUiPreferences'
import { useTranslation } from '../i18n'
import { publicAssetPath } from '../lib/publicAsset'

const DEFAULT_PROFILE: DesktopProfilePreferences = {
  displayName: 'BilliardBuddy',
  subtitle: '',
  avatarFile: null,
  avatarUpdatedAt: null,
}

const DEFAULT_AVATAR_SRC = publicAssetPath('app-icon.png')

function withProfileDefaults(profile: Partial<DesktopProfilePreferences> | null | undefined): DesktopProfilePreferences {
  return { ...DEFAULT_PROFILE, ...profile }
}

export function ProfileSettings() {
  const t = useTranslation()
  const avatarInputRef = useRef<HTMLInputElement | null>(null)
  const [profile, setProfile] = useState<DesktopProfilePreferences>(DEFAULT_PROFILE)
  const [draftDisplayName, setDraftDisplayName] = useState(DEFAULT_PROFILE.displayName)
  const [draftSubtitle, setDraftSubtitle] = useState(DEFAULT_PROFILE.subtitle)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [errorKey, setErrorKey] = useState<'settings.general.profileLoadFailed' | 'settings.general.profileSaveFailed' | null>(null)

  const applyProfile = useCallback((nextProfile: Partial<DesktopProfilePreferences> | null | undefined) => {
    const normalizedProfile = withProfileDefaults(nextProfile)
    setProfile(normalizedProfile)
    setDraftDisplayName(normalizedProfile.displayName)
    setDraftSubtitle(normalizedProfile.subtitle)
  }, [])

  useEffect(() => {
    let cancelled = false
    setIsLoading(true)
    setErrorKey(null)

    desktopUiPreferencesApi.getPreferences()
      .then((result) => {
        if (!cancelled) applyProfile(result.preferences.profile)
      })
      .catch(() => {
        if (!cancelled) setErrorKey('settings.general.profileLoadFailed')
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [applyProfile])

  const saveProfile = async () => {
    setIsSaving(true)
    setErrorKey(null)
    setStatus(null)
    try {
      const result = await desktopUiPreferencesApi.updateProfilePreferences({
        displayName: draftDisplayName,
        subtitle: draftSubtitle,
      })
      applyProfile(result.preferences.profile)
      setStatus(t('settings.general.profileSaved'))
    } catch {
      setErrorKey('settings.general.profileSaveFailed')
    } finally {
      setIsSaving(false)
    }
  }

  const handleAvatarChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setIsSaving(true)
    setErrorKey(null)
    setStatus(null)
    try {
      const result = await desktopUiPreferencesApi.uploadProfileAvatar(file)
      applyProfile(result.preferences.profile)
      setStatus(t('settings.general.profileSaved'))
    } catch {
      setErrorKey('settings.general.profileSaveFailed')
    } finally {
      setIsSaving(false)
    }
  }

  const removeAvatar = async () => {
    setIsSaving(true)
    setErrorKey(null)
    setStatus(null)
    try {
      const result = await desktopUiPreferencesApi.deleteProfileAvatar()
      applyProfile(result.preferences.profile)
      setStatus(t('settings.general.profileSaved'))
    } catch {
      setErrorKey('settings.general.profileSaveFailed')
    } finally {
      setIsSaving(false)
    }
  }

  const avatarSrc = profile.avatarFile ? getProfileAvatarUrl(profile.avatarUpdatedAt) : DEFAULT_AVATAR_SRC
  const avatarClassName = profile.avatarFile
    ? 'h-full w-full object-cover'
    : 'h-full w-full scale-[1.28] object-contain'

  return (
    <section className="mb-8 border-b border-[var(--color-border)]/70 pb-8" data-testid="profile-settings">
      <h2 className="mb-1 text-base font-semibold text-[var(--color-text-primary)]">{t('settings.general.profileTitle')}</h2>
      <p className="mb-4 text-sm text-[var(--color-text-tertiary)]">{t('settings.general.profileDescription')}</p>

      <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface-container-low)] p-4">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full border border-[var(--color-border)] bg-[var(--color-surface-container-lowest)]">
            <img
              src={avatarSrc}
              alt={`${profile.displayName} avatar`}
              className={avatarClassName}
              onError={(event) => {
                event.currentTarget.src = DEFAULT_AVATAR_SRC
                event.currentTarget.className = 'h-full w-full scale-[1.28] object-contain'
              }}
            />
          </div>
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-[var(--color-text-primary)]">{profile.displayName}</div>
            {profile.subtitle && <div className="mt-0.5 truncate text-xs text-[var(--color-text-tertiary)]">{profile.subtitle}</div>}
          </div>
        </div>

        <form
          className="mt-5 grid gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void saveProfile()
          }}
        >
          <div className="grid gap-2">
            <label htmlFor="profile-display-name" className="text-xs font-medium text-[var(--color-text-secondary)]">
              {t('settings.general.profileDisplayName')}
            </label>
            <input
              id="profile-display-name"
              value={draftDisplayName}
              onChange={(event) => setDraftDisplayName(event.target.value)}
              disabled={isLoading || isSaving}
              className="h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>

          <div className="grid gap-2">
            <label htmlFor="profile-subtitle" className="text-xs font-medium text-[var(--color-text-secondary)]">
              {t('settings.general.profileSubtitle')}
            </label>
            <input
              id="profile-subtitle"
              value={draftSubtitle}
              onChange={(event) => setDraftSubtitle(event.target.value)}
              disabled={isLoading || isSaving}
              className="h-10 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text-primary)] outline-none transition-colors focus:border-[var(--color-border-focus)] disabled:cursor-not-allowed disabled:opacity-60"
            />
            <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.general.profileDisplayNameHelper')}</p>
          </div>

          <div className="grid gap-2">
            <div className="text-xs font-medium text-[var(--color-text-secondary)]">{t('settings.general.profileAvatar')}</div>
            <p className="text-xs text-[var(--color-text-tertiary)]">{t('settings.general.profileAvatarHelper')}</p>
            <div className="flex flex-wrap gap-2">
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-label={t('settings.general.profileAvatar')}
                className="hidden"
                onChange={handleAvatarChange}
              />
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-md border border-[var(--color-border)] px-2.5 text-xs font-medium text-[var(--color-text-secondary)] transition-[background-color,transform] hover:bg-[var(--color-surface-hover)] active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-50"
                onClick={() => avatarInputRef.current?.click()}
                disabled={isLoading || isSaving}
              >
                <span className="material-symbols-outlined text-[15px]" aria-hidden="true">upload</span>
                {t('settings.general.profileChangeAvatar')}
              </button>
              {profile.avatarFile && (
                <button
                  type="button"
                  className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium text-[var(--color-text-tertiary)] transition-[background-color,transform] hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-text-primary)] active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void removeAvatar()}
                  disabled={isSaving}
                >
                  {t('settings.general.profileRemoveAvatar')}
                </button>
              )}
            </div>
          </div>

          {errorKey && <div className="rounded-md border border-[var(--color-error)]/30 bg-[var(--color-error)]/10 px-3 py-2 text-xs text-[var(--color-error)]">{t(errorKey)}</div>}
          {status && <div className="text-xs text-[var(--color-success)]">{status}</div>}

          <div className="flex justify-end">
            <button
              type="submit"
              className="h-8 rounded-md bg-[var(--color-text-primary)] px-3 text-xs font-medium text-[var(--color-surface)] transition-[opacity,transform] active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isLoading || isSaving}
            >
              {t('settings.general.profileSave')}
            </button>
          </div>
        </form>
      </div>
    </section>
  )
}
