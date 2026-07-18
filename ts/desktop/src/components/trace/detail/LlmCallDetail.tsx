import { useEffect, useMemo, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslation } from '../../../i18n'
import type { TraceCallRecord } from '../../../types/trace'
import type { TraceSpan } from '../../../lib/traceViewModel'
import { fetchTraceCallDetail } from '../../../lib/trace/callCache'
import { parseTraceRequestBody, parseTraceResponseBody } from '../../../lib/trace/requestParse'
import type { NormalizedMessage } from '../../../lib/trace/types'
import { MetaChip } from '../TraceBadges'
import { Section } from './Section'
import { MessageBlocks } from './MessageBlocks'

export function LlmCallDetail({ sessionId, span }: { sessionId: string; span: TraceSpan }) {
  const t = useTranslation()
  const call = span.call
  const callId = call?.id ?? null
  const isTerminal = span.status !== 'pending'
  const [detail, setDetail] = useState<TraceCallRecord | null>(null)
  const [fetchFailed, setFetchFailed] = useState(false)
  const fetchKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!callId || !isTerminal) return
    const key = `${sessionId}:${callId}`
    // Ref guard keeps React StrictMode's double effect run from issuing a
    // second request; staleness is checked against the ref at resolve time.
    if (fetchKeyRef.current === key) return
    fetchKeyRef.current = key
    void fetchTraceCallDetail(sessionId, callId).then((full) => {
      if (fetchKeyRef.current !== key) return
      if (full) {
        setDetail(full)
        setFetchFailed(false)
      } else {
        setFetchFailed(true)
      }
    })
  }, [sessionId, callId, isTerminal])

  const effectiveCall = detail && detail.id === callId ? detail : call
  const parsed = useMemo(() => {
    if (!effectiveCall) return { request: null, response: null }
    return {
      request: effectiveCall.request.body.preview
        ? parseTraceRequestBody(effectiveCall.request.body.preview, effectiveCall.source)
        : null,
      response: effectiveCall.response?.body.preview
        ? parseTraceResponseBody(effectiveCall.response.body.preview, effectiveCall.source)
        : null,
    }
  }, [effectiveCall])

  if (!call || !effectiveCall) return null

  const loadingDetail = isTerminal && (!detail || detail.id !== callId) && !fetchFailed
  const requestParseFailed = Boolean(effectiveCall.request.body.preview) && parsed.request === null
  const responseParseFailed = Boolean(effectiveCall.response?.body.preview) &&
    (parsed.response === null || parsed.response.message === null)
  const legacyFallback = !loadingDetail && (requestParseFailed || (isTerminal && !call.error && responseParseFailed))
  const params = parsed.request?.params ?? {}
  const hiddenParams = new Set(['model', 'provider', 'base_url', 'baseUrl'])
  const paramEntries = Object.entries(params).filter(([key]) => !hiddenParams.has(key))

  return (
    <div data-testid="trace-llm-detail">
      {loadingDetail ? (
        <div className="progress-indeterminate-track h-0.5 bg-[var(--color-surface-container)]" data-testid="trace-detail-loading" />
      ) : null}
      {fetchFailed ? (
        <NoticeBar text={t('trace.detail.fetchFailed')} />
      ) : null}
      {legacyFallback ? (
        <NoticeBar text={t('trace.detail.legacyTruncated')} />
      ) : null}

      <Section sectionKey="llm.response" title={t('trace.section.response')} defaultOpen>
        <ResponseContent
          call={effectiveCall}
          pending={!isTerminal}
          parsedMessage={parsed.response?.message ?? null}
          stopReason={parsed.response?.stopReason}
        />
      </Section>

      {paramEntries.length > 0 ? (
        <Section sectionKey="llm.parameters" title={t('trace.section.parameters')} badge={paramEntries.length}>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[11px]">
            {paramEntries.map(([key, value]) => (
              <ParamRow key={key} name={key} value={value} />
            ))}
          </dl>
        </Section>
      ) : null}

    </div>
  )
}

export function isAbortedTraceCall(call: TraceCallRecord): boolean {
  if (call.metadata?.aborted === true) return true
  const name = call.error?.name
  return name === 'AbortError' || name === 'TimeoutError'
}

function ResponseContent({
  call,
  pending,
  parsedMessage,
  stopReason,
}: {
  call: TraceCallRecord
  pending: boolean
  parsedMessage: NormalizedMessage | null
  stopReason?: string
}) {
  const t = useTranslation()
  if (call.error) {
    const aborted = isAbortedTraceCall(call)
    return (
      <div
        className="rounded-[var(--radius-md)] border border-[var(--color-error)]/25 bg-[var(--color-error-container)]/40 px-3 py-2"
        data-testid="trace-call-error"
      >
        <div className="flex min-w-0 items-center gap-2">
          <div className="text-xs font-semibold text-[var(--color-error)]">{call.error.name}</div>
          {aborted ? (
            <span
              className="inline-flex shrink-0 items-center rounded-[var(--radius-sm)] bg-[var(--color-error)]/10 px-1.5 py-0.5 text-[10px] font-semibold text-[var(--color-error)]"
              data-testid="trace-call-aborted-badge"
            >
              {t('trace.status.aborted')}
            </span>
          ) : null}
        </div>
        <div className="mt-1 text-xs leading-5 text-[var(--color-text-secondary)]">{call.error.message}</div>
        {aborted ? (
          <div className="mt-1 text-[11px] leading-4 text-[var(--color-text-tertiary)]">
            {t('trace.detail.aborted')}
          </div>
        ) : null}
        {call.error.stack ? (
          <details className="mt-1.5">
            <summary className="cursor-pointer text-[10px] uppercase tracking-[0.08em] text-[var(--color-text-tertiary)]">
              stack
            </summary>
            <pre className="mt-1 max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-[var(--color-text-tertiary)]">
              {call.error.stack}
            </pre>
          </details>
        ) : null}
      </div>
    )
  }
  if (pending) {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-3 text-xs text-[var(--color-text-tertiary)]">
        <Loader2 size={13} strokeWidth={2} className="animate-spin" />
        {t('trace.detail.streaming')}
      </div>
    )
  }
  if (!parsedMessage) {
    return (
      <div className="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] px-3 py-3 text-xs text-[var(--color-text-tertiary)]">
        {call.response ? t('trace.detail.legacyTruncated') : t('trace.noResponse')}
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <MessageBlocks message={parsedMessage} />
      {stopReason ? (
        <div>
          <MetaChip label={t('trace.detail.stopReason')} value={stopReason} />
        </div>
      ) : null}
    </div>
  )
}

function ParamRow({ name, value }: { name: string; value: unknown }) {
  return (
    <>
      <dt className="font-mono text-[var(--color-text-tertiary)]">{name}</dt>
      <dd className="min-w-0 truncate font-mono text-[var(--color-text-secondary)]" title={stringifyParam(value)}>
        {stringifyParam(value)}
      </dd>
    </>
  )
}

function stringifyParam(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value) ?? 'null'
  } catch {
    return String(value)
  }
}

function NoticeBar({ text }: { text: string }) {
  return (
    <div className="mx-4 mt-3 rounded-[var(--radius-md)] border border-[var(--color-warning)]/30 bg-[var(--color-warning-container)]/30 px-3 py-1.5 text-[11px] text-[var(--color-text-secondary)]">
      {text}
    </div>
  )
}
