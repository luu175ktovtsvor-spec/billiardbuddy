import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export type LegacyArtifactKind = 'poster' | 'video' | 'content' | 'task' | 'memory' | 'file_change'

export interface LegacyArtifact {
  id: string
  kind: LegacyArtifactKind
  type: string
  title: string
  subtitle: string
  url?: string | null
  content?: string | null
  conversation_id?: string | null
  created_at?: string | null
  ratio?: string | null
  duration?: number | null
  width?: number | null
  height?: number | null
  path?: string | null
  backup_path?: string | null
  deleted?: boolean
  deleted_at?: string | null
  effect_rating?: 'good' | 'bad' | null
  effect_note?: string | null
  rated_at?: string | null
}

export interface DeletedConversationRecord {
  id: string
  deleted_at: string
}

interface StoreState {
  artifacts: LegacyArtifact[]
  deletedConversations: DeletedConversationRecord[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isArtifact(value: unknown): value is LegacyArtifact {
  return isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.type === 'string' &&
    typeof value.title === 'string' &&
    typeof value.subtitle === 'string'
}

function isDeletedConversation(value: unknown): value is DeletedConversationRecord {
  return isRecord(value) && typeof value.id === 'string' && typeof value.deleted_at === 'string'
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (!value || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), max)
}

export class LegacyAgentStore {
  private readonly path: string
  private writeQueue = Promise.resolve()

  constructor(rootDir: string) {
    this.path = join(rootDir, 'legacy-agent-store.json')
  }

  async saveArtifact(input: { title?: string; content: string; conversationId?: string | null; kind?: string | null }): Promise<LegacyArtifact> {
    const content = input.content.trim()
    if (!content) throw new Error('没有可保存的内容')
    const timestamp = nowIso()
    const item: LegacyArtifact = {
      id: crypto.randomUUID(),
      kind: 'content',
      type: (input.kind?.trim() || 'saved_text').slice(0, 80),
      title: (input.title?.replace(/\s+/g, ' ').trim() || '保存的成品').slice(0, 80),
      subtitle: '已保存的文字成品',
      content,
      conversation_id: input.conversationId || null,
      created_at: timestamp,
      deleted: false,
      deleted_at: null,
    }
    await this.update(state => {
      state.artifacts.push(item)
      return state
    })
    return publicArtifact(item)
  }

  async listArtifacts(limit = 12, deleted = false): Promise<LegacyArtifact[]> {
    const state = await this.read()
    const n = clampLimit(limit, deleted ? 30 : 12, deleted ? 80 : 30)
    return state.artifacts
      .filter(item => (item.deleted === true) === deleted)
      .sort((a, b) => (b.deleted_at ?? b.created_at ?? '').localeCompare(a.deleted_at ?? a.created_at ?? ''))
      .slice(0, n)
      .map(publicArtifact)
  }

  async setArtifactDeleted(id: string, deleted: boolean): Promise<boolean> {
    let found = false
    await this.update(state => {
      state.artifacts = state.artifacts.map(item => {
        if (item.id !== id) return item
        found = true
        return { ...item, deleted, deleted_at: deleted ? nowIso() : null }
      })
      return state
    })
    return found
  }

  async rateArtifact(id: string, rating: 'good' | 'bad', note?: string | null): Promise<boolean> {
    let found = false
    await this.update(state => {
      state.artifacts = state.artifacts.map(item => {
        if (item.id !== id || item.deleted) return item
        found = true
        return { ...item, effect_rating: rating, effect_note: note || null, rated_at: nowIso() }
      })
      return state
    })
    return found
  }

  async purgeArtifact(id: string): Promise<boolean> {
    let found = false
    await this.update(state => {
      const before = state.artifacts.length
      state.artifacts = state.artifacts.filter(item => item.id !== id)
      found = state.artifacts.length !== before
      return state
    })
    return found
  }

  async clearDeletedArtifacts(): Promise<number> {
    let removed = 0
    await this.update(state => {
      const before = state.artifacts.length
      state.artifacts = state.artifacts.filter(item => !item.deleted)
      removed = before - state.artifacts.length
      return state
    })
    return removed
  }

  async listDeletedConversations(): Promise<DeletedConversationRecord[]> {
    return (await this.read()).deletedConversations
  }

  async deletedConversationIds(): Promise<Set<string>> {
    return new Set((await this.listDeletedConversations()).map(item => item.id))
  }

  async setConversationDeleted(id: string, deleted: boolean): Promise<void> {
    await this.update(state => {
      if (deleted) {
        if (!state.deletedConversations.some(item => item.id === id)) {
          state.deletedConversations.push({ id, deleted_at: nowIso() })
        }
      } else {
        state.deletedConversations = state.deletedConversations.filter(item => item.id !== id)
      }
      return state
    })
  }

  async clearDeletedConversations(): Promise<string[]> {
    let ids: string[] = []
    await this.update(state => {
      ids = state.deletedConversations.map(item => item.id)
      state.deletedConversations = []
      return state
    })
    return ids
  }

  async reset(): Promise<void> {
    await rm(this.path, { force: true })
  }

  private async read(): Promise<StoreState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!isRecord(parsed)) return emptyState()
      return {
        artifacts: Array.isArray(parsed.artifacts) ? parsed.artifacts.filter(isArtifact) : [],
        deletedConversations: Array.isArray(parsed.deletedConversations) ? parsed.deletedConversations.filter(isDeletedConversation) : [],
      }
    } catch {
      return emptyState()
    }
  }

  private async update(mutator: (state: StoreState) => StoreState): Promise<void> {
    const run = this.writeQueue.then(async () => {
      const next = mutator(await this.read())
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
      await rename(tmp, this.path)
    })
    this.writeQueue = run.catch(() => undefined)
    await run
  }
}

function emptyState(): StoreState {
  return { artifacts: [], deletedConversations: [] }
}

function publicArtifact(item: LegacyArtifact): LegacyArtifact {
  const { deleted: _deleted, deleted_at: _deletedAt, effect_rating: _rating, effect_note: _note, rated_at: _ratedAt, ...rest } = item
  return rest
}
