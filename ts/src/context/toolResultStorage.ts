import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '../types/message'

export const DEFAULT_TOOL_RESULT_STORAGE_THRESHOLD_CHARS = 24_000
export const DEFAULT_TOOL_RESULT_STORAGE_PREVIEW_CHARS = 2_000
export const DEFAULT_TOOL_RESULTS_PER_MESSAGE_BUDGET_CHARS = 200_000

const DEFAULT_STORABLE_TOOLS = new Set([
  'run_command',
  'project_diagnostics',
  'grep_files',
  'glob_files',
  'list_dir',
  'code_outline',
  'git_status',
  'git_history',
  'REPL',
  'TaskOutput',
  'file_history',
  'restore_file',
  'list_mcp_resources',
  'read_mcp_resource',
  'list_mcp_prompts',
  'read_mcp_prompt',
])

export interface ToolResultStorageOptions {
  dir?: string
  conversationId?: string
  thresholdChars?: number
  previewChars?: number
  storableTools?: ReadonlySet<string>
}

export interface StoredToolResult {
  content: string
  stored: boolean
  path?: string
}

export interface ContentReplacementState {
  seenIds: Set<string>
  replacements: Map<string, string>
}

export type ContentReplacementRecord = {
  kind: 'tool-result'
  toolUseId: string
  replacement: string
}

interface ToolResultCandidate {
  toolUseId: string
  toolName: string
  content: string
  size: number
}

interface CandidatePartition {
  mustReapply: Array<ToolResultCandidate & { replacement: string }>
  frozen: ToolResultCandidate[]
  fresh: ToolResultCandidate[]
}

export interface ToolResultBudgetOptions extends ToolResultStorageOptions {
  budgetChars?: number
  skipToolNames?: ReadonlySet<string>
}

export async function maybeStoreToolResult(
  tool: string,
  callId: string,
  output: string,
  opts: ToolResultStorageOptions = {},
): Promise<StoredToolResult> {
  if (isEmptyToolResult(output)) {
    return { content: emptyToolResultMessage(tool), stored: false }
  }

  const storableTools = opts.storableTools ?? DEFAULT_STORABLE_TOOLS
  const threshold = positiveInt(opts.thresholdChars, DEFAULT_TOOL_RESULT_STORAGE_THRESHOLD_CHARS)
  if (!isStorableTool(tool, storableTools) || output.length <= threshold) return { content: output, stored: false }

  const previewChars = positiveInt(opts.previewChars, DEFAULT_TOOL_RESULT_STORAGE_PREVIEW_CHARS)
  const dir = opts.dir ?? join(tmpdir(), 'qf-agent-tool-results', safeSegment(opts.conversationId ?? 'adhoc'))
  const filename = `${safeSegment(callId)}-${safeSegment(tool)}.txt`
  const path = join(dir, filename)
  try {
    await mkdir(dir, { recursive: true })
    await writeFile(path, output, { encoding: 'utf8', flag: 'wx' })
    return {
      content: formatStoredToolResult({
        tool,
        callId,
        path,
        output,
        previewChars,
      }),
      stored: true,
      path,
    }
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      return {
        content: formatStoredToolResult({
          tool,
          callId,
          path,
          output,
          previewChars,
        }),
        stored: true,
        path,
      }
    }
    return {
      content: formatStoredToolResult({
        tool,
        callId,
        output,
        previewChars,
        storageError: error instanceof Error ? error.message : String(error),
      }),
      stored: false,
    }
  }
}

export function createContentReplacementState(): ContentReplacementState {
  return { seenIds: new Set(), replacements: new Map() }
}

export function cloneContentReplacementState(source: ContentReplacementState): ContentReplacementState {
  return {
    seenIds: new Set(source.seenIds),
    replacements: new Map(source.replacements),
  }
}

export function reconstructContentReplacementState(
  messages: Message[],
  records: ContentReplacementRecord[] = [],
  inheritedReplacements?: ReadonlyMap<string, string>,
): ContentReplacementState {
  const state = createContentReplacementState()
  const candidateIds = new Set(collectCandidatesByMessage(messages).flat().map(candidate => candidate.toolUseId))
  for (const id of candidateIds) state.seenIds.add(id)
  for (const record of records) {
    if (record.kind === 'tool-result' && candidateIds.has(record.toolUseId)) {
      state.replacements.set(record.toolUseId, record.replacement)
    }
  }
  if (inheritedReplacements) {
    for (const [id, replacement] of inheritedReplacements) {
      if (candidateIds.has(id) && !state.replacements.has(id)) {
        state.replacements.set(id, replacement)
      }
    }
  }
  return state
}

export async function enforceToolResultBudget(
  messages: Message[],
  state: ContentReplacementState,
  opts: ToolResultBudgetOptions = {},
): Promise<{ messages: Message[]; newlyReplaced: ContentReplacementRecord[] }> {
  const groups = collectCandidatesByMessage(messages)
  const limit = positiveInt(opts.budgetChars, DEFAULT_TOOL_RESULTS_PER_MESSAGE_BUDGET_CHARS)
  const replacementMap = new Map<string, string>()
  const toPersist: ToolResultCandidate[] = []

  for (const candidates of groups) {
    const { mustReapply, frozen, fresh } = partitionByPriorDecision(candidates, state)
    for (const candidate of mustReapply) replacementMap.set(candidate.toolUseId, candidate.replacement)
    if (fresh.length === 0) {
      for (const candidate of candidates) state.seenIds.add(candidate.toolUseId)
      continue
    }

    const skipped = fresh.filter(candidate => opts.skipToolNames?.has(candidate.toolName))
    for (const candidate of skipped) state.seenIds.add(candidate.toolUseId)
    const eligible = fresh.filter(candidate => !opts.skipToolNames?.has(candidate.toolName))
    const frozenSize = frozen.reduce((sum, candidate) => sum + candidate.size, 0)
    const freshSize = eligible.reduce((sum, candidate) => sum + candidate.size, 0)
    const selected = frozenSize + freshSize > limit
      ? selectFreshToReplace(eligible, frozenSize, limit)
      : []
    const selectedIds = new Set(selected.map(candidate => candidate.toolUseId))

    for (const candidate of candidates) {
      if (!selectedIds.has(candidate.toolUseId)) state.seenIds.add(candidate.toolUseId)
    }
    toPersist.push(...selected)
  }

  if (replacementMap.size === 0 && toPersist.length === 0) {
    return { messages, newlyReplaced: [] }
  }

  const freshReplacements = await Promise.all(toPersist.map(async candidate => {
    const stored = await maybeStoreToolResult(candidate.toolName, candidate.toolUseId, candidate.content, {
      dir: opts.dir,
      conversationId: opts.conversationId,
      previewChars: opts.previewChars,
      thresholdChars: 1,
      storableTools: new Set([candidate.toolName]),
    })
    return [candidate, stored.stored ? stored.content : null] as const
  }))

  const newlyReplaced: ContentReplacementRecord[] = []
  for (const [candidate, replacement] of freshReplacements) {
    state.seenIds.add(candidate.toolUseId)
    if (!replacement) continue
    replacementMap.set(candidate.toolUseId, replacement)
    state.replacements.set(candidate.toolUseId, replacement)
    newlyReplaced.push({
      kind: 'tool-result',
      toolUseId: candidate.toolUseId,
      replacement,
    })
  }

  if (replacementMap.size === 0) return { messages, newlyReplaced: [] }
  return { messages: replaceToolResultContents(messages, replacementMap), newlyReplaced }
}

export async function applyToolResultBudget(
  messages: Message[],
  state: ContentReplacementState | undefined,
  opts: ToolResultBudgetOptions & {
    writeRecords?: (records: ContentReplacementRecord[]) => void | Promise<void>
  } = {},
): Promise<Message[]> {
  if (!state) return messages
  const result = await enforceToolResultBudget(messages, state, opts)
  if (result.newlyReplaced.length > 0) await opts.writeRecords?.(result.newlyReplaced)
  return result.messages
}

function isEmptyToolResult(output: string): boolean {
  return output.trim() === ''
}

function emptyToolResultMessage(tool: string): string {
  return `(${tool} completed with no output)`
}

function isStorableTool(tool: string, storableTools: ReadonlySet<string>): boolean {
  if (storableTools.has(tool)) return true
  return storableTools === DEFAULT_STORABLE_TOOLS && tool.startsWith('mcp__')
}

function collectCandidatesByMessage(messages: Message[]): ToolResultCandidate[][] {
  const groups: ToolResultCandidate[][] = []
  let current: ToolResultCandidate[] = []
  const toolNames = buildToolNameMap(messages)
  const flush = () => {
    if (current.length > 0) groups.push(current)
    current = []
  }

  for (const message of messages) {
    if (message.role === 'user') {
      current.push(...collectCandidatesFromMessage(message, toolNames))
    } else if (message.role === 'assistant') {
      flush()
    }
  }
  flush()
  return groups
}

function collectCandidatesFromMessage(message: Message, toolNames: ReadonlyMap<string, string>): ToolResultCandidate[] {
  if (message.role !== 'user') return []
  return message.content.flatMap(block => {
    if (block.type !== 'tool_result') return []
    // 多模态 tool_result(content 是块数组,如 read_file 读图)不参与落盘/预算裁剪:图像块不能当文本切,
    // 且 read_file 本就不在 storable 名单。只对纯文本结果做候选收集(向后兼容)。
    if (typeof block.content !== 'string') return []
    if (block.content.trim() === '') return []
    if (isContentAlreadyStored(block.content)) return []
    return [{
      toolUseId: block.tool_use_id,
      toolName: toolNames.get(block.tool_use_id) ?? 'tool_result',
      content: block.content,
      size: block.content.length,
    }]
  })
}

function buildToolNameMap(messages: Message[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const block of message.content) {
      if (block.type === 'tool_use') map.set(block.id, block.name)
    }
  }
  return map
}

function partitionByPriorDecision(candidates: ToolResultCandidate[], state: ContentReplacementState): CandidatePartition {
  return candidates.reduce<CandidatePartition>((acc, candidate) => {
    const replacement = state.replacements.get(candidate.toolUseId)
    if (replacement !== undefined) {
      acc.mustReapply.push({ ...candidate, replacement })
    } else if (state.seenIds.has(candidate.toolUseId)) {
      acc.frozen.push(candidate)
    } else {
      acc.fresh.push(candidate)
    }
    return acc
  }, { mustReapply: [], frozen: [], fresh: [] })
}

function selectFreshToReplace(fresh: ToolResultCandidate[], frozenSize: number, limit: number): ToolResultCandidate[] {
  const selected: ToolResultCandidate[] = []
  let remaining = frozenSize + fresh.reduce((sum, candidate) => sum + candidate.size, 0)
  for (const candidate of [...fresh].sort((a, b) => b.size - a.size)) {
    if (remaining <= limit) break
    selected.push(candidate)
    remaining -= candidate.size
  }
  return selected
}

function replaceToolResultContents(messages: Message[], replacementMap: ReadonlyMap<string, string>): Message[] {
  return messages.map(message => {
    if (message.role !== 'user') return message
    const needsReplacement = message.content.some(block => block.type === 'tool_result' && replacementMap.has(block.tool_use_id))
    if (!needsReplacement) return message
    return {
      ...message,
      content: message.content.map(block => {
        if (block.type !== 'tool_result') return block
        const replacement = replacementMap.get(block.tool_use_id)
        return replacement === undefined ? block : { ...block, content: replacement }
      }),
    }
  })
}

function isContentAlreadyStored(content: string): boolean {
  return content.startsWith('<stored_tool_result')
}

function formatStoredToolResult(input: {
  tool: string
  callId: string
  path?: string
  output: string
  previewChars: number
  storageError?: string
}): string {
  const preview = splitPreview(input.output, input.previewChars)
  const attrs = [
    `tool="${xmlAttr(input.tool)}"`,
    `call_id="${xmlAttr(input.callId)}"`,
    `chars="${input.output.length}"`,
    `bytes="${Buffer.byteLength(input.output, 'utf8')}"`,
    input.path ? `path="${xmlAttr(input.path)}"` : '',
    input.storageError ? `storage_error="${xmlAttr(input.storageError)}"` : '',
  ].filter(Boolean).join(' ')
  return [
    `<stored_tool_result ${attrs}>`,
    input.path
      ? '工具结果过长,已写入 path;模型上下文仅保留头尾预览。需要细看时用 read_stored_tool_result 按窗口读取该 path,或重新运行更窄的命令。'
      : '工具结果过长,落盘失败;模型上下文仅保留头尾预览。请重新运行更窄的命令。',
    `<preview_head chars="${preview.head.length}">`,
    xmlText(preview.head),
    '</preview_head>',
    `<preview_tail chars="${preview.tail.length}">`,
    xmlText(preview.tail),
    '</preview_tail>',
    '</stored_tool_result>',
  ].join('\n')
}

function splitPreview(text: string, previewChars: number): { head: string; tail: string } {
  const half = Math.max(1, Math.floor(previewChars / 2))
  return {
    head: text.slice(0, half),
    tail: text.slice(Math.max(0, text.length - half)),
  }
}

function positiveInt(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.floor(n))
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'item'
}

function errorCode(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : ''
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
