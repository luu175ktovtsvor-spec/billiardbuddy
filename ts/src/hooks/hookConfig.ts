import { spawn } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mergeHookRegistries, parseHookDecisionJSON, type HookDecision, type HookEvent, type HookHandler, type HookPayload, type HookRegistry, type HookRule, type HookSource } from './hooks'
import type { Tool, ToolContext } from '../tools/Tool'
import { ToolRegistry } from '../tools/registry'
import { runAgentLoop } from '../harness/loop'
import { MEMORY_DOT_DIR, getUserConfigHomeDir } from '../harness/memoryNames'
import { textBlock, type Message } from '../types/message'
import { assertHttpHookHostAllowed, ssrfGuardedLookup } from './ssrfGuard'

// 配置文件可声明的事件白名单 = cc 全部 27 个(与 hooks.ts HookEvent 同步,对齐 cc coreTypes.ts:25-53
// HOOK_EVENTS)。声明任何一个都不会被静默吞;派发点状态见 hooks.ts HookEvent 文档。
const HOOK_EVENTS = new Set<HookEvent>([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'StopFailure',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'Notification',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
])
const STRUCTURED_OUTPUT_TOOL_NAME = 'StructuredOutput'
const AGENT_HOOK_MAX_TURNS = 50
const AGENT_HOOK_ALLOWED_TOOLS = new Set([
  'read_file',
  'read_many_files',
  'list_dir',
  'glob_files',
  'grep_files',
  'code_outline',
  'git_status',
  'git_history',
  'LSP',
  'list_project_instructions',
  'project_diagnostics',
  'read_stored_tool_result',
])

interface RawHookRule {
  event?: unknown
  matcher?: unknown
  decision?: unknown
  decisions?: unknown
}

interface RawCommandHook {
  type?: unknown
  command?: unknown
  timeout?: unknown
  decision?: unknown
  decisions?: unknown
}

interface RawHttpHook {
  type?: unknown
  url?: unknown
  timeout?: unknown
  headers?: unknown
  allowedEnvVars?: unknown
  decision?: unknown
  decisions?: unknown
}

interface RawPromptHook {
  type?: unknown
  prompt?: unknown
  timeout?: unknown
  model?: unknown
}

interface RawAgentHook {
  type?: unknown
  prompt?: unknown
  timeout?: unknown
  model?: unknown
}

export interface NormalizeHookRegistryOptions {
  agentFrontmatter?: boolean
  /**
   * 规则来源标记(对齐 cc-haha hook 源分层)。传 'local' 时,本次规范化出的每条规则都打上
   * source:'local',执行时受信任门(allowManagedHooksOnly + workspace trust)约束。省略即 managed(可信)。
   * loadHookRegistryFile 加载工作区文件时传 'local';内置注册(域包/目标/技能)不传 → managed。
   */
  source?: HookSource
  httpPolicy?: {
    allowedUrls?: string[]
    allowedEnvVars?: string[]
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function normalizeDecision(value: unknown): HookDecision | null {
  if (!isRecord(value)) return null
  if (value.action === 'allow') return { action: 'allow', message: typeof value.message === 'string' ? value.message : undefined }
  if (value.action === 'deny' && typeof value.message === 'string') return { action: 'deny', message: value.message }
  if (value.action === 'context' && typeof value.additionalContext === 'string') {
    return { action: 'context', additionalContext: value.additionalContext }
  }
  if (value.action === 'modify' && 'updatedInput' in value) {
    return { action: 'modify', updatedInput: value.updatedInput, message: typeof value.message === 'string' ? value.message : undefined }
  }
  if (value.action === 'elicitation' && (value.elicitationAction === 'accept' || value.elicitationAction === 'decline' || value.elicitationAction === 'cancel')) {
    return { action: 'elicitation', elicitationAction: value.elicitationAction, content: isRecord(value.content) ? value.content : undefined }
  }
  return null
}

function normalizeDecisionList(value: unknown): HookDecision[] {
  if (Array.isArray(value)) return value.map(normalizeDecision).filter((d): d is HookDecision => !!d)
  const single = normalizeDecision(value)
  return single ? [single] : []
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true'
}

function onceHandler(raw: Record<string, unknown>, handler: HookHandler): HookHandler {
  if (!booleanValue(raw.once)) return handler
  let used = false
  return async (payload, ctx) => {
    if (used) return null
    const result = await handler(payload, ctx)
    if (Array.isArray(result) ? result.length > 0 : !!result) used = true
    return result
  }
}

function targetEvent(event: HookEvent, options?: NormalizeHookRegistryOptions): HookEvent {
  return options?.agentFrontmatter && event === 'Stop' ? 'SubagentStop' : event
}

function normalizeRule(raw: RawHookRule, options?: NormalizeHookRegistryOptions): HookRule | null {
  if (typeof raw.event !== 'string' || !HOOK_EVENTS.has(raw.event as HookEvent)) return null
  const decisions = normalizeDecisionList(raw.decisions ?? raw.decision)
  if (decisions.length === 0) return null
  const matcher = typeof raw.matcher === 'string' && raw.matcher.trim() ? raw.matcher.trim() : undefined
  return {
    event: targetEvent(raw.event as HookEvent, options),
    matcher,
    handler: () => decisions,
  }
}

function normalizeFlatRules(value: unknown, options?: NormalizeHookRegistryOptions): HookRule[] {
  if (!Array.isArray(value)) return []
  return value
    .filter(isRecord)
    .map(rule => normalizeRule(rule as RawHookRule, options))
    .filter((rule): rule is HookRule => !!rule)
}

function commandHookPayload(payload: HookPayload, ctx: ToolContext): Record<string, unknown> {
  return {
    hook_event_name: payload.event,
    session_id: payload.sessionId ?? ctx.conversationId ?? '',
    cwd: ctx.workspace.root,
    permission_mode: ctx.permissionMode,
    ...(payload.toolName ? { tool_name: payload.toolName } : {}),
    ...(payload.input !== undefined ? { tool_input: payload.input } : {}),
    ...(payload.output !== undefined ? { tool_response: payload.output, last_assistant_message: payload.output } : {}),
    ...(payload.userPrompt !== undefined ? { prompt: payload.userPrompt } : {}),
    ...(payload.agentId ? { agent_id: payload.agentId } : {}),
    ...(payload.agentType ? { agent_type: payload.agentType } : {}),
    ...(payload.toolUseId ? { tool_use_id: payload.toolUseId } : {}),
    // PreCompact/PostCompact/Notification/SessionEnd/PostToolUseFailure 载荷字段(cc snake_case 命名)
    ...(payload.compactTrigger ? { trigger: payload.compactTrigger } : {}),
    ...(payload.compactCustomInstructions !== undefined ? { custom_instructions: payload.compactCustomInstructions } : {}),
    ...(payload.compactSummary !== undefined ? { compact_summary: payload.compactSummary } : {}),
    ...(payload.notificationMessage !== undefined ? { message: payload.notificationMessage } : {}),
    ...(payload.notificationTitle !== undefined ? { title: payload.notificationTitle } : {}),
    ...(payload.notificationType !== undefined ? { notification_type: payload.notificationType } : {}),
    ...(payload.sessionEndReason !== undefined ? { reason: payload.sessionEndReason } : {}),
    ...(payload.errorMessage !== undefined ? { error: payload.errorMessage } : {}),
    // PermissionRequest/PermissionDenied 载荷(cc permission_suggestions/reason)
    ...(payload.permissionSuggestions !== undefined ? { permission_suggestions: payload.permissionSuggestions } : {}),
    ...(payload.permissionReason !== undefined ? { reason: payload.permissionReason } : {}),
    // Setup/TeammateIdle/TaskCreated/TaskCompleted 载荷(cc trigger/teammate_name/team_name/task_*)
    ...(payload.setupTrigger !== undefined ? { trigger: payload.setupTrigger } : {}),
    ...(payload.teammateName !== undefined ? { teammate_name: payload.teammateName } : {}),
    ...(payload.teamName !== undefined ? { team_name: payload.teamName } : {}),
    ...(payload.taskId !== undefined ? { task_id: payload.taskId } : {}),
    ...(payload.taskSubject !== undefined ? { task_subject: payload.taskSubject } : {}),
    ...(payload.taskDescription !== undefined ? { task_description: payload.taskDescription } : {}),
    // Elicitation/ElicitationResult 载荷(cc mcp_server_name/message/mode/url/elicitation_id/requested_schema/action/content)
    ...(payload.mcpServerName !== undefined ? { mcp_server_name: payload.mcpServerName } : {}),
    ...(payload.elicitationMessage !== undefined ? { message: payload.elicitationMessage } : {}),
    ...(payload.elicitationMode !== undefined ? { mode: payload.elicitationMode } : {}),
    ...(payload.elicitationUrl !== undefined ? { url: payload.elicitationUrl } : {}),
    ...(payload.elicitationId !== undefined ? { elicitation_id: payload.elicitationId } : {}),
    ...(payload.elicitationRequestedSchema !== undefined ? { requested_schema: payload.elicitationRequestedSchema } : {}),
    ...(payload.elicitationAction !== undefined ? { action: payload.elicitationAction } : {}),
    ...(payload.elicitationContent !== undefined ? { content: payload.elicitationContent } : {}),
    // ConfigChange/InstructionsLoaded/FileChanged/Worktree/Cwd 载荷(cc source/file_path/memory_type/load_reason/...)
    ...(payload.configSource !== undefined ? { source: payload.configSource } : {}),
    ...(payload.filePath !== undefined ? { file_path: payload.filePath } : {}),
    ...(payload.memoryType !== undefined ? { memory_type: payload.memoryType } : {}),
    ...(payload.loadReason !== undefined ? { load_reason: payload.loadReason } : {}),
    ...(payload.instructionGlobs !== undefined ? { globs: payload.instructionGlobs } : {}),
    ...(payload.triggerFilePath !== undefined ? { trigger_file_path: payload.triggerFilePath } : {}),
    ...(payload.parentFilePath !== undefined ? { parent_file_path: payload.parentFilePath } : {}),
    ...(payload.worktreeName !== undefined ? { name: payload.worktreeName } : {}),
    ...(payload.worktreePath !== undefined ? { worktree_path: payload.worktreePath } : {}),
    ...(payload.oldCwd !== undefined ? { old_cwd: payload.oldCwd } : {}),
    ...(payload.newCwd !== undefined ? { new_cwd: payload.newCwd } : {}),
    ...(payload.fileEvent !== undefined ? { event: payload.fileEvent } : {}),
  }
}

function commandTimeoutMs(value: unknown): number {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return 120_000
  return Math.min(Math.max(Math.round(seconds * 1000), 1000), 600_000)
}

function hookTimeoutMs(value: unknown, fallbackMs: number): number {
  const seconds = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(seconds) || seconds <= 0) return fallbackMs
  return Math.min(Math.max(Math.round(seconds * 1000), 1000), 600_000)
}

function hookSpecificDecisions(raw: Record<string, unknown>): HookDecision[] {
  const out: HookDecision[] = []
  if (raw.decision === 'block') out.push({ action: 'deny', message: typeof raw.reason === 'string' ? raw.reason : 'hook blocked execution' })
  if (raw.decision === 'approve') out.push({ action: 'allow', message: typeof raw.reason === 'string' ? raw.reason : undefined })
  const specific = isRecord(raw.hookSpecificOutput) ? raw.hookSpecificOutput : null
  if (specific) {
    if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) {
      out.push({ action: 'context', additionalContext: specific.additionalContext })
    }
    if ('updatedInput' in specific) {
      out.push({ action: 'modify', updatedInput: specific.updatedInput, message: typeof raw.reason === 'string' ? raw.reason : undefined })
    }
  }
  return out
}

function parseCommandHookStdout(stdout: string): HookDecision | HookDecision[] | null {
  const text = stdout.trim()
  if (!text) return null
  const direct = parseHookDecisionJSON(text)
  if (direct) return direct
  try {
    const raw = JSON.parse(text) as unknown
    if (!isRecord(raw)) return { action: 'context', additionalContext: text }
    const decisions = hookSpecificDecisions(raw)
    return decisions.length > 0 ? decisions : { action: 'context', additionalContext: text }
  } catch {
    return { action: 'context', additionalContext: text }
  }
}

function parseHookArguments(args: string): string[] {
  const out: string[] = []
  let current = ''
  let quote: '"' | "'" | '' = ''
  let escaped = false
  for (const ch of args) {
    if (escaped) {
      current += ch
      escaped = false
      continue
    }
    if (ch === '\\' && quote !== "'") {
      escaped = true
      continue
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? '' : ch
      continue
    }
    if (!quote && /\s/.test(ch)) {
      if (current) {
        out.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (escaped) current += '\\'
  if (current) out.push(current)
  return out
}

function addArgumentsToPrompt(prompt: string, jsonInput: string): string {
  let content = prompt
  const original = content
  const args = parseHookArguments(jsonInput)
  content = content.replace(/\$ARGUMENTS\[(\d+)\]/g, (_, indexStr: string) => args[Number.parseInt(indexStr, 10)] ?? '')
  content = content.replace(/\$(\d+)(?!\w)/g, (_, indexStr: string) => args[Number.parseInt(indexStr, 10)] ?? '')
  content = content.replaceAll('$ARGUMENTS', jsonInput)
  return content === original && jsonInput ? `${content}\n\nARGUMENTS: ${jsonInput}` : content
}

function isGoalPromptHookCommand(command: unknown): command is string {
  return typeof command === 'string' && command.includes('<cc-haha-goal-hook>')
}

function goalPromptHookFailure(raw: RawPromptHook, reason: string): HookDecision | null {
  if (!isGoalPromptHookCommand(raw.prompt)) return null
  return {
    action: 'deny',
    message: `Goal evaluator failed: ${reason}. Treat the goal as incomplete and continue working toward it.`,
  }
}

function parsePromptHookJSON(text: string): { value?: { ok: boolean; reason?: string }; error?: 'invalid_json' | 'schema' } {
  try {
    const raw = JSON.parse(text) as unknown
    if (!isRecord(raw) || typeof raw.ok !== 'boolean') return { error: 'schema' }
    if ('reason' in raw && raw.reason !== undefined && typeof raw.reason !== 'string') return { error: 'schema' }
    return { value: { ok: raw.ok, reason: typeof raw.reason === 'string' ? raw.reason : undefined } }
  } catch {
    return { error: 'invalid_json' }
  }
}

function promptHookSystemPrompt(): string {
  return `You are evaluating a hook in Claude Code.

Your response must be a JSON object matching one of the following schemas:
1. If the condition is met, return: {"ok": true}
2. If the condition is not met, return: {"ok": false, "reason": "Reason for why it is not met"}`
}

function createStructuredOutputTool(onOutput: (value: unknown) => void): Tool {
  return {
    name: STRUCTURED_OUTPUT_TOOL_NAME,
    description: 'Return the hook verification result. You MUST call this exactly once at the end with { ok, reason? }.',
    inputSchema: {
      type: 'object',
      properties: {
        ok: { type: 'boolean', description: 'Whether the hook condition was met.' },
        reason: { type: 'string', description: 'Reason when ok is false.' },
      },
      required: ['ok'],
      additionalProperties: false,
    },
    isReadOnly: true,
    async execute(input) {
      onOutput(input)
      return '<structured_output status="captured" />'
    },
  }
}

function agentHookTools(ctx: ToolContext, onOutput: (value: unknown) => void): ToolRegistry | null {
  if (!ctx.registry) return null
  const tools = ctx.registry.list()
    .filter(tool => tool.name !== STRUCTURED_OUTPUT_TOOL_NAME)
    .filter(tool => AGENT_HOOK_ALLOWED_TOOLS.has(tool.name))
  return new ToolRegistry([...tools, createStructuredOutputTool(onOutput)])
}

function agentHookSystemPrompt(ctx: ToolContext): string {
  return [
    'You are verifying a stop condition in a coding agent.',
    'Use the available read-only inspection and diagnostic tools to verify the condition efficiently.',
    'Do not edit files, start subagents, ask the user, or enter plan mode.',
    `The workspace root is: ${ctx.workspace.root}`,
    `When done, call ${STRUCTURED_OUTPUT_TOOL_NAME} exactly once with:`,
    '- ok: true if the condition is met',
    '- ok: false with reason if the condition is not met',
  ].join('\n')
}

function structuredOutputFrom(value: unknown): { ok: boolean; reason?: string } | null {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return null
  if ('reason' in value && value.reason !== undefined && typeof value.reason !== 'string') return null
  return { ok: value.ok, reason: typeof value.reason === 'string' ? value.reason : undefined }
}

async function runAgentHook(raw: RawAgentHook, payload: HookPayload, ctx: ToolContext): Promise<HookDecision | HookDecision[] | null> {
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) return null
  const model = ctx.model
  if (!model) {
    return { action: 'context', additionalContext: `[${payload.event} agent hook 非阻塞错误] model was unavailable` }
  }
  let structuredOutput: { ok: boolean; reason?: string } | null = null
  const registry = agentHookTools(ctx, value => { structuredOutput = structuredOutputFrom(value) })
  if (!registry) {
    return { action: 'context', additionalContext: `[${payload.event} agent hook 非阻塞错误] tool registry was unavailable` }
  }
  const jsonInput = JSON.stringify(commandHookPayload(payload, ctx))
  const processedPrompt = addArgumentsToPrompt(raw.prompt, jsonInput)
  const timeoutMs = hookTimeoutMs(raw.timeout, 60_000)
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  ctx.signal?.addEventListener('abort', abort, { once: true })
  try {
    let finalText = ''
    for await (const event of runAgentLoop({
      model,
      registry,
      workspace: ctx.workspace,
      systemPrompt: agentHookSystemPrompt(ctx),
      userMessage: processedPrompt,
      maxTurns: AGENT_HOOK_MAX_TURNS,
      signal: controller.signal,
      sandbox: ctx.sandbox,
      permissionMode: 'plan',
      conversationId: `${ctx.conversationId ?? payload.sessionId ?? 'hook'}:agent-hook`,
      toolResultStoreDir: ctx.toolResultStoreDir,
    })) {
      if (event.type === 'final') finalText = event.text
      if (structuredOutput) controller.abort()
    }
    if (!structuredOutput) {
      const parsed = parsePromptHookJSON(finalText.trim())
      structuredOutput = parsed.value ?? null
    }
    if (!structuredOutput) return null
    if (!structuredOutput.ok) {
      return {
        action: 'deny',
        message: `Agent hook condition was not met: ${structuredOutput.reason ?? 'condition was not met'}`,
      }
    }
    return { action: 'allow' }
  } catch (error) {
    if (controller.signal.aborted && structuredOutput) {
      if (!structuredOutput.ok) {
        return {
          action: 'deny',
          message: `Agent hook condition was not met: ${structuredOutput.reason ?? 'condition was not met'}`,
        }
      }
      return { action: 'allow' }
    }
    if (controller.signal.aborted || ctx.signal?.aborted) return null
    return { action: 'context', additionalContext: `[${payload.event} agent hook 非阻塞错误] ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', abort)
  }
}

async function runPromptHook(raw: RawPromptHook, payload: HookPayload, ctx: ToolContext): Promise<HookDecision | HookDecision[] | null> {
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim()) return null
  const model = ctx.model
  if (!model) {
    const goalFailure = goalPromptHookFailure(raw, 'model was unavailable')
    if (goalFailure) return goalFailure
    return { action: 'context', additionalContext: `[${payload.event} prompt hook 非阻塞错误] model was unavailable` }
  }
  const jsonInput = JSON.stringify(commandHookPayload(payload, ctx))
  const processedPrompt = addArgumentsToPrompt(raw.prompt, jsonInput)
  const timeoutMs = hookTimeoutMs(raw.timeout, 30_000)
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  ctx.signal?.addEventListener('abort', abort, { once: true })
  try {
    const messages: Message[] = [{ role: 'user', content: [textBlock(processedPrompt)] }]
    const step = await model.step({
      system: promptHookSystemPrompt(),
      messages,
      tools: [],
      signal: controller.signal,
    })
    const fullResponse = (step.kind === 'final' ? step.text : step.text ?? '').trim()
    const parsed = parsePromptHookJSON(fullResponse)
    if (!parsed.value) {
      const reason = parsed.error === 'schema'
        ? 'response did not match the expected schema'
        : 'response was not valid JSON'
      const goalFailure = goalPromptHookFailure(raw, reason)
      if (goalFailure) return goalFailure
      return {
        action: 'context',
        additionalContext: `[${payload.event} prompt hook 非阻塞错误] JSON validation failed${fullResponse ? `: ${fullResponse}` : ''}`,
      }
    }
    if (!parsed.value.ok) {
      return {
        action: 'deny',
        message: `Prompt hook condition was not met: ${parsed.value.reason ?? 'condition was not met'}`,
      }
    }
    return { action: 'allow' }
  } catch (error) {
    const aborted = controller.signal.aborted || ctx.signal?.aborted
    const reason = aborted && !ctx.signal?.aborted
      ? 'evaluation timed out'
      : error instanceof Error ? error.message : String(error)
    const goalFailure = goalPromptHookFailure(raw, reason || 'evaluation failed')
    if (goalFailure) return goalFailure
    if (aborted && ctx.signal?.aborted) return null
    return { action: 'context', additionalContext: `[${payload.event} prompt hook 非阻塞错误] ${reason || 'evaluation failed'}` }
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', abort)
  }
}

async function runCommandHook(raw: RawCommandHook, payload: HookPayload, ctx: ToolContext): Promise<HookDecision | HookDecision[] | null> {
  if (typeof raw.command !== 'string' || !raw.command.trim()) return null
  const command = raw.command.trim()
  const timeoutMs = commandTimeoutMs(raw.timeout)
  const jsonInput = JSON.stringify(commandHookPayload(payload, ctx))
  return await new Promise<HookDecision | HookDecision[] | null>(resolve => {
    const child = spawn(command, {
      cwd: ctx.workspace.root,
      env: process.env,
      shell: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (decision: HookDecision | HookDecision[] | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      ctx.signal?.removeEventListener('abort', abort)
      resolve(decision)
    }
    const abort = () => {
      child.kill()
      settle({ action: 'deny', message: `hook command aborted: ${command}` })
    }
    timer = setTimeout(() => {
      child.kill()
      settle({ action: 'deny', message: `hook command timed out after ${Math.round(timeoutMs / 1000)}s: ${command}` })
    }, timeoutMs)
    ctx.signal?.addEventListener('abort', abort, { once: true })
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => settle({ action: 'deny', message: `hook command failed: ${error.message}` }))
    child.on('close', code => {
      if (settled) return
      const output = (stderr || stdout).trim()
      if (code === 2) {
        settle({ action: 'deny', message: output || `hook command blocked: ${command}` })
        return
      }
      if (code && code !== 0) {
        settle({ action: 'context', additionalContext: `[${payload.event} command hook 非阻塞错误] ${output || `exit ${code}: ${command}`}` })
        return
      }
      settle(parseCommandHookStdout(stdout))
    })
    child.stdin?.end(jsonInput)
  })
}

function sanitizeHeaderValue(value: string): string {
  return value.replace(/[\r\n\x00]/g, '')
}

function interpolateAllowedEnv(value: string, allowedEnvVars: Set<string>): string {
  return sanitizeHeaderValue(value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}|\$([A-Z_][A-Z0-9_]*)/g, (_, braced: string | undefined, unbraced: string | undefined) => {
    const name = braced ?? unbraced ?? ''
    return allowedEnvVars.has(name) ? process.env[name] ?? '' : ''
  }))
}

function normalizeHeaders(value: unknown, allowedEnvVars: Set<string>): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (!isRecord(value)) return headers
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue
    const cleanName = name.trim()
    if (!cleanName || /[\r\n\x00:]/.test(cleanName)) continue
    headers[cleanName] = interpolateAllowedEnv(raw, allowedEnvVars)
  }
  return headers
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value
    .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim())
}

function envList(name: string): string[] | undefined {
  if (!(name in process.env)) return undefined
  return (process.env[name] ?? '').split(',').map(value => value.trim()).filter(Boolean)
}

function urlMatchesPattern(url: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}$`).test(url)
}

function httpHookAllowedUrls(policy: NormalizeHookRegistryOptions['httpPolicy'] | undefined): string[] | undefined {
  return policy?.allowedUrls ?? envList('HTTP_HOOK_ALLOWED_URLS')
}

function httpHookAllowedEnvVars(raw: RawHttpHook, policy: NormalizeHookRegistryOptions['httpPolicy'] | undefined): Set<string> {
  const hookVars = normalizeStringArray(raw.allowedEnvVars) ?? []
  const policyVars = policy?.allowedEnvVars ?? envList('HTTP_HOOK_ALLOWED_ENV_VARS')
  const effective = policyVars ? hookVars.filter(name => policyVars.includes(name)) : hookVars
  return new Set(effective.filter(Boolean))
}

function normalizeHttpPolicy(value: unknown, options?: NormalizeHookRegistryOptions): NormalizeHookRegistryOptions['httpPolicy'] | undefined {
  if (!isRecord(value)) return options?.httpPolicy
  const nested = isRecord(value.httpPolicy) ? value.httpPolicy : {}
  const allowedUrls = options?.httpPolicy?.allowedUrls ??
    normalizeStringArray(nested.allowedUrls) ??
    normalizeStringArray(value.allowedHttpHookUrls)
  const allowedEnvVars = options?.httpPolicy?.allowedEnvVars ??
    normalizeStringArray(nested.allowedEnvVars) ??
    normalizeStringArray(value.httpHookAllowedEnvVars)
  return allowedUrls !== undefined || allowedEnvVars !== undefined ? { allowedUrls, allowedEnvVars } : options?.httpPolicy
}

function normalizeOptions(value: unknown, options?: NormalizeHookRegistryOptions): NormalizeHookRegistryOptions | undefined {
  const httpPolicy = normalizeHttpPolicy(value, options)
  return httpPolicy ? { ...options, httpPolicy } : options
}

function requestHostname(url: URL): string {
  return url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname
}

async function postHttpHook(url: URL, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; body: string }> {
  const hostname = requestHostname(url)
  assertHttpHookHostAllowed(hostname)
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
  return await new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error('HTTP hook aborted'), { name: 'AbortError' }))
      return
    }
    const req = transport({
      protocol: url.protocol,
      hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'POST',
      headers: {
        ...headers,
        'Content-Length': Buffer.byteLength(body),
      },
      lookup: ssrfGuardedLookup,
      timeout: 0,
    }, res => {
      const chunks: Buffer[] = []
      res.on('data', chunk => { chunks.push(Buffer.from(chunk)) })
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
      })
    })
    const abort = () => {
      req.destroy(Object.assign(new Error('HTTP hook aborted'), { name: 'AbortError' }))
    }
    signal.addEventListener('abort', abort, { once: true })
    req.on('error', reject)
    req.on('close', () => signal.removeEventListener('abort', abort))
    req.end(body)
  })
}

async function runHttpHook(raw: RawHttpHook, payload: HookPayload, ctx: ToolContext, policy?: NormalizeHookRegistryOptions['httpPolicy']): Promise<HookDecision | HookDecision[] | null> {
  if (typeof raw.url !== 'string' || !raw.url.trim()) return null
  let url: URL
  try {
    url = new URL(raw.url.trim())
  } catch {
    return { action: 'deny', message: `http hook url invalid: ${String(raw.url)}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { action: 'deny', message: `http hook url protocol not allowed: ${url.protocol}` }
  }
  const allowedUrls = httpHookAllowedUrls(policy)
  if (allowedUrls !== undefined && !allowedUrls.some(pattern => urlMatchesPattern(url.toString(), pattern))) {
    return { action: 'deny', message: `HTTP hook blocked: ${url.toString()} does not match any pattern in allowedHttpHookUrls` }
  }
  const allowedEnvVars = httpHookAllowedEnvVars(raw, policy)
  const timeoutMs = hookTimeoutMs(raw.timeout, 120_000)
  const controller = new AbortController()
  const abort = () => controller.abort()
  const timer = setTimeout(abort, timeoutMs)
  ctx.signal?.addEventListener('abort', abort, { once: true })
  try {
    const response = await postHttpHook(
      url,
      JSON.stringify(commandHookPayload(payload, ctx)),
      normalizeHeaders(raw.headers, allowedEnvVars),
      controller.signal,
    )
    if (response.status < 200 || response.status >= 300) {
      return { action: 'context', additionalContext: `[${payload.event} http hook 非阻塞错误] HTTP ${response.status}${response.body.trim() ? `: ${response.body.trim()}` : ''}` }
    }
    return parseCommandHookStdout(response.body)
  } catch (error) {
    if (controller.signal.aborted) {
      return { action: 'deny', message: `http hook aborted or timed out after ${Math.round(timeoutMs / 1000)}s: ${url.toString()}` }
    }
    return { action: 'context', additionalContext: `[${payload.event} http hook 非阻塞错误] ${error instanceof Error ? error.message : String(error)}` }
  } finally {
    clearTimeout(timer)
    ctx.signal?.removeEventListener('abort', abort)
  }
}

function normalizeHookCommand(event: HookEvent, matcher: string | undefined, raw: Record<string, unknown>, options?: NormalizeHookRegistryOptions): HookRule | null {
  const staticDecisions = normalizeDecisionList(raw.decisions ?? raw.decision ?? (raw.action ? raw : undefined))
  if (staticDecisions.length > 0) {
    return { event, matcher, handler: onceHandler(raw, () => staticDecisions) }
  }

  if (raw.type === 'command' && typeof raw.command === 'string' && raw.command.trim()) {
    const commandHook = raw as RawCommandHook
    return { event, matcher, handler: onceHandler(raw, (payload, ctx) => runCommandHook(commandHook, payload, ctx)) }
  }

  if (raw.type === 'http' && typeof raw.url === 'string' && raw.url.trim()) {
    const httpHook = raw as RawHttpHook
    return { event, matcher, handler: onceHandler(raw, (payload, ctx) => runHttpHook(httpHook, payload, ctx, options?.httpPolicy)) }
  }

  if (raw.type === 'prompt' && typeof raw.prompt === 'string' && raw.prompt.trim()) {
    const promptHook = raw as RawPromptHook
    return { event, matcher, handler: onceHandler(raw, (payload, ctx) => runPromptHook(promptHook, payload, ctx)) }
  }

  if (raw.type === 'agent' && typeof raw.prompt === 'string' && raw.prompt.trim()) {
    const agentHook = raw as RawAgentHook
    return { event, matcher, handler: onceHandler(raw, (payload, ctx) => runAgentHook(agentHook, payload, ctx)) }
  }

  return null
}

function normalizeEventMap(value: unknown, options?: NormalizeHookRegistryOptions): HookRule[] {
  if (!isRecord(value)) return []
  const rules: HookRule[] = []
  for (const [eventName, matcherConfigs] of Object.entries(value)) {
    if (!HOOK_EVENTS.has(eventName as HookEvent) || !Array.isArray(matcherConfigs)) continue
    const event = targetEvent(eventName as HookEvent, options)
    for (const matcherConfig of matcherConfigs) {
      if (!isRecord(matcherConfig)) continue
      const matcher = typeof matcherConfig.matcher === 'string' && matcherConfig.matcher.trim() ? matcherConfig.matcher.trim() : undefined
      if (Array.isArray(matcherConfig.hooks)) {
        for (const hook of matcherConfig.hooks) {
          if (!isRecord(hook)) continue
          const rule = normalizeHookCommand(event, matcher, hook, options)
          if (rule) rules.push(rule)
        }
        continue
      }
      const rule = normalizeHookCommand(event, matcher, matcherConfig, options)
      if (rule) rules.push(rule)
    }
  }
  return rules
}

export function normalizeHookRegistry(value: unknown, options?: NormalizeHookRegistryOptions): HookRegistry {
  const effectiveOptions = normalizeOptions(value, options)
  const rules: HookRule[] = []
  if (Array.isArray(value)) rules.push(...normalizeFlatRules(value, effectiveOptions))
  if (isRecord(value)) {
    rules.push(...normalizeFlatRules(value.rules, effectiveOptions))
    if (Array.isArray(value.hooks)) rules.push(...normalizeFlatRules(value.hooks, effectiveOptions))
    else if (isRecord(value.hooks)) rules.push(...normalizeEventMap(value.hooks, effectiveOptions))
    rules.push(...normalizeEventMap(value, effectiveOptions))
  }
  // 来源标记透传到每条规则,供执行前的信任门(runHookEvent → shouldRunHookRule)按 source 判定。
  const source = effectiveOptions?.source
  return { rules: source ? rules.map(rule => ({ ...rule, source })) : rules }
}

/** 读单个 hook 配置文件、按给定 source 标记规范化;文件不存在/坏 JSON 静默返回 undefined(不拖垮调用方)。 */
async function loadHookRegistryFromPath(path: string, source: HookSource): Promise<HookRegistry | undefined> {
  let raw = ''
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return undefined
  }
  try {
    const registry = normalizeHookRegistry(JSON.parse(raw) as unknown, { source })
    return registry.rules.length > 0 ? registry : undefined
  } catch {
    return undefined
  }
}

/**
 * 加载单个显式路径的 hook 配置文件,标 `source:'local'`(工作区来源、任意命令,受信任门约束)。
 * 供调用方显式传一个覆盖路径时用(如 server 启动 opts.hooksPath);常规加载走三级
 * `loadWorkspaceHookRegistry`(见下方),不再靠这个函数单独顶替 user/project/local 三级分层。
 */
export async function loadHookRegistryFile(path: string | undefined): Promise<HookRegistry | undefined> {
  if (!path) return undefined
  // 工作区 .billiardbuddy/settings 风格文件里的 hook 是不可信来源(任意命令),标 'local' 交给信任门约束。
  return loadHookRegistryFromPath(path, 'local')
}

/**
 * 用户级 hooks:`~/.billiardbuddy/settings.json` 的 `hooks` 字段(白标目录 getUserConfigHomeDir 派生,
 * 对齐同仓库 `permissions/permissionsSettings.ts` loadUserPermissionRules 的用户级源)。
 * 标 `source:'user'`——是用户自己机器上的配置、非工作区攻击面,不过 workspace trust 闸(见 hooks.ts
 * HookSource 文档),但仍受 disableAllHooks/allowManagedHooksOnly 约束。
 */
export async function loadUserHookRegistry(): Promise<HookRegistry | undefined> {
  return loadHookRegistryFromPath(join(getUserConfigHomeDir(), 'settings.json'), 'user')
}

/**
 * 工作区级 hook 配置文件相对路径(白标:.billiardbuddy/,与 permissions/permissionsSettings.ts
 * WORKSPACE_SETTINGS_FILES 同构):project = <root>/.billiardbuddy/settings.json,
 * local = <root>/.billiardbuddy/settings.local.json。二者信任语义相同(都是工作区来源、都受
 * workspace trust 闸约束),统一标 `source:'local'`,不再细分(不像 permissions 那样需要区分写入落点——
 * hooks 没有"运行时持久化一条规则"的写回场景)。
 */
const WORKSPACE_HOOK_SETTINGS_RELATIVE_PATHS: readonly string[] = [
  join(MEMORY_DOT_DIR, 'settings.json'),
  join(MEMORY_DOT_DIR, 'settings.local.json'),
]

/**
 * 三级 hook 配置合并加载(取代已删除的死路径 `defaultHooksPath()` 找老 Python `server/hooks.json`):
 *   用户级(~/.billiardbuddy/settings.json,source:'user',不过 workspace trust 闸)
 * + 工作区 project(<root>/.billiardbuddy/settings.json,source:'local')
 * + 工作区 local(<root>/.billiardbuddy/settings.local.json,source:'local')
 * + 可选显式覆盖路径(`extraPath`,兼容调用方/测试直传单文件的用法,同标 source:'local')。
 *
 * 合并语义对齐 cc `getAllHooks`(`src/utils/hooks/hooksSettings.ts:92-161`):**各源全部合并参与匹配**,
 * 不是"高优先级覆盖低优先级"——hooks 本身没有互斥覆盖概念,谁真正生效由信任门(`shouldRunHookRule`)
 * + deny>ask>allow 决策聚合决定,不是配置加载阶段的取舍。
 */
export async function loadWorkspaceHookRegistry(workspaceRoot: string, extraPath?: string): Promise<HookRegistry | undefined> {
  const registries = await Promise.all([
    loadUserHookRegistry(),
    ...WORKSPACE_HOOK_SETTINGS_RELATIVE_PATHS.map(rel => loadHookRegistryFromPath(join(workspaceRoot, rel), 'local')),
    extraPath ? loadHookRegistryFile(extraPath) : Promise.resolve(undefined),
  ])
  return mergeHookRegistries(...registries)
}

/**
 * 把已启用插件的 hooks 配置文件加载成一个合并 HookRegistry(对齐 cc loadPluginHooks:
 * convertPluginHooksToMatchers → registerHookCallbacks 的落地版)。
 *
 * - 每个 path 是某插件的 hooks 配置文件(如 `<plugin>/hooks/hooks.json`,cc 标准位置)。文件既可是
 *   `{ description, hooks: { PreToolUse: [{matcher, hooks:[...]}] } }` 包裹结构,也可是裸事件映射——
 *   normalizeHookRegistry 两种都吃(normalizeEventMap 会分别处理 value.hooks 与顶层)。
 * - 来源标 `'plugin'`:与插件 .mcp.json"app 级可信、不走工作区信任闸"口径一致——受 disableAllHooks /
 *   allowManagedHooksOnly 约束,但不过 workspace trust 闸(插件不在被打开的工作区里、非 RCE 攻击面)。
 * - 单个文件读/解析失败静默跳过(不因一个坏插件拖垮整体);全空则返回 undefined。
 */
export async function loadPluginHookRegistry(paths: readonly string[]): Promise<HookRegistry | undefined> {
  const registries: Array<HookRegistry | undefined> = []
  for (const path of paths) {
    let raw = ''
    try {
      raw = await readFile(path, 'utf8')
    } catch {
      continue
    }
    try {
      const registry = normalizeHookRegistry(JSON.parse(raw) as unknown, { source: 'plugin' })
      if (registry.rules.length > 0) registries.push(registry)
    } catch {
      // 坏 JSON / 非法结构:跳过这一个插件的 hooks,不影响其余。
    }
  }
  return mergeHookRegistries(...registries)
}
