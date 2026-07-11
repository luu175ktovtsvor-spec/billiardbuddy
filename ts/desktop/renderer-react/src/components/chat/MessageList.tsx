// 消息流。对齐 cc-haha-ref desktop/src/components/chat/MessageList.tsx 的整体切法:
// 连续 tool_use 折成一组(ToolCallGroup,见 file:line 对齐见该组件顶部注释)、thinking 走独立
// ThinkingBlock、todo 清单走 sticky SessionTaskBar、api_retry/streaming_fallback 两种严重度分开渲染。
//
// 视觉皮改造(owner 2026-07-11)新增一层"回合分组":user 消息之间的所有内容(深度思考+工具行+
// 助手回复)套一个 AssistantMessageHeader(头像+名字+"已完成 Xs ⌄"),对齐 Codex 每段
// 回复顶部的头像+状态。chevron 默认展开(和改造前视觉一致),点了才折叠——纯新增,不改默认呈现。
import { useEffect, useMemo, useRef, useState } from 'react'
import { useChatStore, type ChatBlock } from '../../stores/chatStore'
import { MarkdownRenderer } from '../markdown/MarkdownRenderer'
import { ToolCallGroup } from './ToolCallGroup'
import { EditSummaryCard } from './EditSummaryCard'
import { ThinkingBlock } from './ThinkingBlock'
import { ApprovalCard } from './ApprovalCard'
import { AssistantMessageHeader } from './AssistantMessageHeader'
import { SessionTaskBar } from './SessionTaskBar'
import { StreamingIndicator } from './StreamingIndicator'
import { MessageActions } from './MessageActions'
import { IconRefresh, IconChevronDown, IconEdit } from '../shared/icons'
import { useComposerStore } from '../../stores/composerStore'
import { t } from '../../i18n'

type ToolBlockT = Extract<ChatBlock, { kind: 'tool' }>
type AssistantBlockT = Extract<ChatBlock, { kind: 'assistant' }>
type RenderItem =
  | { key: string; kind: 'tool-group'; blocks: ToolBlockT[] }
  | { key: string; kind: 'edit-group'; blocks: ToolBlockT[] }
  | { key: string; kind: 'block'; block: ChatBlock }

// 编辑类工具:连续的这些块折成 Codex「已编辑 N 个文件」汇总卡,和普通工具行分开。
const EDIT_TOOLS = new Set(['edit_file', 'multi_edit_file', 'write_file', 'patch_file', 'patch_files', 'edit_excel'])

/** 连续 tool 块折成一组(对齐 cc);编辑类与非编辑类不混组(编辑走「已编辑 N 个文件」汇总卡)。 */
function groupBlocks(blocks: ChatBlock[]): RenderItem[] {
  const items: RenderItem[] = []
  let i = 0
  while (i < blocks.length) {
    const b = blocks[i]!
    if (b.kind === 'tool') {
      const isEdit = EDIT_TOOLS.has(b.tool)
      const group: ToolBlockT[] = [b]
      let j = i + 1
      while (j < blocks.length) {
        const next = blocks[j]
        if (!next || next.kind !== 'tool' || EDIT_TOOLS.has(next.tool) !== isEdit) break
        group.push(next)
        j += 1
      }
      items.push({ key: b.id, kind: isEdit ? 'edit-group' : 'tool-group', blocks: group })
      i = j
    } else {
      items.push({ key: b.id, kind: 'block', block: b })
      i += 1
    }
  }
  return items
}

type TurnEntry = { type: 'user'; item: RenderItem } | { type: 'turn'; key: string; items: RenderItem[] }

/** user 消息切界:每条 user 消息独立渲染,之间的所有内容(思考/工具/回复)归进同一个"回合",
 *  供 AssistantMessageHeader 统一套头。 */
function splitTurns(items: RenderItem[]): TurnEntry[] {
  const out: TurnEntry[] = []
  let current: RenderItem[] = []
  let turnSeq = 0
  function flush() {
    if (current.length > 0) {
      out.push({ type: 'turn', key: `turn-${turnSeq++}-${current[0]!.key}`, items: current })
      current = []
    }
  }
  for (const item of items) {
    if (item.kind === 'block' && item.block.kind === 'user') {
      flush()
      out.push({ type: 'user', item })
    } else {
      current.push(item)
    }
  }
  flush()
  return out
}

function ApiRetryBanner({ text }: { text: string }) {
  return (
    <div
      className="my-2 flex w-fit max-w-full items-center gap-2 rounded-md px-3 py-2 text-xs"
      style={{
        border: '1px solid color-mix(in srgb, var(--color-warning) 45%, transparent)',
        background: 'color-mix(in srgb, var(--color-warning) 14%, transparent)',
        color: 'var(--color-warning)',
      }}
      data-block="note-api-retry"
    >
      <IconRefresh size={13} className="qf-spin" />
      <span className="font-medium">{t('chat.retryTitle')}</span>
      <span className="truncate">{text}</span>
    </div>
  )
}

function StreamingFallbackBanner({ text }: { text: string }) {
  return (
    <div
      className="my-2 flex w-fit max-w-full items-center gap-2 rounded-full px-3 py-1 text-xs"
      style={{ border: '1px solid var(--color-border)', background: 'var(--color-surface-container-low)', color: 'var(--color-text-secondary)' }}
      data-block="note-streaming-fallback"
    >
      <IconRefresh size={12} className="qf-spin" />
      <span className="font-medium">{t('chat.fallbackTitle')}</span>
      <span className="truncate" style={{ color: 'var(--color-text-tertiary)' }}>{text}</span>
    </div>
  )
}

function Block({ block, isLast }: { block: ChatBlock; isLast?: boolean }) {
  switch (block.kind) {
    case 'user':
      return (
        <div className="group/user my-2 flex items-center justify-end gap-1" data-block="user">
          <button
            type="button"
            aria-label="编辑"
            title="编辑并重发"
            onClick={() => useComposerStore.getState().setDraft(block.text)}
            className="shrink-0 rounded-md p-1 opacity-0 transition-opacity hover:bg-[var(--color-surface-hover)] group-hover/user:opacity-100"
            style={{ color: 'var(--color-text-tertiary)' }}
          >
            <IconEdit size={13} />
          </button>
          <div
            className="max-w-[80%] rounded-2xl px-4 py-2 text-sm whitespace-pre-wrap"
            style={{ background: 'var(--color-bubble-user)', color: 'var(--color-text-primary)' }}
          >
            {block.text}
          </div>
        </div>
      )
    case 'assistant':
      return (
        <div className="group/msg text-sm leading-relaxed" data-block="assistant" style={{ color: 'var(--color-text-primary)' }}>
          <MarkdownRenderer content={block.text} />
          {block.streaming && <span className="qf-cursor">▍</span>}
          {!block.streaming && block.text.trim() && <MessageActions text={block.text} pinned={isLast} />}
        </div>
      )
    case 'thinking':
      return <ThinkingBlock content={block.text} isActive={block.active} />
    case 'tool':
      // 兜底(正常走 groupBlocks → ToolCallGroup,不会直接命中这里)。
      return <ToolCallGroup blocks={[block]} />
    case 'approval':
      return <ApprovalCard block={block} />
    case 'note': {
      if (block.variant === 'api_retry') return <ApiRetryBanner text={block.text} />
      if (block.variant === 'streaming_fallback') return <StreamingFallbackBanner text={block.text} />
      const color = block.variant === 'error' ? 'var(--color-error)' : 'var(--color-text-tertiary)'
      return (
        <div className="my-1.5 text-xs whitespace-pre-wrap" data-block="note" style={{ color }}>
          {block.text}
        </div>
      )
    }
  }
}

function renderItem(item: RenderItem, isLast: boolean) {
  if (item.kind === 'edit-group') return <EditSummaryCard key={item.key} blocks={item.blocks} />
  if (item.kind === 'tool-group') return <ToolCallGroup key={item.key} blocks={item.blocks} />
  return <Block key={item.key} block={item.block} isLast={isLast} />
}

/** 一个"回合"=两条 user 消息之间的所有内容。有思考/工具/回复才套 AssistantMessageHeader;
 *  只有零散 note/approval(没有真正回复)时原样平铺,不套头(避免空回合也顶个头像)。 */
function TurnBody({ items, lastKey }: { items: RenderItem[]; lastKey: string | undefined }) {
  const [collapsed, setCollapsed] = useState(false)

  let assistantBlock: AssistantBlockT | undefined
  let hasProcess = false
  for (const item of items) {
    if (item.kind === 'tool-group' || item.kind === 'edit-group') hasProcess = true
    else if (item.block.kind === 'thinking') hasProcess = true
    else if (item.block.kind === 'assistant') assistantBlock = item.block
  }

  if (!assistantBlock && !hasProcess) {
    return <>{items.map((item) => renderItem(item, item.key === lastKey))}</>
  }

  return (
    <div className="my-1" data-block="turn">
      <AssistantMessageHeader
        streaming={assistantBlock?.streaming ?? false}
        durationSec={assistantBlock?.durationSec}
        collapsed={collapsed}
        onToggle={() => setCollapsed((v) => !v)}
      />
      {!collapsed &&
        items.map((item) => renderItem(item, item.key === lastKey))}
    </div>
  )
}

export function MessageList() {
  const blocks = useChatStore((s) => s.blocks)
  const endRef = useRef<HTMLDivElement>(null)
  const items = useMemo(() => groupBlocks(blocks), [blocks])
  const turns = useMemo(() => splitTurns(items), [items])
  const lastKey = items[items.length - 1]?.key
  const containerRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)

  function onScroll() {
    const el = containerRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [blocks])

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={containerRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-[768px]">
          <SessionTaskBar />
          {turns.map((entry) =>
            entry.type === 'user' ? (
              renderItem(entry.item, entry.item.key === lastKey)
            ) : (
              <TurnBody key={entry.key} items={entry.items} lastKey={lastKey} />
            ),
          )}
          <StreamingIndicator />
          <div ref={endRef} />
        </div>
      </div>
      {!atBottom && (
        <button
          type="button"
          onClick={() => endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}
          aria-label="滚动到底部"
          className="absolute bottom-4 left-1/2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-surface-hover)]"
          style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-popover)', color: 'var(--color-text-secondary)' }}
        >
          <IconChevronDown size={16} />
        </button>
      )}
    </div>
  )
}
