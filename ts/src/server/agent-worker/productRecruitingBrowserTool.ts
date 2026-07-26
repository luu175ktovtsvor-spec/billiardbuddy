import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import type { ChromeSessionBridge } from '../services/chromeSessionBridge.js'
import { buildProductTool } from './productTool.js'

const inputSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('get_current_pages') }),
  z.strictObject({
    action: z.literal('prepare_recruiting_action'),
    session_id: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
    page_revision: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
    candidate_ref: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
    kind: z.enum(['send_message', 'invite', 'reject']),
    message: z.string().min(1).max(2_000).optional(),
    client_operation_id: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).optional(),
  }),
  z.strictObject({
    action: z.literal('get_recruiting_action'),
    action_id: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
  }),
])

type RecruitingBrowserOutput =
  | { pages: ReturnType<ChromeSessionBridge['listPages']> }
  | { action: Awaited<ReturnType<ChromeSessionBridge['getAction']>> | null }

function safeFailure(error: unknown): string {
  switch (error instanceof Error ? error.message : '') {
    case 'BROWSER_PAGE_STALE': return '招聘页面已经变化，请重新读取当前候选人后再准备操作。'
    case 'BROWSER_CANDIDATE_NOT_FOUND': return '当前页面中找不到这位候选人，请重新读取页面。'
    case 'BROWSER_IDEMPOTENCY_CONFLICT': return '同一个操作编号不能用于不同的招聘动作。'
    default: return '招聘浏览器当前无法准备此操作，请检查扩展连接后重试。'
  }
}

/** ProductTask capability: reads evidence and prepares, but never executes, a recruiting action. */
export function createProductRecruitingBrowserTool(taskId: string, bridge: ChromeSessionBridge) {
  return buildProductTool<typeof inputSchema, RecruitingBrowserOutput>({
    name: 'RecruitingBrowser',
    searchHint: 'read recruiting candidates and prepare reviewed actions',
    maxResultSizeChars: 100_000,
    shouldDefer: true,
    inputSchema,
    async description() {
      return 'Read job-relevant evidence from the connected recruiting page and prepare an action for human confirmation.'
    },
    async prompt() {
      return 'Prepared actions are incomplete until the authoritative state is succeeded. outcome_unknown requires manual reconciliation.'
    },
    isConcurrencySafe(input) { return input.action !== 'prepare_recruiting_action' },
    isReadOnly(input) { return input.action !== 'prepare_recruiting_action' },
    toAutoClassifierInput(input) { return input.action },
    async call(input) {
      try {
        if (input.action === 'get_current_pages') return { data: { pages: bridge.listPages() } }
        if (input.action === 'get_recruiting_action') {
          return { data: { action: await bridge.getAction(taskId, input.action_id) ?? null } }
        }
        const action = await bridge.prepareAction(taskId, {
          session_id: input.session_id,
          page_revision: input.page_revision,
          candidate_ref: input.candidate_ref,
          kind: input.kind,
          ...(input.message ? { message: input.message } : {}),
          client_operation_id: input.client_operation_id ?? `browser_op_${randomUUID().replaceAll('-', '')}`,
        })
        return { data: { action } }
      } catch (error) {
        throw new Error(safeFailure(error))
      }
    },
    mapToolResultToToolResultBlockParam(output, toolUseID) {
      return { type: 'tool_result', tool_use_id: toolUseID, content: JSON.stringify(output) }
    },
  })
}
