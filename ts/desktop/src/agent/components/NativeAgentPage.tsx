import { useCallback, useEffect, useRef, useState, type ChangeEvent, type FormEvent, type KeyboardEvent } from 'react'
import { MarkdownRenderer } from '../../components/markdown/MarkdownRenderer'
import { getDesktopHost } from '../../lib/desktopHost'
import type {
  NativeAgentApprovalDecision,
  NativeAgentEvent,
  NativeAgentThreadSnapshot,
  NativeAgentTurnInput,
} from '../../lib/desktopHost/types'

type NativeAgentPageProps = {
  threadId?: string
  workDir?: string
  onThreadReady?: (threadId: string, workDir: string, title: string) => void
}

type AgentEntry = {
  id: string
  kind: 'user' | 'assistant' | 'activity'
  text: string
  complete: boolean
}

type ImageDraft = {
  name: string
  url: string
}

type Approval = Extract<NativeAgentEvent, { type: 'approval' }>

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function protocolThreadId(params: unknown): string | undefined {
  return text(object(params)?.threadId)
}

function protocolTurnId(params: unknown): string | undefined {
  return text(object(params)?.turnId) ?? text(object(object(params)?.turn)?.id)
}

function userItemText(item: Record<string, unknown>): string {
  const content = Array.isArray(item.content) ? item.content : []
  const parts = content.flatMap((raw) => {
    const input = object(raw)
    if (!input) return []
    if (input.type === 'text' && typeof input.text === 'string') return [input.text]
    if (input.type === 'image' || input.type === 'localImage') return ['[图片]']
    if (input.type === 'audio' || input.type === 'localAudio') return ['[音频]']
    if (input.type === 'skill' && typeof input.name === 'string') return [`/${input.name}`]
    if (input.type === 'mention' && typeof input.name === 'string') return [`@${input.name}`]
    return []
  })
  return parts.join('\n') || '（没有可显示的输入内容）'
}

function itemEntry(itemValue: unknown): AgentEntry | null {
  const item = object(itemValue)
  const id = text(item?.id)
  const type = text(item?.type)
  if (!item || !id || !type) return null
  if (type === 'userMessage') {
    return { id, kind: 'user', text: userItemText(item), complete: true }
  }
  if (type === 'agentMessage') {
    return { id, kind: 'assistant', text: text(item.text) ?? '', complete: false }
  }
  if (type === 'commandExecution') {
    const command = text(item.command) ?? '命令'
    const output = text(item.aggregatedOutput)
    const status = text(item.status) ?? '执行中'
    return { id, kind: 'activity', text: `命令 · ${status}\n${command}${output ? `\n\n${output}` : ''}`, complete: status !== 'inProgress' }
  }
  if (type === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes.length : 0
    return { id, kind: 'activity', text: `文件修改 · ${text(item.status) ?? '执行中'}${changes ? `（${changes} 项）` : ''}`, complete: text(item.status) !== 'inProgress' }
  }
  if (type === 'reasoning') {
    const summary = Array.isArray(item.summary) ? item.summary.filter((part): part is string => typeof part === 'string').join('\n') : ''
    return summary ? { id, kind: 'activity', text: `推理摘要\n${summary}`, complete: true } : null
  }
  if (type === 'contextCompaction') return { id, kind: 'activity', text: '正在压缩上下文', complete: false }
  if (type === 'mcpToolCall') return { id, kind: 'activity', text: `MCP · ${text(item.server) ?? '服务'} / ${text(item.tool) ?? '工具'} · ${text(item.status) ?? '执行中'}`, complete: text(item.status) !== 'inProgress' }
  if (type === 'webSearch') return { id, kind: 'activity', text: '正在进行网页检索', complete: true }
  if (type === 'collabAgentToolCall') return { id, kind: 'activity', text: `协作 Agent · ${text(item.tool) ?? '操作'}`, complete: true }
  return null
}

function titleFromDraft(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized ? normalized.slice(0, 42) : '新 Agent 会话'
}

function approvalLabel(value: NativeAgentApprovalDecision): string {
  switch (value) {
    case 'accept': return '允许一次'
    case 'acceptForSession': return '本会话允许'
    case 'cancel': return '取消本轮'
    case 'decline': return '拒绝'
  }
}

function approvalDescription(approval: Approval): string {
  const params = object(approval.params)
  if (approval.method === 'item/commandExecution/requestApproval') {
    return text(params?.command) ?? text(params?.reason) ?? 'Agent 请求执行命令。'
  }
  const changes = Array.isArray(params?.changes) ? params.changes.length : 0
  return `${text(params?.reason) ?? 'Agent 请求修改文件。'}${changes ? `（${changes} 项改动）` : ''}`
}

function mergeEntry(entries: AgentEntry[], next: AgentEntry): AgentEntry[] {
  const index = entries.findIndex(entry => entry.id === next.id)
  if (index < 0) return [...entries, next]
  return entries.map((entry, entryIndex) => entryIndex === index ? { ...entry, ...next } : entry)
}

function snapshotEntries(snapshot: NativeAgentThreadSnapshot): AgentEntry[] {
  const thread = object(snapshot.thread)
  const turns = Array.isArray(thread?.turns) ? thread.turns : []
  const entries: AgentEntry[] = []
  for (const turn of turns) {
    const items = Array.isArray(object(turn)?.items) ? object(turn)?.items as unknown[] : []
    for (const item of items) {
      const entry = itemEntry(item)
      if (entry) entries.push({ ...entry, complete: true })
    }
  }
  return entries
}

async function imageDrafts(event: ChangeEvent<HTMLInputElement>): Promise<ImageDraft[]> {
  const files = Array.from(event.target.files ?? [])
  event.target.value = ''
  return await Promise.all(files.slice(0, 4).map(async file => await new Promise<ImageDraft>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('读取图片失败'))
    reader.onload = () => typeof reader.result === 'string'
      ? resolve({ name: file.name || '图片', url: reader.result })
      : reject(new Error('读取图片失败'))
    reader.readAsDataURL(file)
  })))
}

/**
 * The first formal BilliardBuddy Agent surface. It projects native App Server
 * Items only; it does not read or write ProductTask, Run, Worker or Tool Host
 * state. Rust remains the durable Thread owner.
 */
export function NativeAgentPage({ threadId: persistedThreadId, workDir: persistedWorkDir, onThreadReady }: NativeAgentPageProps) {
  const host = getDesktopHost()
  const [threadId, setThreadId] = useState<string | null>(persistedThreadId ?? null)
  const [workDir, setWorkDir] = useState(persistedWorkDir ?? '')
  const [entries, setEntries] = useState<AgentEntry[]>([])
  const [approvals, setApprovals] = useState<Approval[]>([])
  const [draft, setDraft] = useState('')
  const [images, setImages] = useState<ImageDraft[]>([])
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [isStarting, setIsStarting] = useState(Boolean(persistedThreadId))
  const [error, setError] = useState<string | null>(null)
  const threadIdRef = useRef<string | null>(persistedThreadId ?? null)
  const completedTurnsRef = useRef(new Set<string>())
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const setCurrentThread = useCallback((nextThreadId: string | null) => {
    threadIdRef.current = nextThreadId
    setThreadId(nextThreadId)
  }, [])

  const hydrate = useCallback(async (id: string) => {
    try {
      const snapshot = await host.nativeAgent.readThread(id)
      if (threadIdRef.current === id) setEntries(snapshotEntries(snapshot))
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      // An empty Thread has no rollout yet. It is valid immediately after
      // thread/start and should render as a clean composer, not an error.
      if (!/no rollout found/i.test(message)) throw reason
    }
  }, [host.nativeAgent])

  useEffect(() => {
    if (!persistedThreadId || !persistedWorkDir || !host.capabilities.nativeAgent) return
    let cancelled = false
    setIsStarting(true)
    setError(null)
    void (async () => {
      try {
        const resumed = await host.nativeAgent.resumeThread(persistedThreadId, persistedWorkDir)
        if (cancelled) return
        setCurrentThread(resumed.id)
        await hydrate(resumed.id)
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : '无法恢复本地 Agent 会话。')
      } finally {
        if (!cancelled) setIsStarting(false)
      }
    })()
    return () => { cancelled = true }
  }, [host.capabilities.nativeAgent, host.nativeAgent, hydrate, persistedThreadId, persistedWorkDir, setCurrentThread])

  useEffect(() => {
    if (!host.capabilities.nativeAgent) return
    let unlisten: (() => void) | undefined
    void host.nativeAgent.onEvent((event) => {
      const currentThreadId = threadIdRef.current
      const eventThreadId = event.type === 'approval'
        ? protocolThreadId(event.params)
        : protocolThreadId(event.params)
      if (!currentThreadId || eventThreadId !== currentThreadId) return
      if (event.type === 'approval') {
        setApprovals(current => current.some(value => value.requestId === event.requestId) ? current : [...current, event])
        return
      }
      const params = object(event.params)
      if (event.method === 'item/agentMessage/delta') {
        const itemId = text(params?.itemId)
        const delta = text(params?.delta)
        if (itemId && delta !== undefined) {
          setEntries(current => {
            const existing = current.find(entry => entry.id === itemId)
            return mergeEntry(current, {
              id: itemId,
              kind: 'assistant',
              text: `${existing?.text ?? ''}${delta}`,
              complete: false,
            })
          })
        }
        return
      }
      if (event.method === 'item/started' || event.method === 'item/completed') {
        const entry = itemEntry(params?.item)
        if (entry) setEntries(current => mergeEntry(current, { ...entry, complete: event.method === 'item/completed' || entry.complete }))
        return
      }
      if (event.method === 'turn/completed') {
        const completedTurnId = protocolTurnId(params)
        if (completedTurnId) completedTurnsRef.current.add(completedTurnId)
        setActiveTurnId(current => current === completedTurnId ? null : current)
        return
      }
      if (event.method === 'error') {
        const issue = object(params?.error)
        setError(text(issue?.message) ?? 'Agent 本轮执行未完成。')
      }
    }).then((cleanup) => { unlisten = cleanup }).catch(() => {})
    return () => { unlisten?.() }
  }, [host.capabilities.nativeAgent, host.nativeAgent])

  const chooseWorkspace = async () => {
    try {
      const selected = await host.dialogs.open({ directory: true, title: '选择 Agent 工作目录' })
      const directory = Array.isArray(selected) ? selected[0] : selected
      if (directory) {
        setWorkDir(directory)
        setError(null)
      }
    } catch {
      setError('无法打开工作目录选择器。')
    }
  }

  const submit = async () => {
    if (!host.capabilities.nativeAgent || isStarting) return
    const trimmed = draft.trim()
    if (!trimmed && images.length === 0) return
    if (!workDir.trim()) {
      setError('请先选择 Agent 工作目录。')
      return
    }
    setError(null)
    let currentThreadId = threadIdRef.current
    try {
      if (!currentThreadId) {
        setIsStarting(true)
        const created = await host.nativeAgent.startThread(workDir)
        currentThreadId = created.id
        setCurrentThread(created.id)
        onThreadReady?.(created.id, workDir, titleFromDraft(trimmed))
        setIsStarting(false)
      }
      const input: NativeAgentTurnInput[] = [
        ...(trimmed ? [{ type: 'text' as const, text: trimmed }] : []),
        ...images.map(({ url }) => ({ type: 'image' as const, url })),
      ]
      if (activeTurnId) {
        await host.nativeAgent.steerTurn(currentThreadId, activeTurnId, trimmed || '请继续处理已附加的图片。')
      } else {
        const turn = await host.nativeAgent.startTurn(currentThreadId, input)
        if (!completedTurnsRef.current.has(turn.id)) setActiveTurnId(turn.id)
      }
      setDraft('')
      setImages([])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法发送这条 Agent 指令。')
    } finally {
      setIsStarting(false)
    }
  }

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    void submit()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229 || event.key !== 'Enter' || event.shiftKey) return
    event.preventDefault()
    void submit()
  }

  const resolveApproval = async (approval: Approval, decision: NativeAgentApprovalDecision) => {
    try {
      await host.nativeAgent.resolveApproval(approval.requestId, decision)
      setApprovals(current => current.filter(value => value.requestId !== approval.requestId))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法提交审批决定。')
    }
  }

  const stop = async () => {
    if (!threadId || !activeTurnId) return
    try {
      await host.nativeAgent.interruptTurn(threadId, activeTurnId)
      setActiveTurnId(null)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法停止当前回合。')
    }
  }

  const fork = async () => {
    if (!threadId || !workDir) return
    try {
      const created = await host.nativeAgent.forkThread(threadId, workDir)
      setEntries([])
      setApprovals([])
      setActiveTurnId(null)
      setCurrentThread(created.id)
      onThreadReady?.(created.id, workDir, '分叉会话')
      await hydrate(created.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法分叉当前会话。')
    }
  }

  const addImages = async (event: ChangeEvent<HTMLInputElement>) => {
    try {
      const next = await imageDrafts(event)
      setImages(current => [...current, ...next].slice(0, 4))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法读取图片。')
    }
  }

  if (!host.capabilities.nativeAgent) {
    return (
      <main className="flex h-full min-h-0 items-center justify-center bg-[var(--color-app-main)] px-6">
        <p className="max-w-lg text-center text-sm leading-6 text-[var(--color-text-secondary)]">原生 Agent 需要在 BilliardBuddy 桌面应用中运行。</p>
      </main>
    )
  }

  return (
    <main className="flex h-full min-h-0 flex-col bg-[var(--color-app-main)]" data-testid="native-agent-page">
      <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold text-[var(--color-text-primary)]">BilliardBuddy Agent</h1>
          <p className="mt-0.5 truncate text-xs text-[var(--color-text-secondary)]">
            {workDir || '选择一个本地工作目录后开始'}
          </p>
        </div>
        <button type="button" onClick={() => void chooseWorkspace()} disabled={Boolean(threadId) || isStarting} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] disabled:opacity-50">
          {workDir ? '工作目录' : '选择目录'}
        </button>
        {threadId ? (
          <button type="button" onClick={() => void fork()} disabled={Boolean(activeTurnId) || isStarting} className="rounded-lg border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] disabled:opacity-50">
            分叉
          </button>
        ) : null}
        {activeTurnId ? (
          <button type="button" onClick={() => void stop()} className="rounded-lg bg-[var(--color-error)] px-3 py-1.5 text-xs font-medium text-white">停止</button>
        ) : null}
      </header>

      <section className="min-h-0 flex-1 overflow-y-auto px-5 py-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
          {!threadId && !isStarting ? (
            <div className="rounded-2xl border border-dashed border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-8 text-center">
              <h2 className="text-base font-medium text-[var(--color-text-primary)]">开始一个本地 Agent 会话</h2>
              <p className="mt-2 text-sm leading-6 text-[var(--color-text-secondary)]">会话、工具结果和恢复资料只保存在此设备的 Codex Thread Store。BilliardBuddy 网关仅处理模型鉴权与用量。</p>
            </div>
          ) : null}
          {entries.map(entry => entry.kind === 'user' ? (
            <article key={entry.id} className="ml-auto max-w-[min(42rem,88%)] rounded-2xl rounded-br-md bg-[var(--color-primary)] px-4 py-3 text-sm leading-6 text-white">
              <p className="whitespace-pre-wrap">{entry.text}</p>
            </article>
          ) : entry.kind === 'assistant' ? (
            <article key={entry.id} className="max-w-3xl rounded-2xl rounded-bl-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm leading-6 text-[var(--color-text-primary)]">
              <MarkdownRenderer content={entry.text || '正在思考…'} streaming={!entry.complete} />
            </article>
          ) : (
            <details key={entry.id} className="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-xs text-[var(--color-text-secondary)]">
              <summary className="cursor-pointer select-none">{entry.text.split('\n')[0]}</summary>
              {entry.text.includes('\n') ? <pre className="mt-2 max-h-52 overflow-auto whitespace-pre-wrap font-mono text-[11px]">{entry.text}</pre> : null}
            </details>
          ))}

          {approvals.map(approval => (
            <section key={approval.requestId} className="rounded-xl border border-[var(--color-warning)]/50 bg-[var(--color-warning)]/10 p-4">
              <p className="text-sm font-medium text-[var(--color-text-primary)]">需要你的确认</p>
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap text-xs leading-5 text-[var(--color-text-secondary)]">{approvalDescription(approval)}</pre>
              <div className="mt-3 flex flex-wrap gap-2">
                {approval.availableDecisions.map(decision => (
                  <button key={decision} type="button" onClick={() => void resolveApproval(approval, decision)} className={`rounded-lg px-3 py-1.5 text-xs font-medium ${decision === 'accept' || decision === 'acceptForSession' ? 'bg-[var(--color-primary)] text-white' : 'border border-[var(--color-border)] text-[var(--color-text-primary)]'}`}>
                    {approvalLabel(decision)}
                  </button>
                ))}
              </div>
            </section>
          ))}
        </div>
      </section>

      <footer className="shrink-0 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
        <form onSubmit={onSubmit} className="mx-auto w-full max-w-3xl">
          {error ? <p role="alert" className="mb-2 text-xs text-[var(--color-error)]">{error}</p> : null}
          {images.length ? (
            <div className="mb-2 flex flex-wrap gap-2">
              {images.map((image, index) => (
                <button key={`${image.name}:${index}`} type="button" title="移除图片" onClick={() => setImages(current => current.filter((_, itemIndex) => itemIndex !== index))} className="group relative h-14 w-14 overflow-hidden rounded-md border border-[var(--color-border)]">
                  <img src={image.url} alt={image.name} className="h-full w-full object-cover" />
                  <span className="absolute inset-0 hidden items-center justify-center bg-black/50 text-xs text-white group-hover:flex">移除</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="flex items-end gap-2 rounded-2xl border border-[var(--color-border)] bg-[var(--color-app-main)] p-2">
            <input ref={fileInputRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="hidden" onChange={(event) => void addImages(event)} />
            <button type="button" title="添加图片" onClick={() => fileInputRef.current?.click()} disabled={isStarting} className="mb-1 rounded-lg px-2 py-1 text-lg text-[var(--color-text-secondary)] disabled:opacity-50">+</button>
            <textarea value={draft} onChange={event => setDraft(event.target.value)} onKeyDown={onKeyDown} rows={2} placeholder={activeTurnId ? '补充或引导当前回合…' : '描述你希望 Agent 完成的工作…'} className="min-h-[48px] flex-1 resize-none bg-transparent px-1 py-2 text-sm leading-6 outline-none placeholder:text-[var(--color-text-tertiary)]" />
            <button type="submit" disabled={isStarting || (!draft.trim() && images.length === 0)} className="mb-1 rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
              {isStarting ? '准备中' : activeTurnId ? '引导' : '发送'}
            </button>
          </div>
        </form>
      </footer>
    </main>
  )
}
