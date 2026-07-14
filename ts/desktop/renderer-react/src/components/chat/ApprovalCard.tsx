import { useState } from 'react'
import type { ChatBlock } from '../../stores/chatStore'
import { useChatStore } from '../../stores/chatStore'
import { t } from '../../i18n'
import { IconAlertCircle, IconCheckCircle, IconChevronDown, IconShield, IconX } from '../shared/icons'
import { toolDisplayName, toolSummary } from './toolMeta'

type ApprovalBlock = Extract<ChatBlock, { kind: 'approval' }>

export function ApprovalCard({ block }: { block: ApprovalBlock }) {
  const approve = useChatStore((s) => s.approve)
  const reject = useChatStore((s) => s.reject)
  const [expanded, setExpanded] = useState(false)
  const reasonLines: string[] = []
  if (block.reason?.why) reasonLines.push(t('approval.reasonWhy') + block.reason.why)
  if (block.reason?.impact) reasonLines.push(t('approval.reasonImpact') + block.reason.impact)
  if (block.preview) reasonLines.push(block.preview)
  const details = reasonLines.join('\n')
  const summary = toolSummary(block.tool, block.args)
  const action = toolDisplayName(block.tool)

  if (block.resolved) {
    const rejected = block.resolved === 'rejected'
    const Icon = rejected ? IconX : IconCheckCircle
    const status = rejected
      ? t('approval.rejected')
      : block.resolved === 'approved-session'
        ? t('approval.approvedSession')
        : t('approval.approved')

    return (
      <div className="my-1 flex items-center gap-1.5 px-1.5 py-1 text-[12.5px]" style={{ color: 'var(--color-text-tertiary)' }}>
        <Icon size={13} />
        <span>{status}</span>
        <span className="min-w-0 truncate" title={summary || action} style={{ fontFamily: summary ? 'var(--font-mono)' : undefined }}>
          {summary || action}
        </span>
      </div>
    )
  }

  return (
    <div
      className="my-1.5 rounded-lg px-2.5 py-2"
      style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)' }}
      data-block="approval-request"
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <IconShield size={13} style={{ color: 'var(--color-warning)' }} />
        <span className="shrink-0 text-[12.5px] font-medium" style={{ color: 'var(--color-text-primary)' }}>
          {t('approval.title').replace(/[:：]\s*$/, '')}
        </span>
        <span className="shrink-0 text-[12.5px]" style={{ color: 'var(--color-text-secondary)' }}>{action}</span>
        {summary && (
          <span className="min-w-0 flex-1 truncate text-[12px]" title={summary} style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
            {summary}
          </span>
        )}
        {(details || block.reason?.what) && (
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="ml-auto flex h-6 w-6 shrink-0 items-center justify-center rounded-md hover:bg-[var(--color-surface-hover)]"
            title={expanded ? '收起详情' : '查看详情'}
            aria-label={expanded ? '收起详情' : '查看详情'}
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            <IconChevronDown size={13} style={{ transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform .15s ease' }} />
          </button>
        )}
      </div>
      {block.warning && (
        <div className="mt-1.5 flex items-start gap-1.5 text-[12px]" style={{ color: 'var(--color-warning)' }}>
          <IconAlertCircle size={12} className="mt-0.5 shrink-0" />
          <span>{block.warning}</span>
        </div>
      )}
      {expanded && (block.reason?.what || details) && (
        <div
          className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md px-2.5 py-2 text-[11.5px]"
          style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}
        >
          {[block.reason?.what, details].filter(Boolean).join('\n')}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => approve(block.id, false)}
          className="rounded-md px-2.5 py-1 text-[12px] font-medium text-white"
          style={{ background: 'var(--color-primary)' }}
        >
          {t('approval.allowOnce')}
        </button>
        {block.rememberable && (
          <button
            type="button"
            onClick={() => approve(block.id, true)}
            className="rounded-md px-2.5 py-1 text-[12px]"
            style={{ border: '1px solid var(--color-border)', color: 'var(--color-text-secondary)' }}
          >
            {t('approval.allowSession')}
          </button>
        )}
        <button
          type="button"
          onClick={() => reject(block.id)}
          className="rounded-md px-2.5 py-1 text-[12px] hover:bg-[var(--color-surface-hover)]"
          style={{ color: 'var(--color-error)' }}
        >
          {t('approval.reject')}
        </button>
      </div>
    </div>
  )
}
