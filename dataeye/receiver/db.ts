import { SQL } from 'bun'
import { mkdir, writeFile } from 'node:fs/promises'
import { commonpath } from './path'
import { dirname, resolve } from 'node:path'

export type BatchItem = {
  kind?: string
  ref_id?: string
  payload?: unknown
}

export type InsertBatch = (machineId: unknown, batch: BatchItem[]) => Promise<[accepted: number, duplicated: number]>

const DEFAULT_DSN = 'postgresql://dataeye:dataeye@127.0.0.1/dataeye'
const TRANSCRIPT_STORE_DIR = process.env.TRANSCRIPT_STORE_DIR ?? '/data/transcripts'
const SAFE_COMPONENT = /^[A-Za-z0-9._-]+$/

let sqlClient: any | null = null

function sql(): any {
  if (sqlClient === null) {
    sqlClient = new SQL(process.env.PGDSN ?? DEFAULT_DSN)
  }
  return sqlClient
}

export async function closePool(): Promise<void> {
  if (sqlClient?.close) await sqlClient.close()
  sqlClient = null
}

export function safeComponent(value: unknown, field: string): string {
  const s = String(value ?? '')
  if (!s || s.includes('..') || s.includes('/') || s.includes('\\') || !SAFE_COMPONENT.test(s)) {
    throw new Error(`unsafe path component for ${field}: ${String(value)}`)
  }
  return s
}

function jsonText(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return JSON.stringify(value)
}

function toInt(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null
  if (typeof value === 'string' && /^[-+]?\d+$/.test(value.trim())) return Number(value.trim())
  return null
}

function toBool(value: unknown): boolean | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') return ['1', 'true', 't', 'yes'].includes(value.trim().toLowerCase())
  return null
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value
  if (typeof value !== 'string' || !value.trim()) return null
  const parsed = new Date(value.endsWith('Z') ? value : value)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

function textValue(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function objectPayload(payload: unknown): Record<string, any> {
  return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload as Record<string, any> : {}
}

function splitLinesLikePython(value: string): string[] {
  const lines = value.split(/\r\n|\r|\n/)
  if (lines.at(-1) === '') lines.pop()
  return lines
}

async function insertRawInbox(conn: any, machineId: unknown, kind: unknown, refId: unknown, payload: unknown): Promise<boolean> {
  const rows = await conn`
    INSERT INTO raw_inbox (machine_id, kind, ref_id, payload)
    VALUES (${machineId ?? null}, ${kind ?? null}, ${refId ?? null}, ${jsonText(payload)}::jsonb)
    ON CONFLICT (machine_id, kind, ref_id) DO NOTHING
    RETURNING 1 AS inserted
  `
  return rows.length > 0
}

async function handleEvent(conn: any, machineId: unknown, payload: Record<string, any>): Promise<void> {
  await conn`
    INSERT INTO events (machine_id, event_id, store_id, user_id, event, props, created_at)
    VALUES (
      ${machineId ?? null},
      ${payload.id ?? null},
      ${payload.store_id ?? null},
      ${payload.user_id ?? null},
      ${payload.event ?? null},
      ${jsonText(payload.props ?? {})}::jsonb,
      ${parseDate(payload.created_at)}
    )
    ON CONFLICT (machine_id, event_id) DO NOTHING
  `
}

async function handleGeneration(conn: any, machineId: unknown, payload: Record<string, any>): Promise<void> {
  await conn`
    INSERT INTO generations (
      machine_id, gen_id, store_id, type, sub_type, prompt_used, result,
      model_used, tokens_used, effect_rating, effect_note, is_favorite,
      source_rec_id, conversation_id, created_at
    ) VALUES (
      ${machineId ?? null},
      ${payload.id ?? null},
      ${payload.store_id ?? null},
      ${payload.type ?? null},
      ${payload.sub_type ?? null},
      ${textValue(payload.prompt_used)},
      ${textValue(payload.result)},
      ${payload.model_used ?? null},
      ${toInt(payload.tokens_used)},
      ${payload.effect_rating ?? null},
      ${payload.effect_note ?? null},
      ${toBool(payload.is_favorite)},
      ${payload.source_rec_id ?? null},
      ${payload.conversation_id ?? null},
      ${parseDate(payload.created_at)}
    )
    ON CONFLICT (machine_id, gen_id) DO NOTHING
  `
}

async function handleStore(conn: any, machineId: unknown, payload: Record<string, any>): Promise<void> {
  const snapshot = objectPayload(payload.snapshot ?? payload)
  await conn`
    INSERT INTO stores (machine_id, store_id, snapshot)
    VALUES (${machineId ?? null}, ${snapshot.id ?? null}, ${jsonText(snapshot)}::jsonb)
    ON CONFLICT (machine_id, store_id)
    DO UPDATE SET snapshot = EXCLUDED.snapshot, received_at = now()
  `
}

async function handleTrace(conn: any, machineId: unknown, payload: Record<string, any>): Promise<void> {
  const conversationId = payload.conversation_id
  const content = typeof payload.content === 'string' ? payload.content : ''
  let filePath = ''
  let turns = 0
  let summary = ''

  if (content) {
    turns = splitLinesLikePython(content).length
    summary = content.slice(0, 200)
    const safeMid = safeComponent(machineId, 'machine_id')
    const safeCid = safeComponent(conversationId, 'conversation_id')
    const base = resolve(TRANSCRIPT_STORE_DIR)
    const destDir = resolve(base, safeMid)
    const destFile = resolve(destDir, `${safeCid}.jsonl`)
    if (commonpath([base, destFile]) !== base) {
      throw new Error(`path escapes store dir: ${destFile}`)
    }
    await mkdir(dirname(destFile), { recursive: true })
    await writeFile(destFile, content, 'utf8')
    filePath = destFile
  }

  await conn`
    INSERT INTO transcripts (machine_id, conversation_id, file_path, summary, turns, created_at)
    VALUES (${machineId ?? null}, ${conversationId ?? null}, ${filePath}, ${summary}, ${turns}, now())
    ON CONFLICT (machine_id, conversation_id)
    DO UPDATE SET file_path = EXCLUDED.file_path, summary = EXCLUDED.summary, turns = EXCLUDED.turns
  `
}

const handlers: Record<string, (conn: any, machineId: unknown, payload: Record<string, any>) => Promise<void>> = {
  event: handleEvent,
  gen: handleGeneration,
  store: handleStore,
  trace: handleTrace,
}

export const insertBatch: InsertBatch = async (machineId, batch) => {
  const conn = sql()
  let accepted = 0
  let duplicated = 0

  for (const item of Array.isArray(batch) ? batch : []) {
    const kind = item?.kind
    const refId = item?.ref_id
    const payload = item?.payload
    try {
      const inserted = await insertRawInbox(conn, machineId, kind, refId, payload)
      if (!inserted) {
        duplicated += 1
        continue
      }
    } catch (err) {
      console.error('[dataeye receiver] raw_inbox insert failed', { machineId, kind, refId, err })
      continue
    }

    accepted += 1
    const handler = kind ? handlers[kind] : undefined
    if (!handler) {
      console.warn('[dataeye receiver] unknown kind', { machineId, kind, refId })
      continue
    }
    try {
      await handler(conn, machineId, objectPayload(payload))
    } catch (err) {
      console.error('[dataeye receiver] integrate failed', { machineId, kind, refId, err })
    }
  }

  return [accepted, duplicated]
}
