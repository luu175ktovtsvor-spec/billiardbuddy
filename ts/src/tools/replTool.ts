import type { ApprovalClass, PermissionMode } from '../permissions/types'
import { actionKey } from '../permissions/denialTracking'
import { resolvePermission } from '../permissions/resolve'
import type { Tool, ToolContext, ToolProgressEvent } from './Tool'
import type { ToolRegistry } from './registry'

export const REPL_TOOL_NAME = 'REPL'

const DEFAULT_MAX_STEPS = 12
const HARD_MAX_STEPS = 40
const DEFAULT_STEP_OUTPUT_CHARS = 20_000
const MAX_STEP_OUTPUT_CHARS = 100_000

const REPL_PRIMITIVE_TOOL_NAMES = new Set([
  'read_file',
  'read_many_files',
  'write_file',
  'edit_file',
  'edit_excel',
  'multi_edit_file',
  'patch_file',
  'patch_files',
  'list_dir',
  'glob_files',
  'grep_files',
  'code_outline',
  'git_status',
  'git_history',
  'NotebookEdit',
  'LSP',
  'read_stored_tool_result',
  'read_agent_task_stored_result',
  'project_diagnostics',
  'PowerShell',
  'run_command',
  'agent_task',
  'start_background_agent_task',
  'list_background_tasks',
  'read_background_task',
  'TaskOutput',
  'cancel_background_task',
])

const APPROVAL_RANK: Record<ApprovalClass, number> = {
  file: 1,
  outreach: 2,
  destructive: 3,
}

interface ReplInput {
  steps?: ReplStepInput[]
  stop_on_error?: boolean | string
  max_steps?: number | string
  max_output_chars?: number | string
}

interface ReplStepInput {
  tool?: string
  name?: string
  input?: unknown
  args?: unknown
  id?: string
}

interface ReplStep {
  tool: string
  input: unknown
  id: string
  index: number
}

export function createReplTool(registry: ToolRegistry): Tool<ReplInput> {
  return {
    name: REPL_TOOL_NAME,
    description: [
      'Execute a structured batch of primitive coding tools through the same registry, permissions, and workspace context.',
      'Use this for multi-step code exploration or edits that benefit from one compact tool call.',
      'This is not JavaScript eval: each step is { tool, input, id? } and calls an existing tool such as read_file, grep_files, edit_file, edit_excel, run_command, PowerShell, or agent_task.',
      'Fatal red lines, plan mode, read-before-edit guards, and tool-specific security checks still apply.',
      'Input: { steps:[{tool,input,id?}], stop_on_error?, max_steps?, max_output_chars? }.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        steps: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              tool: { type: 'string', description: 'Existing primitive tool name to run inside REPL.' },
              input: { type: 'object', description: 'Input object for that tool.' },
              id: { type: 'string', description: 'Optional stable label for progress and output.' },
            },
            required: ['tool', 'input'],
          },
        },
        stop_on_error: { type: ['boolean', 'string'], description: 'Defaults true. Stop after the first error, denial, or pending approval.' },
        max_steps: { type: ['number', 'string'], description: `Maximum steps to execute, default ${DEFAULT_MAX_STEPS}, hard cap ${HARD_MAX_STEPS}.` },
        max_output_chars: { type: ['number', 'string'], description: `Per-step output cap, default ${DEFAULT_STEP_OUTPUT_CHARS}, max ${MAX_STEP_OUTPUT_CHARS}.` },
      },
      required: ['steps'],
    },
    isReadOnly: false,
    isReadOnlyFor(input, ctx) {
      return normalizeSteps(input, ctx).every(step => {
        const tool = registry.get(step.tool)
        return !!tool && isAllowedReplPrimitive(step.tool) && (tool.isReadOnly || (tool.isReadOnlyFor?.(step.input, ctx) ?? false))
      })
    },
    requiresApprovalFor(input, ctx) {
      return normalizeSteps(input, ctx).some(step => {
        const tool = registry.get(step.tool)
        if (!tool || !isAllowedReplPrimitive(step.tool)) return false
        return resolvePermission(tool, step.input, ctx).behavior === 'ask'
      })
    },
    approvalClassFor(input, ctx) {
      return strongestApprovalClass(normalizeSteps(input, ctx), registry, ctx)
    },
    forceConfirmFor(input, ctx) {
      return normalizeSteps(input, ctx).some(step => {
        const tool = registry.get(step.tool)
        if (!tool || !isAllowedReplPrimitive(step.tool)) return false
        const decision = resolvePermission(tool, step.input, ctx)
        return decision.behavior === 'ask' && decision.reason?.type === 'forceConfirm'
      })
    },
    requiresUserInteractionFor(input, ctx) {
      return normalizeSteps(input, ctx).some(step => {
        const tool = registry.get(step.tool)
        if (!tool || !isAllowedReplPrimitive(step.tool)) return false
        const decision = resolvePermission(tool, step.input, ctx)
        return decision.behavior === 'ask' && decision.reason?.type === 'requiresUserInteraction'
      })
    },
    fatalReasonFor(input, ctx) {
      const steps = normalizeSteps(input, ctx)
      for (const step of steps) {
        if (step.tool === REPL_TOOL_NAME) return `REPL step ${step.index} 不允许递归调用 REPL`
        if (!isAllowedReplPrimitive(step.tool)) return `REPL step ${step.index} 不允许调用 ${step.tool};只能调用 primitive coding tools`
        const tool = registry.get(step.tool)
        if (!tool) return `REPL step ${step.index} 未知工具:${step.tool}`
        const decision = resolvePermission(tool, step.input, ctx)
        if (decision.behavior === 'deny' && decision.reason.type === 'fatal') {
          return `REPL step ${step.index} ${decision.message}`
        }
      }
      return null
    },
    async previewFor(input, ctx) {
      const steps = normalizeSteps(input, ctx)
      if (!steps.length) return 'REPL 没有可执行 steps'
      const lines = ['<repl_preview>']
      for (const step of steps) {
        const tool = registry.get(step.tool)
        const decision = tool ? resolvePermission(tool, step.input, ctx) : null
        lines.push(`<step index="${step.index}" id="${xmlAttr(step.id)}" tool="${xmlAttr(step.tool)}" decision="${xmlAttr(decision?.behavior ?? 'missing')}">`)
        if (tool?.previewFor) {
          try {
            const preview = await tool.previewFor(step.input, ctx)
            if (preview) lines.push(truncate(preview, 3000))
          } catch (err) {
            lines.push(`preview_error: ${err instanceof Error ? err.message : String(err)}`)
          }
        } else {
          lines.push(truncate(stableJson(step.input), 3000))
        }
        lines.push('</step>')
      }
      lines.push('</repl_preview>')
      return lines.join('\n')
    },
    approvalReasonFor(input, ctx) {
      const steps = normalizeSteps(input, ctx)
      const klass = strongestApprovalClass(steps, registry, ctx) ?? 'file'
      return {
        what: `执行 REPL 批量步骤:${steps.map(step => `${step.index}.${step.tool}`).join(', ')}`,
        why: `这批步骤中包含 ${approvalClassLabel(klass)} 动作,需要按内部工具权限口径确认。`,
        impact: '批准后会按顺序调用现有工具;危险红线、强交互限制和工具自身校验仍会生效。',
      }
    },
    async execute(input, ctx) {
      const steps = normalizeSteps(input, ctx)
      if (!steps.length) throw new Error('REPL 需要非空 steps 数组')
      const maxOutputChars = clampInt(input?.max_output_chars, DEFAULT_STEP_OUTPUT_CHARS, MAX_STEP_OUTPUT_CHARS)
      const stopOnError = semanticBoolean(input?.stop_on_error, true)
      const outerApproved = ctx.approvedToolExecution?.name === REPL_TOOL_NAME &&
        ctx.approvedToolExecution.key === actionKey(REPL_TOOL_NAME, input)
      const blocks: string[] = []
      let ok = 0
      let failed = 0
      let pending = 0
      let denied = 0

      for (const step of steps) {
        const result = await executeReplStep(step, registry, ctx, {
          outerApproved,
          maxOutputChars,
        })
        blocks.push(result.block)
        if (result.status === 'ok') ok++
        if (result.status === 'error') failed++
        if (result.status === 'pending') pending++
        if (result.status === 'denied') denied++
        if (stopOnError && result.status !== 'ok') break
      }

      const status = failed || denied ? 'error' : pending ? 'pending' : 'ok'
      return [
        `<repl_result status="${status}" steps="${steps.length}" ok="${ok}" errors="${failed}" denied="${denied}" pending="${pending}" approved="${outerApproved}">`,
        blocks.join('\n'),
        '</repl_result>',
      ].join('\n')
    },
  }
}

async function executeReplStep(
  step: ReplStep,
  registry: ToolRegistry,
  ctx: ToolContext,
  opts: { outerApproved: boolean; maxOutputChars: number },
): Promise<{ status: 'ok' | 'error' | 'pending' | 'denied'; block: string }> {
  if (!isAllowedReplPrimitive(step.tool)) {
    return replStepBlock(step, 'denied', `REPL 不允许调用 ${step.tool};只能调用 primitive coding tools`)
  }
  const tool = registry.get(step.tool)
  if (!tool) return replStepBlock(step, 'denied', `未知工具:${step.tool}`)

  const decision = await withTemporaryPermissionMode(ctx, opts.outerApproved ? 'bypassPermissions' : undefined, () =>
    Promise.resolve(resolvePermission(tool, step.input, ctx)))
  if (decision.behavior === 'deny') return replStepBlock(step, 'denied', decision.message)
  if (decision.behavior === 'ask') return replStepBlock(step, 'pending', decision.message)

  const previousEmit = ctx.progressEmit
  if (previousEmit) {
    ctx.progressEmit = (event: ToolProgressEvent) => previousEmit({
      ...event,
      tool: event.tool || step.tool,
      id: event.id || step.id,
    })
  }
  try {
    const output = await withTemporaryPermissionMode(ctx, opts.outerApproved ? 'bypassPermissions' : undefined, () =>
      tool.execute(decision.updatedInput ?? step.input, ctx))
    return replStepBlock(step, 'ok', truncate(output, opts.maxOutputChars), output.length > opts.maxOutputChars)
  } catch (err) {
    return replStepBlock(step, 'error', `工具 ${step.tool} 执行失败:${err instanceof Error ? err.message : String(err)}`)
  } finally {
    ctx.progressEmit = previousEmit
  }
}

function normalizeSteps(input: ReplInput | undefined, ctx: ToolContext): ReplStep[] {
  const rawSteps = Array.isArray(input?.steps) ? input.steps : []
  const maxSteps = clampInt(input?.max_steps, DEFAULT_MAX_STEPS, HARD_MAX_STEPS)
  return rawSteps.slice(0, maxSteps).map((raw, index) => {
    const record = asRecord(raw)
    const tool = stringValue(record.tool) || stringValue(record.name)
    const stepInput = 'input' in record ? record.input : record.args
    const id = stringValue(record.id) || `repl-step-${index + 1}`
    return { tool, input: stepInput ?? {}, id, index: index + 1 }
  }).filter(step => step.tool)
}

function isAllowedReplPrimitive(tool: string): boolean {
  return REPL_PRIMITIVE_TOOL_NAMES.has(tool)
}

function strongestApprovalClass(steps: ReplStep[], registry: ToolRegistry, ctx: ToolContext): ApprovalClass | undefined {
  let strongest: ApprovalClass | undefined
  for (const step of steps) {
    const tool = registry.get(step.tool)
    if (!tool || !isAllowedReplPrimitive(step.tool)) continue
    const decision = resolvePermission(tool, step.input, ctx)
    const klass = decision.behavior === 'ask'
      ? decision.approvalClass
      : tool.approvalClassFor?.(step.input, ctx) ?? tool.approvalClass
    if (!klass) continue
    if (!strongest || APPROVAL_RANK[klass] > APPROVAL_RANK[strongest]) strongest = klass
  }
  return strongest
}

async function withTemporaryPermissionMode<T>(ctx: ToolContext, mode: PermissionMode | undefined, fn: () => Promise<T>): Promise<T> {
  if (!mode) return await fn()
  const previous = ctx.permissionMode
  ctx.permissionMode = mode
  try {
    return await fn()
  } finally {
    ctx.permissionMode = previous
  }
}

function replStepBlock(step: ReplStep, status: 'ok' | 'error' | 'pending' | 'denied', output: string, truncated = false): { status: 'ok' | 'error' | 'pending' | 'denied'; block: string } {
  return {
    status,
    block: [
      `<step index="${step.index}" id="${xmlAttr(step.id)}" tool="${xmlAttr(step.tool)}" status="${status}"${truncated ? ' truncated="true"' : ''}>`,
      xmlText(output),
      '</step>',
    ].join('\n'),
  }
}

function clampInt(value: unknown, fallback: number, max: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(max, Math.floor(n)))
}

function semanticBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['1', 'true', 'yes', 'y', 'on'].includes(text)) return true
  if (['0', 'false', 'no', 'n', 'off'].includes(text)) return false
  return fallback
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}\n<truncated chars="${value.length - maxChars}" />`
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return '<unserializable>'
  }
}

function approvalClassLabel(klass: ApprovalClass): string {
  if (klass === 'file') return '文件修改'
  if (klass === 'outreach') return '外部触达'
  return '高风险/不可逆'
}

function xmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}
