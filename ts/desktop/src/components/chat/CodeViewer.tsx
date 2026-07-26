import { useState } from 'react'
import { Highlight, type PrismTheme } from 'prism-react-renderer'
import { CopyButton } from '../shared/CopyButton'

type Props = {
  code: string
  language?: string
  maxLines?: number
  showLineNumbers?: boolean
  wrapLongLines?: boolean
}

const warmPrismTheme: PrismTheme = {
  plain: {
    color: 'var(--color-code-fg)',
    backgroundColor: 'transparent',
  },
  styles: [
    { types: ['comment', 'prolog', 'doctype', 'cdata'], style: { color: 'var(--color-code-comment)', fontStyle: 'italic' as const } },
    { types: ['string', 'attr-value', 'template-string'], style: { color: 'var(--color-code-string)' } },
    { types: ['keyword', 'selector', 'important', 'atrule'], style: { color: 'var(--color-code-keyword)' } },
    { types: ['function'], style: { color: 'var(--color-code-function)' } },
    { types: ['tag'], style: { color: 'var(--color-code-keyword)' } },
    { types: ['number', 'boolean'], style: { color: 'var(--color-code-number)' } },
    { types: ['operator'], style: { color: 'var(--color-code-fg)' } },
    { types: ['punctuation'], style: { color: 'var(--color-code-punctuation)' } },
    { types: ['variable', 'parameter'], style: { color: 'var(--color-code-fg)' } },
    { types: ['property', 'attr-name'], style: { color: 'var(--color-code-property)' } },
    { types: ['builtin', 'class-name', 'constant', 'symbol'], style: { color: 'var(--color-code-type)' } },
    { types: ['regex'], style: { color: 'var(--color-primary-container)' } },
    { types: ['inserted'], style: { color: 'var(--color-code-inserted)' } },
    { types: ['deleted'], style: { color: 'var(--color-code-deleted)' } },
  ],
}

const CODE_AREA_PADDING = '0.5rem 12px'
const CODE_LINE_HEIGHT = 1.3

function PrismCodeContent({
  code,
  language,
  showLineNumbers,
  wrapLongLines,
}: {
  code: string
  language?: string
  showLineNumbers: boolean
  wrapLongLines: boolean
}) {
  return (
    <Highlight
      theme={warmPrismTheme}
      code={code}
      language={language || 'text'}
    >
      {({ tokens, getLineProps, getTokenProps }) => (
        <pre
          data-code-viewer-content=""
          data-highlight-engine="prism"
          style={{
            margin: 0,
            padding: CODE_AREA_PADDING,
            fontFamily: 'var(--font-mono)',
            fontSize: '12px',
            lineHeight: String(CODE_LINE_HEIGHT),
            whiteSpace: wrapLongLines ? 'pre-wrap' : 'pre',
            wordBreak: wrapLongLines ? 'break-word' : 'normal',
            color: 'var(--color-code-fg)',
          }}
        >
          {tokens.map((line, index) => (
            <span
              key={index}
              {...getLineProps({ line })}
              data-line-number={showLineNumbers ? index + 1 : undefined}
            >
              {showLineNumbers && (
                <span className="mr-3 inline-block min-w-[2.5ch] select-none text-right text-[var(--color-text-tertiary)]">
                  {index + 1}
                </span>
              )}
              {line.map((token, key) => (
                <span key={key} {...getTokenProps({ token })} />
              ))}
            </span>
          ))}
        </pre>
      )}
    </Highlight>
  )
}

function CodeArea({
  code,
  language,
  showLineNumbers,
  wrapLongLines,
}: {
  code: string
  language?: string
  showLineNumbers: boolean
  wrapLongLines: boolean
}) {
  return (
    <div
      data-has-line-numbers={showLineNumbers ? 'true' : 'false'}
      className="code-viewer-area relative max-h-[420px] overflow-auto bg-[var(--color-code-bg)]"
    >
      <PrismCodeContent
        code={code}
        language={language}
        showLineNumbers={showLineNumbers}
        wrapLongLines={wrapLongLines}
      />
    </div>
  )
}

export function CodeViewer({ code, language, maxLines = 20, showLineNumbers = false, wrapLongLines = false }: Props) {
  const [expanded, setExpanded] = useState(false)

  const allLines = code.split('\n')
  const isTruncated = !expanded && allLines.length > maxLines
  const visibleCode = isTruncated ? allLines.slice(0, maxLines).join('\n') : code

  const effectiveShowLineNumbers = showLineNumbers && !!language && language !== 'text'
  const languageLabel = language || 'code'
  const lineCountLabel = `${allLines.length} ${allLines.length === 1 ? 'line' : 'lines'}`
  const showExpandToggle = allLines.length > maxLines

  return (
    <div className="overflow-hidden rounded-[var(--radius-lg)] border border-[var(--color-outline-variant)]/50 bg-[var(--color-surface-container-low)]">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container)] px-3 py-1.5 text-[11px] text-[var(--color-text-tertiary)]">
        <div className="flex items-center gap-3">
          <span className="font-semibold uppercase tracking-[0.14em]">{languageLabel}</span>
          <span>{lineCountLabel}</span>
        </div>
        <CopyButton
          text={code}
          className="rounded-md border border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container-lowest)] px-2 py-1 text-[11px] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
        />
      </div>

      {/* Code area */}
      <CodeArea
        code={visibleCode}
        language={language}
        showLineNumbers={effectiveShowLineNumbers}
        wrapLongLines={wrapLongLines}
      />

      {/* Expand/collapse toggle */}
      {showExpandToggle && (
        <button
          onClick={() => setExpanded((value) => !value)}
          className="w-full border-t border-[var(--color-outline-variant)]/40 bg-[var(--color-surface-container)] py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-text-tertiary)] transition-colors hover:bg-[var(--color-surface-container-high)] hover:text-[var(--color-text-primary)]"
        >
          {expanded ? 'Collapse' : `Show ${allLines.length - maxLines} more lines`}
        </button>
      )}
    </div>
  )
}
