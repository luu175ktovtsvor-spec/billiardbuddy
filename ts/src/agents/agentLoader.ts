import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { extractDescription, parseMarkdownDocument, stringArrayField, stringField } from '../commands/frontmatter'
import type { Tool } from '../tools/Tool'
import type { PermissionMode } from '../permissions/types'

export type AgentMcpServerSpec = string | Record<string, unknown>

export interface AgentDefinition {
  name: string
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: string
  skills?: string[]
  memory?: boolean
  permissionMode?: PermissionMode
  maxTurns?: number
  initialPrompt?: string
  background?: boolean
  isolation?: 'worktree'
  mcpServers?: AgentMcpServerSpec[]
  requiredMcpServers?: string[]
  filePath: string
}

function safeName(value: string): string {
  return value.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

function parseTools(frontmatter: Record<string, unknown>, key: string): string[] | undefined {
  const tools = stringArrayField(frontmatter, key)
  if (!tools) return undefined
  return tools.includes('*') ? undefined : tools
}

function booleanField(frontmatter: Record<string, unknown>, key: string): boolean | undefined {
  const value = frontmatter[key]
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return undefined
}

function positiveIntField(frontmatter: Record<string, unknown>, key: string): number | undefined {
  const value = frontmatter[key]
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : NaN
  if (!Number.isInteger(n) || n <= 0) return undefined
  return n
}

function permissionModeField(frontmatter: Record<string, unknown>): PermissionMode | undefined {
  const value = stringField(frontmatter, 'permissionMode')
  if (value === 'ask' || value === 'auto_files' || value === 'full' || value === 'plan' || value === 'bypassPermissions') return value
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function mcpServersField(frontmatter: Record<string, unknown>): AgentMcpServerSpec[] | undefined {
  const value = frontmatter.mcpServers
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string' && value.trim()
      ? value.split(',').map(item => item.trim()).filter(Boolean)
      : []
  const specs = values
    .map(item => {
      if (typeof item === 'string' && item.trim()) return item.trim()
      if (isRecord(item)) return item
      return null
    })
    .filter((item): item is AgentMcpServerSpec => item !== null)
  return specs.length > 0 ? specs : undefined
}

export async function loadAgentFile(filePath: string): Promise<AgentDefinition> {
  const raw = await readFile(filePath, 'utf8')
  const doc = parseMarkdownDocument(raw)
  const name = safeName(stringField(doc.frontmatter, 'name') ?? basename(filePath, '.md'))
  const description = stringField(doc.frontmatter, 'description') ?? extractDescription(doc.body) ?? name
  const memory = doc.frontmatter.memory === true || doc.frontmatter.memory === 'true'
  const isolation = stringField(doc.frontmatter, 'isolation') === 'worktree' ? 'worktree' : undefined
  return {
    name,
    description,
    prompt: doc.body.trim(),
    tools: parseTools(doc.frontmatter, 'tools'),
    disallowedTools: parseTools(doc.frontmatter, 'disallowedTools'),
    model: stringField(doc.frontmatter, 'model'),
    skills: stringArrayField(doc.frontmatter, 'skills'),
    memory,
    permissionMode: permissionModeField(doc.frontmatter),
    maxTurns: positiveIntField(doc.frontmatter, 'maxTurns'),
    initialPrompt: stringField(doc.frontmatter, 'initialPrompt'),
    background: booleanField(doc.frontmatter, 'background'),
    ...(isolation ? { isolation } : {}),
    mcpServers: mcpServersField(doc.frontmatter),
    requiredMcpServers: stringArrayField(doc.frontmatter, 'requiredMcpServers') ?? stringArrayField(doc.frontmatter, 'required_mcp_servers'),
    filePath,
  }
}

export async function loadAgentsDir(rootDir: string): Promise<AgentDefinition[]> {
  let entries: string[] = []
  try {
    entries = await readdir(rootDir)
  } catch {
    return []
  }

  const agents: AgentDefinition[] = []
  for (const entry of entries.sort()) {
    if (entry.startsWith('.') || !entry.endsWith('.md')) continue
    const filePath = join(rootDir, entry)
    try {
      const s = await stat(filePath)
      if (s.isFile()) agents.push(await loadAgentFile(filePath))
    } catch {
      continue
    }
  }
  return agents
}

export function resolveAgentTools(agent: AgentDefinition, allTools: Tool[]): Tool[] {
  const allowed = !agent.tools || agent.tools.length === 0 ? null : new Set(agent.tools)
  const disallowed = new Set(agent.disallowedTools ?? [])
  return allTools.filter(tool => (!allowed || allowed.has(tool.name)) && !disallowed.has(tool.name))
}
