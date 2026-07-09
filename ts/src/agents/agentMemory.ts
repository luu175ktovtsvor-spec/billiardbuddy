import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getUserConfigHomeDir, MEMORY_DOT_DIR } from '../harness/memoryNames'
import { Workspace } from '../workspace/workspace'

export type AgentMemoryScope = 'user' | 'project' | 'local'

const MEMORY_FILE = 'MEMORY.md'
const SNAPSHOT_BASE = 'agent-memory-snapshots'
const SNAPSHOT_JSON = 'snapshot.json'
const SYNCED_JSON = '.snapshot-synced.json'
const VALID_SCOPES = new Set<AgentMemoryScope>(['user', 'project', 'local'])
const MAX_MEMORY_LINES = 200
const MAX_MEMORY_BYTES = 25_000

export function parseAgentMemoryScope(value: unknown): AgentMemoryScope | undefined {
  if (value === true || value === 'true') return 'user'
  if (typeof value !== 'string') return undefined
  const normalized = value.trim()
  return VALID_SCOPES.has(normalized as AgentMemoryScope) ? normalized as AgentMemoryScope : undefined
}

export function isAgentMemoryEnabled(value: unknown): value is AgentMemoryScope {
  return typeof value === 'string' && VALID_SCOPES.has(value as AgentMemoryScope)
}

function sanitizeAgentNameForPath(agentName: string): string {
  return agentName.trim().replace(/[:/\\]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
}

export function getAgentMemoryDir(agentName: string, scope: AgentMemoryScope, workspaceRoot: string): string {
  const dirName = sanitizeAgentNameForPath(agentName)
  // 白标:用户全局记忆走 memoryNames.getUserConfigHomeDir()(~/.billiardbuddy,env
  // BILLIARDBUDDY_CONFIG_DIR 可覆盖),绝不读 ~/.claude;项目级用 MEMORY_DOT_DIR(.billiardbuddy)。
  if (scope === 'project') return join(workspaceRoot, MEMORY_DOT_DIR, 'agent-memory', dirName)
  if (scope === 'local') return join(workspaceRoot, MEMORY_DOT_DIR, 'agent-memory-local', dirName)
  return join(getUserConfigHomeDir(), 'agent-memory', dirName)
}

export function getAgentMemoryEntrypoint(agentName: string, scope: AgentMemoryScope, workspaceRoot: string): string {
  return join(getAgentMemoryDir(agentName, scope, workspaceRoot), MEMORY_FILE)
}

export async function initializeAgentMemorySnapshot(agentName: string, scope: AgentMemoryScope, workspaceRoot: string): Promise<'none' | 'initialized' | 'updated_available'> {
  const snapshotMeta = await readSnapshotMeta(agentName, workspaceRoot)
  if (!snapshotMeta) return 'none'
  const memoryDir = getAgentMemoryDir(agentName, scope, workspaceRoot)
  if (!(await hasMarkdownFiles(memoryDir))) {
    await copySnapshotFiles(agentName, scope, workspaceRoot)
    await writeSyncedMeta(agentName, scope, workspaceRoot, snapshotMeta.updatedAt)
    return 'initialized'
  }
  const synced = await readSyncedMeta(agentName, scope, workspaceRoot)
  if (!synced || new Date(snapshotMeta.updatedAt) > new Date(synced.syncedFrom)) return 'updated_available'
  return 'none'
}

export async function replaceAgentMemoryFromSnapshot(agentName: string, scope: AgentMemoryScope, workspaceRoot: string): Promise<boolean> {
  const snapshotMeta = await readSnapshotMeta(agentName, workspaceRoot)
  if (!snapshotMeta) return false
  const memoryDir = getAgentMemoryDir(agentName, scope, workspaceRoot)
  try {
    const dirents = await readdir(memoryDir, { withFileTypes: true })
    await Promise.all(dirents
      .filter(dirent => dirent.isFile() && dirent.name.endsWith('.md'))
      .map(dirent => unlink(join(memoryDir, dirent.name)).catch(() => undefined)))
  } catch {
    // Directory may not exist yet.
  }
  await copySnapshotFiles(agentName, scope, workspaceRoot)
  await writeSyncedMeta(agentName, scope, workspaceRoot, snapshotMeta.updatedAt)
  return true
}

export async function buildAgentMemoryPrompt(agentName: string, scope: AgentMemoryScope, workspaceRoot: string): Promise<string> {
  const memoryDir = getAgentMemoryDir(agentName, scope, workspaceRoot)
  await mkdir(memoryDir, { recursive: true }).catch(() => undefined)
  if (scope === 'user') await initializeAgentMemorySnapshot(agentName, scope, workspaceRoot).catch(() => 'none')
  const entrypoint = await readMemoryEntrypoint(memoryDir)
  const scopeNote = scopeGuidance(scope)
  return [
    '# Persistent Agent Memory',
    '',
    `You have a persistent, file-based memory system for this subagent at: \`${memoryDir}\``,
    '',
    scopeNote,
    '- Use this memory for durable facts, preferences, decisions, and operating notes that will help this same agent in future runs.',
    '- Do not save secrets, credentials, private keys, or information that can be derived directly from the current repository state.',
    `- The directory already exists. Read and write memory files directly with read_file, write_file, and edit_file. The main index is \`${join(memoryDir, MEMORY_FILE)}\`.`,
    '- Keep entries concise, current, and semantically organized. Update or remove stale memories instead of duplicating them.',
    '',
    `## ${MEMORY_FILE}`,
    '',
    entrypoint.trim()
      ? truncateMemoryEntrypoint(entrypoint)
      : `Your ${MEMORY_FILE} is currently empty. When you save new memories, they will appear here.`,
  ].join('\n')
}

export function workspaceWithAgentMemory(ctxWorkspace: Workspace, agentName: string, scope?: AgentMemoryScope): Workspace {
  if (!scope) return ctxWorkspace
  const memoryDir = getAgentMemoryDir(agentName, scope, ctxWorkspace.root)
  return ctxWorkspace.withAllowedPaths([memoryDir])
}

interface SnapshotMeta {
  updatedAt: string
}

interface SyncedMeta {
  syncedFrom: string
}

async function readSnapshotMeta(agentName: string, workspaceRoot: string): Promise<SnapshotMeta | null> {
  const parsed = await readJson(join(snapshotDir(agentName, workspaceRoot), SNAPSHOT_JSON))
  if (!parsed || typeof parsed.updatedAt !== 'string' || !parsed.updatedAt.trim()) return null
  return { updatedAt: parsed.updatedAt.trim() }
}

async function readSyncedMeta(agentName: string, scope: AgentMemoryScope, workspaceRoot: string): Promise<SyncedMeta | null> {
  const parsed = await readJson(join(getAgentMemoryDir(agentName, scope, workspaceRoot), SYNCED_JSON))
  if (!parsed || typeof parsed.syncedFrom !== 'string' || !parsed.syncedFrom.trim()) return null
  return { syncedFrom: parsed.syncedFrom.trim() }
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

async function hasMarkdownFiles(dir: string): Promise<boolean> {
  try {
    const dirents = await readdir(dir, { withFileTypes: true })
    return dirents.some(dirent => dirent.isFile() && dirent.name.endsWith('.md'))
  } catch {
    return false
  }
}

async function copySnapshotFiles(agentName: string, scope: AgentMemoryScope, workspaceRoot: string): Promise<void> {
  const sourceDir = snapshotDir(agentName, workspaceRoot)
  const targetDir = getAgentMemoryDir(agentName, scope, workspaceRoot)
  await mkdir(targetDir, { recursive: true })
  const dirents = await readdir(sourceDir, { withFileTypes: true }).catch(() => [])
  for (const dirent of dirents) {
    if (!dirent.isFile() || dirent.name === SNAPSHOT_JSON) continue
    const content = await readFile(join(sourceDir, dirent.name), 'utf8')
    await writeFile(join(targetDir, dirent.name), content, 'utf8')
  }
}

async function writeSyncedMeta(agentName: string, scope: AgentMemoryScope, workspaceRoot: string, snapshotTimestamp: string): Promise<void> {
  const memoryDir = getAgentMemoryDir(agentName, scope, workspaceRoot)
  await mkdir(memoryDir, { recursive: true })
  await writeFile(join(memoryDir, SYNCED_JSON), JSON.stringify({ syncedFrom: snapshotTimestamp }, null, 2), 'utf8')
}

async function readMemoryEntrypoint(memoryDir: string): Promise<string> {
  const path = join(memoryDir, MEMORY_FILE)
  try {
    const info = await stat(path)
    if (!info.isFile()) return ''
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

function snapshotDir(agentName: string, workspaceRoot: string): string {
  return join(workspaceRoot, MEMORY_DOT_DIR, SNAPSHOT_BASE, sanitizeAgentNameForPath(agentName))
}

function scopeGuidance(scope: AgentMemoryScope): string {
  if (scope === 'user') return '- Since this memory is user-scope, keep learnings general because they apply across all projects.'
  if (scope === 'project') return '- Since this memory is project-scope and may be shared by version control, tailor memories to this project.'
  return '- Since this memory is local-scope and not checked into version control, tailor memories to this project and machine.'
}

function truncateMemoryEntrypoint(raw: string): string {
  const trimmed = raw.trim()
  const lines = trimmed.split('\n')
  const lineTruncated = lines.length > MAX_MEMORY_LINES
  const byteTruncated = Buffer.byteLength(trimmed, 'utf8') > MAX_MEMORY_BYTES
  if (!lineTruncated && !byteTruncated) return trimmed

  let truncated = lineTruncated ? lines.slice(0, MAX_MEMORY_LINES).join('\n') : trimmed
  if (Buffer.byteLength(truncated, 'utf8') > MAX_MEMORY_BYTES) {
    truncated = Buffer.from(truncated, 'utf8').subarray(0, MAX_MEMORY_BYTES).toString('utf8')
    const lastNewline = truncated.lastIndexOf('\n')
    if (lastNewline > 0) truncated = truncated.slice(0, lastNewline)
  }
  return `${truncated.trimEnd()}\n\n> WARNING: ${MEMORY_FILE} was truncated before loading. Keep index entries concise and move detail into topic files.`
}
