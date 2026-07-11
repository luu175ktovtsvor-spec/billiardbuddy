// chatStore —— 地基最高风险件。消息 reducer 逐字段对齐我们真实的 /agent/ws 协议:
//   顶层信封(ServerMessage):ready / error / event / pong / approve_result / reject_result / steer_result / interrupt_result
//   event.event(AgentEvent,见 types/events.ts):content_delta / thinking / tool_call(用 input!) / tool_result /
//     final / approval_request / context_note / steering / max_turns_reached / done ...
// 参照物 = 现有 vanilla app.js 的 renderEvent(交互细节的验收基线),但不搬它的 DOM 代码。
import { create } from 'zustand'
import { wsManager } from '../api/websocket'
import { useSettingsStore } from './settingsStore'
import { useSessionStore } from './sessionStore'
import type { ClientMessage, ServerMessage } from '../types/chat'
import type { AgentEvent, ApprovalReason } from '../types/events'

// 命令实时输出尾部上限(字符):tool_progress 逐块文本累加进 block.liveOutput 供终端/展开行实时滚动,
// 超过就只保留尾部(实时看的是最新输出;完整全文另由命令结束的 tool_result 落 block.output)。
const LIVE_OUTPUT_CAP = 48_000

export type RunVerb = 'working' | 'thinking' | 'running'
// 四态互斥(对齐 cc ToolCallBlock):running(进行中)/ ok(成功)/ error(失败)/ interrupted(中断)。
export type ToolStatus = 'running' | 'ok' | 'error' | 'interrupted'

export interface TodoItem {
  task: string
  status: 'pending' | 'in_progress' | 'done'
}

export type ChatBlock =
  | { id: string; kind: 'user'; text: string }
  // durationSec:视觉皮改造新增(对齐 Codex 助手回合头「已完成 Xs」),只在 'done' 时快照一次,不参与任何状态机判断。
  | { id: string; kind: 'assistant'; text: string; streaming: boolean; ts?: number; tokens?: number; durationSec?: number }
  | { id: string; kind: 'thinking'; text: string; active: boolean }
  // startedAt/endedAt:视觉皮改造新增(工具编组折叠头「已完成 Xs」耗时展示),纯展示用元数据。
  | { id: string; kind: 'tool'; tool: string; input: unknown; output?: string; status: ToolStatus; liveChars?: number; liveOutput?: string; startedAt?: number; endedAt?: number }
  | {
      id: string
      kind: 'approval'
      tool: string
      args: unknown
      token: string
      preview?: string
      reason?: ApprovalReason
      warning?: string
      rememberable?: boolean
      resolved: null | 'approved' | 'approved-session' | 'rejected'
    }
  | { id: string; kind: 'note'; text: string; variant: 'note' | 'steering' | 'error' | 'maxturns' | 'api_retry' | 'streaming_fallback' }

interface ChatState {
  conversationId: string | null
  blocks: ChatBlock[]
  status: 'idle' | 'running'
  connected: boolean
  runVerb: RunVerb
  lastSeq: number
  // 忙碌胶囊(对齐 cc StreamingIndicator):本回合秒表 + 估算已流出字数(字数/4≈token,和 cc 一致)。
  elapsedSeconds: number
  streamingChars: number
  // todo 会话栏(对齐 cc SessionTaskBar):单一真相源从 todo_update 事件解析而来。
  todos: TodoItem[]
  todoBarExpanded: boolean
  // 内部流式指针
  _currentAssistantId: string | null
  _currentThinkingId: string | null
  _sawStreaming: boolean
  _lastTotalTokens: number
  _turnBaselineTokens: number
  _unsub: (() => void) | null
  _wantReplay: boolean
  /** 是否已收到过一次 ready:用于区分首连与重连(重连后要补拉遗漏事件)。 */
  _sawReady: boolean

  startConversation: (conversationId: string, opts?: { replay?: boolean }) => void
  sendMessage: (text: string) => void
  approve: (blockId: string, remember: boolean) => void
  reject: (blockId: string) => void
  interrupt: () => void
  disconnect: () => void
  toggleTodoBar: () => void
  dismissTodos: () => void
}

let seqCounter = 0
function newBlockId(): string {
  seqCounter += 1
  return `b${seqCounter}-${Math.random().toString(36).slice(2, 7)}`
}

const ERROR_RE = /error|错误|失败|<tool_use_error>/i

// —— 流式节流(file:line 对齐 cc-haha-ref desktop/src/stores/chatStore.ts:1743-1765 的
// content_delta 50ms 攒批量刷:攒够 50ms 里到的所有 delta 一次性提交,不逐字触发重渲染)。
let pendingAssistantDelta = ''
let assistantFlushTimer: ReturnType<typeof setTimeout> | null = null
let pendingThinkingDelta = ''
let thinkingFlushTimer: ReturnType<typeof setTimeout> | null = null
// 本地乐观 user 气泡的回声计数:sendMessage 先本地插一条 user 块,server 又会把同一句作
// user_prompt 事件发回(事件日志=回放唯一真相源)。计数>0 时吞掉一次回声防双气泡;回放时计数=0 → 正常重建。
let pendingUserEcho = 0

// todo_update 载荷是后端 formatTodoChecklist()(ts/src/types/todo.ts)吐出的大白话清单文本,
// 前端从 ☐/◐/☑ 行标记反解析回结构化项,渲成 SessionTaskBar(对齐 cc SessionTaskBar 的结构化 task 列表)。
const TODO_MARK_STATUS: Record<string, TodoItem['status']> = { '☐': 'pending', '◐': 'in_progress', '☑': 'done' }
function parseTodoChecklist(content: string): TodoItem[] {
  const items: TodoItem[] = []
  for (const line of content.split('\n')) {
    const m = /^\s*([☐◐☑])\s*(.+)$/.exec(line)
    if (!m) continue
    const status = TODO_MARK_STATUS[m[1]!]
    const task = m[2]!.trim()
    if (status && task) items.push({ task, status })
  }
  return items
}

type NoteVariant = Extract<ChatBlock, { kind: 'note' }>['variant']

export const useChatStore = create<ChatState>((set, get) => {
  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  function stopElapsedTimer() {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
  }
  /** 回合开始:秒表清零起跑 + 流出字数清零(对齐 cc ensureElapsedTimer)。 */
  function startElapsedTimer() {
    stopElapsedTimer()
    const startedAt = Date.now()
    set({ elapsedSeconds: 0, streamingChars: 0 })
    elapsedTimer = setInterval(() => {
      set({ elapsedSeconds: Math.floor((Date.now() - startedAt) / 1000) })
    }, 1000)
  }

  function commitAssistantText(text: string) {
    const id = get()._currentAssistantId
    if (id) {
      set((s) => ({
        streamingChars: s.streamingChars + text.length,
        blocks: s.blocks.map((b) => (b.id === id && b.kind === 'assistant' ? { ...b, text: b.text + text } : b)),
      }))
    } else {
      const nid = newBlockId()
      set((s) => ({
        _currentAssistantId: nid,
        streamingChars: s.streamingChars + text.length,
        blocks: [...s.blocks, { id: nid, kind: 'assistant', text, streaming: true, ts: Date.now() }],
      }))
    }
  }

  function flushAssistantDelta() {
    if (assistantFlushTimer) {
      clearTimeout(assistantFlushTimer)
      assistantFlushTimer = null
    }
    if (!pendingAssistantDelta) return
    const text = pendingAssistantDelta
    pendingAssistantDelta = ''
    commitAssistantText(text)
  }

  /** final 事件的全文是权威覆盖,丢弃(不提交)尚未落地的 delta 残片,防止追加重复。 */
  function discardAssistantBuffer() {
    if (assistantFlushTimer) {
      clearTimeout(assistantFlushTimer)
      assistantFlushTimer = null
    }
    pendingAssistantDelta = ''
  }

  function commitThinkingText(text: string) {
    const id = get()._currentThinkingId
    if (id) {
      set((s) => ({
        streamingChars: s.streamingChars + text.length,
        blocks: s.blocks.map((b) => (b.id === id && b.kind === 'thinking' ? { ...b, text: b.text + text } : b)),
      }))
    } else {
      const nid = newBlockId()
      set((s) => ({
        _currentThinkingId: nid,
        streamingChars: s.streamingChars + text.length,
        blocks: [...s.blocks, { id: nid, kind: 'thinking', text, active: true }],
      }))
    }
  }

  function flushThinkingDelta() {
    if (thinkingFlushTimer) {
      clearTimeout(thinkingFlushTimer)
      thinkingFlushTimer = null
    }
    if (!pendingThinkingDelta) return
    const text = pendingThinkingDelta
    pendingThinkingDelta = ''
    commitThinkingText(text)
  }

  /** 把当前正在流式的 assistant 气泡落定(一轮多气泡分块:工具/思考到来时收尾)。 */
  function settleAssistant() {
    flushAssistantDelta()
    const id = get()._currentAssistantId
    if (!id) return
    set((s) => ({
      _currentAssistantId: null,
      blocks: s.blocks.map((b) => (b.id === id && b.kind === 'assistant' ? { ...b, streaming: false } : b)),
    }))
  }

  function finalizeThinking() {
    flushThinkingDelta()
    const id = get()._currentThinkingId
    if (!id) return
    set((s) => ({
      _currentThinkingId: null,
      blocks: s.blocks.map((b) => (b.id === id && b.kind === 'thinking' ? { ...b, active: false } : b)),
    }))
  }

  /** 回合结束时把这轮真实 token 消耗(累计 total 的回合差)落到最后一条 assistant 气泡。 */
  function attachTurnTokens() {
    const turn = get()._lastTotalTokens - get()._turnBaselineTokens
    if (turn <= 0) return
    set((s) => {
      const blocks = [...s.blocks]
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]
        if (b && b.kind === 'assistant') {
          blocks[i] = { ...b, tokens: turn }
          break
        }
      }
      return { blocks }
    })
  }

  /** 视觉皮改造新增(对齐助手回合头「已完成 Xs」):回合结束时把秒表定格值快照到最后一条 assistant 气泡,
   *  纯展示用,不影响 elapsedSeconds 本身的运行时语义(它下一轮还会被 startElapsedTimer 清零复用)。 */
  function attachTurnDuration() {
    const seconds = get().elapsedSeconds
    if (seconds <= 0) return
    set((s) => {
      const blocks = [...s.blocks]
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i]
        if (b && b.kind === 'assistant') {
          blocks[i] = { ...b, durationSec: seconds }
          break
        }
      }
      return { blocks }
    })
  }

  function appendAssistant(text: string) {
    pendingAssistantDelta += text
    if (!assistantFlushTimer) {
      assistantFlushTimer = setTimeout(() => {
        assistantFlushTimer = null
        const buffered = pendingAssistantDelta
        pendingAssistantDelta = ''
        if (buffered) commitAssistantText(buffered)
      }, 50)
    }
  }

  function appendThinking(text: string) {
    pendingThinkingDelta += text
    if (!thinkingFlushTimer) {
      thinkingFlushTimer = setTimeout(() => {
        thinkingFlushTimer = null
        const buffered = pendingThinkingDelta
        pendingThinkingDelta = ''
        if (buffered) commitThinkingText(buffered)
      }, 50)
    }
  }

  function pushNote(text: string, variant: NoteVariant) {
    set((s) => ({ blocks: [...s.blocks, { id: newBlockId(), kind: 'note', text, variant }] }))
  }

  /** AgentEvent reducer(对齐 app.js renderEvent 一一对应)。 */
  function reduceEvent(ev: AgentEvent | { type: 'done' } | { type: 'user_prompt'; text: string }) {
    switch (ev.type) {
      case 'user_prompt': {
        // 用户这句话(回合流第一条)。本地已乐观插过 → 吞一次回声;回放路径(计数=0)→ 重建用户气泡。
        if (pendingUserEcho > 0) { pendingUserEcho--; break }
        if (ev.text && ev.text.trim()) set((s) => ({ blocks: [...s.blocks, { id: newBlockId(), kind: 'user', text: ev.text }] }))
        break
      }
      case 'content_delta': {
        if (ev.channel === 'text' && ev.text) {
          finalizeThinking()
          set({ _sawStreaming: true, runVerb: 'working' })
          appendAssistant(ev.text)
        } else if (ev.channel === 'thinking' && ev.text) {
          settleAssistant()
          set({ _sawStreaming: true, runVerb: 'thinking' })
          appendThinking(ev.text)
        }
        break
      }
      case 'thinking': {
        // 步末合并事件:流式已逐字渲过就吞掉去重;非流式模型才落进思考块。
        if (ev.text && ev.text.trim() && !get()._sawStreaming) {
          settleAssistant()
          set({ runVerb: 'thinking' })
          appendThinking(ev.text)
        }
        break
      }
      case 'command_invocation': {
        settleAssistant()
        finalizeThinking()
        set({ runVerb: 'running' })
        set((s) => ({
          blocks: [
            ...s.blocks,
            {
              id: newBlockId(),
              kind: 'tool',
              tool: `/${ev.name}`,
              input: ev.args,
              status: 'ok' as ToolStatus,
              output: undefined,
              startedAt: Date.now(),
              endedAt: Date.now(),
            },
          ],
        }))
        break
      }
      case 'tool_call': {
        settleAssistant()
        finalizeThinking()
        set({ runVerb: 'running' })
        set((s) => ({
          // ⚠️ tool_call 载荷是 { tool, input }(不是 args)——对齐后端 harness/loop.ts。
          blocks: [
            ...s.blocks,
            { id: newBlockId(), kind: 'tool', tool: ev.tool, input: ev.input, status: 'running' as ToolStatus, startedAt: Date.now() },
          ],
        }))
        break
      }
      case 'tool_result': {
        const isErr = ERROR_RE.test(ev.output || '')
        set((s) => {
          // 补最近一个 running 的同类工具块(低噪)。
          const blocks = [...s.blocks]
          for (let i = blocks.length - 1; i >= 0; i--) {
            const b = blocks[i]
            if (b && b.kind === 'tool' && b.status === 'running') {
              blocks[i] = { ...b, output: ev.output, status: isErr ? 'error' : 'ok', endedAt: Date.now() }
              break
            }
          }
          return { blocks }
        })
        finalizeThinking()
        settleAssistant()
        break
      }
      case 'tool_progress': {
        // 实时输出:把真实 stdout/stderr 文本累加进最近一个同名 running 工具块,供终端面板 + 对话展开行
        // 逐块实时滚动(此前只累加 chunk.length 当「N 字」、把文本丢了 = 看不到命令实际在跑什么)。
        // 同时保留 liveChars 计数(折叠行「N 字」摘要);文本按尾部截断防长命令无限增长。
        const chunk = typeof ev.chunk === 'string' ? ev.chunk : ''
        if (chunk) {
          set((s) => {
            const blocks = [...s.blocks]
            for (let i = blocks.length - 1; i >= 0; i--) {
              const b = blocks[i]
              if (b && b.kind === 'tool' && b.status === 'running' && b.tool === ev.tool) {
                const merged = (b.liveOutput ?? '') + chunk
                const liveOutput = merged.length > LIVE_OUTPUT_CAP ? merged.slice(merged.length - LIVE_OUTPUT_CAP) : merged
                blocks[i] = { ...b, liveChars: (b.liveChars ?? 0) + chunk.length, liveOutput }
                break
              }
            }
            return { blocks }
          })
        }
        break
      }
      case 'todo_update': {
        set({ todos: parseTodoChecklist(ev.content) })
        break
      }
      case 'ask_question': {
        // 占位类型:归下一批审批/计划 UI,本轮先不渲染、也不吞掉后续事件。
        break
      }
      case 'final': {
        discardAssistantBuffer()
        finalizeThinking()
        // final 全文为权威:覆盖当前流式气泡;没有就新建一条。
        const id = get()._currentAssistantId
        if (ev.text) {
          if (id) {
            set((s) => ({ blocks: s.blocks.map((b) => (b.id === id && b.kind === 'assistant' ? { ...b, text: ev.text, streaming: false } : b)) }))
          } else {
            // 尾随思考会提前 settle 掉流式气泡(有的模型在正文后还继续思考):final 全文与已渲染的
            // 最后一条 assistant 一致时只收尾不追加,防同一回复渲染两遍。
            const last = [...get().blocks].reverse().find((b) => b.kind === 'assistant')
            if (last && last.kind === 'assistant' && last.text === ev.text) {
              set((s) => ({ blocks: s.blocks.map((b) => (b.id === last.id && b.kind === 'assistant' ? { ...b, streaming: false } : b)) }))
            } else {
              set((s) => ({ blocks: [...s.blocks, { id: newBlockId(), kind: 'assistant', text: ev.text, streaming: false, ts: Date.now() }] }))
            }
          }
        }
        settleAssistant()
        set({ runVerb: 'working' })
        break
      }
      case 'approval_request': {
        settleAssistant()
        finalizeThinking()
        set((s) => ({
          blocks: [
            ...s.blocks,
            {
              id: newBlockId(),
              kind: 'approval',
              tool: ev.tool,
              args: ev.args,
              token: ev.token,
              preview: ev.preview,
              reason: ev.reason,
              warning: ev.warning,
              rememberable: ev.rememberable,
              resolved: null,
            },
          ],
        }))
        break
      }
      case 'steering':
        pushNote(`↳ 插话:${ev.content}`, 'steering')
        break
      case 'context_note': {
        const text = ev.text || ''
        // api_retry/streaming_fallback 两种严重度分开(对齐 cc StreamingIndicator 的琥珀/中性两条横幅):
        // 后端目前只把这两类塞进通用 context_note 文本(远程子代理桥接场景,见 tasks/bridgeSdkEventProjection.ts),
        // 前端按文本模式识别、渲成对应色阶的横幅,而不是普通灰字旁白。
        if (/^Remote API retry/i.test(text)) {
          pushNote(text, 'api_retry')
          break
        }
        if (/^Remote streaming fallback/i.test(text)) {
          pushNote(text, 'streaming_fallback')
          break
        }
        if (/压缩|compact/i.test(text)) set({ runVerb: 'working' })
        pushNote(text, 'note')
        break
      }
      case 'max_turns_reached':
        pushNote('连着跑了好几个回合,先停下来喘口气。想接着做的话,回一句让它继续。', 'maxturns')
        break
      case 'usage_update':
        // 累计 total_tokens;回合结束(done)时用「结束 total − 回合开始 baseline」算这轮真实消耗。
        set({ _lastTotalTokens: ev.total_tokens })
        break
      case 'done':
        set({ status: 'idle' })
        finalizeThinking()
        settleAssistant()
        attachTurnTokens()
        attachTurnDuration()
        stopElapsedTimer()
        // 回合结束刷会话列表:新会话首条消息跑完,侧栏对应项目组立刻出现该对话(不然要等点击才刷,
        // 组头一直空着显示"还没有对话";项目聚合由 Sidebar 的 useEffect 跟着 sessions 变化联动刷)。
        void useSessionStore.getState().refresh()
        break
    }
  }

  function handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'ready': {
        set({ connected: true })
        const firstReady = !get()._sawReady
        set({ _sawReady: true })
        if (get()._wantReplay) {
          set({ _wantReplay: false })
          send({ type: 'replay', conversationId: get().conversationId ?? msg.conversationId, after: get().lastSeq })
        } else if (!firstReady) {
          // 重连(sidecar 重启/网络抖动后再次 ready):补拉断线期间遗漏的事件(after=lastSeq,幂等去重),不丢上下文。
          send({ type: 'replay', conversationId: get().conversationId ?? msg.conversationId, after: get().lastSeq })
        }
        break
      }
      case 'error': {
        set({ status: 'idle' })
        finalizeThinking()
        settleAssistant()
        stopElapsedTimer()
        pendingUserEcho = 0 // 回合没起来,别让回声计数吞掉下一次回放的用户气泡
        pushNote(`这次没跑成:${msg.error}`, 'error')
        break
      }
      case 'event': {
        if (typeof msg.seq === 'number' && msg.seq > get().lastSeq) set({ lastSeq: msg.seq })
        reduceEvent(msg.event)
        if (msg.event.type === 'final' || msg.event.type === 'done') {
          set({ status: 'idle', runVerb: 'working' })
        }
        break
      }
      case 'approve_result': {
        const result = typeof msg.result === 'string' ? msg.result : ''
        if (result) pushNote(`这一步已完成:${result.slice(0, 200)}`, 'note')
        break
      }
      case 'interrupt_result': {
        if (msg.interrupted) {
          // 中断态(第 4 态):正在跑的工具卡原地翻成"已中断",流式气泡按已有内容落定(不丢部分产出)。
          finalizeThinking()
          settleAssistant()
          stopElapsedTimer()
          set((s) => ({
            status: 'idle',
            blocks: s.blocks.map((b) =>
              b.kind === 'tool' && b.status === 'running' ? { ...b, status: 'interrupted' as ToolStatus, endedAt: Date.now() } : b,
            ),
          }))
        }
        break
      }
      case 'pong':
      case 'reject_result':
      case 'steer_result':
        break
    }
  }

  function send(message: ClientMessage) {
    const id = get().conversationId
    if (!id) return
    wsManager.send(id, message)
  }

  return {
    conversationId: null,
    blocks: [],
    status: 'idle',
    connected: false,
    runVerb: 'working',
    lastSeq: 0,
    elapsedSeconds: 0,
    streamingChars: 0,
    todos: [],
    todoBarExpanded: false,
    _currentAssistantId: null,
    _currentThinkingId: null,
    _sawStreaming: false,
    _lastTotalTokens: 0,
    _turnBaselineTokens: 0,
    _unsub: null,
    _wantReplay: false,
    _sawReady: false,

    startConversation: (conversationId, opts) => {
      // 切换会话:断掉旧的处理器,重置渲染态。
      get()._unsub?.()
      stopElapsedTimer()
      pendingUserEcho = 0
      // 按会话激活工作目录:workspaceRoot 变成该会话记住的文件夹(多窗口各选各的、切回不串台)。
      useSettingsStore.getState().activateConversation(conversationId)
      set({
        conversationId,
        blocks: [],
        status: 'idle',
        connected: false,
        runVerb: 'working',
        lastSeq: 0,
        elapsedSeconds: 0,
        streamingChars: 0,
        todos: [],
        todoBarExpanded: false,
        _currentAssistantId: null,
        _currentThinkingId: null,
        _sawStreaming: false,
        _lastTotalTokens: 0,
        _turnBaselineTokens: 0,
        _wantReplay: Boolean(opts?.replay),
        _sawReady: false,
      })
      const unsub = wsManager.onMessage(conversationId, handleServerMessage)
      wsManager.connect(conversationId)
      set({ _unsub: unsub })
      // 连接已存在(切走再切回同一会话):connect() 是 no-op、'ready' 不会再来,_wantReplay 永远没人消费,
      // 而上面已把 blocks 清空 → 会话看着像被抹掉。此时直接在现有连接上补发 replay,把历史拉回来。
      if (opts?.replay && wsManager.isConnected(conversationId)) {
        set({ _wantReplay: false })
        wsManager.send(conversationId, { type: 'replay', conversationId, after: 0 })
      }
    },

    sendMessage: (text) => {
      const trimmed = text.trim()
      const id = get().conversationId
      if (!trimmed || !id) return
      // 运行中 → 插话纠偏(steer);否则起新一轮(run)。
      if (get().status === 'running') {
        set((s) => ({ blocks: [...s.blocks, { id: newBlockId(), kind: 'user', text: trimmed }] }))
        send({ type: 'steer', message: trimmed, conversationId: id })
        return
      }
      // 上一轮的清单全done了、用户又开新一轮:收起旧清单(对齐 cc completedAndDismissed 的
      // "用户已接着聊"语义,我们简化成新回合直接清空,别让上一轮的已完成清单赖着不走)。
      const staleTodos = get().todos
      const clearTodos = staleTodos.length > 0 && staleTodos.every((td) => td.status === 'done')
      pendingUserEcho++ // server 会把这句作 user_prompt 事件回发,吞一次防双气泡
      set((s) => ({
        blocks: [...s.blocks, { id: newBlockId(), kind: 'user', text: trimmed }],
        status: 'running',
        runVerb: 'working',
        _sawStreaming: false,
        _turnBaselineTokens: get()._lastTotalTokens,
        ...(clearTodos ? { todos: [] } : {}),
      }))
      startElapsedTimer()
      const settings = useSettingsStore.getState()
      const run: Extract<ClientMessage, { type: 'run' }> = {
        type: 'run',
        message: trimmed,
        conversationId: id,
        permissionMode: settings.defaultPermissionMode,
      }
      if (settings.enabledPacks.length > 0) run.enabled_packs = settings.enabledPacks
      if (settings.workspaceRoot) run.working_dir = settings.workspaceRoot
      send(run)
    },

    approve: (blockId, remember) => {
      const id = get().conversationId
      const block = get().blocks.find((b) => b.id === blockId)
      if (!id || !block || block.kind !== 'approval') return
      // working_dir 必带(与 sendMessage 同源):审批放行的执行要跑在本会话的工作目录,漏带时后端
      // 兜底默认目录 → 文件写错文件夹(2026-07-12 真机逮到的真 bug;后端也已加 session meta 自愈)。
      const approveRoot = useSettingsStore.getState().workspaceRoot
      send({
        type: 'approve',
        tool: block.tool,
        args: block.args,
        token: block.token,
        conversationId: id,
        permissionMode: 'default',
        remember_approval: remember,
        ...(approveRoot ? { working_dir: approveRoot } : {}),
      })
      set((s) => ({
        blocks: s.blocks.map((b) =>
          b.id === blockId && b.kind === 'approval' ? { ...b, resolved: remember ? 'approved-session' : 'approved' } : b,
        ),
      }))
    },

    reject: (blockId) => {
      const id = get().conversationId
      const block = get().blocks.find((b) => b.id === blockId)
      if (!id || !block || block.kind !== 'approval') return
      send({ type: 'reject', tool: block.tool, args: block.args, conversationId: id })
      set((s) => ({
        blocks: s.blocks.map((b) => (b.id === blockId && b.kind === 'approval' ? { ...b, resolved: 'rejected' } : b)),
      }))
    },

    interrupt: () => {
      const id = get().conversationId
      if (id) send({ type: 'interrupt', conversationId: id })
    },

    toggleTodoBar: () => set((s) => ({ todoBarExpanded: !s.todoBarExpanded })),
    dismissTodos: () => set({ todos: [], todoBarExpanded: false }),

    disconnect: () => {
      get()._unsub?.()
      stopElapsedTimer()
      const id = get().conversationId
      if (id) wsManager.disconnect(id)
      set({ _unsub: null, connected: false })
    },
  }
})
