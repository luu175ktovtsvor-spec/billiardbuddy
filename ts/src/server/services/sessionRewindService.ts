import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import { createTwoFilesPatch, diffLines } from 'diff'
import { Workspace } from '../../workspace/workspace'
import type { ToolContext } from '../../tools/Tool'
import { fileHistoryBackupPath, loadFileHistory, restoreFileFromHistory, type FileHistoryRecord } from '../../tools/fileHistory'
import type { StampedHistoryRecord } from '../../memory/transcript'
import type { SessionMeta, SessionService, TurnRegistry } from './sessionService'

/** 回退/checkpoint 目标选择器(对齐 cc RewindTargetSelector 的对外形状)。 */
export interface RewindTargetSelector {
  targetUserMessageId?: string
  userMessageIndex?: number
  expectedContent?: string
}

export interface RewindCodePreview {
  available: boolean
  reason?: string
  filesChanged: string[]
  insertions: number
  deletions: number
}

export interface SessionRewindPreview {
  target: {
    targetUserMessageId: string
    userMessageIndex: number
    userMessageCount: number
  }
  conversation: {
    messagesRemoved: number
  }
  code: RewindCodePreview
}

export type SessionTurnCheckpointPreview = SessionRewindPreview & { workDir: string }

/** 单文件 diff 结果(对齐 cc SessionTurnCheckpointDiffResult):state 区分"有 diff/没有可用变更/读取出错"三态。 */
export interface SessionTurnCheckpointDiffResult {
  target: SessionRewindPreview['target']
  workDir: string
  path: string
  state: 'ok' | 'missing' | 'error'
  diff?: string
  error?: string
}

export type SessionRewindExecuteResult = SessionRewindPreview & {
  conversation: SessionRewindPreview['conversation'] & { removedMessageIds: string[] }
}

interface ResolvedRewindTarget {
  targetUserMessageId: string
  userMessageIndex: number
  userMessageCount: number
  messagesRemoved: number
}

interface TurnRange {
  userUuid: string
  /** 该轮在完整活跃链(stamped history)里的起始下标(= user 消息自身的下标)。 */
  start: number
  /** 该轮结束(不含,= 下一条 user 消息的下标,或链长度)。 */
  end: number
}

interface TurnFileChange {
  path: string
  insertions: number
  deletions: number
}

const INTERRUPT_WAIT_TIMEOUT_MS = 10_000
const INTERRUPT_POLL_INTERVAL_MS = 50

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function isTextBlock(block: unknown): block is { type: 'text'; text: string } {
  return !!block && typeof block === 'object' && (block as { type?: unknown }).type === 'text' && typeof (block as { text?: unknown }).text === 'string'
}

/** 从 user 消息的 content-block 数组里抠出纯文本(拼接所有 text 块),供 expectedContent 比对用。 */
function extractUserPromptText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content.filter(isTextBlock).map(b => b.text).join('\n')
}

function normalizePromptText(text: string): string {
  return text.replace(/\r\n/g, '\n').trim()
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

function countDiffStats(before: string, after: string): { insertions: number; deletions: number } {
  let insertions = 0
  let deletions = 0
  for (const change of diffLines(before, after)) {
    if (change.added) insertions += change.count || 0
    if (change.removed) deletions += change.count || 0
  }
  return { insertions, deletions }
}

function absPath(workspaceRoot: string, relPath: string): string {
  return isAbsolute(relPath) ? relPath : join(workspaceRoot, relPath)
}

/** 把请求方传来的路径(可能是绝对路径,也可能是相对工作区的路径)归一成 fileHistory 记录用的相对路径。 */
function relativeToWorkspace(workspaceRoot: string, requestedPath: string): string {
  const abs = isAbsolute(requestedPath) ? requestedPath : join(workspaceRoot, requestedPath)
  return relative(workspaceRoot, abs) || '.'
}

/** 按 path 分组,取每组"首条"(loadFileHistory 按 append 顺序返回,首个出现的即最早那条)。 */
function firstRecordPerPath(records: FileHistoryRecord[]): Map<string, FileHistoryRecord> {
  const out = new Map<string, FileHistoryRecord>()
  for (const r of records) {
    if (!out.has(r.path)) out.set(r.path, r)
  }
  return out
}

/**
 * 某条 fileHistory 记录的"前像"内容:existed=false → 空字符串(文件当时不存在);skippedReason(超 5MB / 非普通
 * 文件,没留真实备份内容)→ null(没法可靠读到,调用方应如实跳过、别编造数字);否则读备份文件本体。
 */
async function readRecordBackupContent(ctx: ToolContext, record: FileHistoryRecord): Promise<string | null> {
  if (!record.existed) return ''
  if (record.skippedReason) return null
  const backupPath = fileHistoryBackupPath(ctx, record)
  if (!backupPath) return null
  return await readTextOrNull(backupPath)
}

/** 活跃链按 user 消息切成"轮次"区间:[user_i, user_{i+1}) 或 [user_last, 链尾]。 */
function turnRanges(history: StampedHistoryRecord[]): TurnRange[] {
  const userIndices: number[] = []
  history.forEach((r, i) => { if (r.message.role === 'user') userIndices.push(i) })
  return userIndices.map((start, k) => ({
    userUuid: history[start]!.uuid,
    start,
    end: userIndices[k + 1] ?? history.length,
  }))
}

/** 某区间(不含起点的 user 消息自身)里全部 assistant 消息的 uuid——fileHistory 记录按这些 uuid 归到所属轮次。 */
function assistantUuidsInRange(history: StampedHistoryRecord[], start: number, end: number): Set<string> {
  const out = new Set<string>()
  for (let i = start + 1; i < end; i++) {
    if (history[i]!.message.role === 'assistant') out.add(history[i]!.uuid)
  }
  return out
}

/** 从 fromIndex(含)起到链尾,全部 assistant 消息 uuid——"目标轮起(含)之后"要移除/预览的全部改动都绑在这些 uuid 上。 */
function assistantUuidsFromIndex(history: StampedHistoryRecord[], fromIndex: number): Set<string> {
  const out = new Set<string>()
  for (let i = fromIndex; i < history.length; i++) {
    if (history[i]!.message.role === 'assistant') out.add(history[i]!.uuid)
  }
  return out
}

/**
 * 某轮"本轮变更"= diff(该轮首条该文件记录的前像, 下一轮首条该文件记录的前像 ?? 当前盘上内容)
 * (对齐 cc getTurnBoundaryContents 语义)。前像/后像任一读不到(skippedReason)就如实跳过该文件,不编造数字。
 */
async function computeTurnFileChanges(
  ctx: ToolContext,
  workspaceRoot: string,
  records: FileHistoryRecord[],
  turnAssistantUuids: Set<string>,
  nextTurnAssistantUuids: Set<string> | null,
): Promise<TurnFileChange[]> {
  const turnRecords = records.filter(r => r.messageId !== undefined && turnAssistantUuids.has(r.messageId))
  if (turnRecords.length === 0) return []
  const firstByPath = firstRecordPerPath(turnRecords)
  const nextFirstByPath = nextTurnAssistantUuids
    ? firstRecordPerPath(records.filter(r => r.messageId !== undefined && nextTurnAssistantUuids.has(r.messageId)))
    : new Map<string, FileHistoryRecord>()

  const changes: TurnFileChange[] = []
  for (const [path, record] of firstByPath) {
    const before = await readRecordBackupContent(ctx, record)
    if (before === null) continue

    const nextRecord = nextFirstByPath.get(path)
    let after: string | null
    if (nextRecord) {
      after = await readRecordBackupContent(ctx, nextRecord)
      if (after === null) continue
    } else {
      after = (await readTextOrNull(absPath(workspaceRoot, path))) ?? ''
    }

    if (before === after) continue
    const stats = countDiffStats(before, after)
    changes.push({ path, insertions: stats.insertions, deletions: stats.deletions })
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * rewind/checkpoint 上层服务(对标 cc-haha sessionRewindService,存储机制走我们自己的 append-only 模型):
 * - listTurnCheckpoints:按轮次聚合 fileHistory 记录 → 每轮的文件改动预览(供"按轮次回退"UI 列表)。
 * - getSessionTurnCheckpointDiff:定位到某轮 + 某个具体文件,算出该轮对这个文件的 unified diff 文本
 *   (对齐 cc getSessionTurnCheckpointDiff,供"展开某个 checkpoint 看这个文件到底改了什么"用)。
 * - previewRewind/executeRewind:回退到某条 user 消息之前——预览算"回退会改动哪些文件",执行则真的把文件
 *   恢复回目标之前的状态 + 把 transcript 活跃链掰回去(Transcript.rewindTo,append-only、不重写历史)。
 *
 * 与 cc-haha 的有意分叉(详见 docs/alignment-notes.md):
 * 1) cc trimSessionMessagesFrom 是过滤后整份 transcript 重写;我们是追加一条 rewind-boundary 分支
 *    (Transcript.rewindTo),对外"活跃链被裁短"的行为等价,但存储上更贴近真 cc 的分支模型(append-only 保持)。
 * 2) cc 的 checkpoint 数据源是"每条 user 消息一份 trackedFileBackups 快照";我们从"每次写前像记录
 *    (绑 assistant messageId)"按轮次推导,数据形状不同但语义对齐。
 * 3) cc 执行中会话用 stopSessionAndWait 无界等；我们 interrupt + 最多 10s 轮询等停,超时报错不硬回退。
 */
export class SessionRewindService {
  constructor(
    private readonly sessions: SessionService,
    private readonly turns: TurnRegistry,
    private readonly stateRoot: string,
  ) {}

  async listTurnCheckpoints(sessionId: string): Promise<SessionTurnCheckpointPreview[]> {
    const session = await this.requireSession(sessionId)
    const workspaceRoot = session.workspaceRoot
    const history = await this.loadStampedHistory(sessionId, workspaceRoot)
    const userMessages = history.filter(r => r.message.role === 'user')
    if (userMessages.length === 0) return []

    const ctx = this.buildBaseCtx(sessionId, workspaceRoot)
    const records = await loadFileHistory(ctx)
    const ranges = turnRanges(history)
    const checkpoints: SessionTurnCheckpointPreview[] = []

    for (let i = 0; i < ranges.length; i++) {
      const range = ranges[i]!
      const turnUuids = assistantUuidsInRange(history, range.start, range.end)
      const nextRange = ranges[i + 1]
      const nextTurnUuids = nextRange ? assistantUuidsInRange(history, nextRange.start, nextRange.end) : null
      const changes = await computeTurnFileChanges(ctx, workspaceRoot, records, turnUuids, nextTurnUuids)
      if (changes.length === 0) continue // 没有文件变更的轮次跳过(对齐 cc)

      const userMessageIndex = userMessages.findIndex(r => r.uuid === range.userUuid)
      checkpoints.push({
        target: {
          targetUserMessageId: range.userUuid,
          userMessageIndex,
          userMessageCount: userMessages.length,
        },
        conversation: {
          messagesRemoved: history.length - range.start,
        },
        code: {
          available: true,
          filesChanged: changes.map(c => absPath(workspaceRoot, c.path)),
          insertions: changes.reduce((s, c) => s + c.insertions, 0),
          deletions: changes.reduce((s, c) => s + c.deletions, 0),
        },
        workDir: workspaceRoot,
      })
    }

    return checkpoints
  }

  /**
   * 单文件 diff(对齐 cc getSessionTurnCheckpointDiff):给定回退目标(某条 user 消息,= 一个"轮次")与具体
   * 文件路径,算出"该轮对这个文件的改动"的 unified diff 文本。复用 listTurnCheckpoints 同一套"按轮次首条
   * fileHistory 记录取前像/下一轮首条记录取后像 ?? 当前盘上内容"的语义(见 computeTurnFileChanges),只是
   * 聚焦单个 path 并额外产出 diff 正文(而不只是行数统计)。本轮只补服务层能力,HTTP 路由不在本次改动范围。
   */
  async getSessionTurnCheckpointDiff(
    sessionId: string,
    selector: RewindTargetSelector,
    requestedPath: string,
  ): Promise<SessionTurnCheckpointDiffResult> {
    const session = await this.requireSession(sessionId)
    const workspaceRoot = session.workspaceRoot
    const history = await this.loadStampedHistory(sessionId, workspaceRoot)
    const target = this.resolveTarget(history, selector)
    const targetView = {
      targetUserMessageId: target.targetUserMessageId,
      userMessageIndex: target.userMessageIndex,
      userMessageCount: target.userMessageCount,
    }
    const normalizedPath = relativeToWorkspace(workspaceRoot, requestedPath)
    const displayPath = absPath(workspaceRoot, normalizedPath)
    const missing = (): SessionTurnCheckpointDiffResult => ({ target: targetView, workDir: workspaceRoot, path: displayPath, state: 'missing' })

    const ranges = turnRanges(history)
    const rangeIndex = ranges.findIndex(r => r.userUuid === target.targetUserMessageId)
    if (rangeIndex === -1) return missing()
    const range = ranges[rangeIndex]!
    const nextRange = ranges[rangeIndex + 1]
    const turnUuids = assistantUuidsInRange(history, range.start, range.end)
    const nextTurnUuids = nextRange ? assistantUuidsInRange(history, nextRange.start, nextRange.end) : null

    const ctx = this.buildBaseCtx(sessionId, workspaceRoot)
    const records = await loadFileHistory(ctx)
    const turnRecords = records.filter(r => r.messageId !== undefined && turnUuids.has(r.messageId) && r.path === normalizedPath)
    if (turnRecords.length === 0) return missing() // 该轮没碰过这个文件

    try {
      // 首条(append 顺序里最早那条)= 本轮对该文件的前像,对齐 computeTurnFileChanges 的 firstRecordPerPath。
      const record = turnRecords[0]!
      const before = await readRecordBackupContent(ctx, record)
      if (before === null) return missing() // skippedReason,没留真实备份内容,如实跳过、不编数字

      const nextRecords = nextTurnUuids
        ? records.filter(r => r.messageId !== undefined && nextTurnUuids.has(r.messageId) && r.path === normalizedPath)
        : []
      const nextRecord = nextRecords[0]

      let after: string
      let afterExists: boolean
      if (nextRecord) {
        const nextContent = await readRecordBackupContent(ctx, nextRecord)
        if (nextContent === null) return missing()
        after = nextContent
        afterExists = nextRecord.existed
      } else {
        const disk = await readTextOrNull(absPath(workspaceRoot, normalizedPath))
        after = disk ?? ''
        afterExists = disk !== null
      }

      if (before === after) return missing() // 本轮没有实际改动这个文件

      const diff = createTwoFilesPatch(
        record.existed ? `a/${normalizedPath}` : '/dev/null',
        afterExists ? `b/${normalizedPath}` : '/dev/null',
        before,
        after,
        '', '',
        { context: 3 },
      )
      return { target: targetView, workDir: workspaceRoot, path: displayPath, state: 'ok', diff }
    } catch (err) {
      return { target: targetView, workDir: workspaceRoot, path: displayPath, state: 'error', error: err instanceof Error ? err.message : String(err) }
    }
  }

  async previewRewind(sessionId: string, selector: RewindTargetSelector): Promise<SessionRewindPreview> {
    const session = await this.requireSession(sessionId)
    const workspaceRoot = session.workspaceRoot
    const history = await this.loadStampedHistory(sessionId, workspaceRoot)
    const target = this.resolveTarget(history, selector)
    const ctx = this.buildBaseCtx(sessionId, workspaceRoot)
    const code = await this.buildRewindCodePreview(ctx, workspaceRoot, history, target)
    return {
      target: {
        targetUserMessageId: target.targetUserMessageId,
        userMessageIndex: target.userMessageIndex,
        userMessageCount: target.userMessageCount,
      },
      conversation: { messagesRemoved: target.messagesRemoved },
      code,
    }
  }

  async executeRewind(sessionId: string, selector: RewindTargetSelector): Promise<SessionRewindExecuteResult> {
    const session = await this.requireSession(sessionId)
    const workspaceRoot = session.workspaceRoot
    const history = await this.loadStampedHistory(sessionId, workspaceRoot)
    const target = this.resolveTarget(history, selector)
    const ctx = this.buildBaseCtx(sessionId, workspaceRoot)
    // 先(在改动任何东西之前)算好预览要返回的 diff 统计——真正恢复之后,现盘内容就等于恢复源了,diff 会变成 0。
    const code = await this.buildRewindCodePreview(ctx, workspaceRoot, history, target)

    if (this.turns.isRunning(sessionId)) {
      this.turns.interrupt(sessionId)
      await this.waitUntilStopped(sessionId)
    }

    if (code.available) {
      const targetIndex = history.findIndex(r => r.uuid === target.targetUserMessageId)
      const removedAssistantUuids = assistantUuidsFromIndex(history, targetIndex)
      const records = await loadFileHistory(ctx)
      const relevantRecords = records.filter(r => r.messageId !== undefined && removedAssistantUuids.has(r.messageId))
      const earliestByPath = firstRecordPerPath(relevantRecords)
      for (const record of earliestByPath.values()) {
        if (record.skippedReason) continue // 没留真实备份内容,没法恢复,如实跳过
        await restoreFileFromHistory(ctx, { path: record.path, snapshot_id: record.id })
      }
    }

    const { removedUuids } = await this.sessions.transcript(sessionId, workspaceRoot).rewindTo(target.targetUserMessageId)

    await this.sessions.touch(sessionId, { status: 'idle' })
    await this.sessions
      .appendEvent(sessionId, { type: 'context_note', text: `会话已回退到更早的消息(移除 ${removedUuids.length} 条)` })
      .catch(() => undefined)

    return {
      target: {
        targetUserMessageId: target.targetUserMessageId,
        userMessageIndex: target.userMessageIndex,
        userMessageCount: target.userMessageCount,
      },
      conversation: {
        messagesRemoved: target.messagesRemoved,
        removedMessageIds: removedUuids,
      },
      code,
    }
  }

  private async requireSession(sessionId: string): Promise<SessionMeta> {
    const session = await this.sessions.get(sessionId)
    if (!session) throw new Error(`会话不存在: ${sessionId}`)
    return session
  }

  private async loadStampedHistory(sessionId: string, workspaceRoot: string): Promise<StampedHistoryRecord[]> {
    return await this.sessions.transcript(sessionId, workspaceRoot).loadFullHistoryStamped()
  }

  private buildBaseCtx(sessionId: string, workspaceRoot: string): ToolContext {
    return { workspace: new Workspace(workspaceRoot), stateRoot: this.stateRoot, conversationId: sessionId }
  }

  /** 解析/校验回退目标(照抄 cc resolveRewindTarget 的语义):id 优先、不是 user 消息报错、expectedContent 归一化比对不匹配报错。 */
  private resolveTarget(history: StampedHistoryRecord[], selector: RewindTargetSelector): ResolvedRewindTarget {
    const userMessages = history.filter(r => r.message.role === 'user')
    if (userMessages.length === 0) throw new Error('该会话没有可回退的 user 消息。')

    let target: StampedHistoryRecord | undefined
    let userMessageIndex = -1

    if (selector.targetUserMessageId) {
      const found = history.find(r => r.uuid === selector.targetUserMessageId)
      if (found) {
        if (found.message.role !== 'user') throw new Error('回退目标不是 user 消息。')
        target = found
        userMessageIndex = userMessages.findIndex(r => r.uuid === found.uuid)
      }
    }

    if (!target && Number.isInteger(selector.userMessageIndex)) {
      const idx = selector.userMessageIndex!
      if (idx >= 0 && idx < userMessages.length) {
        target = userMessages[idx]
        userMessageIndex = idx
      }
    }

    if (!target || userMessageIndex < 0) {
      throw new Error(`回退目标无效,需要 targetUserMessageId,或 0-${userMessages.length - 1} 范围内的 userMessageIndex。`)
    }

    if (selector.expectedContent !== undefined) {
      const actual = normalizePromptText(extractUserPromptText(target.message.content))
      const expected = normalizePromptText(selector.expectedContent)
      if (actual !== expected) throw new Error('回退目标的内容与所选提示词不一致,请刷新会话后重试。')
    }

    const activeIndex = history.findIndex(r => r.uuid === target!.uuid)
    return {
      targetUserMessageId: target.uuid,
      userMessageIndex,
      userMessageCount: userMessages.length,
      messagesRemoved: history.length - activeIndex,
    }
  }

  /**
   * 回退预览的 code 部分:"回退到目标轮之前"——目标轮起(含)之后所有被动过的 path,每个取最早一条记录作恢复源,
   * diff(当前盘上内容, 恢复源前像)算 insertions/deletions(顺序对齐 cc:insertions = 恢复后会多出的行)。
   * 没有任何记录 → available:false + reason(文案对齐 cc 的两级兜底)。
   */
  private async buildRewindCodePreview(
    ctx: ToolContext,
    workspaceRoot: string,
    history: StampedHistoryRecord[],
    target: ResolvedRewindTarget,
  ): Promise<RewindCodePreview> {
    const records = await loadFileHistory(ctx)
    if (records.length === 0) {
      return { available: false, reason: 'No file checkpoints were recorded for this session.', filesChanged: [], insertions: 0, deletions: 0 }
    }

    const targetIndex = history.findIndex(r => r.uuid === target.targetUserMessageId)
    const removedAssistantUuids = assistantUuidsFromIndex(history, targetIndex)
    const relevantRecords = records.filter(r => r.messageId !== undefined && removedAssistantUuids.has(r.messageId))
    if (relevantRecords.length === 0) {
      return { available: false, reason: 'No file checkpoint is available for the selected message.', filesChanged: [], insertions: 0, deletions: 0 }
    }

    const earliestByPath = firstRecordPerPath(relevantRecords)
    const filesChanged: string[] = []
    let insertions = 0
    let deletions = 0
    for (const [path, record] of earliestByPath) {
      const restoreSource = await readRecordBackupContent(ctx, record)
      if (restoreSource === null) continue
      const current = (await readTextOrNull(absPath(workspaceRoot, path))) ?? ''
      if (current === restoreSource) continue
      filesChanged.push(absPath(workspaceRoot, path))
      const stats = countDiffStats(current, restoreSource)
      insertions += stats.insertions
      deletions += stats.deletions
    }

    return { available: true, filesChanged: filesChanged.sort(), insertions, deletions }
  }

  private async waitUntilStopped(sessionId: string): Promise<void> {
    const deadline = Date.now() + INTERRUPT_WAIT_TIMEOUT_MS
    while (this.turns.isRunning(sessionId)) {
      if (Date.now() >= deadline) throw new Error(`等待会话 ${sessionId} 停止超时(> ${INTERRUPT_WAIT_TIMEOUT_MS}ms),回退已取消。`)
      await sleep(INTERRUPT_POLL_INTERVAL_MS)
    }
  }
}
