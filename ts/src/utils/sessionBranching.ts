import { createHash, randomUUID, type UUID } from 'crypto'
import { link, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'fs/promises'
import * as path from 'node:path'
import type {
  AttributionSnapshotMessage,
  PersistedWorktreeSession,
  SerializedMessage,
  TranscriptMessage,
} from '../types/logs.js'
import type { ContentReplacementRecord } from './toolResultStorage.js'
import { parseJSONL } from './json.js'
import { buildConversationChain, loadTranscriptFile } from './sessionStorage.js'
import { jsonStringify } from './slowOperations.js'
import { escapeRegExp } from './stringUtils.js'

type SessionMetaEntry = {
  type: 'session-meta'
  isMeta?: boolean
  workDir?: string
  repository?: unknown
  timestamp?: string
  [key: string]: unknown
}

type WorktreeStateEntry = {
  type: 'worktree-state'
  sessionId: string
  worktreeSession: PersistedWorktreeSession | null
  [key: string]: unknown
}

type ModeEntry = {
  type: 'mode'
  sessionId: string
  mode: string
  [key: string]: unknown
}

type PrLinkEntry = {
  type: 'pr-link'
  sessionId: string
  prNumber: number
  prUrl: string
  prRepository: string
  timestamp: string
  [key: string]: unknown
}

type FileHistorySnapshotEntry = {
  type: 'file-history-snapshot'
  messageId: string
  snapshot?: {
    messageId?: string
    trackedFileBackups?: Record<string, unknown>
    timestamp?: string
  }
  [key: string]: unknown
}

type ContentReplacementEntry = {
  type: 'content-replacement'
  sessionId: string
  replacements: ContentReplacementRecord[]
  [key: string]: unknown
}

type TranscriptEntry = TranscriptMessage & {
  forkedFrom?: {
    sessionId: string
    messageUuid: UUID
  }
}

type RawEntry =
  | SessionMetaEntry
  | WorktreeStateEntry
  | ModeEntry
  | PrLinkEntry
  | FileHistorySnapshotEntry
  | AttributionSnapshotMessage
  | ContentReplacementEntry
  | Record<string, unknown>

export type SessionBranchResult = {
  sessionId: UUID
  title: string
  forkPath: string
  workDir: string | null
  serializedMessages: SerializedMessage[]
  contentReplacementRecords: ContentReplacementRecord[]
}

export type DurableBranchPlan = {
  targetSessionId: UUID
  sourceSessionId: string
  sourceTranscriptPath: string
  sourceMessageIds: string[]
  forkPath: string
  projectDirPath: string
  targetMessageId?: string
  title: string
  body: string
  sha256: string
}

export type CreateSessionBranchOptions = {
  sourceSessionId: string
  sourceTranscriptPath: string
  title?: string
  targetMessageId?: string
  sourceWorkDir?: string | null
  sourceRepository?: unknown
  sourceWorktreeSession?: PersistedWorktreeSession | null
  /**
   * Lets callers reserve a session ID before creating an isolated workspace.
   * The normal branch command continues to generate the ID itself.
   */
  targetSessionId?: UUID
  /**
   * Overrides inherited launch metadata for a branch that has moved into a
   * different, already materialized workspace.
   */
  targetWorkDir?: string
  targetRepository?: unknown
  /** Server-only operation marker for a bridge-reserved branch identity. */
  durableOperation?: {
    clientOperationId: string
    canonicalInput: string
  }
  durablePlan?: DurableBranchPlan
}

export class SessionBranchingError extends Error {
  constructor(
    readonly code:
      | 'SOURCE_NOT_FOUND'
      | 'INVALID_TARGET'
      | 'NO_BRANCHABLE_MESSAGES',
    message: string,
  ) {
    super(message)
    this.name = 'SessionBranchingError'
  }
}

function isTranscriptEntry(entry: RawEntry): entry is TranscriptMessage {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    (entry.type === 'user' ||
      entry.type === 'assistant' ||
      entry.type === 'attachment' ||
      entry.type === 'system') &&
    typeof (entry as TranscriptMessage).uuid === 'string'
  )
}

function isSessionMetaEntry(entry: RawEntry): entry is SessionMetaEntry {
  return entry.type === 'session-meta'
}

function isWorktreeStateEntry(entry: RawEntry): entry is WorktreeStateEntry {
  return entry.type === 'worktree-state'
}

function isModeEntry(entry: RawEntry): entry is ModeEntry {
  return entry.type === 'mode'
}

function isPrLinkEntry(entry: RawEntry): entry is PrLinkEntry {
  return entry.type === 'pr-link'
}

function isFileHistorySnapshotEntry(entry: RawEntry): entry is FileHistorySnapshotEntry {
  return entry.type === 'file-history-snapshot'
}

function isAttributionSnapshotEntry(entry: RawEntry): entry is AttributionSnapshotMessage {
  return entry.type === 'attribution-snapshot'
}

function getSnapshotMessageId(entry: FileHistorySnapshotEntry): string | null {
  if (typeof entry.snapshot?.messageId === 'string') return entry.snapshot.messageId
  if (typeof entry.messageId === 'string') return entry.messageId
  return null
}

function getAttributionMessageId(entry: AttributionSnapshotMessage): string | null {
  return typeof entry.messageId === 'string' ? entry.messageId : null
}

function findLatestActiveLeaf(
  messages: Map<UUID, TranscriptMessage>,
  leafUuids: Set<UUID>,
): TranscriptMessage | undefined {
  let latest: TranscriptMessage | undefined
  let latestTimestamp = -Infinity

  const candidates = leafUuids.size > 0
    ? [...leafUuids]
      .map((uuid) => messages.get(uuid))
      .filter((message): message is TranscriptMessage => !!message)
    : [...messages.values()]

  for (const message of candidates) {
    if (message.isSidechain) continue
    const timestamp = Date.parse(message.timestamp)
    if (timestamp >= latestTimestamp) {
      latest = message
      latestTimestamp = timestamp
    }
  }

  return latest
}

function extractToolResultIds(message: TranscriptMessage): string[] {
  if (message.type !== 'user' || !Array.isArray(message.message.content)) {
    return []
  }

  return message.message.content.flatMap((block) => (
    block.type === 'tool_result' && typeof block.tool_use_id === 'string'
      ? [block.tool_use_id]
      : []
  ))
}

async function readRawEntries(filePath: string): Promise<RawEntry[]> {
  const content = await readFile(filePath)
  return parseJSONL<RawEntry>(content)
}

async function listExistingTitles(projectDirPath: string): Promise<string[]> {
  let dirents: import('fs').Dirent[]
  try {
    dirents = await readdir(projectDirPath, { withFileTypes: true })
  } catch {
    return []
  }

  const titles: string[] = []
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) continue
    try {
      const entries = await readRawEntries(path.join(projectDirPath, dirent.name))
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]
        if (
          entry?.type === 'custom-title' &&
          typeof (entry as Record<string, unknown>).customTitle === 'string'
        ) {
          titles.push((entry as Record<string, unknown>).customTitle as string)
          break
        }
      }
    } catch {
      continue
    }
  }

  return titles
}

export function deriveFirstPrompt(
  firstUserMessage: Extract<SerializedMessage, { type: 'user' }> | undefined,
): string {
  const content = firstUserMessage?.message?.content
  if (!content) return 'Branched conversation'
  const raw =
    typeof content === 'string'
      ? content
      : content.find(
          (block): block is { type: 'text'; text: string } =>
            block.type === 'text',
        )?.text
  if (!raw) return 'Branched conversation'
  return (
    raw.replace(/\s+/g, ' ').trim().slice(0, 100) || 'Branched conversation'
  )
}

export async function getUniqueForkName(
  baseName: string,
  projectDirPath: string,
): Promise<string> {
  const existingTitles = new Set(
    (await listExistingTitles(projectDirPath))
      .map((title) => title.trim())
      .filter(Boolean),
  )

  const candidateName = `${baseName} (Branch)`
  if (!existingTitles.has(candidateName)) {
    return candidateName
  }

  const usedNumbers = new Set<number>([1])
  const forkNumberPattern = new RegExp(
    `^${escapeRegExp(baseName)} \\(Branch(?: (\\d+))?\\)$`,
  )

  for (const title of existingTitles) {
    const match = title.match(forkNumberPattern)
    if (!match) continue
    usedNumbers.add(match[1] ? parseInt(match[1], 10) : 1)
  }

  let nextNumber = 2
  while (usedNumbers.has(nextNumber)) {
    nextNumber++
  }
  return `${baseName} (Branch ${nextNumber})`
}

function buildPreservedMetadataEntries(
  sourceEntries: RawEntry[],
  copiedMessageIds: Set<string>,
  forkSessionId: UUID,
): RawEntry[] {
  return sourceEntries.flatMap((entry) => {
    if (isSessionMetaEntry(entry)) {
      return [entry]
    }

    if (isWorktreeStateEntry(entry) && entry.worktreeSession) {
      return [{
        ...entry,
        sessionId: forkSessionId,
        worktreeSession: {
          ...entry.worktreeSession,
          sessionId: forkSessionId,
        },
      }]
    }

    if (isModeEntry(entry)) {
      return [{ ...entry, sessionId: forkSessionId }]
    }

    if (isPrLinkEntry(entry)) {
      return [{ ...entry, sessionId: forkSessionId }]
    }

    if (isFileHistorySnapshotEntry(entry)) {
      const messageId = getSnapshotMessageId(entry)
      return messageId && copiedMessageIds.has(messageId) ? [entry] : []
    }

    if (isAttributionSnapshotEntry(entry)) {
      const messageId = getAttributionMessageId(entry)
      return messageId && copiedMessageIds.has(messageId) ? [entry] : []
    }

    return []
  })
}

function ensureSyntheticSessionMeta(
  preservedMetadataEntries: RawEntry[],
  sourceWorkDir: string | null | undefined,
  sourceRepository: unknown,
): RawEntry[] {
  const hasSessionMeta = preservedMetadataEntries.some(isSessionMetaEntry)
  if (hasSessionMeta || (!sourceWorkDir && sourceRepository === undefined)) {
    return preservedMetadataEntries
  }

  return [{
    type: 'session-meta',
    isMeta: true,
    ...(sourceWorkDir ? { workDir: sourceWorkDir } : {}),
    ...(sourceRepository !== undefined ? { repository: sourceRepository } : {}),
    timestamp: new Date().toISOString(),
  }, ...preservedMetadataEntries]
}

function ensureSyntheticWorktreeState(
  preservedMetadataEntries: RawEntry[],
  forkSessionId: UUID,
  sourceWorktreeSession: PersistedWorktreeSession | null | undefined,
): RawEntry[] {
  const hasWorktreeState = preservedMetadataEntries.some(isWorktreeStateEntry)
  if (hasWorktreeState || !sourceWorktreeSession) {
    return preservedMetadataEntries
  }

  return [{
    type: 'worktree-state',
    sessionId: forkSessionId,
    worktreeSession: {
      ...sourceWorktreeSession,
      sessionId: forkSessionId,
    },
  }, ...preservedMetadataEntries]
}

type CreateSessionBranchInternalOptions = CreateSessionBranchOptions & {
  buildDurablePlanOnly?: (plan: DurableBranchPlan) => void
}

export async function buildDurableBranchPlan(
  options: CreateSessionBranchOptions & {
    durableOperation: NonNullable<CreateSessionBranchOptions['durableOperation']>
    targetSessionId: UUID
  },
): Promise<DurableBranchPlan> {
  let plan: DurableBranchPlan | undefined
  await createSessionBranch({
    ...options,
    buildDurablePlanOnly: (candidate) => {
      plan = candidate
    },
  } as CreateSessionBranchInternalOptions)
  if (!plan) throw new Error('Durable branch plan was not built')
  return plan
}

export async function installDurableBranchPlan(
  forkPath: string,
  plan: DurableBranchPlan,
): Promise<void> {
  const digest = createHash('sha256').update(plan.body).digest('hex')
  if (digest !== plan.sha256) {
    throw new SessionBranchingError('INVALID_TARGET', 'durable branch plan digest is invalid')
  }
  const temporaryPath = `${forkPath}.${randomUUID()}.tmp`
  let primaryError: unknown
  let installationComplete = false
  try {
    await writeFile(temporaryPath, plan.body, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    try {
      // link publishes the completely-written temporary inode without allowing
      // a competing operation to replace an existing transcript.
      await link(temporaryPath, forkPath)
      installationComplete = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      const existingTarget = await lstat(forkPath).catch(() => null)
      if (!existingTarget?.isFile()) {
        throw new SessionBranchingError('INVALID_TARGET', 'branch identity is already in use')
      }
      const existingBody = await readFile(forkPath, 'utf8')
      if (existingBody !== plan.body) {
        throw new SessionBranchingError('INVALID_TARGET', 'branch identity is already in use')
      }
      installationComplete = true
    }
  } catch (error) {
    primaryError = error
    throw error
  } finally {
    try {
      await unlink(temporaryPath)
    } catch (error) {
      console.warn('[SessionBranching] durable branch temporary cleanup failed')
      // Publication is already durable. Reporting this as a terminal failure
      // would make a successfully installed branch unrecoverable on replay.
      if (!primaryError && !installationComplete) throw error
    }
  }
}

export async function createSessionBranch(
  options: CreateSessionBranchOptions,
): Promise<SessionBranchResult> {
  const {
    sourceSessionId,
    sourceTranscriptPath,
    title,
    targetMessageId,
    sourceWorkDir,
    sourceRepository,
    sourceWorktreeSession,
    targetSessionId,
    targetWorkDir,
    targetRepository,
    durableOperation,
    durablePlan,
  } = options
  const buildDurablePlanOnly = (options as CreateSessionBranchInternalOptions).buildDurablePlanOnly

  const projectDirPath = path.dirname(sourceTranscriptPath)
  const forkSessionId = targetSessionId ?? randomUUID() as UUID
  const forkPath = path.join(projectDirPath, `${forkSessionId}.jsonl`)

  if (durableOperation && !title) {
    throw new SessionBranchingError('INVALID_TARGET', 'durable branches require an explicit title')
  }
  if (durablePlan) {
    if (
      durablePlan.targetSessionId !== forkSessionId ||
      path.basename(durablePlan.forkPath) !== `${forkSessionId}.jsonl` ||
      !path.isAbsolute(durablePlan.forkPath) ||
      (targetMessageId !== undefined && durablePlan.targetMessageId !== targetMessageId)
    ) {
      throw new SessionBranchingError('INVALID_TARGET', 'durable branch plan does not match its target')
    }
    await installDurableBranchPlan(durablePlan.forkPath, durablePlan)
    return {
      sessionId: forkSessionId,
      title: durablePlan.title,
      forkPath: durablePlan.forkPath,
      workDir: targetWorkDir ?? sourceWorkDir ?? null,
      serializedMessages: [],
      contentReplacementRecords: [],
    }
  }

  const sourceEntries = await readRawEntries(sourceTranscriptPath).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SessionBranchingError(
        'SOURCE_NOT_FOUND',
        `Session not found: ${sourceSessionId}`,
      )
    }
    throw error
  })

  const transcript = await loadTranscriptFile(sourceTranscriptPath, {
    keepAllLeaves: true,
  })
  const activeLeaf = findLatestActiveLeaf(transcript.messages, transcript.leafUuids)
  if (!activeLeaf) {
    throw new SessionBranchingError(
      'NO_BRANCHABLE_MESSAGES',
      'No conversation to branch',
    )
  }

  const activeChain = buildConversationChain(transcript.messages, activeLeaf)
    .filter((message) => !message.isSidechain)

  if (activeChain.length === 0) {
    throw new SessionBranchingError(
      'NO_BRANCHABLE_MESSAGES',
      'No conversation to branch',
    )
  }

  const targetIndex = targetMessageId
    ? activeChain.findIndex((message) => message.uuid === targetMessageId)
    : activeChain.length - 1

  if (targetIndex < 0) {
    throw new SessionBranchingError(
      'INVALID_TARGET',
      'targetMessageId must reference a main conversation message in the active chain',
    )
  }

  const copiedMessages = activeChain.slice(0, targetIndex + 1)
  if (copiedMessages.length === 0) {
    throw new SessionBranchingError(
      'NO_BRANCHABLE_MESSAGES',
      'No messages to branch',
    )
  }

  const copiedMessageIds = new Set(copiedMessages.map((message) => message.uuid))
  const sourceMessageEntriesById = new Map(
    sourceEntries
      .filter(
        (entry): entry is TranscriptMessage =>
          isTranscriptEntry(entry) &&
          entry.isSidechain !== true &&
          copiedMessageIds.has(entry.uuid),
      )
      .map((entry) => [entry.uuid, entry]),
  )
  const branchMessageEntries = copiedMessages.flatMap((message) => {
    const entry = sourceMessageEntriesById.get(message.uuid)
    return entry ? [entry] : []
  })

  if (branchMessageEntries.length === 0) {
    throw new SessionBranchingError(
      'NO_BRANCHABLE_MESSAGES',
      'No messages to branch',
    )
  }

  const copiedToolResultIds = new Set(
    copiedMessages.flatMap((message) => extractToolResultIds(message)),
  )
  const contentReplacementRecords = (
    transcript.contentReplacements.get(sourceSessionId as UUID) ?? []
  ).filter((record) => copiedToolResultIds.has(record.toolUseId))

  await mkdir(projectDirPath, { recursive: true, mode: 0o700 })

  const serializedMessages: SerializedMessage[] = []
  const messageLines: string[] = []
  let parentUuid: UUID | null = null

  for (const entry of branchMessageEntries) {
    const forkedEntry: TranscriptEntry = {
      ...entry,
      sessionId: forkSessionId,
      parentUuid,
      isSidechain: false,
      forkedFrom: {
        sessionId: sourceSessionId,
        messageUuid: entry.uuid,
      },
    }

    serializedMessages.push({
      ...entry,
      sessionId: forkSessionId,
    })
    messageLines.push(jsonStringify(forkedEntry))
    parentUuid = entry.uuid
  }

  const firstPrompt = deriveFirstPrompt(
    serializedMessages.find(
      (message): message is Extract<SerializedMessage, { type: 'user' }> =>
        message.type === 'user',
    ),
  )
  const effectiveTitle = durableOperation && title
    ? title
    : await getUniqueForkName(title ?? firstPrompt, projectDirPath)

  let metadataEntries = buildPreservedMetadataEntries(
    sourceEntries,
    copiedMessageIds,
    forkSessionId,
  )
  const hasTargetWorkspace =
    targetWorkDir !== undefined || targetRepository !== undefined

  // A new workspace must not retain a source worktree-state record: it would
  // point this branch at the source session's linked checkout.
  if (hasTargetWorkspace) {
    metadataEntries = metadataEntries.filter((entry) => !isWorktreeStateEntry(entry))
  }

  metadataEntries = ensureSyntheticSessionMeta(
    metadataEntries,
    sourceWorkDir ?? null,
    sourceRepository,
  )
  if (!hasTargetWorkspace) {
    metadataEntries = ensureSyntheticWorktreeState(
      metadataEntries,
      forkSessionId,
      sourceWorktreeSession,
    )
  }
  if (durableOperation) {
    metadataEntries = [{
      type: 'session-meta',
      isMeta: true,
      coreOperation: durableOperation,
      timestamp: new Date().toISOString(),
    }, ...metadataEntries]
  }

  // Put this after copied messages so it is authoritative even for legacy
  // transcript entries that happened to contain repository metadata.
  const targetWorkspaceMetadataEntry: SessionMetaEntry | undefined = hasTargetWorkspace
    ? {
        type: 'session-meta',
        isMeta: true,
        ...(targetWorkDir !== undefined ? { workDir: targetWorkDir } : {}),
        ...(targetRepository !== undefined ? { repository: targetRepository } : {}),
        timestamp: new Date().toISOString(),
      }
    : undefined

  const lines = [
    ...metadataEntries.map((entry) => jsonStringify(entry)),
    ...messageLines,
    ...(targetWorkspaceMetadataEntry ? [jsonStringify(targetWorkspaceMetadataEntry)] : []),
  ]

  if (contentReplacementRecords.length > 0) {
    lines.push(jsonStringify({
      type: 'content-replacement',
      sessionId: forkSessionId,
      replacements: contentReplacementRecords,
    } satisfies ContentReplacementEntry))
  }

  lines.push(jsonStringify({
    type: 'custom-title',
    sessionId: forkSessionId,
    customTitle: effectiveTitle,
  }))

  const body = `${lines.join('\n')}\n`
  if (durableOperation) {
    const plan: DurableBranchPlan = {
      targetSessionId: forkSessionId,
      sourceSessionId,
      sourceTranscriptPath: path.resolve(sourceTranscriptPath),
      sourceMessageIds: branchMessageEntries.map((entry) => entry.uuid),
      forkPath,
      projectDirPath,
      targetMessageId: copiedMessages.at(-1)!.uuid,
      title: effectiveTitle,
      body,
      sha256: createHash('sha256').update(body).digest('hex'),
    }
    if (buildDurablePlanOnly) {
      buildDurablePlanOnly(plan)
    } else {
      await installDurableBranchPlan(forkPath, plan)
    }
  } else {
    await writeFile(forkPath, body, {
      encoding: 'utf8',
      mode: 0o600,
    })
  }

  const workDirFromMetadata =
    targetWorkDir ??
    (
      metadataEntries.findLast(isSessionMetaEntry)?.workDir as string | undefined
    ) ??
    sourceWorkDir ??
    branchMessageEntries.findLast((entry) => typeof entry.cwd === 'string')?.cwd ??
    null

  return {
    sessionId: forkSessionId,
    title: effectiveTitle,
    forkPath,
    workDir: workDirFromMetadata,
    serializedMessages,
    contentReplacementRecords,
  }
}
