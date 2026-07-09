// 工具调用卡(最小版)。Block B 会用 cc ToolCallBlock/ToolResultBlock 替换(含卡内 diff / 分组 / 富预览)。
import { useState } from 'react'
import type { ChatBlock } from '../../stores/chatStore'

type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>

function summarize(input: unknown): string {
  if (input == null) return ''
  if (typeof input === 'string') return input.slice(0, 120)
  try {
    const obj = input as Record<string, unknown>
    const path = obj.path ?? obj.file_path ?? obj.command
    if (typeof path === 'string') return path.slice(0, 120)
    return JSON.stringify(input).slice(0, 120)
  } catch {
    return ''
  }
}

const statusIcon: Record<ToolBlock['status'], string> = { running: '●', ok: '✓', error: '✗' }
const statusColor: Record<ToolBlock['status'], string> = {
  running: 'var(--color-text-tertiary)',
  ok: 'var(--color-success)',
  error: 'var(--color-error)',
}

export function ToolCallCard({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false)
  return (
    <div
      className="my-1.5 rounded-lg text-sm overflow-hidden"
      style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)' }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span style={{ color: statusColor[block.status] }}>{statusIcon[block.status]}</span>
        <span className="font-medium" style={{ color: 'var(--color-text-primary)' }}>{block.tool}</span>
        <span className="truncate" style={{ color: 'var(--color-text-tertiary)' }}>{summarize(block.input)}</span>
      </button>
      {open && block.output != null && (
        <pre
          className="px-3 py-2 text-xs overflow-x-auto whitespace-pre-wrap"
          style={{ background: 'var(--color-surface-container)', color: 'var(--color-text-secondary)', margin: 0 }}
        >
          {block.output}
        </pre>
      )}
    </div>
  )
}
