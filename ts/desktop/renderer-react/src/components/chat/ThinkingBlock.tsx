// 思考块(照 Codex Reasoning:折叠行显示「深度思考 · <内容一行摘要预览>」,展开看全文)。
// Codex 用 reasoningSummary 在折叠态露一行思考预览(进行中=最新一行、完成=首行摘要),
// 我们没有单独 summary,就从思考正文现取一行做预览。展开是 reasoningContent 全文 + 呼吸光标。
import { useEffect, useMemo, useRef, useState } from 'react'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { t } from '../../i18n'

export function ThinkingBlock({ content, isActive }: { content: string; isActive: boolean }) {
  const [expanded, setExpanded] = useState(false)
  const contentRef = useRef<HTMLDivElement>(null)
  const displayContent = useMemo(() => content.replace(/\r\n?/g, '\n').trimEnd(), [content])
  const hasContent = displayContent.trim().length > 0

  // 一行摘要预览(Codex reasoningSummary 风格):进行中取最新行,完成取首行。
  const preview = useMemo(() => {
    const lines = displayContent
      .split('\n')
      .map((l) => l.replace(/^[#>\-*\s]+/, '').replace(/[`*_]/g, '').trim())
      .filter(Boolean)
    if (lines.length === 0) return ''
    const line = isActive ? lines[lines.length - 1]! : lines[0]!
    return line.length > 64 ? `${line.slice(0, 64)}…` : line
  }, [displayContent, isActive])

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
        className="flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[12px] transition-colors hover:bg-[var(--color-surface-hover)]"
        style={{ color: 'var(--color-text-tertiary)' }}
      >
        {/* 对齐 Codex 真图:完成态无「已思考」前缀,直接思考内容灰斜体 + 尾随 ⌄;进行中保留「正在想」帮小白理解。 */}
        {isActive && (
          <span className="shrink-0 font-medium italic">
            {t('thinking.active')}
            <span className="qf-thinking-dots" />
          </span>
        )}
        {preview && (
          <span className="min-w-0 flex-1 truncate italic" style={{ color: 'var(--color-text-tertiary)', opacity: 0.8 }}>
            {isActive ? `· ${preview}` : preview}
          </span>
        )}
        <span className="shrink-0 text-[10px] transition-transform" style={{ transform: expanded ? 'rotate(180deg)' : undefined }}>⌄</span>
      </button>
      {expanded && hasContent && (
        <div
          ref={contentRef}
          className="qf-thinking-body relative mt-1 max-h-[300px] overflow-y-auto rounded-lg p-2.5 text-[11px]"
          style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-lowest)', color: 'var(--color-text-secondary)' }}
        >
          <MarkdownRenderer content={displayContent} />
          {isActive && <span className="qf-cursor">▍</span>}
        </div>
      )}
    </div>
  )
}
