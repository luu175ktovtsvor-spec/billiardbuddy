import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { dirname, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { Message } from '../types/message'
import type { ContentReplacementRecord } from '../context/toolResultStorage'

const CID_RE = /^[A-Za-z0-9_-]{1,128}$/
const DEFAULT_PAGE_LIMIT = 200
const MAX_PAGE_LIMIT = 1000

export interface TranscriptPageRecord {
  seq: number
  message: Message
}

export interface TranscriptPage {
  messages: TranscriptPageRecord[]
  nextSeq: number
  hasMore: boolean
}

function isMessage(x: unknown): x is Message {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return (o.role === 'user' || o.role === 'assistant') && Array.isArray(o.content)
}

function isContentReplacementRecord(x: unknown): x is ContentReplacementRecord {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  return o.kind === 'tool-result' && typeof o.toolUseId === 'string' && typeof o.replacement === 'string'
}

function lineFor(m: Message): string {
  return `${JSON.stringify(m)}\n`
}

function clampLimit(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) return DEFAULT_PAGE_LIMIT
  return Math.min(Math.floor(value), MAX_PAGE_LIMIT)
}

export class Transcript {
  readonly path: string
  readonly contentReplacementPath: string

  constructor(rootDir: string, conversationId: string) {
    if (!CID_RE.test(conversationId)) throw new Error('非法 conversation id')
    this.path = join(rootDir, 'transcripts', `${conversationId}.jsonl`)
    this.contentReplacementPath = join(rootDir, 'transcripts', `${conversationId}.content-replacements.jsonl`)
  }

  async load(): Promise<Message[]> {
    let text = ''
    try {
      text = await readFile(this.path, 'utf8')
    } catch {
      return []
    }
    const out: Message[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as unknown
        if (isMessage(parsed)) out.push(parsed)
      } catch {
        // 坏行跳过,不让历史损坏拖垮会话。
      }
    }
    return out
  }

  async loadPage(opts: { after?: number; limit?: number } = {}): Promise<TranscriptPage> {
    const after = Number.isFinite(opts.after) ? Math.max(0, Math.floor(opts.after!)) : 0
    const limit = clampLimit(opts.limit)
    const messages: TranscriptPageRecord[] = []
    let seq = 0
    let hasMore = false

    try {
      const rl = createInterface({
        input: createReadStream(this.path, { encoding: 'utf8' }),
        crlfDelay: Infinity,
      })
      for await (const line of rl) {
        if (!line.trim()) continue
        try {
          const parsed = JSON.parse(line) as unknown
          if (!isMessage(parsed)) continue
          seq++
          if (seq <= after) continue
          if (messages.length >= limit) {
            hasMore = true
            break
          }
          messages.push({ seq, message: parsed })
        } catch {
          // 坏行跳过,分页恢复不能被单行损坏拖垮。
        }
      }
    } catch {
      return { messages: [], nextSeq: after, hasMore: false }
    }

    return {
      messages,
      nextSeq: messages.at(-1)?.seq ?? after,
      hasMore,
    }
  }

  async captureBaselineLen(): Promise<number> {
    try {
      const text = await readFile(this.path, 'utf8')
      return text.split('\n').filter(Boolean).length
    } catch {
      return 0
    }
  }

  async save(messages: Message[]): Promise<void> {
    await this.writeLines(messages.map(lineFor))
  }

  async savePreservingExternalTail(messages: Message[], baselineLen: number): Promise<void> {
    let tail: string[] = []
    try {
      const existing = (await readFile(this.path, 'utf8')).split('\n').filter(Boolean)
      tail = existing.slice(Math.max(0, baselineLen)).map(l => `${l}\n`)
    } catch {
      tail = []
    }
    await this.writeLines([...messages.map(lineFor), ...tail])
  }

  async loadContentReplacementRecords(): Promise<ContentReplacementRecord[]> {
    let text = ''
    try {
      text = await readFile(this.contentReplacementPath, 'utf8')
    } catch {
      return []
    }
    const out: ContentReplacementRecord[] = []
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      try {
        const parsed = JSON.parse(line) as unknown
        if (isContentReplacementRecord(parsed)) out.push(parsed)
      } catch {
        // 坏行跳过,不让 replacement sidecar 损坏拖垮会话恢复。
      }
    }
    return out
  }

  async appendContentReplacementRecords(records: ContentReplacementRecord[]): Promise<void> {
    if (records.length === 0) return
    await mkdir(dirname(this.contentReplacementPath), { recursive: true })
    await appendFile(this.contentReplacementPath, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8')
  }

  async seedContentReplacementRecords(records: ContentReplacementRecord[]): Promise<void> {
    if (records.length === 0) return
    await mkdir(dirname(this.contentReplacementPath), { recursive: true })
    await writeFile(this.contentReplacementPath, records.map(record => `${JSON.stringify(record)}\n`).join(''), 'utf8')
  }

  private async writeLines(lines: string[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, lines.join(''), 'utf8')
    await rename(tmp, this.path)
  }
}
