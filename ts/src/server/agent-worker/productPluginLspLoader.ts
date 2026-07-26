import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { z } from 'zod/v4'
import { getProductPermissionEnvelope } from '../../utils/permissions/productPermissionRuntime.js'
import type { ProductPluginLspServerConfig } from '../services/productPluginRegistry.js'
import { buildProductTool, type ProductTool } from './productTool.js'
import { runProductShell } from './productSandboxRunner.js'

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_RESULT_CHARS = 500_000
const LSP_TIMEOUT_MS = 45_000

type LspOperation = 'hover' | 'definition' | 'references' | 'documentSymbols' | 'diagnostics'

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function shellArg(value: string): string {
  if (process.platform === 'win32') return `"${value.replaceAll('"', '""')}"`
  return `'${value.replaceAll("'", "'\"'\"'")}'`
}

function packet(value: unknown): string {
  const json = JSON.stringify(value)
  return `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`
}

function responses(stdout: string): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = []
  const bytes = Buffer.from(stdout, 'utf8')
  const marker = Buffer.from('Content-Length:', 'ascii')
  const separator = Buffer.from('\r\n\r\n', 'ascii')
  let offset = 0
  while (offset < bytes.length) {
    const header = bytes.indexOf(marker, offset)
    if (header < 0) break
    const boundary = bytes.indexOf(separator, header)
    if (boundary < 0) break
    const length = Number(bytes.subarray(header + marker.length, boundary).toString('ascii').trim().split(/\s+/)[0])
    if (!Number.isInteger(length) || length < 0 || length > MAX_RESULT_CHARS) throw new Error('PLUGIN_LSP_PROTOCOL_INVALID')
    const start = boundary + 4
    const end = start + length
    if (end > bytes.length) throw new Error('PLUGIN_LSP_PROTOCOL_INVALID')
    const body = bytes.subarray(start, end).toString('utf8')
    let parsed: unknown
    try { parsed = JSON.parse(body) } catch { throw new Error('PLUGIN_LSP_PROTOCOL_INVALID') }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) output.push(parsed as Record<string, unknown>)
    offset = end
  }
  return output
}

function method(operation: LspOperation): string {
  if (operation === 'documentSymbols') return 'textDocument/documentSymbol'
  if (operation === 'diagnostics') return 'textDocument/diagnostic'
  return `textDocument/${operation}`
}

function languageId(config: ProductPluginLspServerConfig, file: string): string {
  const extension = path.extname(file).replace(/^\./, '')
  return config.extensionToLanguage?.[extension]
    ?? config.extensionToLanguage?.[`.${extension}`]
    ?? extension
    ?? 'plaintext'
}

const inputSchema = z.strictObject({
  operation: z.enum(['hover', 'definition', 'references', 'documentSymbols', 'diagnostics']),
  file_path: z.string().min(1).max(8_192).describe('Workspace-relative source file'),
  line: z.number().int().min(0).max(10_000_000).optional().describe('Zero-based line for position operations'),
  character: z.number().int().min(0).max(10_000_000).optional().describe('Zero-based UTF-16 character for position operations'),
})

export function createProductPluginLspTool(input: { plugin: string; name: string; config: ProductPluginLspServerConfig }): ProductTool {
  const normalized = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').slice(0, 64)
  const toolName = `lsp__${normalized(input.plugin)}__${normalized(input.name)}`
  return buildProductTool({
    name: toolName,
    inputSchema,
    maxResultSizeChars: MAX_RESULT_CHARS,
    async description() { return `Query the ${input.plugin}:${input.name} language server for hover, definitions, references, symbols, or diagnostics.` },
    async prompt() { return `Use ${toolName} for semantic source-code queries when text search is insufficient.` },
    isReadOnly() { return true },
    isConcurrencySafe() { return false },
    isOpenWorld() { return false },
    userFacingName() { return `${input.plugin}:${input.name} LSP` },
    toAutoClassifierInput(value) { return value },
    async call(value, context) {
      const workspace = context.productPromptContext?.workspace
      if (!workspace || !path.isAbsolute(workspace)) throw new Error('PRODUCT_WORKSPACE_MISSING')
      const root = await fs.realpath(workspace)
      const candidate = path.resolve(root, value.file_path)
      if (!inside(root, candidate)) throw new Error('PRODUCT_PATH_OUTSIDE_WORKSPACE')
      const target = await fs.realpath(candidate)
      if (!inside(root, target)) throw new Error('PRODUCT_PATH_OUTSIDE_WORKSPACE')
      const stat = await fs.stat(target)
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error('PLUGIN_LSP_FILE_UNAVAILABLE')
      const source = await fs.readFile(target, 'utf8')
      if (source.includes('\0')) throw new Error('PLUGIN_LSP_FILE_UNAVAILABLE')
      const uri = pathToFileURL(target).toString()
      const position = { line: value.line ?? 0, character: value.character ?? 0 }
      const params = value.operation === 'documentSymbols' || value.operation === 'diagnostics'
        ? { textDocument: { uri } }
        : value.operation === 'references'
          ? { textDocument: { uri }, position, context: { includeDeclaration: true } }
          : { textDocument: { uri }, position }
      const messages = [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { processId: process.pid, rootUri: pathToFileURL(root).toString(), capabilities: { textDocument: { diagnostic: { dynamicRegistration: false } } }, workspaceFolders: [{ uri: pathToFileURL(root).toString(), name: path.basename(root) }] } },
        { jsonrpc: '2.0', method: 'initialized', params: {} },
        { jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: languageId(input.config, target), version: 1, text: source } } },
        { jsonrpc: '2.0', id: 2, method: method(value.operation), params },
        { jsonrpc: '2.0', id: 3, method: 'shutdown', params: null },
        { jsonrpc: '2.0', method: 'exit', params: null },
      ]
      const envelope = getProductPermissionEnvelope()
      if (!envelope) throw new Error('PRODUCT_PERMISSION_ENVELOPE_MISSING')
      const result = await runProductShell({
        command: [input.config.command, ...(input.config.args ?? [])].map(shellArg).join(' '),
        workDir: root,
        timeoutMs: LSP_TIMEOUT_MS,
        signal: context.abortController.signal,
        envelope,
        stdin: messages.map(packet).join(''),
        env: input.config.env,
      })
      if (result.timedOut) throw new Error('PLUGIN_LSP_TIMEOUT')
      const response = responses(result.stdout).find(item => item.id === 2)
      if (!response) throw new Error('PLUGIN_LSP_RESPONSE_MISSING')
      if (response.error) throw new Error(`PLUGIN_LSP_REQUEST_FAILED:${JSON.stringify(response.error).slice(0, 2_000)}`)
      return { data: JSON.stringify(response.result ?? null, null, 2).slice(0, MAX_RESULT_CHARS) }
    },
    mapToolResultToToolResultBlockParam(content, toolUseID) { return { type: 'tool_result', tool_use_id: toolUseID, content } },
    renderToolUseMessage() { return null },
    renderToolUseProgressMessage() { return null },
    renderToolUseQueuedMessage() { return null },
    renderToolUseRejectedMessage() { return null },
    renderToolResultMessage() { return null },
    renderToolUseErrorMessage() { return null },
  })
}
