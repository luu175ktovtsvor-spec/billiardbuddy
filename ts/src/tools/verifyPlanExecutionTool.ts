import type { Tool, ToolContext } from './Tool'

export const VERIFY_PLAN_EXECUTION_TOOL_NAMES = ['VerifyPlanExecution', 'verify_plan_execution'] as const

type VerifyStatus = 'pass' | 'fail' | 'partial' | 'needs_evidence'

interface EvidenceItem {
  label: string
  status?: string
  output?: string
}

const EVIDENCE_RE = /\b(bun test|bun run|npm test|pnpm|pytest|tsc|typecheck|lint|playwright|curl|project_diagnostics|run_command|read_file|git diff|git status|screenshot|PASS|FAIL)\b|验证|测试|类型检查|命令|输出|截图|复核|通过|失败/i

export function isVerifyPlanExecutionToolName(name: string): boolean {
  return (VERIFY_PLAN_EXECUTION_TOOL_NAMES as readonly string[]).includes(name)
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function statusValue(value: unknown): VerifyStatus | null {
  const text = stringValue(value).toLowerCase()
  if (['pass', 'passed', 'ok', 'success', 'succeeded', '通过', '完成'].includes(text)) return 'pass'
  if (['fail', 'failed', 'error', 'broken', '失败'].includes(text)) return 'fail'
  if (['partial', 'partially_passed', 'incomplete', '部分通过', '部分完成'].includes(text)) return 'partial'
  return null
}

function planItems(plan: string): string[] {
  const lines = plan.split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => line.replace(/^[-*]\s+\[[ xX-]\]\s+/, '').replace(/^[-*]\s+/, '').replace(/^\d+[.)、]\s*/, '').trim())
    .filter(Boolean)
  return lines.length ? lines : [plan.trim()].filter(Boolean)
}

function evidenceItems(value: unknown): EvidenceItem[] {
  const items: EvidenceItem[] = []
  const pushText = (text: string, label = 'evidence') => {
    const trimmed = text.trim()
    if (trimmed) items.push({ label, output: trimmed })
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === 'string') {
        pushText(item)
      } else if (item && typeof item === 'object') {
        const obj = item as Record<string, unknown>
        items.push({
          label: stringValue(obj.label) || stringValue(obj.command) || stringValue(obj.tool) || 'check',
          status: stringValue(obj.status) || stringValue(obj.result) || undefined,
          output: stringValue(obj.output) || stringValue(obj.summary) || stringValue(obj.stderr) || stringValue(obj.stdout) || undefined,
        })
      }
    }
    return items
  }
  if (typeof value === 'string') pushText(value)
  return items
}

function collectEvidence(input: Record<string, unknown>): EvidenceItem[] {
  return [
    ...evidenceItems(input.evidence),
    ...evidenceItems(input.checks),
    ...evidenceItems(input.results),
    ...evidenceItems(input.commands),
    ...evidenceItems(input.verification_steps),
    ...evidenceItems(input.verificationSteps),
  ]
}

function hasConcreteEvidence(items: EvidenceItem[], summary: string): boolean {
  const joined = [
    summary,
    ...items.flatMap(item => [item.label, item.status ?? '', item.output ?? '']),
  ].join('\n')
  return EVIDENCE_RE.test(joined)
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function formatEvidence(items: EvidenceItem[]): string {
  if (items.length === 0) return '<evidence />'
  return [
    '<evidence>',
    ...items.map((item, index) => {
      const status = item.status ? ` status="${xmlEscape(item.status)}"` : ''
      const body = [item.label, item.output].filter(Boolean).join('\n')
      return `  <item index="${index + 1}"${status}>${xmlEscape(body)}</item>`
    }),
    '</evidence>',
  ].join('\n')
}

function makeVerifyTool(name: string): Tool {
  return {
    name,
    description: [
      'Verify that an approved plan was actually implemented before giving the final answer.',
      'Call this directly after implementation work, not through a subagent.',
      'Provide concrete evidence such as command output, diagnostics, file reads, screenshots, or manual checks.',
      'If evidence is missing, the tool returns needs_evidence and the plan is not marked verified.',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        plan: { type: 'string', description: 'The approved plan. Defaults to the pending plan from ExitPlanMode.' },
        summary: { type: 'string', description: 'Brief verification summary.' },
        status: { type: 'string', enum: ['pass', 'fail', 'partial'], description: 'Verification verdict.' },
        evidence: { type: 'array', description: 'Evidence items: strings or {label, command/tool, status, output/summary} objects.', items: { type: 'object' } },
        checks: { type: 'array', description: 'Alias for evidence.', items: { type: 'object' } },
        reason: { type: 'string', description: 'Reason for fail/partial/needs_evidence.' },
      },
    },
    isReadOnly: true,
    async execute(input: unknown, ctx: ToolContext) {
      const obj = asRecord(input)
      const pending = ctx.pendingPlanVerification
      const plan = stringValue(obj.plan) || pending?.plan || ''
      const summary = stringValue(obj.summary) || stringValue(obj.result) || stringValue(obj.verdict)
      const reason = stringValue(obj.reason)
      const evidence = collectEvidence(obj)
      const requested = statusValue(obj.status ?? obj.verdict ?? obj.result)
      const items = planItems(plan)
      const concreteEvidence = hasConcreteEvidence(evidence, summary)
      let status: VerifyStatus = requested ?? 'needs_evidence'

      if (!plan) {
        status = 'needs_evidence'
      } else if (!concreteEvidence && status === 'pass') {
        status = 'needs_evidence'
      } else if (!requested && concreteEvidence) {
        status = 'partial'
      }

      if (pending) {
        pending.verificationStarted = true
        pending.lastStatus = status
        pending.lastReason = reason || summary || undefined
        pending.toolCallsSinceApproval = 0
        pending.verificationCompleted = status !== 'needs_evidence'
      }

      const itemBlock = items.length
        ? [
            '<plan_items>',
            ...items.map((item, index) => `  <item index="${index + 1}">${xmlEscape(item)}</item>`),
            '</plan_items>',
          ].join('\n')
        : '<plan_items />'
      const needs = status === 'needs_evidence'
        ? '\n<next_step>先运行或读取可复核检查,再携带 evidence/checks 重新调用 VerifyPlanExecution。不能只用总结代替验证。</next_step>'
        : ''
      const reasonBlock = reason || summary ? `\n<summary>${xmlEscape(reason || summary)}</summary>` : ''
      return [
        `<plan_verification status="${status}" evidence_count="${evidence.length}" item_count="${items.length}">`,
        itemBlock,
        formatEvidence(evidence),
        `${reasonBlock}${needs}`,
        '</plan_verification>',
      ].join('\n')
    },
  }
}

export const verifyPlanExecutionTool = makeVerifyTool('VerifyPlanExecution')
export const verifyPlanExecutionCompatTool = makeVerifyTool('verify_plan_execution')
