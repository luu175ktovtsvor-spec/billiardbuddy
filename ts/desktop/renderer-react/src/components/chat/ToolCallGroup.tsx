// 对齐 cc-haha-ref desktop/src/components/chat/ToolCallGroup.tsx:39-64(TOOL_VERBS/generateSummary,
// 中文化搬进 toolMeta.groupSummary)+ :418-474(ToolCallGroupMulti 折叠头 + 运行中自动展开)。
// owner 铁律加了一条 cc 没有的行为:跑完自动收起(cc 只在运行中强制展开,收起要靠手动)——
// 有错误时反例外保持展开,方便用户第一眼看见哪一步出错了。
// 视觉皮改造(owner 2026-07-11):折叠头从"带边框的盒子头"换成无框透气行,右侧加 Codex
// 的"已完成 Xs"耗时文案(取 blocks 的 startedAt/endedAt 快照,纯展示,不影响四态判定)。
import { useEffect, useRef, useState } from 'react'
import type { ChatBlock } from '../../stores/chatStore'
import { ToolCallCard } from './ToolCallCard'
import { groupSummary, formatDuration, toolIcon } from './toolMeta'
import { IconAlertCircle, IconChevronDown, IconSpinner } from '../shared/icons'
import { t } from '../../i18n'

type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>

/** 组头图标 = 首个工具的类型图标(灰),对齐 Codex 聚合头。 */
function GroupIcon({ tool }: { tool: string }) {
  const Icon = toolIcon(tool)
  return (
    <span style={{ color: 'var(--color-text-tertiary)' }}>
      <Icon size={13} />
    </span>
  )
}

/** 单个工具调用直接渲染卡片、不套分组外壳(对齐 cc:toolCalls.length === 1 时跳过 group wrapper)。 */
export function ToolCallGroup({ blocks }: { blocks: ToolBlock[] }) {
  if (blocks.length === 0) return null
  if (blocks.length === 1) return <ToolCallCard block={blocks[0]!} />
  return <ToolCallGroupMulti blocks={blocks} />
}

function groupDuration(blocks: ToolBlock[]): string {
  const starts = blocks.map((b) => b.startedAt).filter((n): n is number => typeof n === 'number')
  if (starts.length === 0) return ''
  const ends = blocks.map((b) => b.endedAt).filter((n): n is number => typeof n === 'number')
  if (ends.length === 0) return ''
  const seconds = Math.max(0, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000))
  return seconds > 0 ? formatDuration(seconds) : ''
}

function ToolCallGroupMulti({ blocks }: { blocks: ToolBlock[] }) {
  const isRunning = blocks.some((b) => b.status === 'running')
  const hasError = blocks.some((b) => b.status === 'error')
  const [expanded, setExpanded] = useState(isRunning || hasError)
  const prevRunningRef = useRef(isRunning)

  useEffect(() => {
    if (isRunning) {
      setExpanded(true)
    } else if (prevRunningRef.current && !isRunning && !hasError) {
      setExpanded(false)
    }
    prevRunningRef.current = isRunning
  }, [isRunning, hasError])

  const summary = groupSummary(blocks.map((b) => b.tool))
  const duration = !isRunning ? groupDuration(blocks) : ''

  return (
    <div className="my-0.5" data-block="tool-group">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        {isRunning ? (
          <IconSpinner size={13} style={{ color: 'var(--color-text-tertiary)' }} />
        ) : hasError ? (
          <IconAlertCircle size={13} style={{ color: 'var(--color-error)' }} />
        ) : (
          // 完成态组头 = 首个工具的类型图标(对齐 Codex 源码聚合头 icon: i.icon 语义),不画绿勾。
          <GroupIcon tool={blocks[0]!.tool} />
        )}
        <span className="min-w-0 flex-1 truncate text-[12.5px]" style={{ color: 'var(--color-text-secondary)' }}>
          {summary}
        </span>
        {!isRunning && (
          <span className="shrink-0 text-[11.5px]" style={{ color: hasError ? 'var(--color-error)' : 'var(--color-text-tertiary)' }}>
            {hasError ? t('tools.error') : `${t('toolGroup.done')}${duration ? ` ${duration}` : ''}`}
          </span>
        )}
        <IconChevronDown
          size={13}
          style={{ color: 'var(--color-text-tertiary)', transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform .15s ease' }}
        />
      </button>
      {expanded && (
        <div className="mt-0.5 flex flex-col pl-1">
          {blocks.map((b) => (
            <ToolCallCard key={b.id} block={b} />
          ))}
        </div>
      )}
    </div>
  )
}
