import { DirectoryPicker } from '../shared/DirectoryPicker'
import { useTranslation } from '../../i18n'

type Props = {
  value: string
  onChange: (value: string) => void
  placeholder?: string

  folderPath: string
  onFolderPathChange: (path: string) => void
}

export function PromptEditor({
  value,
  onChange,
  placeholder,
  folderPath,
  onFolderPathChange,
}: Props) {
  const t = useTranslation()
  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--color-border)] focus-within:border-[var(--color-border-focus)] transition-colors overflow-visible">
      {/* Prompt textarea */}
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={4}
        className="w-full resize-y bg-transparent px-3 py-2.5 text-sm leading-relaxed text-[var(--color-text-primary)] outline-none placeholder:text-[var(--color-text-tertiary)]"
        style={{ minHeight: 120 }}
      />

      {/* Bottom toolbar */}
      <div className="border-t border-[var(--color-border)]/40 px-3 py-2 flex flex-col gap-2 bg-[var(--color-surface-container-low)] rounded-b-[var(--radius-lg)]">
        <div className="flex items-center">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-[var(--color-surface-info)] px-2.5 py-1.5 text-xs font-medium text-[var(--color-text-primary)]">
            <span className="material-symbols-outlined text-[14px]">shield</span>
            {t('newTask.unattendedSafeMode')}
          </div>
        </div>

        {/* Row 2: Folder picker */}
        <div className="flex items-center justify-between">
          <DirectoryPicker value={folderPath} onChange={onFolderPathChange} />
        </div>

        <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-md bg-[var(--color-surface-info)] text-[10px] text-[var(--color-text-secondary)]">
          <span className="material-symbols-outlined text-[12px]">info</span>
          {t('newTask.unattendedSafeModeHint')}
        </div>
      </div>
    </div>
  )
}
