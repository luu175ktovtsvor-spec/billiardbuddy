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
import { StepCapsule } from './StepCapsule'
import { MessageActions } from './MessageActions'
import { IconRefresh, IconChevronDown, IconEdit, IconSearch, IconX } from '../shared/icons'
import { useComposerStore } from '../../stores/composerStore'
import { t } from '../../i18n'

// —— ⌘F 线程内查找条(对齐 Codex threadFindBar:搜索任务…/N 个结果/上一个/下一个/关闭)——
function FindBar({ containerRef, onClose }: { containerRef: React.RefObject<HTMLDivElement | null>; onClose: () => void }) {
  const blocks = useChatStore((s) => s.blocks)
  const [query, setQuery] = useState('')
  const [cur, setCur] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // 命中 = 正文含 query 的 user/assistant 块(不搜思考/工具,和「任务内容」语义一致)。
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return [] as string[]
    return blocks
      .filter((b) => (b.kind === 'user' || b.kind === 'assistant') && b.text.toLowerCase().includes(q))
      .map((b) => b.id)
  }, [blocks, query])

  useEffect(() => { setCur(0) }, [query])
  useEffect(() => { inputRef.current?.focus() }, [])

  // 当前命中滚动定位 + 闪烁高亮(qf-find-hit)。
  useEffect(() => {
    const id = hits[cur]
    if (!id) return
    const el = containerRef.current?.querySelector(`[data-bid="${id}"]`)
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    el.classList.add('qf-find-hit')
    const timer = window.setTimeout(() => el.classList.remove('qf-find-hit'), 1600)
    return () => { window.clearTimeout(timer); el.classList.remove('qf-find-hit') }
  }, [hits, cur, containerRef])

  const step = (d: number) => { if (hits.length) setCur((c) => (c + d + hits.length) % hits.length) }

  return (
    <div
      className="absolute right-4 top-2 z-20 flex items-center gap-1 rounded-xl px-2 py-1"
      style={{ background: 'var(--color-surface)', border: '1px solid var(--color-border)', boxShadow: 'var(--shadow-popover)' }}
      data-testid="find-bar"
    >
      <IconSearch size={13} style={{ color: 'var(--color-text-tertiary)' }} />
      <input
        ref={inputRef}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onClose() }
          else if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1) }
        }}
        placeholder="搜索任务…"
        className="w-[170px] bg-transparent text-[12.5px] outline-none"
        style={{ color: 'var(--color-text-primary)' }}
      />
      <span className="shrink-0 text-[11.5px] tabular-nums" style={{ color: 'var(--color-text-tertiary)' }}>
        {query.trim() ? (hits.length ? `${cur + 1}/${hits.length}` : '0 个结果') : ''}
      </span>
      <button type="button" title="上一个结果" onClick={() => step(-1)} className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)' }}>
        <IconChevronDown size={13} style={{ transform: 'rotate(180deg)' }} />
      </button>
      <button type="button" title="下一个结果" onClick={() => step(1)} className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)' }}>
        <IconChevronDown size={13} />
      </button>
      <button type="button" title="关闭查找" onClick={onClose} className="flex h-5 w-5 items-center justify-center rounded transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)' }}>
        <IconX size={13} />
      </button>
    </div>
  )
}

// —— 用户消息导航 rail(对齐 Codex userMessageNavigation 真实 CSS:右缘小横杠列,hover 波浪放大
//    scaleX 1/0.7/0.4/0.2 邻近衰减,点击跳到那条用户消息;≥2 条才显示)——
function UserMessageRail({ containerRef }: { containerRef: React.RefObject<HTMLDivElement | null> }) {
  const blocks = useChatStore((s) => s.blocks)
  const users = useMemo(() => blocks.filter((b): b is Extract<ChatBlock, { kind: 'user' }> => b.kind === 'user'), [blocks])
  const [hover, setHover] = useState<number | null>(null)
  const [current, setCurrent] = useState(0)

  // 当前可视的用户消息(对齐 Codex aria-current):IntersectionObserver 取视口内最靠上的一条。
  useEffect(() => {
    const root = containerRef.current
    if (!root || users.length < 2) return
    const nodes = [...root.querySelectorAll('[data-block="user"]')]
    const visible = new Set<number>()
    const io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          const idx = nodes.indexOf(en.target as Element)
          if (idx === -1) continue
          if (en.isIntersecting) visible.add(idx)
          else visible.delete(idx)
        }
        if (visible.size > 0) setCurrent(Math.min(...visible))
      },
      { root, threshold: 0.1 },
    )
    nodes.forEach((n) => io.observe(n))
    return () => io.disconnect()
  }, [containerRef, users.length])

  if (users.length < 2) return null

  const jump = (i: number) => {
    const nodes = containerRef.current?.querySelectorAll('[data-block="user"]')
    nodes?.[i]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }
  const scaleFor = (i: number) => {
    if (hover == null) return i === current ? 0.6 : 0.35
    const d = Math.abs(i - hover)
    return d === 0 ? 1 : d === 1 ? 0.7 : d === 2 ? 0.45 : d === 3 ? 0.28 : 0.2
  }

  return (
    <div
      className="absolute right-1 top-1/2 z-10 flex -translate-y-1/2 flex-col"
      onMouseLeave={() => setHover(null)}
      aria-label="用户消息"
      data-testid="user-message-rail"
    >
      {users.map((u, i) => (
        <button
          key={u.id}
          type="button"
          title={u.text.slice(0, 48)}
          aria-label={`跳转到用户消息 ${i + 1}`}
          aria-current={i === current || undefined}
          onMouseEnter={() => setHover(i)}
          onClick={() => jump(i)}
          className="flex h-[14px] w-[30px] items-center justify-end pr-1"
        >
          <span
            className="block h-[2px] w-[24px] rounded-full"
            style={{
              background: i === current ? 'var(--color-text-secondary)' : 'var(--color-text-tertiary)',
              transform: `scaleX(${scaleFor(i)})`,
              transformOrigin: 'right',
              transition: 'transform .16s ease, background .16s ease',
            }}
          />
        </button>
      ))}
    </div>
  )
}

type ToolBlockT = Extract<ChatBlock, { kind: 'tool' }>
type ThinkingBlockT = Extract<ChatBlock, { kind: 'thinking' }>
type ActivityBlockT = ToolBlockT | ThinkingBlockT
type AssistantBlockT = Extract<ChatBlock, { kind: 'assistant' }>
type RenderItem =
  | { key: string; kind: 'tool-group'; blocks: ActivityBlockT[] }
  | { key: string; kind: 'edit-group'; blocks: ToolBlockT[] }
  | { key: string; kind: 'block'; block: ChatBlock }

// 编辑类工具:连续的这些块折成 Codex「已编辑 N 个文件」汇总卡,和普通工具行分开。
const EDIT_TOOLS = new Set(['edit_file', 'multi_edit_file', 'write_file', 'patch_file', 'patch_files', 'edit_excel'])

// 内部机制工具:加载技能/搜工具/读暂存结果等 setup 动作,不作为用户级工具行显示——
// 对齐 Codex(内部装载从不摊给用户,只展示对用户有意义的执行步骤:读/写/跑/搜/改)。
// owner 截图指出「已加载工具/读取 Spreadsheets 技能」这类内部行外露=噪音。
const HIDDEN_TOOLS = new Set(['use_skill', 'tool_search', 'read_stored_tool_result'])

/** 连续「工具 + 思考」聚成一个活动组(对齐 Codex agent-activity:思考进组、不占独立行;完成态组头
 *  =分类计数段)。编辑类不混组(走「已编辑 N 个文件」汇总卡,带撤销)。 */
export function groupBlocks(blocks: ChatBlock[]): RenderItem[] {
  // 先滤掉内部机制工具行(藏内部 setup 噪音),再分组。
  const visible = blocks.filter((b) => !(b.kind === 'tool' && HIDDEN_TOOLS.has(b.tool)))
  const items: RenderItem[] = []
  let i = 0
  const isActivity = (b: ChatBlock): b is ActivityBlockT =>
    b.kind === 'thinking' || (b.kind === 'tool' && !EDIT_TOOLS.has(b.tool))
  while (i < visible.length) {
    const b = visible[i]!
    if (b.kind === 'tool' && EDIT_TOOLS.has(b.tool)) {
      const group: ToolBlockT[] = [b]
      let j = i + 1
      while (j < visible.length) {
        const next = visible[j]
        if (!next || next.kind !== 'tool' || !EDIT_TOOLS.has(next.tool)) break
        group.push(next)
        j += 1
      }
      items.push({ key: b.id, kind: 'edit-group', blocks: group })
      i = j
    } else if (isActivity(b)) {
      const group: ActivityBlockT[] = [b]
      let j = i + 1
      while (j < visible.length) {
        const next = visible[j]
        if (!next || !isActivity(next)) break
        group.push(next)
        j += 1
      }
      items.push({ key: b.id, kind: 'tool-group', blocks: group })
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
export function splitTurns(items: RenderItem[]): TurnEntry[] {
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

export function Block({ block, isLast }: { block: ChatBlock; isLast?: boolean }) {
  switch (block.kind) {
    case 'user':
      return (
        <div className="group/user my-2 flex items-center justify-end gap-1" data-block="user" data-bid={block.id}>
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
        <div className="group/msg text-sm leading-relaxed" data-block="assistant" data-bid={block.id} style={{ color: 'var(--color-text-primary)' }}>
          <MarkdownRenderer content={block.text} />
          {!block.streaming && block.text.trim() && <MessageActions text={block.text} pinned={isLast} ts={block.ts} />}
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

function renderItem(item: RenderItem, isLast: boolean, lastEditKey?: string) {
  // 撤销只放最新一组编辑卡:后端 rewind 按「最新 checkpoint」回退,旧卡接上会指错轮,不如不显示。
  if (item.kind === 'edit-group') return <EditSummaryCard key={item.key} blocks={item.blocks} canUndo={item.key === lastEditKey} />
  if (item.kind === 'tool-group') return <ToolCallGroup key={item.key} blocks={item.blocks} />
  return <Block key={item.key} block={item.block} isLast={isLast} />
}

/** Codex 只折叠最终回复之前的 Agent 活动，最终回复本身始终可见。 */
export function partitionTurnItems(items: RenderItem[]): {
  activityItems: RenderItem[]
  responseItems: RenderItem[]
  finalAssistant?: AssistantBlockT
  hasActivity: boolean
} {
  let finalAssistantIndex = -1
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]
    if (item?.kind === 'block' && item.block.kind === 'assistant') {
      finalAssistantIndex = i
      break
    }
  }
  const finalItem = finalAssistantIndex >= 0 ? items[finalAssistantIndex] : undefined
  const finalAssistant = finalItem?.kind === 'block' && finalItem.block.kind === 'assistant' ? finalItem.block : undefined
  const activityItems = finalAssistantIndex >= 0 ? items.slice(0, finalAssistantIndex) : items
  const responseItems = finalAssistantIndex >= 0 ? items.slice(finalAssistantIndex) : []
  const hasActivity = activityItems.some((item) =>
    item.kind === 'tool-group' || item.kind === 'edit-group' || (item.kind === 'block' && (item.block.kind === 'thinking' || item.block.kind === 'assistant')),
  )
  return { activityItems, responseItems, finalAssistant, hasActivity }
}

function TurnBody({ items, lastKey, lastEditKey, isLatest }: { items: RenderItem[]; lastKey: string | undefined; lastEditKey: string | undefined; isLatest: boolean }) {
  const [collapsed, setCollapsed] = useState(false)
  const status = useChatStore((s) => s.status)
  const elapsedSeconds = useChatStore((s) => s.elapsedSeconds)
  const { activityItems, responseItems, finalAssistant, hasActivity } = partitionTurnItems(items)

  if (!finalAssistant && !hasActivity) {
    return <>{items.map((item) => renderItem(item, item.key === lastKey, lastEditKey))}</>
  }
  const activityActive = isLatest && status === 'running' && !finalAssistant

  return (
    <div className="my-1" data-block="turn">
      {hasActivity && (
        <AssistantMessageHeader
          active={activityActive}
          elapsedSec={activityActive ? elapsedSeconds : undefined}
          durationSec={finalAssistant?.durationSec}
          collapsed={collapsed}
          onToggle={() => setCollapsed((v) => !v)}
        />
      )}
      {hasActivity && !collapsed && (
        <div data-block="turn-activity">
          {activityItems.map((item) => renderItem(item, item.key === lastKey, lastEditKey))}
        </div>
      )}
      {responseItems.length > 0 && (
        <div data-block="turn-response">
          {responseItems.map((item) => renderItem(item, item.key === lastKey, lastEditKey))}
        </div>
      )}
    </div>
  )
}

export function MessageList() {
  const blocks = useChatStore((s) => s.blocks)
  const endRef = useRef<HTMLDivElement>(null)
  const items = useMemo(() => groupBlocks(blocks), [blocks])
  const turns = useMemo(() => splitTurns(items), [items])
  const lastKey = items[items.length - 1]?.key
  // 最新一组编辑卡的 key(只有它显示「撤销」,对应后端最新 checkpoint)。
  const lastEditKey = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) if (items[i]!.kind === 'edit-group') return items[i]!.key
    return undefined
  }, [items])
  const containerRef = useRef<HTMLDivElement>(null)
  const [atBottom, setAtBottom] = useState(true)
  const [findOpen, setFindOpen] = useState(false)

  function onScroll() {
    const el = containerRef.current
    if (!el) return
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80)
  }

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [blocks])

  // ⌘F / ⌘K 面板「在任务中查找」打开线程内查找(对齐 Codex threadFindBar;只在消息流挂载时生效)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault()
        setFindOpen(true)
      }
    }
    const onOpenFind = () => setFindOpen(true)
    window.addEventListener('keydown', onKey)
    window.addEventListener('qf-open-find', onOpenFind)
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('qf-open-find', onOpenFind) }
  }, [])

  return (
    <div className="relative min-h-0 flex-1">
      {findOpen && <FindBar containerRef={containerRef} onClose={() => setFindOpen(false)} />}
      <UserMessageRail containerRef={containerRef} />
      <div ref={containerRef} onScroll={onScroll} className="h-full overflow-y-auto px-4 py-4">
        <div className="mx-auto max-w-[768px]">
          <SessionTaskBar />
          {turns.map((entry, index) =>
            entry.type === 'user' ? (
              renderItem(entry.item, entry.item.key === lastKey, lastEditKey)
            ) : (
              <TurnBody key={entry.key} items={entry.items} lastKey={lastKey} lastEditKey={lastEditKey} isLatest={index === turns.length - 1} />
            ),
          )}
          <StreamingIndicator />
          <StepCapsule />
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
