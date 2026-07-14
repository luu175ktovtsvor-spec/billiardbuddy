// 当前 Codex Reasoning：进行中自动展开并跟随最新内容，完成后折叠为「已完成思考」。
import { useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { t } from '../../i18n'

export function ThinkingBlock({ content, isActive }: { content: string; isActive: boolean }) {
  const [expanded, setExpanded] = useState(isActive)
  const wasActiveRef = useRef(isActive)
  const contentRef = useRef<HTMLDivElement>(null)
  const displayContent = useMemo(() => content.replace(/\r\n?/g, '\n').trimEnd(), [content])
  const hasContent = displayContent.trim().length > 0

  useEffect(() => {
    if (isActive) setExpanded(true)
    else if (wasActiveRef.current) setExpanded(false)
    wasActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    if (expanded && isActive && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight
    }
  }, [displayContent, expanded, isActive])

  return (
    <div className="mb-1.5" data-block="thinking">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="group flex max-w-full items-center gap-1 rounded-md border border-transparent py-0.5 pr-1 text-left text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ color: 'var(--color-text-tertiary)' }}
      >
        <span className={isActive ? 'qf-shimmer-text min-w-0 truncate' : 'min-w-0 truncate'}>
          {isActive ? t('thinking.active') : t('thinking.done')}
        </span>
        {hasContent && <span className="shrink-0 text-[10px] opacity-60 transition-transform group-hover:opacity-100" style={{ transform: expanded ? 'rotate(180deg)' : undefined }}>⌄</span>}
      </button>
      {expanded && hasContent && (
        <div
          ref={contentRef}
          className="relative mt-1 max-h-[140px] overflow-y-auto pr-2 text-[12px]"
          style={{ color: 'var(--color-text-secondary)' }}
        >
          <MarkdownRenderer content={displayContent} />
        </div>
      )}
    </div>
  )
}
