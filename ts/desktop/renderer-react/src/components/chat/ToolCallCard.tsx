// 视觉皮改造(owner 2026-07-11):折叠行从"每张套边框的盒子"换成 Codex 真机的
// "无边框透气行"——图标 + 过去式动词(灰)+ 文件名/目标(蓝色链接,仅文件路径类目标)+ 细节(灰)。
// 只换视觉,四态(running/ok/error/interrupted)、展开收起、diff 预览等交互逻辑原样保留,
// 对齐 cc-haha-ref desktop/src/components/chat/ToolCallBlock.tsx:53-192 + :735-834 的状态判定
// (getPendingSummary/getToolSummary/getToolResultSummary/changedLineSummary,中文化在 toolMeta.ts)。
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import type { ChatBlock } from '../../stores/chatStore'
import { useFilePreviewStore } from '../../stores/filePreviewStore'
import { DiffViewer } from './DiffViewer'
import { IconAlertCircle, IconChevronDown, IconCopy, IconSpinner, IconStopCircle } from '../shared/icons'
import { toolIcon, toolSummary, pendingVerb, pastVerb, doneVerb, resultSummary, readRangeDetail, toolTargetIsFile } from './toolMeta'
import { Tooltip } from '../shared/Tooltip'
import { t } from '../../i18n'

type ToolBlock = Extract<ChatBlock, { kind: 'tool' }>

const EDIT_LIKE = new Set(['edit_file', 'multi_edit_file', 'patch_file', 'patch_files'])
const PREFERS_DONE_VERB = new Set(['edit_file', 'multi_edit_file', 'write_file', 'patch_file', 'patch_files', 'edit_excel'])

function inputObj(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' ? (input as Record<string, unknown>) : {}
}

/** 折叠行「细节」段:改文件给行数、read_file 给行范围,其余走已有 resultSummary 兜底。 */
function detailText(block: ToolBlock): string {
  if (block.tool === 'read_file' || block.tool === 'read_many_files') {
    const range = readRangeDetail(block.tool, block.input)
    if (range) return range
  }
  if (PREFERS_DONE_VERB.has(block.tool)) {
    return doneVerb(block.tool, block.input) || resultSummary(block.tool, block.output, false)
  }
  return resultSummary(block.tool, block.output, false)
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setCopied(true)
        setTimeout(() => setCopied(false), 1200)
      }}
      className="shrink-0 rounded-md p-1 transition-colors hover:bg-[var(--color-surface-hover)]"
      title={copied ? t('actions.copied') : t('actions.copy')}
      style={{ color: 'var(--color-text-tertiary)' }}
    >
      <IconCopy size={12} />
    </button>
  )
}

export function ToolCallCard({ block }: { block: ToolBlock }) {
  const obj = inputObj(block.input)
  const Icon = toolIcon(block.tool)
  const summary = toolSummary(block.tool, block.input)
  const filePath = typeof obj.file_path === 'string' ? obj.file_path : typeof obj.path === 'string' ? obj.path : ''
  const isFileTarget = toolTargetIsFile(block.input)

  const hasEditPreview = EDIT_LIKE.has(block.tool) && typeof obj.old_string === 'string' && typeof obj.new_string === 'string'
  const hasWritePreview = block.tool === 'write_file' && typeof obj.content === 'string'
  const hasOutput = Boolean(block.output && block.output.trim())
  const expandable = hasEditPreview || hasWritePreview || hasOutput

  // 出错才默认展开正文;其余默认折叠(对齐 owner 铁律)。挂载后状态才转错也要跟着展开一次。
  const [expanded, setExpanded] = useState(block.status === 'error')
  useEffect(() => {
    if (block.status === 'error') setExpanded(true)
  }, [block.status])

  // 运行中实时输出框自动滚到底(逐块淌进来时始终看最新)。
  const liveRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    const el = liveRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [block.liveOutput])

  const detail = detailText(block)
  const verb =
    block.status === 'running'
      ? pendingVerb(block.tool)
      : block.status === 'interrupted'
        ? t('tools.interrupted')
        : pastVerb(block.tool)
  const verbColor = block.status === 'running' ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)'
  const detailColor = block.status === 'error' ? 'var(--color-error)' : 'var(--color-text-tertiary)'
  const detailValue = block.status === 'error' ? resultSummary(block.tool, block.output, true) : detail

  function openPreview(e: MouseEvent) {
    e.stopPropagation()
    if (filePath) useFilePreviewStore.getState().openFile(filePath)
  }

  return (
    <div className="my-0.5" data-tool={block.tool} data-status={block.status}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => {
          if (expandable) setExpanded((v) => !v)
        }}
        onKeyDown={(e) => {
          if (expandable && (e.key === 'Enter' || e.key === ' ')) setExpanded((v) => !v)
        }}
        className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-surface-hover)]"
      >
        {block.status === 'running' ? (
          <IconSpinner size={13} style={{ color: 'var(--color-text-tertiary)' }} />
        ) : block.status === 'error' ? (
          <IconAlertCircle size={13} style={{ color: 'var(--color-error)' }} />
        ) : block.status === 'interrupted' ? (
          <IconStopCircle size={13} style={{ color: 'var(--color-text-tertiary)' }} />
        ) : (
          <Icon size={13} />
        )}

        <span className="shrink-0 text-[12.5px]" style={{ color: verbColor }}>
          {verb}
        </span>

        {summary &&
          (isFileTarget ? (
            <Tooltip label={filePath || summary}>
              <button type="button" onClick={openPreview} className="qf-tool-link min-w-0 truncate text-[12.5px]">
                {summary}
              </button>
            </Tooltip>
          ) : (
            <span className="min-w-0 truncate text-[12.5px]" title={summary} style={{ color: 'var(--color-text-secondary)', fontFamily: 'var(--font-mono)' }}>
              {summary}
            </span>
          ))}

        {detailValue ? (
          <span className="min-w-0 flex-1 truncate text-[11.5px]" style={{ color: detailColor }}>
            · {detailValue}
          </span>
        ) : (
          <span className="flex-1" />
        )}

        {block.status === 'running' && typeof block.liveChars === 'number' && block.liveChars > 0 && (
          <span className="shrink-0 text-[11px] tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
            {block.liveChars} 字
          </span>
        )}

        {expandable && (
          <IconChevronDown
            size={13}
            style={{ color: 'var(--color-text-tertiary)', transform: expanded ? 'rotate(180deg)' : undefined, transition: 'transform .15s ease' }}
          />
        )}
      </div>

      {/* 运行中实时输出:命令跑的时候就在对话流里逐块滚动(不必开终端面板),完成后收起、点行可展开看全文。 */}
      {block.status === 'running' && block.liveOutput && (
        <div className="ml-6 mt-0.5 mb-1">
          <pre
            ref={liveRef}
            className="max-h-[140px] overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 text-[12px]"
            style={{ fontFamily: 'var(--font-mono)', background: 'var(--color-surface-container-low)', color: 'var(--color-text-secondary)' }}
          >
            {block.liveOutput}
            <span className="qf-cursor">▍</span>
          </pre>
        </div>
      )}

      {/* 只有展开的内容(diff/命令输出/错误)才套柔和底色圆角盒;折叠行本身绝不套盒。 */}
      {expandable && expanded && (
        <div className="ml-6 mt-0.5 mb-1">
          {hasEditPreview && <DiffViewer filePath={filePath || 'file'} oldString={obj.old_string as string} newString={obj.new_string as string} />}
          {hasWritePreview && <DiffViewer filePath={filePath || 'file'} oldString="" newString={obj.content as string} />}
          {!hasEditPreview && !hasWritePreview && hasOutput && (
            <div className="overflow-hidden rounded-lg" style={{ background: 'var(--color-surface-container-low)' }}>
              <div className="flex items-center justify-between px-3 py-1.5" style={{ color: 'var(--color-text-tertiary)' }}>
                <span className="text-[10px] uppercase tracking-wide">{block.status === 'error' ? t('tools.errorOutput') : t('tools.toolOutput')}</span>
                <CopyButton text={block.output ?? ''} />
              </div>
              <pre
                className="max-h-[420px] overflow-auto whitespace-pre-wrap break-words px-3 pb-3 text-[12px]"
                style={{ fontFamily: 'var(--font-mono)', color: block.status === 'error' ? 'var(--color-error)' : 'var(--color-text-secondary)' }}
              >
                {block.output}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
