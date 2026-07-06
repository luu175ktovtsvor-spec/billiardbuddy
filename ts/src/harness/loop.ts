import type { AgentEvent } from '../types/events'
import type { Message, ToolCall } from '../types/message'
import type { Model } from '../types/model'
import type { ToolContext } from '../tools/Tool'
import type { ToolRegistry } from '../tools/registry'
import type { Workspace } from '../workspace/workspace'
import type { Sandbox } from '../sandbox/sandbox'
import type { PermissionMode } from '../permissions/types'
import { APPROVAL_PENDING_MSG, DENIAL_FALLBACK_MSG, resolvePermission } from '../permissions/resolve'
import { actionKey, clearDenial, recordDenial, shouldStopAsking } from '../permissions/denialTracking'
import { signApproval, verifyApproval } from '../permissions/approval'

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
}

/**
 * 真 ReAct 主循环(照 cc-haha query.ts / 现有 loop.py):think → 有 tool_calls 就逐个过权限闸再执行 →
 * 结果作 role:tool 回灌 → 再 think,直到收敛或 max_turns 兜底。
 * W4a 权限闸:deny 回灌拒绝文案不执行;ask 走提案(吐 approval_request + 回灌待确认、不阻塞);allow 才真跑。
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
  }
  const messages: Message[] = [
    { role: 'system', content: opts.systemPrompt },
    { role: 'user', content: opts.userMessage },
  ]

  for (let turn = 0; turn < maxTurns; turn++) {
    const step = await model.step({ messages, tools: registry.specs() })
    if (step.kind === 'final') {
      messages.push({ role: 'assistant', content: step.text })
      yield { type: 'final', text: step.text }
      return
    }
    if (step.text) yield { type: 'thinking', text: step.text }
    messages.push({ role: 'assistant', content: step.text ?? '', toolCalls: step.calls })
    for (const call of step.calls) {
      yield { type: 'tool_call', tool: call.name, input: call.input }
      yield* gateOneCall(registry, call, ctx, messages)
    }
  }

  // max_turns 兜底:强制一次无工具收敛(照 loop.py 的 _FINAL_NUDGE 哲学)。
  const forced = await model.step({ messages, tools: [] })
  yield { type: 'final', text: forced.kind === 'final' ? forced.text : '(已达最大轮次,未能收敛)' }
}

/** 单个 tool_call:权限闸(deny/ask/allow)→ 相应事件 + 回灌 role:tool。ask=提案模式,不执行、不阻塞。 */
async function* gateOneCall(
  registry: ToolRegistry,
  call: ToolCall,
  ctx: ToolContext,
  messages: Message[],
): AsyncGenerator<AgentEvent> {
  const feedback = (output: string): AgentEvent => {
    messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: output })
    return { type: 'tool_result', tool: call.name, output }
  }

  const tool = registry.get(call.name)
  if (!tool) {
    yield feedback(`错误:未知工具 ${call.name}`)
    return
  }

  const decision = resolvePermission(tool, call.input, ctx)
  if (decision.behavior === 'deny') {
    yield feedback(decision.message)
    return
  }
  if (decision.behavior === 'ask') {
    const key = actionKey(call.name, call.input)
    if (shouldStopAsking(ctx.conversationId, key)) {
      yield feedback(DENIAL_FALLBACK_MSG(call.name))
      return
    }
    const preview = (await tool.previewFor?.(call.input, ctx)) ?? undefined
    yield {
      type: 'approval_request',
      tool: call.name,
      args: call.input,
      id: call.id,
      token: signApproval(call.name, call.input),
      preview,
      reason: decision.approvalReason,
    }
    yield feedback(APPROVAL_PENDING_MSG(call.name))
    return
  }

  // allow:full 档下自动放行的 spend 类累加计数(过 AUTO_SPEND_LIMIT 后 resolvePermission 会改判 ask)。
  if (tool.approvalClass === 'spend' && ctx.permissionMode === 'full') {
    ctx.autoSpendCount = (ctx.autoSpendCount ?? 0) + 1
  }
  const input = decision.updatedInput ?? call.input
  yield feedback(await executeTool(tool, input, ctx))
}

/** 工具执行永不抛:执行异常转成错误文本回灌,让模型自救(照 loop.py)。 */
async function executeTool(tool: { execute: (i: unknown, c: ToolContext) => Promise<string> }, input: unknown, ctx: ToolContext): Promise<string> {
  try {
    return await tool.execute(input, ctx)
  } catch (err) {
    return `错误:工具执行失败:${err instanceof Error ? err.message : String(err)}`
  }
}

/**
 * 审批确认后的真执行入口(给独立 /agent/execute 用):验 token → 清该动作拒绝计数 → 跑工具。
 * token 不匹配一律拒(不信任前端回传的 args)。
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
    return { ok: false, output: `执行失败:${err instanceof Error ? err.message : String(err)}` }
  }
}

/** 老板拒绝某审批(给独立 /agent/reject 用):记一次拒绝,喂给下次的 shouldStopAsking。 */
export function handleReject(tool: string, args: unknown, ctx: ToolContext): void {
  recordDenial(ctx.conversationId, actionKey(tool, args))
}
