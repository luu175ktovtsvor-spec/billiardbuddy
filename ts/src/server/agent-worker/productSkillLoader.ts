import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { parseDocument } from 'yaml'
import type { ProductCommand } from './productTool.js'

const MAX_SKILLS = 256
const MAX_SKILL_BYTES = 512 * 1024
const SAFE_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/
const SAFE_TOOL_NAME = /^[A-Za-z][A-Za-z0-9:_-]{0,127}$/

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function strings(value: unknown, pattern: RegExp): string[] {
  const source = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : []
  return source.map(item => String(item).trim()).filter(item => pattern.test(item)).slice(0, 128)
}

function splitSkill(source: string): { metadata: Record<string, unknown>; body: string } | null {
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

async function loadSkill(skillDirectory: string, allowedRoot: string, namespace?: string): Promise<ProductCommand | null> {
  let directory: string
  try {
    directory = await fs.realpath(skillDirectory)
  } catch {
    return null
  }
  if (!isWithinRoot(allowedRoot, directory)) return null
  const file = path.join(directory, 'SKILL.md')
  const stat = await fs.lstat(file).catch(() => undefined)
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > MAX_SKILL_BYTES) return null
  const canonicalFile = await fs.realpath(file)
  if (!isWithinRoot(directory, canonicalFile)) return null
  const parsed = splitSkill(await fs.readFile(canonicalFile, 'utf8'))
  if (!parsed?.body) return null
  const rawName = typeof parsed.metadata.name === 'string' ? parsed.metadata.name.trim() : path.basename(directory)
  const description = typeof parsed.metadata.description === 'string' ? parsed.metadata.description.trim() : ''
  if (!SAFE_SKILL_NAME.test(rawName) || !description || description.length > 2_000) return null
  const name = namespace ? `${namespace}:${rawName}` : rawName
  const allowedTools = strings(parsed.metadata['allowed-tools'] ?? parsed.metadata.allowedTools, SAFE_TOOL_NAME)
  const aliases = strings(parsed.metadata.aliases, SAFE_SKILL_NAME).map(alias => namespace ? `${namespace}:${alias}` : alias)
  const argumentHint = typeof parsed.metadata['argument-hint'] === 'string' ? parsed.metadata['argument-hint'].slice(0, 240) : undefined
  const whenToUse = typeof parsed.metadata.when_to_use === 'string' ? parsed.metadata.when_to_use.slice(0, 2_000) : undefined
  const userInvocable = parsed.metadata['user-invocable'] !== false
  const disableModelInvocation = parsed.metadata['disable-model-invocation'] === true
  const body = parsed.body
  return {
    type: 'prompt',
    name,
    ...(aliases.length ? { aliases } : {}),
    description,
    allowedTools,
    ...(argumentHint ? { argumentHint } : {}),
    ...(whenToUse ? { whenToUse } : {}),
    userInvocable,
    disableModelInvocation,
    contentLength: body.length,
    source: namespace ? 'plugin' : 'project',
    loadedFrom: namespace ? 'plugin' : 'skills',
    progressMessage: 'running',
    async getPromptForCommand(args) {
      const expanded = body.replaceAll('$ARGUMENTS', args)
      return [{
        type: 'text',
        text: `Base directory for this skill: ${directory}\n\n${expanded}${args && !body.includes('$ARGUMENTS') ? `\n\n## Arguments\n\n${args}` : ''}`,
      }]
    },
  }
}

/** Load a bounded, canonical set of directory-format Skills. */
export async function loadProductSkillCommandsFromDirectory(directory: string, allowedRoot: string, namespace?: string): Promise<ProductCommand[]> {
  let root: string
  let boundary: string
  try {
    root = await fs.realpath(directory)
    boundary = await fs.realpath(allowedRoot)
  } catch {
    return []
  }
  if (!isWithinRoot(boundary, root)) return []
  const candidates = [root]
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (candidates.length >= MAX_SKILLS) break
    if (entry.isDirectory() && !entry.isSymbolicLink()) candidates.push(path.join(root, entry.name))
  }
  const loaded = await Promise.all(candidates.map(candidate => loadSkill(candidate, boundary, namespace)))
  return loaded.filter((command): command is ProductCommand => command !== null)
}
