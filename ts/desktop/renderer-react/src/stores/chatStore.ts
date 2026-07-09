// chatStore —— 地基最高风险件。消息 reducer 逐字段对齐我们真实的 /agent/ws 协议:
//   顶层信封(ServerMessage):ready / error / event / pong / approve_result / reject_result / steer_result / interrupt_result
//   event.event(AgentEvent,见 types/events.ts):content_delta / thinking / tool_call(用 input!) / tool_result /
//     final / approval_request / context_note / steering / max_turns_reached / done ...
// 参照物 = 现有 vanilla app.js 的 renderEvent(交互细节的验收基线),但不搬它的 DOM 代码。
import { create } from 'zustand'
import { wsManager } from '../api/websocket'
import { useSettingsStore } from './settingsStore'
import type { ClientMessage, ServerMessage } from '../types/chat'
import type { AgentEvent, ApprovalReason } from '../types/events'

export type RunVerb = 'working' | 'thinking' | 'running'
export type ToolStatus = 'running' | 'ok' | 'error'

export type ChatBlock =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string; streaming: boolean; ts?: number; cost?: number }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; tool: string; input: unknown; output?: string; status: ToolStatus }
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
  | { id: string; kind: 'note'; text: string; variant: 'note' | 'steering' | 'error' | 'maxturns' }

interface ChatState {
  conversationId: string | null
  blocks: ChatBlock[]
  status: 'idle' | 'running'
  connected: boolean
  runVerb: RunVerb
  lastSeq: number
  // 内部流式指针
  _currentAssistantId: string | null
  _currentThinkingId: string | null
  _sawStreaming: boolean
  _unsub: (() => void) | null
  _wantReplay: boolean

  startConversation: (conversationId: string, opts?: { replay?: boolean }) => void
  sendMessage: (text: string) => void
  approve: (blockId: string, remember: boolean) => void
  reject: (blockId: string) => void
  interrupt: () => void
  disconnect: () => void
}

let seqCounter = 0
function newBlockId(): string {
  seqCounter += 1
  return `b${seqCounter}-${Math.random().toString(36).slice(2, 7)}`
}

const ERROR_RE = /error|错误|失败|<tool_use_error>/i

export const useChatStore = create<ChatState>((set, get) => {
  /** 把当前正在流式的 assistant 气泡落定(一轮多气泡分块:工具/思考到来时收尾)。 */
  function settleAssistant() {
    const id = get()._currentAssistantId
    if (!id) return
    set((s) => ({
      _currentAssistantId: null,
      blocks: s.blocks.map((b) => (b.id === id && b.kind === 'assistant' ? { ...b, streaming: false } : b)),
    }))
  }

  function finalizeThinking() {
    if (get()._currentThinkingId) set({ _currentThinkingId: null })
  }

  function appendAssistant(text: string) {
    const id = get()._currentAssistantId
    if (id) {
      set((s) => ({
        blocks: s.blocks.map((b) => (b.id === id && b.kind === 'assistant' ? { ...b, text: b.text + text } : b)),
      }))
    } else {
      const nid = newBlockId()
      set((s) => ({
        _currentAssistantId: nid,
        blocks: [...s.blocks, { id: nid, kind: 'assistant', text, streaming: true, ts: Date.now() }],
      }))
    }
  }

  function appendThinking(text: string) {
    const id = get()._currentThinkingId
    if (id) {
      set((s) => ({
        blocks: s.blocks.map((b) => (b.id === id && b.kind === 'thinking' ? { ...b, text: b.text + text } : b)),
      }))
    } else {
      const nid = newBlockId()
      set((s) => ({
        _currentThinkingId: nid,
        blocks: [...s.blocks, { id: nid, kind: 'thinking', text }],
      }))
    }
  }

  function pushNote(text: string, variant: 'note' | 'steering' | 'error' | 'maxturns') {
    set((s) => ({ blocks: [...s.blocks, { id: newBlockId(), kind: 'note', text, variant }] }))
  }

  /** AgentEvent reducer(对齐 app.js renderEvent 一一对应)。 */
  function reduceEvent(ev: AgentEvent | { type: 'done' }) {
    switch (ev.type) {
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
            { id: newBlockId(), kind: 'tool', tool: `/${ev.name}`, input: ev.args, status: 'ok' as ToolStatus, output: undefined },
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
          blocks: [...s.blocks, { id: newBlockId(), kind: 'tool', tool: ev.tool, input: ev.input, status: 'running' as ToolStatus }],
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
              blocks[i] = { ...b, output: ev.output, status: isErr ? 'error' : 'ok' }
              break
            }
          }
          return { blocks }
        })
        finalizeThinking()
        settleAssistant()
        break
      }
      case 'final': {
        finalizeThinking()
        // final 全文为权威:覆盖当前流式气泡;没有就新建一条。
        const id = get()._currentAssistantId
        if (ev.text) {
          if (id) {
            set((s) => ({ blocks: s.blocks.map((b) => (b.id === id && b.kind === 'assistant' ? { ...b, text: ev.text, streaming: false } : b)) }))
          } else {
            set((s) => ({ blocks: [...s.blocks, { id: newBlockId(), kind: 'assistant', text: ev.text, streaming: false, ts: Date.now() }] }))
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
      case 'context_note':
        if (/压缩|compact/i.test(ev.text || '')) set({ runVerb: 'working' })
        pushNote(ev.text, 'note')
        break
      case 'max_turns_reached':
        pushNote('连着跑了好几个回合,先停下来喘口气。想接着做的话,回一句让它继续。', 'maxturns')
        break
      case 'done':
        set({ status: 'idle' })
        finalizeThinking()
        settleAssistant()
        break
      default:
        // usage_update / tool_progress / todo_update / ask_question 等本切片先不渲染(Block A/B 接)。
        break
    }
  }

  function handleServerMessage(msg: ServerMessage) {
    switch (msg.type) {
      case 'ready': {
        set({ connected: true })
        if (get()._wantReplay) {
          set({ _wantReplay: false })
          send({ type: 'replay', conversationId: get().conversationId ?? msg.conversationId, after: get().lastSeq })
        }
        break
      }
      case 'error': {
        set({ status: 'idle' })
        finalizeThinking()
        settleAssistant()
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
      case 'pong':
      case 'reject_result':
      case 'steer_result':
      case 'interrupt_result':
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
    _currentAssistantId: null,
    _currentThinkingId: null,
    _sawStreaming: false,
    _unsub: null,
    _wantReplay: false,

    startConversation: (conversationId, opts) => {
      // 切换会话:断掉旧的处理器,重置渲染态。
      get()._unsub?.()
      set({
        conversationId,
        blocks: [],
        status: 'idle',
        connected: false,
        runVerb: 'working',
        lastSeq: 0,
        _currentAssistantId: null,
        _currentThinkingId: null,
        _sawStreaming: false,
        _wantReplay: Boolean(opts?.replay),
      })
      const unsub = wsManager.onMessage(conversationId, handleServerMessage)
      wsManager.connect(conversationId)
      set({ _unsub: unsub })
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
      set((s) => ({
        blocks: [...s.blocks, { id: newBlockId(), kind: 'user', text: trimmed }],
        status: 'running',
        runVerb: 'working',
        _sawStreaming: false,
      }))
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
      send({
        type: 'approve',
        tool: block.tool,
        args: block.args,
        token: block.token,
        conversationId: id,
        permissionMode: 'default',
        remember_approval: remember,
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

    disconnect: () => {
      get()._unsub?.()
      const id = get().conversationId
      if (id) wsManager.disconnect(id)
      set({ _unsub: null, connected: false })
    },
  }
})
