import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseDocument } from 'yaml'
import type { ProductCommand } from './productTool.js'

const MAX_COMMANDS = 256
const MAX_COMMAND_BYTES = 512 * 1024
const SAFE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9:_-]{0,127}$/

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function split(source: string): { metadata: Record<string, unknown>; body: string } | null {
  const normalized = source.replaceAll('\r\n', '\n')
  if (!normalized.startsWith('---\n')) return null
  const end = normalized.indexOf('\n---\n', 4)
  if (end < 0) return null
  const document = parseDocument(normalized.slice(4, end), { prettyErrors: false, strict: true })
  if (document.errors.length) return null
  const metadata = document.toJS({ maxAliasCount: 0 })
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  return { metadata: metadata as Record<string, unknown>, body: normalized.slice(end + 5).trim() }
}

function stringList(value: unknown, pattern: RegExp): string[] {
  const source = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
  return source.map(item => String(item).trim()).filter(item => pattern.test(item)).slice(0, 128)
}

export async function loadProductPluginCommands(directory: string, pluginRoot: string, namespace: string): Promise<ProductCommand[]> {
  let root: string
  let boundary: string
  try { root = await fs.realpath(directory); boundary = await fs.realpath(pluginRoot) } catch { return [] }
  if (!isWithinRoot(boundary, root)) return []
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const output: ProductCommand[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (output.length >= MAX_COMMANDS || !entry.isFile() || entry.isSymbolicLink() || !entry.name.toLowerCase().endsWith('.md')) continue
    const file = path.join(root, entry.name)
    const stat = await fs.lstat(file).catch(() => undefined)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_COMMAND_BYTES) continue
    const canonical = await fs.realpath(file).catch(() => '')
    if (!canonical || !isWithinRoot(root, canonical)) continue
    const parsed = split(await fs.readFile(canonical, 'utf8'))
    if (!parsed?.body) continue
    const rawName = typeof parsed.metadata.name === 'string' ? parsed.metadata.name.trim() : path.basename(entry.name, path.extname(entry.name))
    const description = typeof parsed.metadata.description === 'string' ? parsed.metadata.description.trim() : ''
    if (!SAFE_NAME.test(rawName) || !description || description.length > 2_000) continue
    const allowedTools = stringList(parsed.metadata['allowed-tools'] ?? parsed.metadata.allowedTools, SAFE_TOOL_NAME)
    const aliases = stringList(parsed.metadata.aliases, SAFE_NAME).map(alias => `${namespace}:${alias}`)
    const argumentHint = typeof parsed.metadata['argument-hint'] === 'string' ? parsed.metadata['argument-hint'].slice(0, 240) : undefined
    const body = parsed.body
    output.push({
      type: 'prompt',
      name: `${namespace}:${rawName}`,
      ...(aliases.length ? { aliases } : {}),
      description,
      ...(allowedTools.length ? { allowedTools } : {}),
      ...(argumentHint ? { argumentHint } : {}),
      userInvocable: parsed.metadata['user-invocable'] !== false,
      disableModelInvocation: parsed.metadata['disable-model-invocation'] === true,
      source: 'plugin',
      loadedFrom: 'plugin',
      contentLength: body.length,
      progressMessage: 'running',
      async getPromptForCommand(args) {
        return [{ type: 'text', text: body.replaceAll('$ARGUMENTS', args) + (args && !body.includes('$ARGUMENTS') ? `\n\n## Arguments\n\n${args}` : '') }]
      },
    })
  }
  return output
}
