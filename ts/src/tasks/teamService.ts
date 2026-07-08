import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const TEAM_LEAD_NAME = 'team-lead'
export const TEAMMATE_MESSAGE_TAG = 'teammate-message'

const LOCK_RETRIES = 20
const LOCK_MIN_DELAY_MS = 5
const LOCK_MAX_DELAY_MS = 100
const STALE_LOCK_MS = 30_000

export type BackendType = 'in-process' | 'tmux' | 'iterm' | 'local' | string

export interface TeamAllowedPath {
  path: string
  toolName: string
  addedBy: string
  addedAt: number
}

export interface TeamMember {
  agentId: string
  name: string
  agentType?: string
  model?: string
  prompt?: string
  color?: string
  planModeRequired?: boolean
  joinedAt: number
  tmuxPaneId: string
  cwd: string
  worktreePath?: string
  sessionId?: string
  subscriptions: string[]
  backendType?: BackendType
  isActive?: boolean
  mode?: string
}

export interface TeamFile {
  name: string
  description?: string
  createdAt: number
  leadAgentId: string
  leadSessionId?: string
  hiddenPaneIds?: string[]
  teamAllowedPaths?: TeamAllowedPath[]
  members: TeamMember[]
}

export interface ActiveTeam {
  teamName: string
  teamFilePath: string
  leadAgentId: string
  conversationId?: string
  updatedAt: string
}

export interface TeammateMessage {
  from: string
  text: string
  timestamp: string
  read: boolean
  color?: string
  summary?: string
}

export interface PeerInfo {
  agentId: string
  name: string
  agentType?: string
  color?: string
  cwd: string
  worktreePath?: string
  sessionId?: string
  tmuxPaneId?: string
  backendType?: BackendType
  isActive: boolean
  isLead: boolean
  unreadMessages: number
  subscriptions: string[]
  joinedAt: number
  mode?: string
}

export interface PeerListInfo {
  teamName?: string
  teamFilePath?: string
  leadAgentId?: string
  leadSessionId?: string
  description?: string
  createdAt?: number
  isActiveTeam: boolean
  peers: PeerInfo[]
}

export interface TeamInboxContextOptions {
  agentName?: string
  teamName?: string
  markRead?: boolean
}

function nowIso(): string {
  return new Date().toISOString()
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function xmlAttr(value: string): string {
  return xmlText(value).replaceAll('"', '&quot;')
}

export function sanitizeName(name: string): string {
  const cleaned = name.trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').toLowerCase()
  return cleaned || 'team'
}

export function sanitizeAgentName(name: string): string {
  return name.trim().replace(/@/g, '-')
}

export function formatAgentId(agentName: string, teamName: string): string {
  return `${sanitizeAgentName(agentName)}@${teamName}`
}

export function generateRequestId(prefix: string, target: string): string {
  return `${sanitizeName(prefix)}-${sanitizeName(target)}-${randomUUID().slice(0, 8)}`
}

export function isStructuredProtocolMessage(messageText: string): boolean {
  try {
    const parsed = JSON.parse(messageText) as unknown
    if (!isRecord(parsed) || typeof parsed.type !== 'string') return false
    return [
      'permission_request',
      'permission_response',
      'sandbox_permission_request',
      'sandbox_permission_response',
      'shutdown_request',
      'shutdown_approved',
      'team_permission_update',
      'mode_set_request',
      'plan_approval_request',
      'plan_approval_response',
    ].includes(parsed.type)
  } catch {
    return false
  }
}

export function formatTeammateMessages(messages: Array<Pick<TeammateMessage, 'from' | 'text' | 'color' | 'summary'>>): string {
  return messages.map(message => {
    const colorAttr = message.color ? ` color="${xmlAttr(message.color)}"` : ''
    const summaryAttr = message.summary ? ` summary="${xmlAttr(message.summary)}"` : ''
    return `<${TEAMMATE_MESSAGE_TAG} teammate_id="${xmlAttr(message.from)}"${colorAttr}${summaryAttr}>\n${xmlText(message.text)}\n</${TEAMMATE_MESSAGE_TAG}>`
  }).join('\n\n')
}

function normalizeMember(raw: unknown): TeamMember | null {
  if (!isRecord(raw)) return null
  if (typeof raw.agentId !== 'string' || !raw.agentId.trim()) return null
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null
  return {
    agentId: raw.agentId.trim(),
    name: raw.name.trim(),
    agentType: typeof raw.agentType === 'string' ? raw.agentType : undefined,
    model: typeof raw.model === 'string' ? raw.model : undefined,
    prompt: typeof raw.prompt === 'string' ? raw.prompt : undefined,
    color: typeof raw.color === 'string' ? raw.color : undefined,
    planModeRequired: typeof raw.planModeRequired === 'boolean' ? raw.planModeRequired : undefined,
    joinedAt: typeof raw.joinedAt === 'number' ? raw.joinedAt : Date.now(),
    tmuxPaneId: typeof raw.tmuxPaneId === 'string' ? raw.tmuxPaneId : '',
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    worktreePath: typeof raw.worktreePath === 'string' ? raw.worktreePath : undefined,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : undefined,
    subscriptions: Array.isArray(raw.subscriptions) ? raw.subscriptions.filter((item): item is string => typeof item === 'string') : [],
    backendType: typeof raw.backendType === 'string' ? raw.backendType : undefined,
    isActive: typeof raw.isActive === 'boolean' ? raw.isActive : undefined,
    mode: typeof raw.mode === 'string' ? raw.mode : undefined,
  }
}

function normalizeTeamFile(raw: unknown): TeamFile | null {
  if (!isRecord(raw)) return null
  if (typeof raw.name !== 'string' || !raw.name.trim()) return null
  if (typeof raw.leadAgentId !== 'string' || !raw.leadAgentId.trim()) return null
  const members = Array.isArray(raw.members) ? raw.members.map(normalizeMember).filter((member): member is TeamMember => !!member) : []
  return {
    name: raw.name.trim(),
    description: typeof raw.description === 'string' ? raw.description : undefined,
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
    leadAgentId: raw.leadAgentId.trim(),
    leadSessionId: typeof raw.leadSessionId === 'string' ? raw.leadSessionId : undefined,
    hiddenPaneIds: Array.isArray(raw.hiddenPaneIds) ? raw.hiddenPaneIds.filter((item): item is string => typeof item === 'string') : undefined,
    teamAllowedPaths: Array.isArray(raw.teamAllowedPaths) ? raw.teamAllowedPaths.filter(isRecord).map(item => ({
      path: typeof item.path === 'string' ? item.path : '',
      toolName: typeof item.toolName === 'string' ? item.toolName : '',
      addedBy: typeof item.addedBy === 'string' ? item.addedBy : '',
      addedAt: typeof item.addedAt === 'number' ? item.addedAt : Date.now(),
    })).filter(item => item.path && item.toolName && item.addedBy) : undefined,
    members,
  }
}

function normalizeMessages(raw: unknown): TeammateMessage[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(isRecord).map(item => ({
    from: typeof item.from === 'string' ? item.from : 'unknown',
    text: typeof item.text === 'string' ? item.text : JSON.stringify(item.text ?? ''),
    timestamp: typeof item.timestamp === 'string' ? item.timestamp : nowIso(),
    read: typeof item.read === 'boolean' ? item.read : false,
    color: typeof item.color === 'string' ? item.color : undefined,
    summary: typeof item.summary === 'string' ? item.summary : undefined,
  }))
}

function normalizeActiveTeam(raw: unknown): ActiveTeam | null {
  if (!isRecord(raw)) return null
  if (typeof raw.teamName !== 'string' || !raw.teamName.trim()) return null
  if (typeof raw.teamFilePath !== 'string' || !raw.teamFilePath.trim()) return null
  if (typeof raw.leadAgentId !== 'string' || !raw.leadAgentId.trim()) return null
  return {
    teamName: raw.teamName.trim(),
    teamFilePath: raw.teamFilePath.trim(),
    leadAgentId: raw.leadAgentId.trim(),
    conversationId: typeof raw.conversationId === 'string' ? raw.conversationId : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : nowIso(),
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tmp, path)
}

export class TeamService {
  private readonly teamsRoot: string
  private readonly activeTeamPath: string
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(private readonly stateRoot: string) {
    this.teamsRoot = join(stateRoot, 'teams')
    this.activeTeamPath = join(this.teamsRoot, 'active-team.json')
  }

  get root(): string {
    return this.teamsRoot
  }

  teamDir(teamName: string): string {
    return join(this.teamsRoot, sanitizeName(teamName))
  }

  teamFilePath(teamName: string): string {
    return join(this.teamDir(teamName), 'config.json')
  }

  inboxPath(agentName: string, teamName: string): string {
    return join(this.teamDir(teamName), 'inboxes', `${sanitizeName(agentName)}.json`)
  }

  async getActiveTeam(): Promise<ActiveTeam | null> {
    try {
      const active = normalizeActiveTeam(await readJson(this.activeTeamPath))
      if (!active) return null
      if (await this.readTeam(active.teamName)) return active
      await this.clearActiveTeam()
      return null
    } catch {
      return null
    }
  }

  async clearActiveTeam(): Promise<void> {
    await rm(this.activeTeamPath, { force: true }).catch(() => undefined)
  }

  async readTeam(teamName: string): Promise<TeamFile | null> {
    try {
      return normalizeTeamFile(await readJson(this.teamFilePath(teamName)))
    } catch {
      return null
    }
  }

  async writeTeam(teamName: string, teamFile: TeamFile): Promise<void> {
    await this.withFileLock(this.teamFilePath(teamName), async () => {
      await writeJson(this.teamFilePath(teamName), teamFile)
    })
  }

  async mutateTeam(teamName: string, mutator: (teamFile: TeamFile) => void | TeamFile | Promise<void | TeamFile>): Promise<TeamFile> {
    return this.withFileLock(this.teamFilePath(teamName), async () => {
      const current = await this.readTeam(teamName)
      if (!current) throw new Error(`Team "${teamName}" does not exist`)
      const next = await mutator(current) ?? current
      await writeJson(this.teamFilePath(teamName), next)
      return next
    })
  }

  async createTeam(input: { teamName: string; description?: string; agentType?: string; cwd: string; conversationId?: string }): Promise<ActiveTeam> {
    const existing = await this.getActiveTeam()
    if (existing) {
      throw new Error(`Already leading team "${existing.teamName}". Use TeamDelete to end the current team before creating a new one.`)
    }

    const finalTeamName = await this.uniqueTeamName(input.teamName)
    const leadAgentId = formatAgentId(TEAM_LEAD_NAME, finalTeamName)
    const createdAt = Date.now()
    const teamFile: TeamFile = {
      name: finalTeamName,
      description: input.description,
      createdAt,
      leadAgentId,
      leadSessionId: input.conversationId,
      members: [
        {
          agentId: leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: input.agentType || TEAM_LEAD_NAME,
          joinedAt: createdAt,
          tmuxPaneId: '',
          cwd: input.cwd,
          subscriptions: [],
          isActive: true,
        },
      ],
    }
    await this.writeTeam(finalTeamName, teamFile)

    const active: ActiveTeam = {
      teamName: finalTeamName,
      teamFilePath: this.teamFilePath(finalTeamName),
      leadAgentId,
      conversationId: input.conversationId,
      updatedAt: nowIso(),
    }
    await writeJson(this.activeTeamPath, active)
    return active
  }

  async deleteActiveTeam(): Promise<{ success: boolean; message: string; teamName?: string }> {
    const active = await this.getActiveTeam()
    if (!active) {
      await this.clearActiveTeam()
      return { success: true, message: 'No active team found, nothing to clean up' }
    }

    const team = await this.readTeam(active.teamName)
    if (team) {
      const activeMembers = team.members.filter(member => member.name !== TEAM_LEAD_NAME && member.isActive !== false)
      if (activeMembers.length > 0) {
        return {
          success: false,
          message: `Cannot cleanup team with ${activeMembers.length} active member(s): ${activeMembers.map(member => member.name).join(', ')}. Use SendMessage shutdown_request to gracefully terminate teammates first.`,
          teamName: active.teamName,
        }
      }
    }

    await rm(this.teamDir(active.teamName), { recursive: true, force: true })
    await this.clearActiveTeam()
    return {
      success: true,
      message: `Cleaned up team directory for team "${active.teamName}"`,
      teamName: active.teamName,
    }
  }

  async readMailbox(agentName: string, teamName: string): Promise<TeammateMessage[]> {
    try {
      return normalizeMessages(await readJson(this.inboxPath(agentName, teamName)))
    } catch {
      return []
    }
  }

  async readUnreadMessages(agentName: string, teamName: string): Promise<TeammateMessage[]> {
    return (await this.readMailbox(agentName, teamName)).filter(message => !message.read)
  }

  async writeToMailbox(recipientName: string, message: Omit<TeammateMessage, 'read'>, teamName: string): Promise<void> {
    const path = this.inboxPath(recipientName, teamName)
    await mkdir(dirname(path), { recursive: true })
    try {
      await writeFile(path, '[]', { encoding: 'utf8', flag: 'wx' })
    } catch (err) {
      if (!isNodeErrorCode(err, 'EEXIST')) throw err
    }
    await this.withFileLock(path, async () => {
      const messages = await this.readMailbox(recipientName, teamName)
      messages.push({ ...message, read: false })
      await writeJson(path, messages)
    })
  }

  async markMessagesAsRead(agentName: string, teamName: string): Promise<void> {
    const path = this.inboxPath(agentName, teamName)
    await this.withFileLock(path, async () => {
      const messages = await this.readMailbox(agentName, teamName)
      if (messages.length === 0) return
      await writeJson(path, messages.map(message => ({ ...message, read: true })))
    })
  }

  async markMessagesAsReadByPredicate(agentName: string, teamName: string, predicate: (message: TeammateMessage) => boolean): Promise<void> {
    const path = this.inboxPath(agentName, teamName)
    await this.withFileLock(path, async () => {
      const messages = await this.readMailbox(agentName, teamName)
      if (messages.length === 0) return
      const next = messages.map(message => !message.read && predicate(message) ? { ...message, read: true } : message)
      await writeJson(path, next)
    })
  }

  async clearMailbox(agentName: string, teamName: string): Promise<void> {
    const path = this.inboxPath(agentName, teamName)
    try {
      await writeFile(path, '[]', { encoding: 'utf8', flag: 'r+' })
    } catch (err) {
      if (!isNodeErrorCode(err, 'ENOENT')) throw err
    }
  }

  async listPeers(teamName?: string): Promise<PeerListInfo> {
    const active = await this.getActiveTeam()
    const resolvedTeamName = teamName ?? active?.teamName
    if (!resolvedTeamName) return { isActiveTeam: false, peers: [] }
    const team = await this.readTeam(resolvedTeamName)
    if (!team) return { teamName: resolvedTeamName, isActiveTeam: active?.teamName === resolvedTeamName, peers: [] }
    const peers: PeerInfo[] = []
    for (const member of team.members) {
      peers.push({
        agentId: member.agentId,
        name: member.name,
        agentType: member.agentType,
        color: member.color,
        cwd: member.cwd,
        worktreePath: member.worktreePath,
        sessionId: member.sessionId,
        tmuxPaneId: member.tmuxPaneId || undefined,
        backendType: member.backendType,
        isActive: member.isActive !== false,
        isLead: member.agentId === team.leadAgentId || member.name === TEAM_LEAD_NAME,
        unreadMessages: (await this.readUnreadMessages(member.name, resolvedTeamName)).length,
        subscriptions: member.subscriptions,
        joinedAt: member.joinedAt,
        mode: member.mode,
      })
    }
    return {
      teamName: resolvedTeamName,
      teamFilePath: this.teamFilePath(resolvedTeamName),
      leadAgentId: team.leadAgentId,
      leadSessionId: team.leadSessionId,
      description: team.description,
      createdAt: team.createdAt,
      isActiveTeam: active?.teamName === resolvedTeamName,
      peers,
    }
  }

  async buildInboxContext(options: TeamInboxContextOptions = {}): Promise<string | null> {
    const active = options.teamName ? null : await this.getActiveTeam()
    const teamName = options.teamName ?? active?.teamName
    if (!teamName) return null
    const agentName = options.agentName?.trim() || TEAM_LEAD_NAME
    const unread = await this.readUnreadMessages(agentName, teamName)
    const deliverable = unread.filter(message => !isStructuredProtocolMessage(message.text))
    if (deliverable.length === 0) return null

    const deduped: TeammateMessage[] = []
    const seen = new Set<string>()
    for (const message of deliverable) {
      const key = `${message.from}|${message.timestamp}|${message.text.slice(0, 100)}`
      if (seen.has(key)) continue
      seen.add(key)
      deduped.push(message)
    }
    const context = formatTeammateMessages(deduped)
    if (options.markRead !== false) {
      await this.markMessagesAsReadByPredicate(agentName, teamName, message => !isStructuredProtocolMessage(message.text))
    }
    return context || null
  }

  private async uniqueTeamName(providedName: string): Promise<string> {
    const base = providedName.trim()
    if (!base) throw new Error('team_name is required for TeamCreate')
    if (!await this.readTeam(base)) return base
    for (let i = 2; i < 10_000; i++) {
      const candidate = `${base}-${i}`
      if (!await this.readTeam(candidate)) return candidate
    }
    throw new Error(`Could not generate unique team name for "${base}"`)
  }

  private async withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
    const key = `${path}:lock`
    const previous = this.queues.get(key) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(async () => {
      await mkdir(dirname(path), { recursive: true })
      const lockDir = `${path}.lock`
      await acquireLockDir(lockDir)
      try {
        return await fn()
      } finally {
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
      }
    })
    this.queues.set(key, run.catch(() => undefined))
    return run
  }
}

async function acquireLockDir(lockDir: string): Promise<void> {
  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt++) {
    try {
      await mkdir(lockDir, { recursive: false })
      return
    } catch (err) {
      if (!isNodeErrorCode(err, 'EEXIST')) throw err
      await removeStaleLock(lockDir)
      const delay = Math.min(LOCK_MAX_DELAY_MS, LOCK_MIN_DELAY_MS * 2 ** attempt)
      await sleep(delay)
    }
  }
  throw new Error(`Timed out waiting for lock: ${lockDir}`)
}

async function removeStaleLock(lockDir: string): Promise<void> {
  try {
    const info = await stat(lockDir)
    if (Date.now() - info.mtimeMs > STALE_LOCK_MS) {
      await rm(lockDir, { recursive: true, force: true })
    }
  } catch {
    // Missing or unreadable lock will be retried by mkdir.
  }
}

function isNodeErrorCode(err: unknown, code: string): boolean {
  return isRecord(err) && err.code === code
}
