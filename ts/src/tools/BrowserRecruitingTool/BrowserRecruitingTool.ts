import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { ChromeSessionBridge } from '../../server/services/chromeSessionBridge.js'

const inputSchema = lazySchema(() => z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('get_current_pages') }),
  z.strictObject({
    action: z.literal('prepare_recruiting_action'),
    session_id: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
    page_revision: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
    candidate_ref: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
    kind: z.enum(['send_message', 'invite', 'reject']),
    message: z.string().min(1).max(2000).optional(),
    client_operation_id: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/).optional(),
  }),
  z.strictObject({
    action: z.literal('get_recruiting_action'),
    action_id: z.string().regex(/^[a-zA-Z0-9_-]{8,128}$/),
  }),
]))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.record(z.string(), z.unknown()))
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

function safeFailure(error: unknown): string {
  switch (error instanceof Error ? error.message : '') {
    case 'BROWSER_PAGE_STALE': return '招聘页面已经变化，请重新读取当前候选人后再准备操作。'
    case 'BROWSER_CANDIDATE_NOT_FOUND': return '当前页面中找不到这位候选人，请重新读取页面。'
    case 'BROWSER_IDEMPOTENCY_CONFLICT': return '同一个操作编号不能用于不同的招聘动作。'
    default: return '招聘浏览器当前无法准备此操作，请检查扩展连接后重试。'
  }
}

/** ProductTask-scoped tool. It can prepare a side effect, but never confirm or execute one. */
export function createBrowserRecruitingTool(taskId: string, bridge: ChromeSessionBridge) {
  return buildTool({
    name: 'RecruitingBrowser',
    searchHint: 'read BOSS candidates and prepare reviewed recruiting actions',
    maxResultSizeChars: 100_000,
    shouldDefer: true,
    async description() {
      return 'Read job-relevant evidence from the connected BOSS recruiting page and prepare an action for human confirmation.'
    },
    async prompt() {
      return `Use this tool only for the BilliardBuddy recruiting browser connection.

- get_current_pages returns structured, job-relevant candidate evidence from a user-connected BOSS page. Names and protected attributes are deliberately not provided for ranking.
- prepare_recruiting_action creates a durable preview. It never sends, invites, rejects, or changes the website. Tell the user exactly what is waiting in BilliardBuddy and wait for their explicit confirmation there.
- get_recruiting_action checks the authoritative state. A prepared action is not complete while it is awaiting_confirmation or approved_waiting.
- Never claim an external action succeeded without state=succeeded. outcome_unknown requires manual reconciliation and must not be retried as a new action.`
    },
    get inputSchema(): InputSchema { return inputSchema() },
    get outputSchema(): OutputSchema { return outputSchema() },
    isConcurrencySafe(input) { return input.action !== 'prepare_recruiting_action' },
    isReadOnly(input) { return input.action !== 'prepare_recruiting_action' },
    toAutoClassifierInput(input) { return input.action },
    renderToolUseMessage(input) {
      return input.action === 'get_current_pages' ? '读取招聘候选人' : input.action === 'get_recruiting_action' ? '检查招聘操作' : '准备待确认的招聘操作'
    },
    async call(input) {
      try {
        if (input.action === 'get_current_pages') return { data: { pages: bridge.listPages() } }
        if (input.action === 'get_recruiting_action') {
          const action = await bridge.getAction(taskId, input.action_id)
          return { data: action ? { action } : { action: null } }
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
    mapToolResultToToolResultBlockParam(output: Output, toolUseID) {
      return { tool_use_id: toolUseID, type: 'tool_result', content: JSON.stringify(output) }
    },
  } satisfies ToolDef<InputSchema, Output>)
}
