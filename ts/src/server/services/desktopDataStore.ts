import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { computeNextRunAt } from './scheduledTaskSchedule'

type JsonObject = Record<string, unknown>

interface StoreState {
  store: JsonObject
  byok: JsonObject
  byokProfiles: JsonObject[]
  activeByokProfile: string | null
  scheduledTasks: JsonObject[]
  storeDocs: JsonObject
  notifications: JsonObject[]
}

function nowIso(): string {
  return new Date().toISOString()
}

function isRecord(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function cleanString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function defaultStore(): JsonObject {
  const ts = nowIso()
  return {
    id: 'local-store',
    owner_id: 'local-user',
    name: '我的台球房',
    city: null,
    district: null,
    address: null,
    phone: null,
    business_hours: null,
    table_count: null,
    table_types: null,
    pricing: null,
    member_cards: null,
    logo_url: null,
    qrcode_url: null,
    qrcode_text: null,
    has_private_room: false,
    has_coaching: false,
    has_tournament: false,
    has_parking: false,
    target_customers: null,
    style: null,
    brand_style: null,
    brand_color: null,
    advantages: null,
    common_activities: null,
    operation_profile: null,
    operation_profile_completeness: null,
    completeness: 10,
    my_role: 'owner',
    coach_count: null,
    coach_service_types: null,
    coach_price_range: null,
    cue_price_range: null,
    table_brands: null,
    cue_brands: null,
    other_equipment: null,
    membership_types: null,
    recharge_rules: null,
    membership_benefits: null,
    daily_avg_customers: null,
    peak_hours: null,
    avg_spend_range: null,
    created_at: ts,
    updated_at: ts,
  }
}

function defaultByok(): JsonObject {
  return {
    enabled: false,
    base_url: null,
    model: null,
    key_configured: false,
    key_mask: '',
    image_enabled: false,
    image_base_url: null,
    image_model: null,
    image_key_configured: false,
    image_key_mask: '',
    agent_auto_spend_limit: 3,
    bundled_model_label: 'MiMo v2.5',
    bundled_image_label: '内置生图',
  }
}

function defaultStoreDocs(): JsonObject {
  return {
    folder_path: null,
    status: 'idle',
    indexed_file_count: 0,
    indexed_chunk_count: 0,
    last_indexed_at: null,
    last_error: null,
  }
}

function emptyState(): StoreState {
  return {
    store: defaultStore(),
    byok: defaultByok(),
    byokProfiles: [],
    activeByokProfile: null,
    scheduledTasks: [],
    storeDocs: defaultStoreDocs(),
    notifications: [],
  }
}

export class DesktopDataStore {
  private readonly path: string
  private writeQueue = Promise.resolve()

  constructor(rootDir: string) {
    this.path = join(rootDir, 'desktop-data.json')
  }

  async getStore(): Promise<JsonObject> {
    return (await this.read()).store
  }

  async updateStore(patch: JsonObject): Promise<JsonObject> {
    let store: JsonObject = {}
    await this.update(state => {
      store = { ...state.store, ...patch, id: state.store.id ?? 'local-store', owner_id: state.store.owner_id ?? 'local-user', updated_at: nowIso() }
      state.store = store
      return state
    })
    return store
  }

  async getByok(): Promise<JsonObject> {
    return (await this.read()).byok
  }

  async updateByok(input: JsonObject): Promise<JsonObject> {
    let byok: JsonObject = {}
    await this.update(state => {
      const apiKey = cleanString(input.api_key)
      const imageKey = cleanString(input.image_api_key)
      byok = {
        ...state.byok,
        enabled: input.enabled === true,
        base_url: input.base_url ?? state.byok.base_url ?? null,
        model: input.model ?? state.byok.model ?? null,
        image_enabled: input.image_enabled === true,
        image_base_url: input.image_base_url ?? state.byok.image_base_url ?? null,
        image_model: input.image_model ?? state.byok.image_model ?? null,
        agent_auto_spend_limit: typeof input.agent_auto_spend_limit === 'number' ? input.agent_auto_spend_limit : state.byok.agent_auto_spend_limit ?? 3,
        key_configured: apiKey ? true : state.byok.key_configured === true,
        key_mask: apiKey ? maskSecret(apiKey) : state.byok.key_mask ?? '',
        image_key_configured: imageKey ? true : state.byok.image_key_configured === true,
        image_key_mask: imageKey ? maskSecret(imageKey) : state.byok.image_key_mask ?? '',
      }
      state.byok = byok
      return state
    })
    return byok
  }

  async validateByok(input: JsonObject): Promise<JsonObject> {
    return {
      ok: !!(cleanString(input.api_key) || cleanString(input.base_url) || cleanString(input.model)),
      model: cleanString(input.model) ?? cleanString(input.text_model) ?? undefined,
      sample: 'ok',
    }
  }

  async listByokProfiles(): Promise<JsonObject> {
    const state = await this.read()
    return { profiles: state.byokProfiles.map(profile => ({ ...profile, is_active: profile.name === state.activeByokProfile })) }
  }

  async addByokProfile(input: JsonObject): Promise<JsonObject> {
    const name = cleanString(input.name) ?? `profile-${Date.now()}`
    await this.update(state => {
      const profile = {
        name,
        base_url: input.base_url ?? null,
        model: input.model ?? null,
        has_key: !!cleanString(input.api_key),
        is_active: false,
      }
      state.byokProfiles = state.byokProfiles.filter(item => item.name !== name)
      state.byokProfiles.push(profile)
      return state
    })
    return this.listByokProfiles()
  }

  async activateByokProfile(name: string): Promise<JsonObject> {
    await this.update(state => {
      state.activeByokProfile = name
      return state
    })
    return { active: name, ...(await this.listByokProfiles()) }
  }

  async deleteByokProfile(name: string): Promise<JsonObject> {
    await this.update(state => {
      state.byokProfiles = state.byokProfiles.filter(item => item.name !== name)
      if (state.activeByokProfile === name) state.activeByokProfile = null
      return state
    })
    return this.listByokProfiles()
  }

  async listScheduledTasks(): Promise<JsonObject[]> {
    return (await this.read()).scheduledTasks
  }

  async createScheduledTask(input: JsonObject): Promise<JsonObject> {
    const task = normalizeScheduledTask(input)
    await this.update(state => {
      state.scheduledTasks.push(task)
      return state
    })
    return task
  }

  async updateScheduledTask(id: string, patch: JsonObject): Promise<JsonObject | null> {
    let out: JsonObject | null = null
    await this.update(state => {
      state.scheduledTasks = state.scheduledTasks.map(item => {
        if (item.id !== id) return item
        const merged = { ...item, ...patch }
        // 用户改了排程(或重新启用)时重算 next_run_at;但调度器显式写回的 next_run_at 优先(尊重"跑完重排/关闭")。
        const scheduleTouched = 'schedule_kind' in patch || 'schedule_spec' in patch || patch.enabled === true
        if (scheduleTouched && !('next_run_at' in patch)) {
          merged.next_run_at = merged.enabled === false ? null : computeNextRunAt(merged)
        }
        out = merged
        return out
      })
      return state
    })
    return out
  }

  async deleteScheduledTask(id: string): Promise<void> {
    await this.update(state => {
      state.scheduledTasks = state.scheduledTasks.filter(item => item.id !== id)
      return state
    })
  }

  async getStoreDocs(): Promise<JsonObject> {
    return (await this.read()).storeDocs
  }

  async updateStoreDocs(patch: JsonObject): Promise<JsonObject> {
    let docs: JsonObject = {}
    await this.update(state => {
      docs = { ...state.storeDocs, ...patch }
      state.storeDocs = docs
      return state
    })
    return docs
  }

  async addNotification(input: JsonObject): Promise<JsonObject> {
    let item: JsonObject = {}
    await this.update(state => {
      const maxId = state.notifications.reduce((max, notification) => {
        return typeof notification.id === 'number' && Number.isFinite(notification.id)
          ? Math.max(max, notification.id)
          : max
      }, 0)
      item = {
        id: Math.max(Date.now(), maxId + 1),
        title: typeof input.title === 'string' && input.title.trim() ? input.title.trim() : '通知',
        body: typeof input.body === 'string' ? input.body : '',
        kind: typeof input.kind === 'string' && input.kind.trim() ? input.kind.trim() : 'info',
        meta: isRecord(input.meta) ? input.meta : {},
      }
      state.notifications.push(item)
      return state
    })
    return item
  }

  async notificationsAfter(after: number): Promise<JsonObject> {
    const items = (await this.read()).notifications.filter(item => typeof item.id === 'number' && item.id > after)
    return { items, cursor: items.at(-1)?.id ?? after }
  }

  async read(): Promise<StoreState> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown
      if (!isRecord(parsed)) return emptyState()
      const defaults = emptyState()
      return {
        store: isRecord(parsed.store) ? { ...defaults.store, ...parsed.store } : defaults.store,
        byok: isRecord(parsed.byok) ? { ...defaults.byok, ...parsed.byok } : defaults.byok,
        byokProfiles: Array.isArray(parsed.byokProfiles) ? parsed.byokProfiles.filter(isRecord) : [],
        activeByokProfile: typeof parsed.activeByokProfile === 'string' ? parsed.activeByokProfile : null,
        scheduledTasks: Array.isArray(parsed.scheduledTasks) ? parsed.scheduledTasks.filter(isRecord) : [],
        storeDocs: isRecord(parsed.storeDocs) ? { ...defaults.storeDocs, ...parsed.storeDocs } : defaults.storeDocs,
        notifications: Array.isArray(parsed.notifications) ? parsed.notifications.filter(isRecord) : [],
      }
    } catch {
      return emptyState()
    }
  }

  private async update(mutator: (state: StoreState) => StoreState): Promise<void> {
    const run = this.writeQueue.then(async () => {
      const state = mutator(await this.read())
      await mkdir(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await rename(tmp, this.path)
    })
    this.writeQueue = run.catch(() => undefined)
    await run
  }
}

function maskSecret(secret: string): string {
  if (secret.length <= 8) return '****'
  return `${secret.slice(0, 4)}...${secret.slice(-4)}`
}

function normalizeScheduledTask(input: JsonObject): JsonObject {
  const enabled = input.enabled !== false
  const task: JsonObject = {
    id: crypto.randomUUID(),
    name: cleanString(input.name) ?? '定时任务',
    instruction: cleanString(input.instruction) ?? '',
    billiards_mode: input.billiards_mode !== false,
    working_dir: cleanString(input.working_dir ?? input.workspaceRoot ?? input.folder_path),
    schedule_kind: cleanString(input.schedule_kind) ?? 'daily',
    schedule_spec: isRecord(input.schedule_spec) ? input.schedule_spec : { hour: 9, minute: 0 },
    next_run_at: null,
    last_run_at: null,
    last_run_status: null,
    last_result_summary: null,
    last_run_conversation_id: null,
    enabled,
  }
  // 建任务即算下次触发(排程引擎),让"点了有反应":面板能立刻看到 next_run_at、调度器到点会真触发。
  task.next_run_at = enabled ? computeNextRunAt(task) : null
  return task
}
