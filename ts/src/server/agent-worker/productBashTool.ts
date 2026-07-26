import { z } from 'zod/v4'
import { buildProductTool, type ProductToolDef } from './productTool.js'
import { getProductPermissionEnvelope } from '../../utils/permissions/productPermissionRuntime.js'
import { runProductShell } from './productSandboxRunner.js'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 10 * 60_000

const inputSchema = z.strictObject({
  command: z.string().min(1).max(100_000).describe('Shell command to execute in the current task workspace'),
  timeout: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional().describe('Timeout in milliseconds'),
  description: z.string().max(240).optional().describe('Short description of the command'),
})

type Output = {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
}

const LOCAL_READ_COMMANDS = new Set(['pwd', 'ls', 'tree', 'du', 'wc', 'stat', 'file', 'cat', 'head', 'tail', 'grep', 'rg', 'sort', 'uniq', 'cut', 'tr', 'jq'])
const READ_ONLY_GIT_COMMANDS = new Set(['status', 'diff', 'log', 'show', 'rev-parse', 'ls-files', 'ls-tree'])

function isConservativeReadOnly(command: string): boolean {
  if (!command.trim() || /[>`]|\$\(|\n|\r/.test(command)) return false
  const parts = command.split(/&&|\|\||[;|]/).map(part => part.trim()).filter(Boolean)
  if (parts.length === 0) return false
  return parts.every(part => {
    const tokens = part.split(/\s+/)
    const executable = tokens[0]
    if (!executable || executable.includes('=')) return false
    if (executable === 'git') return Boolean(tokens[1] && READ_ONLY_GIT_COMMANDS.has(tokens[1]))
    if (!LOCAL_READ_COMMANDS.has(executable)) return false
    if (executable === 'rg' && tokens.some(token => token === '--pre' || token.startsWith('--pre='))) return false
    return true
  })
}

export const ProductBashTool = buildProductTool({
  name: 'Bash',
  maxResultSizeChars: 1_100_000,
  inputSchema,
  async description() { return 'Run one bounded shell command in the current task workspace' },
  async prompt() { return 'Run a shell command. Commands are cancelled with the Turn, have a finite timeout, and remain inside the frozen Turn sandbox.' },
  isReadOnly(input) { return isConservativeReadOnly(input.command) },
  isDestructive(input) { return !isConservativeReadOnly(input.command) },
  isConcurrencySafe() { return false },
  isOpenWorld(input) { return /(^|[;&|]\s*)(curl|wget|ssh|scp|sftp|nc|ncat|telnet)\b/.test(input.command) },
  interruptBehavior() { return 'cancel' },
  toAutoClassifierInput(input) { return input.command },
  async checkPermissions() {
    return { behavior: 'passthrough' as const, message: 'Shell execution requires Host authorization.' }
  },
  async call({ command, timeout }, context) {
    const envelope = getProductPermissionEnvelope()
    if (!envelope) throw new Error('PRODUCT_PERMISSION_ENVELOPE_MISSING')
    const result = await runProductShell({
      command,
      workDir: context.productPromptContext?.workspace ?? process.cwd(),
      timeoutMs: timeout ?? DEFAULT_TIMEOUT_MS,
      signal: context.abortController.signal,
      envelope,
    })
    return { data: result }
  },
  mapToolResultToToolResultBlockParam(result, toolUseID) {
    const sections = [
      `exit_code: ${result.exitCode}`,
      result.timedOut ? 'timed_out: true' : '',
      result.truncated ? 'output_truncated: true' : '',
      result.stdout ? `stdout:\n${result.stdout}` : '',
      result.stderr ? `stderr:\n${result.stderr}` : '',
    ].filter(Boolean)
    return {
      type: 'tool_result',
      tool_use_id: toolUseID,
      ...(result.exitCode !== 0 || result.timedOut ? { is_error: true } : {}),
      content: sections.join('\n'),
    }
  },
} satisfies ProductToolDef<typeof inputSchema, Output>)
