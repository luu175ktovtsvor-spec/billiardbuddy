// 连续工具活动聚成一个可展开组：完成态显示紧凑摘要，运行态显示最新动作。
// 运行中展开显示即时进度；回合完成后自动收起，错误明细由用户主动展开。
import { useEffect, useRef, useState } from 'react'
import type { ChatBlock } from '../../stores/chatStore'
import { ToolCallCard } from './ToolCallCard'
import { ThinkingBlock } from './ThinkingBlock'
import { summarizeActivity, toolIcon, statusVerb, toolSummary, visibleActivityTools } from './toolMeta'
import { IconAlertCircle, IconChevronDown } from '../shared/icons'
import { t } from '../../i18n'

type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>
type ThinkingBlockT = Extract<ChatBlock, { kind: 'thinking' }>
export type ActivityBlock = ToolBlock | ThinkingBlockT

/** 单个工具且无思考:直接渲染卡片、不套组(对齐 cc toolCalls.length===1 跳过 wrapper;也符合 Codex 单活动单行观感)。 */
export function ToolCallGroup({ blocks }: { blocks: ActivityBlock[] }) {
  const tools = blocks.filter((b): b is ToolBlock => b.kind === 'tool')
  if (blocks.length === 0) return null
  if (tools.length === 0) {
    // 纯思考(无工具):保持思考行直渲染(它本身就是折叠预览行)。
    return <>{blocks.map((b) => b.kind === 'thinking' ? <ThinkingBlock key={b.id} content={b.text} isActive={b.active} /> : null)}</>
  }
  if (blocks.length === 1 && tools.length === 1) return <ToolCallCard block={tools[0]!} />
  return <ActivityGroupMulti blocks={blocks} tools={tools} />
}

function GroupIcon({ tool }: { tool: string }) {
  const Icon = toolIcon(tool)
  return (
    <span style={{ color: 'var(--color-text-tertiary)' }}>
      <Icon size={16} />
    </span>
  )
}

function ActivityGroupMulti({ blocks, tools }: { blocks: ActivityBlock[]; tools: ToolBlock[] }) {
  const visibleTools = visibleActivityTools(tools)
  const runningTool = visibleTools.find((b) => b.status === 'running')
  const thinkingActive = blocks.some((b) => b.kind === 'thinking' && b.active)
  const isRunning = !!runningTool || thinkingActive
  const hasError = visibleTools.some((b) => b.status === 'error')
  const [expanded, setExpanded] = useState(isRunning)
  const prevRunningRef = useRef(isRunning)

  useEffect(() => {
    if (isRunning) {
      setExpanded(true)
    } else if (prevRunningRef.current && !isRunning) {
      setExpanded(false)
    }
    prevRunningRef.current = isRunning
  }, [isRunning])

  // 组头文案:进行中 = 最新活动实时行(对齐 Codex fDe active 态);完成 = 分类计数段(hDe summaryParts);
  // 只有一个工具的组(工具+思考混组)直接用该工具自己的动词文案,免得兜底「已处理」和回合头重复。
  const headerText = runningTool
    ? `${statusVerb(runningTool.tool, 'running')} ${toolSummary(runningTool.tool, runningTool.input)}`.trim()
    : thinkingActive
      ? t('thinking.active')
      : visibleTools.length === 1
        ? `${statusVerb(visibleTools[0]!.tool, visibleTools[0]!.status)} ${toolSummary(visibleTools[0]!.tool, visibleTools[0]!.input)}`.trim()
        : summarizeActivity(visibleTools)

  return (
    <div className="my-0.5" data-block="tool-group">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex min-h-8 w-full items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        {runningTool ? (
          <GroupIcon tool={runningTool.tool} />
        ) : hasError ? (
          <IconAlertCircle size={16} className="shrink-0" style={{ color: 'var(--color-error)' }} />
        ) : !thinkingActive ? (
          // 完成态组头 = 首个工具的类型图标(对齐 Codex 聚合头 icon 语义),不画绿勾。
          <GroupIcon tool={visibleTools[0]?.tool ?? tools[0]!.tool} />
        ) : null}
        {/* chevron 紧跟文字(对齐 Codex 真机:不推到行尾),文字截断保护 */}
        <span className={isRunning ? 'qf-shimmer-text min-w-0 truncate text-[13.5px]' : 'min-w-0 truncate text-[13.5px]'} style={{ color: 'var(--color-text-secondary)' }}>
          {headerText}
        </span>
        {hasError && !isRunning && (
          <span className="shrink-0 text-[12px]" style={{ color: 'var(--color-error)' }}>{t('tools.error')}</span>
        )}
        <IconChevronDown
          size={14}
          className="shrink-0"
          style={{ color: 'var(--color-text-tertiary)', transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform .15s ease' }}
        />
      </button>
      {expanded && (
        <div className="mt-0.5 flex flex-col">
          {visibleTools.map((block) => <ToolCallCard key={block.id} block={block} />)}
        </div>
      )}
    </div>
  )
}
