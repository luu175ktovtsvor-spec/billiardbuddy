import type { AgentEvent } from '../types/events'
import type { Message, ContentBlock, ToolResultBlock, ToolCall } from '../types/message'
import { textBlock, toolUseBlock, toolResultBlock, userText } from '../types/message'
import type { Model } from '../types/model'
import type { ToolContext } from '../tools/Tool'
import type { ToolRegistry } from '../tools/registry'
import type { Workspace } from '../workspace/workspace'
import type { Sandbox } from '../sandbox/sandbox'
import type { PermissionMode } from '../permissions/types'
import { APPROVAL_PENDING_MSG, DENIAL_FALLBACK_MSG, resolvePermission } from '../permissions/resolve'
import { actionKey, clearDenial, recordDenial, shouldStopAsking } from '../permissions/denialTracking'
import { signApproval, verifyApproval } from '../permissions/approval'
import { collectReminders, drainSteering, extendTurns, steerBlock, wrapReminder } from './reminders'
import { formatTodoChecklist, parseProgressMarkdown } from '../types/todo'

export interface RunAgentLoopOptions {
  model: Model
  registry: ToolRegistry
  workspace: Workspace
  systemPrompt: string
  userMessage: string
  maxTurns?: number
  signal?: AbortSignal
  sandbox?: Sandbox
  permissionMode?: PermissionMode
  conversationId?: string
  steerInbox?: string[]
}

/**
 * 真 ReAct 主循环(照 cc-haha query.ts / 现有 loop.py),内核 = Anthropic content-block:
 * think → 有 tool_use 就逐个过权限闸执行 → 一批 tool_result 装单条 user 消息回灌 → 再 think,直到收敛或 max_turns。
 * 退出信号看"有没有 tool_use 块"(kind==='tool_calls'),不信 finish_reason(05 清单⑥)。
 * 工具错误一律 <tool_use_error>+is_error 回灌不崩循环。system 走 ModelStepInput 独立字段。
 */
export async function* runAgentLoop(opts: RunAgentLoopOptions): AsyncGenerator<AgentEvent> {
  const { model, registry } = opts
  const maxTurns = opts.maxTurns ?? 12
  const ctx: ToolContext = {
    workspace: opts.workspace,
    signal: opts.signal,
    sandbox: opts.sandbox,
    permissionMode: opts.permissionMode ?? 'ask',
    conversationId: opts.conversationId,
    autoSpendCount: 0,
    steerInbox: opts.steerInbox ?? [],
    todos: [],
    requestsSinceProgress: 0,
  }
  const system = opts.systemPrompt
  const messages: Message[] = [userText(opts.userMessage)]

  let turnsLimit = maxTurns
  let turn = 0
  while (turn < turnsLimit) {
    const step = await model.step({ system, messages, tools: registry.specs() })

    if (step.kind === 'final') {
      if (step.thinking) yield { type: 'thinking', text: step.thinking }
      messages.push({ role: 'assistant', content: [textBlock(step.text)] })
      // steering 优先于收尾:模型想结束但收件箱有插话 → 灌进去接着跑
      const drained = drainSteering(ctx)
      if (drained.length) {
        messages.push({ role: 'user', content: drained.map(steerBlock) })
        for (const m of drained) yield { type: 'steering', content: m }
        turnsLimit = extendTurns(turnsLimit, maxTurns, drained.length)
        turn++
        continue
      }
      yield { type: 'final', text: step.text }
      return
    }

    // 展示:reasoning + 正文叙述合成一条 thinking 事件(保证每步≤1条,前端细分事件归 W16)
    const display = [step.thinking, step.text].filter(Boolean).join('\n\n')
    if (display) yield { type: 'thinking', text: display }

    // assistant 历史块:正文 text(若有)+ tool_use 块(thinking 不进历史、不回灌模型)
    const asstContent: ContentBlock[] = []
    if (step.text) asstContent.push(textBlock(step.text))
    for (const c of step.calls) asstContent.push(toolUseBlock(c))
    messages.push({ role: 'assistant', content: asstContent })

    // 逐个过闸,tool_result 块累积;稍后装单条 user 消息(tool_result 紧贴 tool_use)
    const toolResults: ToolResultBlock[] = []
    for (const call of step.calls) {
      const progress = popTaskProgress(call.input)
      if (progress !== null) {
        ctx.todos = parseProgressMarkdown(progress)
        ctx.requestsSinceProgress = 0
        yield { type: 'todo_update', content: formatTodoChecklist(ctx.todos) }
      }
      yield { type: 'tool_call', tool: call.name, input: call.input }
      yield* gateOneCall(registry, call, ctx, toolResults)
      if (call.name === 'todo_write') {
        ctx.requestsSinceProgress = 0
        yield { type: 'todo_update', content: formatTodoChecklist(ctx.todos ?? []) }
      } else {
        ctx.requestsSinceProgress = (ctx.requestsSinceProgress ?? 0) + 1
      }
    }

    // 单条 user 消息:一批 tool_result 块 + steering + reminder(都作 text 块尾随)
    const followup: ContentBlock[] = [...toolResults]
    const drained = drainSteering(ctx)
    if (drained.length) {
      for (const m of drained) {
        followup.push(steerBlock(m))
        yield { type: 'steering', content: m }
      }
      turnsLimit = extendTurns(turnsLimit, maxTurns, drained.length)
    }
    for (const r of collectReminders(ctx)) {
      followup.push(textBlock(wrapReminder(r.text)))
      if (r.kind === 'progress') ctx.requestsSinceProgress = 0
    }
    messages.push({ role: 'user', content: followup })
    turn++
  }

  // max_turns 兜底:强制一次无工具收敛(照 loop.py 的 _FINAL_NUDGE 哲学)。
  const forced = await model.step({ system, messages, tools: [] })
  yield { type: 'final', text: forced.kind === 'final' ? forced.text : '(已达最大轮次,未能收敛)' }
}

/** 剥离工具入参里的 task_progress(Cline Focus-Chain 内联清单,非真工具参数)。原地删并返回其字符串;无则 null。永不抛。 */
function popTaskProgress(input: unknown): string | null {
  if (input && typeof input === 'object' && 'task_progress' in input) {
    const o = input as Record<string, unknown>
    const p = o.task_progress
    delete o.task_progress
    return typeof p === 'string' ? p : null
  }
  return null
}

/**
 * 单个 tool_call:权限闸(deny/ask/allow)→ 相应事件 + 累积 tool_result 块。ask=提案模式,不执行不阻塞。
 * 工具执行/未知工具/异常 → is_error:true + <tool_use_error> 包壳回灌(OpenAI 侧没有 is_error 字段,
 * 文本包壳是国产模型能看到的唯一报错信号);权限类消息(deny/pending)= 普通 tool_result 不当报错。
 */
async function* gateOneCall(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolContext,
  toolResults: ToolResultBlock[],
): AsyncGenerator<AgentEvent> {
  const feedback = (output: string, isError = false): AgentEvent => {
    const content = isError ? `<tool_use_error>\n${output}\n</tool_use_error>` : output
    toolResults.push(toolResultBlock(call.id, content, isError))
    return { type: 'tool_result', tool: call.name, output }
  }

  const tool = registry.get(call.name)
  if (!tool) {
    yield feedback(`错误:未知工具 ${call.name}`, true)
    return
  }

  const decision = resolvePermission(tool, call.input, ctx)
  if (decision.behavior === 'deny') {
    yield feedback(decision.message, false)
    return
  }
  if (decision.behavior === 'ask') {
    const key = actionKey(call.name, call.input)
    if (shouldStopAsking(ctx.conversationId, key)) {
      yield feedback(DENIAL_FALLBACK_MSG(call.name), false)
      return
    }
    let preview: string | undefined
    try {
      preview = (await tool.previewFor?.(call.input, ctx)) ?? undefined
    } catch {
      preview = undefined
    }
    yield {
      type: 'approval_request',
      tool: call.name,
      args: call.input,
      id: call.id,
      token: signApproval(call.name, call.input),
      preview,
      reason: decision.approvalReason,
    }
    yield feedback(APPROVAL_PENDING_MSG(call.name), false)
    return
  }

  // allow:full 档下自动放行的 spend 类累加计数(过 AUTO_SPEND_LIMIT 后 resolvePermission 会改判 ask)。
  if (tool.approvalClass === 'spend' && ctx.permissionMode === 'full') {
    ctx.autoSpendCount = (ctx.autoSpendCount ?? 0) + 1
  }
  const input = decision.updatedInput ?? call.input
  try {
    yield feedback(await tool.execute(input, ctx), false)
  } catch (err) {
    yield feedback(`错误:工具 ${tool.name} 执行失败:${err instanceof Error ? err.message : String(err)}`, true)
  }
}

/**
 * 审批确认后的真执行入口(给独立 /agent/execute 用):验 token → 清该动作拒绝计数 → 跑工具。
 * token 不匹配一律拒(不信任前端回传的 args)。返回纯 output 字符串——把它包成 tool_result 块重注入会话是
 * 审批恢复流(W5/server)的活,本层不扩责。
 */
export async function executeApproved(
  registry: ToolRegistry,
  tool: string,
  args: unknown,
  token: string | null | undefined,
  ctx: ToolContext,
): Promise<{ ok: boolean; output: string }> {
  if (!verifyApproval(tool, args, token)) return { ok: false, output: '审批校验失败:token 与动作不匹配,拒绝执行。' }
  clearDenial(ctx.conversationId, actionKey(tool, args))
  const t = registry.get(tool)
  if (!t) return { ok: false, output: `未知工具 ${tool}` }
  try {
    return { ok: true, output: await t.execute(args, ctx) }
  } catch (err) {
    return { ok: false, output: `工具 ${tool} 执行失败:${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 老板拒绝某审批(给独立 /agent/reject 用):记一次拒绝,喂给下次的 shouldStopAsking。 */
export function handleReject(tool: string, args: unknown, ctx: ToolContext): void {
  recordDenial(ctx.conversationId, actionKey(tool, args))
}
