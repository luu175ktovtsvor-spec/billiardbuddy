import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { extractDescription, parseMarkdownDocument, stringArrayField, stringField } from '../commands/frontmatter'
import type { Tool } from '../tools/Tool'

export interface AgentDefinition {
  name: string
  description: string
  prompt: string
  tools?: string[]
  model?: string
  skills?: string[]
  memory?: boolean
  filePath: string
}

function safeName(value: string): string {
  return value.trim().replace(/\s+/g, '-').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
}

export async function loadAgentFile(filePath: string): Promise<AgentDefinition> {
  const raw = await readFile(filePath, 'utf8')
  const doc = parseMarkdownDocument(raw)
  const name = safeName(stringField(doc.frontmatter, 'name') ?? basename(filePath, '.md'))
  const description = stringField(doc.frontmatter, 'description') ?? extractDescription(doc.body) ?? name
  const memory = doc.frontmatter.memory === true || doc.frontmatter.memory === 'true'
  return {
    name,
    description,
    prompt: doc.body.trim(),
    tools: stringArrayField(doc.frontmatter, 'tools'),
    model: stringField(doc.frontmatter, 'model'),
    skills: stringArrayField(doc.frontmatter, 'skills'),
    memory,
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
  if (!agent.tools || agent.tools.length === 0 || agent.tools.includes('*')) return allTools
  const allowed = new Set(agent.tools)
  return allTools.filter(tool => allowed.has(tool.name))
}
