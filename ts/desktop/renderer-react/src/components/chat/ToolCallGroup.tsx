// 活动组(对齐 Codex 源码 agent-activity 结构,asar 反混淆:hDe/fDe/nwe/vDe):
// 一个回合内连续的「工具 + 思考」聚成一个可展开组——
//   完成态组头 = 分类计数段 Intl.ListFormat 连接(「已读取文件运行了 6 条命令」)+ chevron 紧跟文字;
//   进行中组头 = 最新活动实时行(「正在运行 <命令>」)或「正在想…」shimmer(思考是组头占位态,不是独立行);
//   展开体 = 按时序的子行明细(工具行 + 思考行)。
// 保留 cc/owner 既有行为:运行中强制展开、跑完自动收起、出错保持展开。
import { useEffect, useRef, useState } from 'react'
import type { ChatBlock } from '../../stores/chatStore'
import { ToolCallCard } from './ToolCallCard'
import { ThinkingBlock } from './ThinkingBlock'
import { summarizeActivity, toolIcon, statusVerb, toolSummary } from './toolMeta'
import { IconAlertCircle, IconChevronDown, IconSpinner } from '../shared/icons'
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
      <Icon size={13} />
    </span>
  )
}

function ActivityGroupMulti({ blocks, tools }: { blocks: ActivityBlock[]; tools: ToolBlock[] }) {
  const runningTool = tools.find((b) => b.status === 'running')
  const thinkingActive = blocks.some((b) => b.kind === 'thinking' && b.active)
  const isRunning = !!runningTool || thinkingActive
  const hasError = tools.some((b) => b.status === 'error')
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

  // 组头文案:进行中 = 最新活动实时行(对齐 Codex fDe active 态);完成 = 分类计数段(hDe summaryParts)。
  const headerText = runningTool
    ? `${statusVerb(runningTool.tool, 'running')} ${toolSummary(runningTool.tool, runningTool.input)}`.trim()
    : thinkingActive
      ? '正在想…'
      : summarizeActivity(tools.map((b) => b.tool))

  return (
    <div className="my-0.5" data-block="tool-group">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        {isRunning ? (
          <IconSpinner size={13} className="shrink-0" style={{ color: 'var(--color-text-tertiary)' }} />
        ) : hasError ? (
          <IconAlertCircle size={13} className="shrink-0" style={{ color: 'var(--color-error)' }} />
        ) : (
          // 完成态组头 = 首个工具的类型图标(对齐 Codex 聚合头 icon 语义),不画绿勾。
          <GroupIcon tool={tools[0]!.tool} />
        )}
        {/* chevron 紧跟文字(对齐 Codex 真机:不推到行尾),文字截断保护 */}
        <span className="min-w-0 truncate text-[12.5px]" style={{ color: 'var(--color-text-secondary)', fontStyle: thinkingActive && !runningTool ? 'italic' : undefined }}>
          {headerText}
        </span>
        {hasError && !isRunning && (
          <span className="shrink-0 text-[11.5px]" style={{ color: 'var(--color-error)' }}>{t('tools.error')}</span>
        )}
        <IconChevronDown
          size={13}
          className="shrink-0"
          style={{ color: 'var(--color-text-tertiary)', transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform .15s ease' }}
        />
      </button>
      {expanded && (
        <div className="mt-0.5 flex flex-col pl-1">
          {blocks.map((b) =>
            b.kind === 'tool'
              ? <ToolCallCard key={b.id} block={b} />
              : <ThinkingBlock key={b.id} content={b.text} isActive={b.active} />,
          )}
        </div>
      )}
    </div>
  )
}
