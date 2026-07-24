import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  publicVoiceOperationSchema,
  transcriptSchema,
  voiceOperationSchema,
  type PublicVoiceOperation,
  type Transcript,
  type TranscriptBinding,
  type TranscriptRevision,
  type VoiceConsumer,
  type VoiceConsumerEvidence,
  type VoiceOperation,
} from '../../../shared/contracts/voice.js'
import { lock } from '../../utils/lockfile.js'

const DEFAULT_RETENTION_DAYS = 30

export class VoiceOperationError extends Error {
  constructor(
    message: string,
    readonly status = 422,
    readonly code = 'VOICE_OPERATION_INVALID',
  ) {
    super(message)
    this.name = 'VoiceOperationError'
  }
}

export type VoiceOperationServiceOptions = {
  root?: string
  now?: () => Date
  retentionDays?: number
}

function id(prefix: 'voice' | 'transcript' | 'revision' | 'binding'): string {
  return `${prefix}_${randomUUID().replaceAll('-', '')}`
}

function missing(code: string): VoiceOperationError {
  return new VoiceOperationError('语音记录不存在', 404, code)
}

/**
 * Durable product voice history. Audio bytes are deliberately never persisted:
 * the request body goes straight to the managed gateway and only its digest,
 * raw transcript and immutable user revisions enter this store.
 */
export class VoiceOperationService {
  private readonly root: string
  private readonly operationsDir: string
  private readonly transcriptsDir: string
  private readonly locksDir: string
  private readonly now: () => Date
  private readonly retentionDays: number
  private readonly active = new Map<string, AbortController>()

  constructor(options: VoiceOperationServiceOptions = {}) {
    this.root = options.root ?? join(
      process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude'),
      'billiardbuddy',
      'voice',
    )
    this.operationsDir = join(this.root, 'operations')
    this.transcriptsDir = join(this.root, 'transcripts')
    this.locksDir = join(this.root, 'locks')
    this.now = options.now ?? (() => new Date())
    this.retentionDays = Math.max(1, Math.min(365, Math.trunc(
      options.retentionDays ?? Number(process.env.BB_VOICE_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS),
    ) || DEFAULT_RETENTION_DAYS))
  }

  private iso(): string {
    return this.now().toISOString()
  }

  private async ensureDirs(): Promise<void> {
    await Promise.all([
      mkdir(this.operationsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.transcriptsDir, { recursive: true, mode: 0o700 }),
      mkdir(this.locksDir, { recursive: true, mode: 0o700 }),
    ])
  }

  private path(dir: string, entityId: string): string {
    if (!/^(?:voice|transcript)_[a-f0-9]{32}$/.test(entityId)) {
      throw new VoiceOperationError('语音记录 ID 无效', 400, 'VOICE_ID_INVALID')
    }
    return join(dir, `${entityId}.json`)
  }

  private operationPath(operationId: string): string {
    return this.path(this.operationsDir, operationId)
  }

  private transcriptPath(transcriptId: string): string {
    return this.path(this.transcriptsDir, transcriptId)
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    const temporary = `${path}.tmp-${randomUUID()}`
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temporary, path)
  }

  private async withLock<T>(entityId: string, action: () => Promise<T>): Promise<T> {
    await this.ensureDirs()
    const guard = join(this.locksDir, `${entityId}.guard`)
    await writeFile(guard, '', { flag: 'a', mode: 0o600 })
    const release = await lock(guard, {
      stale: 30_000,
      retries: { retries: 100, minTimeout: 5, maxTimeout: 25 },
    })
    try {
      return await action()
    } finally {
      await release()
    }
  }

  private async readOperation(operationId: string): Promise<VoiceOperation> {
    return readFile(this.operationPath(operationId), 'utf8')
      .then(value => voiceOperationSchema.parse(JSON.parse(value)))
      .catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing('VOICE_OPERATION_NOT_FOUND')
        throw error
      })
  }

  async getTranscript(transcriptId: string): Promise<Transcript> {
    return readFile(this.transcriptPath(transcriptId), 'utf8')
      .then(value => transcriptSchema.parse(JSON.parse(value)))
      .catch(error => {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw missing('TRANSCRIPT_NOT_FOUND')
        throw error
      })
  }

  async begin(
    file: File,
    consentReceiptId: string,
  ): Promise<{ operation: PublicVoiceOperation; signal: AbortSignal }> {
    await this.ensureDirs()
    const bytes = new Uint8Array(await file.arrayBuffer())
    const now = this.iso()
    const operation: VoiceOperation = voiceOperationSchema.parse({
      schema_version: 1,
      id: id('voice'),
      status: 'running',
      source: {
        name: file.name || 'recording',
        mime_type: file.type || 'application/octet-stream',
        byte_size: file.size,
        content_hash: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      },
      consent_receipt_id: consentReceiptId,
      created_at: now,
      updated_at: now,
    })
    const controller = new AbortController()
    this.active.set(operation.id, controller)
    await this.writeJson(this.operationPath(operation.id), operation)
    return { operation: publicVoiceOperationSchema.parse(operation), signal: controller.signal }
  }

  async getOperation(operationId: string): Promise<PublicVoiceOperation> {
    let operation = await this.readOperation(operationId)
    if (operation.status === 'running' && !this.active.has(operationId)) {
      operation = await this.withLock(operationId, async () => {
        const current = await this.readOperation(operationId)
        if (current.status !== 'running' || this.active.has(operationId)) return current
        const at = this.iso()
        const interrupted = voiceOperationSchema.parse({
          ...current,
          status: 'failed',
          error_code: 'INTERRUPTED',
          updated_at: at,
          finished_at: at,
        })
        await this.writeJson(this.operationPath(operationId), interrupted)
        return interrupted
      })
    }
    return publicVoiceOperationSchema.parse(operation)
  }

  async complete(operationId: string, text: string): Promise<{ operation: PublicVoiceOperation; transcript: Transcript }> {
    try {
      return await this.withLock(operationId, async () => {
        const operation = await this.readOperation(operationId)
        if (operation.status === 'cancelled') {
          throw new VoiceOperationError('语音转写已取消', 499, 'VOICE_TRANSCRIPTION_CANCELLED')
        }
        if (operation.status === 'succeeded' && operation.transcript_id) {
          return {
            operation: publicVoiceOperationSchema.parse(operation),
            transcript: await this.getTranscript(operation.transcript_id),
          }
        }
        if (operation.status !== 'running') {
          throw new VoiceOperationError('语音转写已结束', 409, 'VOICE_OPERATION_SETTLED')
        }
        const normalized = text.trim()
        if (!normalized) throw new VoiceOperationError('语音转写结果为空', 502, 'VOICE_TRANSCRIPTION_INVALID_RESULT')
        const at = this.iso()
        const transcriptId = id('transcript')
        const revisionId = id('revision')
        const rawRevision: TranscriptRevision = {
          id: revisionId,
          transcript_id: transcriptId,
          kind: 'raw',
          text: normalized,
          created_at: at,
        }
        const transcript = transcriptSchema.parse({
          schema_version: 1,
          id: transcriptId,
          operation_id: operationId,
          raw_revision_id: revisionId,
          current_revision_id: revisionId,
          revisions: [rawRevision],
          bindings: [],
          created_at: at,
          updated_at: at,
        })
        await this.writeJson(this.transcriptPath(transcriptId), transcript)
        const completed = voiceOperationSchema.parse({
          ...operation,
          status: 'succeeded',
          transcript_id: transcriptId,
          raw_revision_id: revisionId,
          updated_at: at,
          finished_at: at,
        })
        await this.writeJson(this.operationPath(operationId), completed)
        return { operation: publicVoiceOperationSchema.parse(completed), transcript }
      })
    } finally {
      this.active.delete(operationId)
    }
  }

  async fail(operationId: string): Promise<PublicVoiceOperation> {
    try {
      return await this.withLock(operationId, async () => {
        const operation = await this.readOperation(operationId)
        if (operation.status !== 'running') return publicVoiceOperationSchema.parse(operation)
        const at = this.iso()
        const failed = voiceOperationSchema.parse({
          ...operation,
          status: 'failed',
          error_code: 'TRANSCRIPTION_FAILED',
          updated_at: at,
          finished_at: at,
        })
        await this.writeJson(this.operationPath(operationId), failed)
        return publicVoiceOperationSchema.parse(failed)
      })
    } finally {
      this.active.delete(operationId)
    }
  }

  async cancel(operationId: string): Promise<PublicVoiceOperation> {
    this.active.get(operationId)?.abort(new Error('voice operation cancelled'))
    try {
      return await this.withLock(operationId, async () => {
        const operation = await this.readOperation(operationId)
        if (operation.status !== 'running') return publicVoiceOperationSchema.parse(operation)
        const at = this.iso()
        const cancelled = voiceOperationSchema.parse({
          ...operation,
          status: 'cancelled',
          updated_at: at,
          finished_at: at,
        })
        await this.writeJson(this.operationPath(operationId), cancelled)
        return publicVoiceOperationSchema.parse(cancelled)
      })
    } finally {
      this.active.delete(operationId)
    }
  }

  async revise(
    transcriptId: string,
    input: { parent_revision_id: string; text: string },
  ): Promise<Transcript> {
    return await this.withLock(transcriptId, async () => {
      const transcript = await this.getTranscript(transcriptId)
      if (input.parent_revision_id !== transcript.current_revision_id) {
        throw new VoiceOperationError('转写文本已被更新，请刷新后重试', 409, 'TRANSCRIPT_REVISION_CONFLICT')
      }
      const parent = transcript.revisions.find(revision => revision.id === input.parent_revision_id)
      if (!parent) throw missing('TRANSCRIPT_REVISION_NOT_FOUND')
      const text = input.text.trim()
      if (!text) throw new VoiceOperationError('转写文本不能为空', 400, 'TRANSCRIPT_TEXT_INVALID')
      const at = this.iso()
      const revision: TranscriptRevision = {
        id: id('revision'),
        transcript_id: transcriptId,
        parent_revision_id: parent.id,
        kind: 'edit',
        text,
        created_at: at,
      }
      const next = transcriptSchema.parse({
        ...transcript,
        current_revision_id: revision.id,
        revisions: [...transcript.revisions, revision],
        updated_at: at,
      })
      await this.writeJson(this.transcriptPath(transcriptId), next)
      return next
    })
  }

  async bind(
    transcriptId: string,
    input: { revision_id: string; consumer: VoiceConsumer },
  ): Promise<Transcript> {
    return await this.withLock(transcriptId, async () => {
      const transcript = await this.getTranscript(transcriptId)
      if (!transcript.revisions.some(revision => revision.id === input.revision_id)) {
        throw missing('TRANSCRIPT_REVISION_NOT_FOUND')
      }
      const existing = transcript.bindings.find(binding => (
        binding.revision_id === input.revision_id
        && binding.consumer.kind === input.consumer.kind
        && binding.consumer.id === input.consumer.id
      ))
      if (existing) return transcript
      const binding: TranscriptBinding = {
        id: id('binding'),
        revision_id: input.revision_id,
        consumer: input.consumer,
        created_at: this.iso(),
      }
      const next = transcriptSchema.parse({
        ...transcript,
        bindings: [...transcript.bindings, binding],
        updated_at: binding.created_at,
      })
      await this.writeJson(this.transcriptPath(transcriptId), next)
      return next
    })
  }

  async listBound(consumer: VoiceConsumer): Promise<VoiceConsumerEvidence[]> {
    await this.ensureDirs()
    const evidence: VoiceConsumerEvidence[] = []
    for (const entry of await readdir(this.transcriptsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^transcript_[a-f0-9]{32}\.json$/.test(entry.name)) continue
      const transcript = await this.getTranscript(entry.name.slice(0, -5))
      for (const binding of transcript.bindings) {
        if (binding.consumer.kind !== consumer.kind || binding.consumer.id !== consumer.id) continue
        const revision = transcript.revisions.find(candidate => candidate.id === binding.revision_id)
        if (revision) evidence.push({ transcript, binding, revision })
      }
    }
    return evidence.sort((left, right) => right.binding.created_at.localeCompare(left.binding.created_at))
  }

  async purgeExpired(): Promise<{ operations: number; transcripts: number }> {
    await this.ensureDirs()
    const cutoff = this.now().getTime() - this.retentionDays * 24 * 60 * 60 * 1000
    let operations = 0
    let transcripts = 0
    for (const entry of await readdir(this.operationsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/^voice_[a-f0-9]{32}\.json$/.test(entry.name)) continue
      const operationId = entry.name.slice(0, -5)
      await this.withLock(operationId, async () => {
        const operation = await this.readOperation(operationId)
        if (operation.status === 'running' || Date.parse(operation.updated_at) > cutoff) return
        if (operation.transcript_id) {
          const transcript = await this.getTranscript(operation.transcript_id).catch(() => null)
          if (transcript?.bindings.length) return
          if (transcript) {
            await rm(this.transcriptPath(transcript.id), { force: true })
            transcripts += 1
          }
        }
        await rm(this.operationPath(operationId), { force: true })
        operations += 1
      })
    }
    return { operations, transcripts }
  }
}

export const voiceOperationService = new VoiceOperationService()
