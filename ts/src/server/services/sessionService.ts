/**
 * Session Service — 会话文件的读写操作封装
 *
 * 读写 CLI 持久化在 ~/.claude/projects/{sanitized_path}/{sessionId}.jsonl 的会话数据，
 * 确保 Desktop App 与 CLI 的数据完全互通。
 */

import { createReadStream, type Stats } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createInterface } from 'node:readline'
import { ApiError } from '../middleware/errorHandler.js'
import { sanitizePath as sanitizePortablePath } from '../../utils/sessionStoragePortable.js'
import type { FileHistorySnapshot } from '../../utils/fileHistory.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import {
  resolveSessionWorkspaceLaunch,
  type CreateSessionRepositoryOptions,
  type PreparedSessionWorkspace,
} from './repositoryLaunchService.js'
import { registerFilesystemAccessRoot } from './filesystemAccessRoots.js'
import { normalizeDriveRootPathForPlatform } from './windowsDrivePath.js'
import { cleanSessionTitleSource } from '../../utils/sessionTitleText.js'
import { shouldHideCommandMetadataContent } from '../../utils/commandMetadata.js'

// ============================================================================
// Types
// ============================================================================

export type SessionListItem = {
  id: string
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  projectPath: string
  projectRoot: string | null
  workDir: string | null
  workDirExists: boolean
  permissionMode?: string
}

export type SessionLaunchInfo = {
  filePath: string
  projectDir: string
  workDir: string
  repository?: PreparedSessionWorkspace['repository']
  worktreeSession?: PersistedWorktreeSession | null
  transcriptMessageCount: number
  customTitle: string | null
  permissionMode?: string
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: string
}

export type MessageUsage = {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

export type MessageEntry = {
  id: string
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result'
  content: unknown
  toolUseResult?: unknown
  timestamp: string
  model?: string
  usage?: MessageUsage
  parentUuid?: string
  parentToolUseId?: string
  isSidechain?: boolean
}

/** Raw entry parsed from a single JSONL line */
type RawEntry = {
  type?: string
  subtype?: string
  content?: unknown
  uuid?: string
  messageId?: string
  parentUuid?: string | null
  parent_tool_use_id?: string | null
  isSidechain?: boolean
  isMeta?: boolean
  cwd?: string
  message?: {
    role?: string
    content?: unknown
    model?: string
    id?: string
    type?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_read_input_tokens?: number
      cache_creation_input_tokens?: number
    }
  }
  timestamp?: string
  snapshot?: {
    messageId?: string
    trackedFileBackups?: Record<string, unknown>
    timestamp?: string
  }
  customTitle?: string
  permissionMode?: string
  worktreeSession?: PersistedWorktreeSession | null
  title?: string
  [key: string]: unknown
}

type RawMessageUsage = NonNullable<RawEntry['message']>['usage']

function normalizeMessageUsage(usage: RawMessageUsage): MessageUsage | undefined {
  if (!usage) return undefined

  const normalized: MessageUsage = {}
  if (typeof usage.input_tokens === 'number' && Number.isFinite(usage.input_tokens)) {
    normalized.input_tokens = usage.input_tokens
  }
  if (typeof usage.output_tokens === 'number' && Number.isFinite(usage.output_tokens)) {
    normalized.output_tokens = usage.output_tokens
  }
  if (
    typeof usage.cache_read_input_tokens === 'number' &&
    Number.isFinite(usage.cache_read_input_tokens)
  ) {
    normalized.cache_read_input_tokens = usage.cache_read_input_tokens
  }
  if (
    typeof usage.cache_creation_input_tokens === 'number' &&
    Number.isFinite(usage.cache_creation_input_tokens)
  ) {
    normalized.cache_creation_input_tokens = usage.cache_creation_input_tokens
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined
}

type PersistedWorktreeSession = {
  originalCwd: string
  worktreePath: string
  worktreeName: string
  worktreeBranch?: string
  originalBranch?: string
  originalHeadCommit?: string
  sessionId: string
  tmuxSessionName?: string
  hookBased?: boolean
}

type SessionListSummary = {
  title: string
  createdAt: string
  modifiedAt: string
  messageCount: number
  workDir: string | null
  permissionMode?: string
  runtimeProviderId?: string | null
  runtimeModelId?: string
  effortLevel?: string
  repository?: PreparedSessionWorkspace['repository']
  worktreeSession?: PersistedWorktreeSession | null
}

type SessionListSummaryCacheEntry = {
  mtimeMs: number
  size: number
  summary: SessionListSummary
}

const VALID_SESSION_PERMISSION_MODES = new Set([
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
])
const VALID_SESSION_EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'max'])

type ContentBlock = Record<string, unknown>

const USER_INTERRUPTION_TEXTS = new Set([
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
])

const NO_RESPONSE_REQUESTED_TEXT = 'No response requested.'
const TASK_NOTIFICATION_RE = /^<task-notification>\s*[\s\S]*<\/task-notification>$/i
const TASK_NOTIFICATION_BLOCK_RE = /<task-notification>\s*[\s\S]*?<\/task-notification>/i

// ============================================================================
// Service
// ============================================================================

export class SessionService {
  private readonly sessionListCacheTtlMs = 5_000
  private readonly sessionListCache = new Map<string, {
    expiresAt: number
    result: { sessions: SessionListItem[]; total: number }
  }>()
  private readonly sessionListSummaryCache = new Map<string, SessionListSummaryCacheEntry>()

  private sessionListCacheKey(options?: {
    project?: string
    limit?: number
    offset?: number
  }): string {
    return JSON.stringify({
      project: options?.project ?? null,
      limit: options?.limit ?? 50,
      offset: options?.offset ?? 0,
    })
  }

  private cloneSessionListResult(result: { sessions: SessionListItem[]; total: number }): { sessions: SessionListItem[]; total: number } {
    return {
      total: result.total,
      sessions: result.sessions.map((session) => ({ ...session })),
    }
  }

  private invalidateSessionListCache(): void {
    this.sessionListCache.clear()
  }

  /**
   * Called by integrations that create a transcript outside SessionService.
   */
  invalidateSessionList(): void {
    this.invalidateSessionListCache()
  }

  private cloneSessionListSummary(summary: SessionListSummary): SessionListSummary {
    return {
      ...summary,
      repository: summary.repository ? { ...summary.repository } : undefined,
      worktreeSession: summary.worktreeSession
        ? { ...summary.worktreeSession }
        : summary.worktreeSession,
    }
  }

  private latestTimestamp(current: string | null, candidate: unknown): string | null {
    if (typeof candidate !== 'string') return current
    const candidateTime = Date.parse(candidate)
    if (!Number.isFinite(candidateTime)) return current
    if (!current) return candidate
    const currentTime = Date.parse(current)
    return !Number.isFinite(currentTime) || candidateTime > currentTime
      ? candidate
      : current
  }

  private metadataMatchesLaunchInfo(
    launchInfo: SessionLaunchInfo | null,
    metadata: {
      workDir: string
      repository?: PreparedSessionWorkspace['repository']
      permissionMode?: string
      runtimeProviderId?: string | null
      runtimeModelId?: string
      effortLevel?: string
    },
  ): boolean {
    if (!launchInfo) return false
    if (normalizeDriveRootPathForPlatform(launchInfo.workDir) !== metadata.workDir) {
      return false
    }
    if (
      JSON.stringify(launchInfo.repository ?? null) !==
      JSON.stringify(metadata.repository ?? null)
    ) {
      return false
    }
    if (
      metadata.permissionMode &&
      VALID_SESSION_PERMISSION_MODES.has(metadata.permissionMode) &&
      launchInfo.permissionMode !== metadata.permissionMode
    ) {
      return false
    }
    if (
      metadata.runtimeProviderId !== undefined &&
      launchInfo.runtimeProviderId !== metadata.runtimeProviderId
    ) {
      return false
    }
    if (metadata.runtimeModelId && launchInfo.runtimeModelId !== metadata.runtimeModelId) {
      return false
    }
    if (
      metadata.effortLevel &&
      VALID_SESSION_EFFORT_LEVELS.has(metadata.effortLevel) &&
      launchInfo.effortLevel !== metadata.effortLevel
    ) {
      return false
    }
    return true
  }

  private async getCachedSessionListSummary(
    filePath: string,
    projectDir: string,
    stat: Stats,
  ): Promise<SessionListSummary> {
    const cached = this.sessionListSummaryCache.get(filePath)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return this.cloneSessionListSummary(cached.summary)
    }

    const summary = await this.scanSessionListSummary(filePath, projectDir, stat)
    this.sessionListSummaryCache.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      summary: this.cloneSessionListSummary(summary),
    })
    return summary
  }

  // --------------------------------------------------------------------------
  // Config helpers
  // --------------------------------------------------------------------------

  private getConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  }

  private getProjectsDir(): string {
    return path.join(this.getConfigDir(), 'projects')
  }

  /**
   * Sanitize a path the same way the shared session storage does.
   * This must remain Windows-safe, so reserved characters such as ':' are normalized too.
   */
  private sanitizePath(dirPath: string): string {
    return sanitizePortablePath(dirPath)
  }

  // --------------------------------------------------------------------------
  // JSONL parsing
  // --------------------------------------------------------------------------

  private async readJsonlFile(filePath: string): Promise<RawEntry[]> {
    let content: string
    try {
      content = await fs.readFile(filePath, 'utf-8')
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw err
    }

    const entries: RawEntry[] = []
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        entries.push(JSON.parse(trimmed) as RawEntry)
      } catch {
        // skip malformed lines
      }
    }
    return entries
  }

  private async streamJsonlFile(
    filePath: string,
    onEntry: (entry: RawEntry) => void,
  ): Promise<void> {
    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    })

    try {
      for await (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          onEntry(JSON.parse(trimmed) as RawEntry)
        } catch {
          // skip malformed lines
        }
      }
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err
      }
    } finally {
      lines.close()
      stream.destroy()
    }
  }

  private async scanSessionListSummary(
    filePath: string,
    projectDir: string,
    stat: { birthtime: Date; mtime: Date },
  ): Promise<SessionListSummary> {
    let createdAt = stat.birthtime.toISOString()
    let hasCreatedAt = false
    let modifiedAt: string | null = null
    let messageCount = 0
    let firstUserTitle: string | null = null
    let goalTitle: string | null = null
    let aiTitle: string | null = null
    let customTitle: string | null = null
    let latestWorkDir: string | null = null
    let latestCwd: string | null = null
    let permissionMode: string | undefined
    let runtimeProviderId: string | null | undefined
    let runtimeModelId: string | undefined
    let effortLevel: string | undefined
    let repository: PreparedSessionWorkspace['repository'] | undefined
    let worktreeSession: PersistedWorktreeSession | null | undefined

    const stream = createReadStream(filePath, { encoding: 'utf8' })
    const lines = createInterface({
      input: stream,
      crlfDelay: Infinity,
    })

    try {
      for await (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed) continue

        let entry: RawEntry
        try {
          entry = JSON.parse(trimmed) as RawEntry
        } catch {
          continue
        }

        if (!hasCreatedAt && entry.timestamp) {
          createdAt = entry.timestamp
          hasCreatedAt = true
        }

        if (
          (entry.type === 'user' || entry.type === 'assistant') &&
          entry.message?.role
        ) {
          messageCount += 1
          if (!entry.isMeta) {
            modifiedAt = this.latestTimestamp(modifiedAt, entry.timestamp)
          }
        }

        if (entry.type === 'session-meta') {
          if (typeof (entry as Record<string, unknown>).workDir === 'string') {
            latestWorkDir = normalizeDriveRootPathForPlatform(
              (entry as Record<string, unknown>).workDir as string,
            )
          }
          if (
            typeof entry.permissionMode === 'string' &&
            VALID_SESSION_PERMISSION_MODES.has(entry.permissionMode)
          ) {
            permissionMode = entry.permissionMode
          }
          if (
            (entry as Record<string, unknown>).runtimeProviderId === null ||
            typeof (entry as Record<string, unknown>).runtimeProviderId === 'string'
          ) {
            runtimeProviderId = (entry as Record<string, unknown>).runtimeProviderId as string | null
          }
          if (typeof (entry as Record<string, unknown>).runtimeModelId === 'string') {
            runtimeModelId = (entry as Record<string, unknown>).runtimeModelId as string
          }
          if (
            typeof (entry as Record<string, unknown>).effortLevel === 'string' &&
            VALID_SESSION_EFFORT_LEVELS.has((entry as Record<string, unknown>).effortLevel as string)
          ) {
            effortLevel = (entry as Record<string, unknown>).effortLevel as string
          }
        }

        if (typeof entry.cwd === 'string' && entry.cwd.trim()) {
          latestCwd = normalizeDriveRootPathForPlatform(entry.cwd)
        }

        const candidateRepository = (entry as Record<string, unknown>)?.repository
        if (candidateRepository && typeof candidateRepository === 'object') {
          repository = candidateRepository as PreparedSessionWorkspace['repository']
        }

        if (entry.type === 'worktree-state') {
          if (entry.worktreeSession === null) {
            worktreeSession = null
          } else if (
            entry.worktreeSession &&
            typeof entry.worktreeSession === 'object' &&
            typeof entry.worktreeSession.worktreePath === 'string' &&
            typeof entry.worktreeSession.worktreeName === 'string'
          ) {
            worktreeSession = entry.worktreeSession
          }
        }

        if (entry.type === 'custom-title' && entry.customTitle) {
          customTitle = String(entry.customTitle)
        }

        if (!goalTitle) {
          goalTitle = this.goalCreationCommandTitle(entry)
        }

        if (entry.type === 'ai-title' && entry.aiTitle) {
          const title = cleanSessionTitleSource(String(entry.aiTitle))
          if (title) aiTitle = title
        }

        if (
          !firstUserTitle &&
          entry.type === 'user' &&
          !entry.isMeta &&
          entry.message?.role === 'user'
        ) {
          firstUserTitle = this.extractUserMessageTitle(entry.message.content)
        }
      }
    } finally {
      lines.close()
      stream.destroy()
    }

    return {
      title: customTitle ||
        goalTitle ||
        aiTitle ||
        firstUserTitle ||
        'Untitled Session',
      createdAt,
      modifiedAt: modifiedAt ?? stat.mtime.toISOString(),
      messageCount,
      workDir: latestWorkDir || latestCwd || this.desanitizePath(projectDir),
      ...(permissionMode ? { permissionMode } : {}),
      ...(runtimeProviderId !== undefined ? { runtimeProviderId } : {}),
      ...(runtimeModelId ? { runtimeModelId } : {}),
      ...(effortLevel ? { effortLevel } : {}),
      ...(repository ? { repository } : {}),
      ...(worktreeSession !== undefined ? { worktreeSession } : {}),
    }
  }

  private async appendJsonlEntry(filePath: string, entry: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify(entry) + '\n'
    await fs.appendFile(filePath, line, 'utf-8')
  }

  private resolveWorkDirFromEntries(
    entries: RawEntry[],
    fallbackProjectDir?: string,
  ): string | null {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry.type === 'session-meta' && typeof (entry as Record<string, unknown>).workDir === 'string') {
        return normalizeDriveRootPathForPlatform((entry as Record<string, unknown>).workDir as string)
      }
    }

    for (let i = entries.length - 1; i >= 0; i--) {
      const cwd = entries[i]?.cwd
      if (typeof cwd === 'string' && cwd.trim()) {
        return normalizeDriveRootPathForPlatform(cwd)
      }
    }

    return fallbackProjectDir ? this.desanitizePath(fallbackProjectDir) : null
  }

  private resolveRepositoryFromEntries(entries: RawEntry[]): PreparedSessionWorkspace['repository'] | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const repository = (entries[i] as Record<string, unknown>)?.repository
      if (repository && typeof repository === 'object') {
        return repository as PreparedSessionWorkspace['repository']
      }
    }
    return undefined
  }

  private resolvePermissionModeFromEntries(entries: RawEntry[]): string | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry?.type !== 'session-meta') continue
      const permissionMode = entry.permissionMode
      if (
        typeof permissionMode === 'string' &&
        VALID_SESSION_PERMISSION_MODES.has(permissionMode)
      ) {
        return permissionMode
      }
    }
    return undefined
  }

  private resolveWorktreeSessionFromEntries(entries: RawEntry[]): PersistedWorktreeSession | null | undefined {
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i]
      if (entry?.type !== 'worktree-state') continue

      const worktreeSession = entry.worktreeSession
      if (worktreeSession === null) return null
      if (
        worktreeSession &&
        typeof worktreeSession === 'object' &&
        typeof worktreeSession.worktreePath === 'string' &&
        typeof worktreeSession.worktreeName === 'string'
      ) {
        return worktreeSession
      }
    }
    return undefined
  }

  private async resolveProjectRootFromSessionMetadata({
    worktreeSession,
    repository,
    workDir,
    fallbackProjectDir,
  }: {
    worktreeSession?: PersistedWorktreeSession | null
    repository?: PreparedSessionWorkspace['repository']
    workDir: string | null
    fallbackProjectDir?: string
  }): Promise<string | null> {
    const candidate = worktreeSession?.originalCwd ||
      repository?.repoRoot ||
      workDir ||
      (fallbackProjectDir ? this.desanitizePath(fallbackProjectDir) : null)

    if (!candidate) return null

    const canonicalCandidate = await this.canonicalizeProjectPath(candidate)
    const gitRoot = findCanonicalGitRoot(canonicalCandidate)
    if (gitRoot) return gitRoot

    if (workDir) {
      const marker = `${path.sep}.claude${path.sep}worktrees${path.sep}`
      const markerIndex = canonicalCandidate.indexOf(marker)
      if (markerIndex > 0) return canonicalCandidate.slice(0, markerIndex)
    }

    return canonicalCandidate
  }

  private async canonicalizeProjectPath(projectPath: string): Promise<string> {
    try {
      return normalizeDriveRootPathForPlatform(await fs.realpath(projectPath)).normalize('NFC')
    } catch {
      return projectPath.normalize('NFC')
    }
  }

  private countTranscriptMessages(entries: RawEntry[]): number {
    return entries.filter((entry) =>
      !entry.isMeta &&
      !!entry.message?.role &&
      (entry.type === 'user' || entry.type === 'assistant' || entry.type === 'system')
    ).length
  }

  // --------------------------------------------------------------------------
  // Entry → MessageEntry conversion
  // --------------------------------------------------------------------------

  private entryToMessage(
    entry: RawEntry,
    parentToolUseId?: string,
  ): MessageEntry | null {
    const msg = entry.message
    if (!msg || !msg.role) return null

    // Determine our normalized type
    let type: MessageEntry['type']
    const role = msg.role

    if (role === 'user') {
      // Check if the content is a tool_result array
      if (Array.isArray(msg.content)) {
        const hasToolResult = msg.content.some(
          (block: Record<string, unknown>) => block.type === 'tool_result'
        )
        if (hasToolResult) {
          type = 'tool_result'
        } else {
          type = 'user'
        }
      } else {
        type = 'user'
      }
    } else if (role === 'assistant') {
      // Check if the content contains tool_use blocks
      if (Array.isArray(msg.content)) {
        const hasToolUse = msg.content.some(
          (block: Record<string, unknown>) => block.type === 'tool_use'
        )
        type = hasToolUse ? 'tool_use' : 'assistant'
      } else {
        type = 'assistant'
      }
    } else {
      type = 'system'
    }

    const usage = normalizeMessageUsage(msg.usage)

    return {
      id: entry.uuid || crypto.randomUUID(),
      type,
      content: msg.content,
      ...(entry.toolUseResult !== undefined ? { toolUseResult: entry.toolUseResult } : {}),
      timestamp: entry.timestamp || new Date().toISOString(),
      model: msg.model,
      ...(usage ? { usage } : {}),
      parentUuid: entry.parentUuid ?? undefined,
      parentToolUseId,
      isSidechain: entry.isSidechain,
    }
  }

  private extractTextBlocks(content: unknown): string[] {
    if (typeof content === 'string') return [content]
    if (!Array.isArray(content)) return []

    return content
      .flatMap((block) => {
        if (!block || typeof block !== 'object') return []
        const record = block as Record<string, unknown>
        return record.type === 'text' && typeof record.text === 'string'
          ? [record.text]
          : []
      })
      .map((text) => text.trim())
      .filter(Boolean)
  }

  private isSyntheticUserInterruption(content: unknown): boolean {
    const textBlocks = this.extractTextBlocks(content)
    return (
      textBlocks.length > 0 &&
      textBlocks.every((text) => USER_INTERRUPTION_TEXTS.has(text))
    )
  }

  private isSyntheticNoResponseAssistant(content: unknown): boolean {
    const textBlocks = this.extractTextBlocks(content)
    return (
      textBlocks.length > 0 &&
      textBlocks.every((text) => text === NO_RESPONSE_REQUESTED_TEXT)
    )
  }

  private isToolResultContent(content: unknown): boolean {
    return (
      Array.isArray(content) &&
      content.some((block) =>
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'tool_result'
      )
    )
  }

  private isTaskNotificationContent(content: unknown): boolean {
    const textBlocks = this.extractTextBlocks(content)
    return (
      textBlocks.length > 0 &&
      textBlocks.every((text) => this.extractTaskNotificationXml(text) !== null)
    )
  }

  private extractTaskNotificationXml(text: string): string | null {
    const trimmed = text.trim()
    if (TASK_NOTIFICATION_RE.test(trimmed)) return trimmed
    return trimmed.match(TASK_NOTIFICATION_BLOCK_RE)?.[0] ?? null
  }

  private decodeXmlText(text: string): string {
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&')
  }

  private readXmlTag(xml: string, tag: string): string | undefined {
    const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'i'))
    return match?.[1] ? this.decodeXmlText(match[1].trim()) : undefined
  }

  private shouldHideTranscriptEntry(entry: RawEntry): boolean {
    const role = entry.message?.role
    const content = entry.message?.content

    if (role === 'user') {
      return (
        shouldHideCommandMetadataContent(content) ||
        this.isSyntheticUserInterruption(content) ||
        this.isTaskNotificationContent(content)
      )
    }

    if (role === 'assistant') {
      return this.isSyntheticNoResponseAssistant(content)
    }

    return false
  }

  private isVisibleTranscriptMessageEntry(entry: RawEntry): boolean {
    if (!entry.message?.role || entry.isMeta) return false
    if (
      entry.type !== 'user' &&
      entry.type !== 'assistant' &&
      entry.type !== 'system'
    ) {
      return false
    }
    return !this.shouldHideTranscriptEntry(entry)
  }

  private isGoalLocalCommandOutput(output: string): boolean {
    const trimmed = output.trim()
    return (
      trimmed.startsWith('Goal set:') ||
      trimmed.startsWith('Goal continuing:') ||
      trimmed.startsWith('Goal cleared:') ||
      trimmed === 'Goal cleared.' ||
      trimmed === 'Goal marked complete.' ||
      trimmed === 'No active goal.'
    )
  }

  private isGoalLocalCommandEntry(entry: RawEntry): boolean {
    if (
      entry.type !== 'system' ||
      entry.subtype !== 'local_command' ||
      typeof entry.content !== 'string'
    ) {
      return false
    }

    const commandName = this.readXmlTag(entry.content, 'command-name')?.replace(/^\//, '')
    if (commandName) return commandName === 'goal'

    const output =
      this.readXmlTag(entry.content, 'local-command-stdout') ??
      this.readXmlTag(entry.content, 'local-command-stderr')
    return output ? this.isGoalLocalCommandOutput(output) : false
  }

  private goalLocalCommandEntryToMessage(entry: RawEntry): MessageEntry | null {
    if (!this.isGoalLocalCommandEntry(entry)) return null
    return {
      id: entry.uuid || crypto.randomUUID(),
      type: 'system',
      content: entry.content,
      timestamp: entry.timestamp || new Date().toISOString(),
      parentUuid: entry.parentUuid ?? undefined,
      isSidechain: entry.isSidechain,
    }
  }

  private goalCreationCommandTitle(entry: RawEntry): string | null {
    if (
      entry.type !== 'system' ||
      entry.subtype !== 'local_command' ||
      typeof entry.content !== 'string'
    ) {
      return null
    }

    const commandName = this.readXmlTag(entry.content, 'command-name')?.replace(/^\//, '')
    if (commandName !== 'goal') return null

    const args = this.readXmlTag(entry.content, 'command-args')?.trim()
    if (!args || /^clear\b/i.test(args)) return null

    const title = cleanSessionTitleSource(`/goal ${args}`)
    return title ? title.length > 80 ? title.slice(0, 80) + '...' : title : null
  }

  private extractAgentToolUseId(entry: RawEntry): string | undefined {
    const content = entry.message?.content
    if (!Array.isArray(content)) return undefined

    for (const block of content as Array<Record<string, unknown>>) {
      if (
        block.type === 'tool_use' &&
        block.name === 'Agent' &&
        typeof block.id === 'string'
      ) {
        return block.id
      }
    }

    return undefined
  }

  private extractAgentToolUseIdsFromMessage(message: MessageEntry): string[] {
    if (message.type !== 'tool_use' || !Array.isArray(message.content)) {
      return []
    }

    return (message.content as ContentBlock[])
      .filter((block) => block.type === 'tool_use' && block.name === 'Agent')
      .flatMap((block) => (typeof block.id === 'string' ? [block.id] : []))
  }

  private extractTextFromContent(content: unknown): string {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''

    return (content as ContentBlock[])
      .flatMap((block) => (typeof block.text === 'string' ? [block.text] : []))
      .join('\n')
  }

  private extractAgentIdFromResultText(text: string): string | undefined {
    const match = text.match(/(?:^|\n)\s*agentId:\s*([A-Za-z0-9_-]+)/)
    return match?.[1]
  }

  private extractAgentResultLinks(messages: MessageEntry[]): Map<string, string> {
    const agentToolUseIds = new Set(
      messages.flatMap((message) => this.extractAgentToolUseIdsFromMessage(message)),
    )
    const resultLinks = new Map<string, string>()

    for (const message of messages) {
      if (message.type !== 'tool_result' || !Array.isArray(message.content)) {
        continue
      }

      for (const block of message.content as ContentBlock[]) {
        if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') {
          continue
        }
        if (!agentToolUseIds.has(block.tool_use_id)) {
          continue
        }

        const agentId = this.extractAgentIdFromResultText(
          this.extractTextFromContent(block.content),
        )
        if (agentId) {
          resultLinks.set(block.tool_use_id, agentId)
        }
      }
    }

    return resultLinks
  }

  private namespaceSubagentContentIds(content: unknown, namespace: string): unknown {
    if (!Array.isArray(content)) return content

    return (content as ContentBlock[]).map((block) => {
      if (!block || typeof block !== 'object') return block
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        return { ...block, id: `${namespace}/${block.id}` }
      }
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
        return { ...block, tool_use_id: `${namespace}/${block.tool_use_id}` }
      }
      return block
    })
  }

  private subagentTranscriptPath(
    projectDir: string,
    sessionId: string,
    agentId: string,
  ): string {
    const normalizedAgentId = agentId.startsWith('agent-') ? agentId : `agent-${agentId}`
    return path.join(
      this.getProjectsDir(),
      projectDir,
      sessionId,
      'subagents',
      `${normalizedAgentId}.jsonl`,
    )
  }

  private async loadSubagentToolMessages(
    projectDir: string,
    sessionId: string,
    parentToolUseId: string,
    agentId: string,
  ): Promise<MessageEntry[]> {
    const filePath = this.subagentTranscriptPath(projectDir, sessionId, agentId)
    const entries = await this.readJsonlFile(filePath)
    const namespace = `${parentToolUseId}/${agentId}`
    const messages: MessageEntry[] = []

    for (const entry of entries) {
      if (!entry.message?.role || entry.isMeta) continue
      if (this.shouldHideTranscriptEntry(entry)) continue
      if (entry.type !== 'user' && entry.type !== 'assistant' && entry.type !== 'system') {
        continue
      }

      const message = this.entryToMessage(
        {
          ...entry,
          message: {
            ...entry.message,
            content: this.namespaceSubagentContentIds(entry.message.content, namespace),
          },
        },
        parentToolUseId,
      )
      if (message && (message.type === 'tool_use' || message.type === 'tool_result')) {
        messages.push(message)
      }
    }

    return messages
  }

  private async appendSubagentToolMessages(
    projectDir: string,
    sessionId: string,
    messages: MessageEntry[],
  ): Promise<MessageEntry[]> {
    const resultLinks = this.extractAgentResultLinks(messages)
    if (resultLinks.size === 0) {
      return messages
    }

    const childMessages = await Promise.all(
      [...resultLinks.entries()].map(([parentToolUseId, agentId]) =>
        this.loadSubagentToolMessages(projectDir, sessionId, parentToolUseId, agentId),
      ),
    )
    return [...messages, ...childMessages.flat()]
  }

  private resolveParentToolUseId(
    entry: RawEntry,
    entriesByUuid: Map<string, RawEntry>,
    cache: Map<string, string | undefined>,
  ): string | undefined {
    if (
      typeof entry.parent_tool_use_id === 'string' &&
      entry.parent_tool_use_id.length > 0
    ) {
      return entry.parent_tool_use_id
    }

    if (entry.isSidechain !== true) {
      return undefined
    }

    const cacheKey = entry.uuid
    if (cacheKey && cache.has(cacheKey)) {
      return cache.get(cacheKey)
    }

    let resolved: string | undefined
    let currentParentUuid =
      typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined
    const visited = new Set<string>()

    while (currentParentUuid && !visited.has(currentParentUuid)) {
      visited.add(currentParentUuid)
      const parentEntry = entriesByUuid.get(currentParentUuid)
      if (!parentEntry) break

      const directAgentToolUseId = this.extractAgentToolUseId(parentEntry)
      if (directAgentToolUseId) {
        resolved = directAgentToolUseId
        break
      }

      if (parentEntry.uuid && cache.has(parentEntry.uuid)) {
        resolved = cache.get(parentEntry.uuid)
        break
      }

      currentParentUuid =
        typeof parentEntry.parentUuid === 'string'
          ? parentEntry.parentUuid
          : undefined
    }

    if (cacheKey) {
      cache.set(cacheKey, resolved)
    }

    return resolved
  }

  private extractUserMessageTitle(content: unknown): string | null {
    let text: string | undefined
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      const textBlock = content.find(
        (block: Record<string, unknown>) => block.type === 'text' && typeof block.text === 'string'
      )
      if (textBlock) text = textBlock.text as string
    }
    if (!text) return null

    const title = cleanSessionTitleSource(text)
    if (!title) return null
    return title.length > 80 ? `${title.slice(0, 80)}...` : title
  }

  // --------------------------------------------------------------------------
  // Session file discovery
  // --------------------------------------------------------------------------

  /**
   * Find all .jsonl session files across all project directories.
   * Returns an array of { filePath, projectDir, sessionId }.
   */
  private async discoverSessionFiles(projectFilter?: string): Promise<
    Array<{ filePath: string; projectDir: string; sessionId: string }>
  > {
    const projectsDir = this.getProjectsDir()
    let projectDirs: string[]

    try {
      projectDirs = await fs.readdir(projectsDir)
    } catch {
      return []
    }

    // Optionally filter to a specific project
    if (projectFilter) {
      const sanitized = this.sanitizePath(normalizeDriveRootPathForPlatform(projectFilter))
      projectDirs = projectDirs.filter((d) => d === sanitized)
    }

    const results: Array<{ filePath: string; projectDir: string; sessionId: string }> = []

    for (const dir of projectDirs) {
      const dirPath = path.join(projectsDir, dir)

      // Ensure it's a directory
      try {
        const stat = await fs.stat(dirPath)
        if (!stat.isDirectory()) continue
      } catch {
        continue
      }

      let files: string[]
      try {
        files = await fs.readdir(dirPath)
      } catch {
        continue
      }

      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue
        const sessionId = file.replace('.jsonl', '')
        results.push({
          filePath: path.join(dirPath, file),
          projectDir: dir,
          sessionId,
        })
      }
    }

    return results
  }

  /**
   * Convert a sanitized directory name back to the original absolute path.
   * Reverses sanitizePath(): `-Users-nanmi-workspace` → `/Users/nanmi/workspace`.
   */
  desanitizePath(sanitized: string): string {
    // The sanitized form replaces all non-alphanumeric characters with '-'.
    // This fallback is necessarily lossy, but old Windows transcripts without
    // session-meta still need the drive separator restored well enough to resume.
    const windowsDrivePath = sanitized.match(/^([a-zA-Z])--(.+)$/)
    if (windowsDrivePath) {
      return `${windowsDrivePath[1]}:${path.win32.sep}${windowsDrivePath[2].replace(/-/g, path.win32.sep)}`
    }

    const windowsDriveRoot = sanitized.match(/^([a-zA-Z])--$/)
    if (windowsDriveRoot) {
      return `${windowsDriveRoot[1]}:${path.win32.sep}`
    }

    // On POSIX the original path starts with '/', so the sanitized form starts with '-'.
    // UNC-style Windows paths also recover to a leading double separator on Windows.
    return sanitized.replace(/-/g, path.sep)
  }

  /**
   * Find the .jsonl file for a given session ID.
   * Searches across all project directories since sessions may belong to any project.
   */
  private async findSessionFiles(
    sessionId: string
  ): Promise<Array<{ filePath: string; projectDir: string }>> {
    if (!this.isValidSessionId(sessionId)) {
      return []
    }

    const projectsDir = this.getProjectsDir()
    let projectDirs: string[]

    try {
      projectDirs = await fs.readdir(projectsDir)
    } catch {
      return []
    }

    const matches: Array<{ filePath: string; projectDir: string; mtimeMs: number }> = []
    for (const dir of projectDirs) {
      const filePath = path.join(projectsDir, dir, `${sessionId}.jsonl`)
      try {
        const stat = await fs.stat(filePath)
        matches.push({ filePath, projectDir: dir, mtimeMs: stat.mtimeMs })
      } catch {
        continue
      }
    }

    return matches
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map(({ filePath, projectDir }) => ({ filePath, projectDir }))
  }

  async findSessionFile(
    sessionId: string
  ): Promise<{ filePath: string; projectDir: string } | null> {
    return (await this.findSessionFiles(sessionId))[0] ?? null
  }

  private isValidSessionId(id: string): boolean {
    // UUID v4 format
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  }


  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * List all sessions, optionally filtered by project path.
   */
  async listSessions(options?: {
    project?: string
    limit?: number
    offset?: number
  }): Promise<{ sessions: SessionListItem[]; total: number }> {
    const cacheKey = this.sessionListCacheKey(options)
    const cached = this.sessionListCache.get(cacheKey)
    if (cached && cached.expiresAt > Date.now()) {
      return this.cloneSessionListResult(cached.result)
    }

    const sessionFiles = await this.discoverSessionFiles(options?.project)
    const filesWithStats = (await Promise.all(sessionFiles.map(async (sessionFile) => {
      try {
        return {
          ...sessionFile,
          stat: await fs.stat(sessionFile.filePath),
        }
      } catch {
        return null
      }
    }))).filter((item): item is NonNullable<typeof item> => item !== null)

    const summarizedFiles: Array<{
      filePath: string
      projectDir: string
      sessionId: string
      stat: Stats
      summary: SessionListSummary
    }> = []
    for (const item of filesWithStats) {
      try {
        summarizedFiles.push({
          ...item,
          summary: await this.getCachedSessionListSummary(
            item.filePath,
            item.projectDir,
            item.stat,
          ),
        })
      } catch {
        // Skip unreadable files
      }
    }

    summarizedFiles.sort(
      (a, b) =>
        Date.parse(b.summary.modifiedAt) - Date.parse(a.summary.modifiedAt),
    )

    const total = summarizedFiles.length
    const offset = options?.offset ?? 0
    const limit = options?.limit ?? 50
    const paginatedFiles = summarizedFiles.slice(offset, offset + limit)

    // Build session list items with metadata from file stats & a streaming
    // transcript summary. Keep this sequential so large JSONL files are not
    // loaded into memory concurrently by the sidebar's frequent refresh.
    const items: SessionListItem[] = []
    for (const { projectDir, sessionId, summary } of paginatedFiles) {
      try {
        const workDir = summary.workDir
        const projectRoot = await this.resolveProjectRootFromSessionMetadata({
          worktreeSession: summary.worktreeSession,
          repository: summary.repository,
          workDir,
          fallbackProjectDir: projectDir,
        })
        const workDirExists = await this.pathExists(workDir)

        items.push({
          id: sessionId,
          title: summary.title,
          createdAt: summary.createdAt,
          modifiedAt: summary.modifiedAt,
          messageCount: summary.messageCount,
          projectPath: projectDir,
          projectRoot,
          workDir,
          workDirExists,
          permissionMode: summary.permissionMode,
        })
      } catch {
        // Skip unreadable files
      }
    }

    const result = { sessions: items, total }
    this.sessionListCache.set(cacheKey, {
      expiresAt: Date.now() + this.sessionListCacheTtlMs,
      result: this.cloneSessionListResult(result),
    })
    return result
  }

  /**
   * Get only the messages for a session (lighter than full detail).
   */
  async getSessionMessages(sessionId: string): Promise<MessageEntry[]> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(found.filePath)
    return await this.appendSubagentToolMessages(
      found.projectDir,
      sessionId,
      this.entriesToMessages(entries),
    )
  }

  /**
   * Create a new session file for the given working directory.
   */
  async createSession(
    workDir?: string,
    repositoryOptions?: CreateSessionRepositoryOptions,
    permissionMode?: string,
  ): Promise<{ sessionId: string; workDir: string }> {
    // Default to user home directory when no workDir specified
    const resolvedWorkDir = workDir || os.homedir()
    const sessionId = crypto.randomUUID()

    // Resolve to absolute path. NOTE: path.resolve() uses process.cwd() to
    // expand relative paths — in bundled sidecar mode the server's cwd is
    // typically '/'. Callers (IM adapters) already send absolute realPath,
    // but we log here so cwd regressions are caught early.
    const preparedWorkspace = await resolveSessionWorkspaceLaunch(
      resolvedWorkDir,
      repositoryOptions,
      sessionId,
    )
    const absWorkDir = preparedWorkspace.workDir
    registerFilesystemAccessRoot(absWorkDir)
    console.log(
      `[SessionService] createSession: requested workDir=${JSON.stringify(
        workDir,
      )}, resolved=${absWorkDir}, repository=${JSON.stringify(
        preparedWorkspace.repository ?? null,
      )} (process.cwd()=${process.cwd()})`,
    )

    const sanitized = this.sanitizePath(absWorkDir)
    const dirPath = path.join(this.getProjectsDir(), sanitized)

    // Ensure the project directory exists
    await fs.mkdir(dirPath, { recursive: true })

    const filePath = path.join(dirPath, `${sessionId}.jsonl`)
    const now = new Date().toISOString()

    // Write an initial file-history-snapshot entry (matches CLI behavior)
    const initialEntry = {
      type: 'file-history-snapshot',
      messageId: crypto.randomUUID(),
      snapshot: {
        messageId: crypto.randomUUID(),
        trackedFileBackups: {},
        timestamp: now,
      },
      isSnapshotUpdate: false,
    }

    // Store actual workDir for later retrieval
    const metaEntry = {
      type: 'session-meta',
      isMeta: true,
      workDir: absWorkDir,
      repository: preparedWorkspace.repository,
      ...(permissionMode && VALID_SESSION_PERMISSION_MODES.has(permissionMode)
        ? { permissionMode }
        : {}),
      timestamp: now,
    }

    await fs.writeFile(filePath, JSON.stringify(initialEntry) + '\n' + JSON.stringify(metaEntry) + '\n', 'utf-8')
    this.invalidateSessionListCache()

    return { sessionId, workDir: absWorkDir }
  }

  /**
   * Rename a session by appending a custom-title entry to its JSONL file.
   */
  async renameSession(sessionId: string, title: string): Promise<void> {
    if (!title || typeof title !== 'string') {
      throw ApiError.badRequest('title is required')
    }

    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entry = {
      type: 'custom-title',
      customTitle: title,
      timestamp: new Date().toISOString(),
    }

    await this.appendJsonlEntry(found.filePath, entry)
    this.invalidateSessionListCache()
  }

  /**
   * Append an AI-generated title entry to a session's JSONL file.
   */
  async appendAiTitle(sessionId: string, title: string): Promise<void> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return

    await this.appendJsonlEntry(found.filePath, {
      type: 'ai-title',
      aiTitle: title,
      timestamp: new Date().toISOString(),
    })
    this.invalidateSessionListCache()
  }

  async getCustomTitle(sessionId: string): Promise<string | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.readJsonlFile(found.filePath)
    let customTitle: string | null = null
    for (const entry of entries) {
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string' && entry.customTitle.trim()) {
        customTitle = entry.customTitle
      }
    }
    return customTitle
  }

  /**
   * Get the actual working directory for a session.
   * First checks for stored session-meta entry, then falls back to desanitizePath.
   */
  async getSessionWorkDir(sessionId: string): Promise<string | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.readJsonlFile(found.filePath)
    return this.resolveWorkDirFromEntries(entries, found.projectDir)
  }

  /**
   * Inspect how a session should be launched.
   * Placeholder desktop-created sessions have zero transcript messages.
   */
  async getSessionLaunchInfo(sessionId: string): Promise<SessionLaunchInfo | null> {
    const found = await this.findSessionFile(sessionId)
    if (!found) return null

    const entries = await this.readJsonlFile(found.filePath)
    const workDir = this.resolveWorkDirFromEntries(entries, found.projectDir) || process.cwd()
    const repository = this.resolveRepositoryFromEntries(entries)
    const worktreeSession = this.resolveWorktreeSessionFromEntries(entries)
    const permissionMode = this.resolvePermissionModeFromEntries(entries)
    let customTitle: string | null = null
    let runtimeProviderId: string | null | undefined
    let runtimeModelId: string | undefined
    let effortLevel: string | undefined

    for (const entry of entries) {
      if (entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
        customTitle = entry.customTitle
      }
      if (entry.type === 'session-meta') {
        const record = entry as Record<string, unknown>
        if (record.runtimeProviderId === null || typeof record.runtimeProviderId === 'string') {
          runtimeProviderId = record.runtimeProviderId as string | null
        }
        if (typeof record.runtimeModelId === 'string') {
          runtimeModelId = record.runtimeModelId
        }
        if (
          typeof record.effortLevel === 'string' &&
          VALID_SESSION_EFFORT_LEVELS.has(record.effortLevel)
        ) {
          effortLevel = record.effortLevel
        }
      }
    }
    const transcriptMessageCount = this.countTranscriptMessages(entries)

    return {
      filePath: found.filePath,
      projectDir: found.projectDir,
      workDir,
      repository,
      worktreeSession,
      transcriptMessageCount,
      customTitle,
      permissionMode,
      ...(runtimeProviderId !== undefined ? { runtimeProviderId } : {}),
      ...(runtimeModelId ? { runtimeModelId } : {}),
      ...(effortLevel ? { effortLevel } : {}),
    }
  }

  async clearSessionTranscript(
    sessionId: string,
    fallbackWorkDir?: string,
    preservedPermissionMode?: string,
  ): Promise<void> {
    let found = await this.findSessionFile(sessionId)
    if (!found && fallbackWorkDir) {
      const resolvedPath = path.resolve(normalizeDriveRootPathForPlatform(fallbackWorkDir))
      const absWorkDir = await fs.realpath(resolvedPath).catch(() => resolvedPath)
      const dirPath = path.join(this.getProjectsDir(), this.sanitizePath(absWorkDir))
      await fs.mkdir(dirPath, { recursive: true })
      found = {
        filePath: path.join(dirPath, `${sessionId}.jsonl`),
        projectDir: this.sanitizePath(absWorkDir),
      }
    }
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(found.filePath)
    const workDir = this.resolveWorkDirFromEntries(entries, found.projectDir) || fallbackWorkDir || process.cwd()
    const repository = this.resolveRepositoryFromEntries(entries)
    const permissionMode = (
      preservedPermissionMode &&
      VALID_SESSION_PERMISSION_MODES.has(preservedPermissionMode)
    )
      ? preservedPermissionMode
      : this.resolvePermissionModeFromEntries(entries)
    const now = new Date().toISOString()

    const initialEntry = {
      type: 'file-history-snapshot',
      messageId: crypto.randomUUID(),
      snapshot: {
        messageId: crypto.randomUUID(),
        trackedFileBackups: {},
        timestamp: now,
      },
      isSnapshotUpdate: false,
    }

    const metaEntry = {
      type: 'session-meta',
      isMeta: true,
      workDir,
      repository,
      ...(permissionMode ? { permissionMode } : {}),
      timestamp: now,
    }

    await fs.writeFile(
      found.filePath,
      `${JSON.stringify(initialEntry)}\n${JSON.stringify(metaEntry)}\n`,
      'utf-8',
    )
    this.invalidateSessionListCache()
  }

  async appendSessionMetadata(
    sessionId: string,
    metadata: {
      workDir: string
      customTitle?: string | null
      repository?: PreparedSessionWorkspace['repository']
      permissionMode?: string
      runtimeProviderId?: string | null
      runtimeModelId?: string
      effortLevel?: string
    }
  ): Promise<void> {
    const matches = await this.findSessionFiles(sessionId)
    if (matches.length === 0) return

    let repository = metadata.repository
    if (!repository) {
      for (const match of matches) {
        const candidate = this.resolveRepositoryFromEntries(await this.readJsonlFile(match.filePath))
        if (candidate) {
          repository = candidate
          break
        }
      }
    }

    const normalizedWorkDir = normalizeDriveRootPathForPlatform(metadata.workDir)
    const targetProjectDir = this.sanitizePath(normalizedWorkDir)
    const targetFilePath = path.join(this.getProjectsDir(), targetProjectDir, `${sessionId}.jsonl`)

    if (!metadata.customTitle) {
      const launchInfo = await this.getSessionLaunchInfo(sessionId)
      if (this.metadataMatchesLaunchInfo(launchInfo, {
        ...metadata,
        workDir: normalizedWorkDir,
        repository,
      })) {
        return
      }
    }

    await fs.mkdir(path.dirname(targetFilePath), { recursive: true })

    await this.appendJsonlEntry(targetFilePath, {
      type: 'session-meta',
      isMeta: true,
      workDir: normalizedWorkDir,
      repository,
      ...(metadata.permissionMode && VALID_SESSION_PERMISSION_MODES.has(metadata.permissionMode)
        ? { permissionMode: metadata.permissionMode }
        : {}),
      ...(metadata.runtimeProviderId !== undefined
        ? { runtimeProviderId: metadata.runtimeProviderId }
        : {}),
      ...(metadata.runtimeModelId ? { runtimeModelId: metadata.runtimeModelId } : {}),
      ...(metadata.effortLevel && VALID_SESSION_EFFORT_LEVELS.has(metadata.effortLevel)
        ? { effortLevel: metadata.effortLevel }
        : {}),
      timestamp: new Date().toISOString(),
    })

    if (metadata.customTitle) {
      await this.appendJsonlEntry(targetFilePath, {
        type: 'custom-title',
        customTitle: metadata.customTitle,
        timestamp: new Date().toISOString(),
      })
    }
    this.invalidateSessionListCache()
  }

  async deletePlaceholderSessionFiles(
    sessionId: string,
    keepWorkDir: string,
  ): Promise<number> {
    if (!this.isValidSessionId(sessionId)) return 0

    const projectsDir = this.getProjectsDir()
    let projectDirs: import('node:fs').Dirent[]
    try {
      projectDirs = await fs.readdir(projectsDir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 0
      throw err
    }

    const keepProjectDir = this.sanitizePath(normalizeDriveRootPathForPlatform(keepWorkDir))
    let removed = 0
    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue
      if (projectDir.name === keepProjectDir) continue
      const filePath = path.join(projectsDir, projectDir.name, `${sessionId}.jsonl`)
      const entries = await this.readJsonlFile(filePath)
      if (entries.length === 0) continue

      if (this.countTranscriptMessages(entries) > 0) continue

      await fs.rm(filePath, { force: true })
      removed += 1
    }
    if (removed > 0) this.invalidateSessionListCache()
    return removed
  }

  async getSessionFileHistorySnapshots(
    sessionId: string,
  ): Promise<FileHistorySnapshot[]> {
    const found = await this.findSessionFile(sessionId)
    if (!found) {
      throw ApiError.notFound(`Session not found: ${sessionId}`)
    }

    const entries = await this.readJsonlFile(found.filePath)
    const snapshotsByMessageId = new Map<string, FileHistorySnapshot>()

    for (const entry of entries) {
      if (entry.type !== 'file-history-snapshot' || !entry.snapshot) continue

      const snapshotMessageId =
        typeof entry.snapshot.messageId === 'string'
          ? entry.snapshot.messageId
          : typeof entry.messageId === 'string'
            ? entry.messageId
            : null

      if (!snapshotMessageId) continue

      snapshotsByMessageId.set(snapshotMessageId, {
        messageId: snapshotMessageId as FileHistorySnapshot['messageId'],
        trackedFileBackups:
          entry.snapshot.trackedFileBackups &&
          typeof entry.snapshot.trackedFileBackups === 'object'
            ? (entry.snapshot.trackedFileBackups as FileHistorySnapshot['trackedFileBackups'])
            : {},
        timestamp: new Date(
          entry.snapshot.timestamp || entry.timestamp || new Date().toISOString(),
        ),
      })
    }

    return [...snapshotsByMessageId.values()]
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private entriesToMessages(entries: RawEntry[]): MessageEntry[] {
    const messages: MessageEntry[] = []
    const entriesByUuid = new Map<string, RawEntry>()
    const parentToolUseIdCache = new Map<string, string | undefined>()
    let suppressTaskNotificationResponse = false

    for (const entry of entries) {
      if (typeof entry.uuid === 'string' && entry.uuid.length > 0) {
        entriesByUuid.set(entry.uuid, entry)
      }
    }

    for (const entry of entries) {
      const goalLocalCommandMessage = this.goalLocalCommandEntryToMessage(entry)
      if (goalLocalCommandMessage) {
        messages.push(goalLocalCommandMessage)
        continue
      }

      // Only process transcript entries (user / assistant / system with messages)
      if (!entry.message?.role) continue

      // Skip meta entries (CLI internal bookkeeping)
      if (entry.isMeta) continue

      const isTaskNotification =
        entry.message.role === 'user' &&
        this.isTaskNotificationContent(entry.message.content)
      if (isTaskNotification) {
        suppressTaskNotificationResponse = true
        continue
      }

      if (
        entry.message.role === 'user' &&
        !this.isToolResultContent(entry.message.content)
      ) {
        suppressTaskNotificationResponse = false
      } else if (suppressTaskNotificationResponse) {
        continue
      }

      if (this.shouldHideTranscriptEntry(entry)) continue

      // Skip non-transcript entry types
      const entryType = entry.type
      if (
        entryType !== 'user' &&
        entryType !== 'assistant' &&
        entryType !== 'system'
      ) {
        continue
      }

      const parentToolUseId = this.resolveParentToolUseId(
        entry,
        entriesByUuid,
        parentToolUseIdCache,
      )
      const msg = this.entryToMessage(entry, parentToolUseId)
      if (msg) {
        messages.push(msg)
      }
    }
    return messages
  }

  private async pathExists(targetPath: string | null): Promise<boolean> {
    if (!targetPath) return false

    try {
      const stat = await fs.stat(targetPath)
      return stat.isDirectory()
    } catch {
      return false
    }
  }
}

// Singleton instance for shared use across API handlers
export const sessionService = new SessionService()
