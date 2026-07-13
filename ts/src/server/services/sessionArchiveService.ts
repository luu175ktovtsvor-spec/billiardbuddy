// 会话归档应用服务：压缩旧消息、备份原 transcript，再保存摘要视图。

import { copyFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { compactPipeline } from '../../context/compaction'
import { createInvokedSkillsMessage, restoreInvokedSkillsFromMessages } from '../../skills/invokedSkills'
import type { Model } from '../../types/model'
import { numberFrom } from '../requestParams'
import type { SessionService } from './sessionService'

interface SessionArchiveServiceDependencies {
  sessions: SessionService
  archiveRoot: string
  resolveModel: () => Promise<Model>
}

export class SessionArchiveError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export class SessionArchiveService {
  constructor(private readonly deps: SessionArchiveServiceDependencies) {}

  async archive(id: string, rawBody: Record<string, unknown>) {
    const session = await this.deps.sessions.get(id)
    if (!session) throw new SessionArchiveError('session not found', 404)
    if (session.status === 'running') throw new SessionArchiveError('session is running', 409)
    const model = await this.deps.resolveModel()

    const transcript = this.deps.sessions.transcript(id, session.workspaceRoot)
    const messages = await transcript.load()
    restoreInvokedSkillsFromMessages(messages, id)
    const invokedSkills = createInvokedSkillsMessage(id)
    const keepRecentMessages = Math.max(1, Math.min(100, numberFrom(rawBody.keepRecentMessages ?? rawBody.keep_recent_messages, 12)))
    const minOldMessages = Math.max(1, Math.min(20, numberFrom(rawBody.minOldMessages ?? rawBody.min_old_messages, 1)))
    const compacted = await compactPipeline({
      messages,
      model,
      force: true,
      postSummaryMessages: invokedSkills ? [invokedSkills] : [],
      keepRecentMessages,
      minOldMessages,
      readOnlyToolNames: new Set(),
    })
    if (!compacted.didCompact) {
      return { ok: false, archived: false, reason: 'not enough transcript messages to archive', messages: messages.length }
    }

    await mkdir(this.deps.archiveRoot, { recursive: true })
    const archivePath = join(this.deps.archiveRoot, `${id}-${Date.now()}.jsonl`)
    await copyFile(transcript.path, archivePath)
    await transcript.save(compacted.messages)
    await this.deps.sessions.touch(id, { status: 'idle' })
    return {
      ok: true,
      archived: true,
      archivePath,
      beforeMessages: messages.length,
      afterMessages: compacted.messages.length,
      note: compacted.note,
    }
  }
}
