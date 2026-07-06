import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

type JsonObject = Record<string, unknown>

interface StoreState {
  store: JsonObject
  byok: JsonObject
  byokProfiles: JsonObject[]
  activeByokProfile: string | null
  memories: JsonObject[]
  scheduledTasks: JsonObject[]
  storeDocs: JsonObject
  notifications: JsonObject[]
  dismissedRecommendations: string[]
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
    has_private_room: false,
    has_coaching: false,
    has_tournament: false,
    has_parking: false,
    target_customers: null,
    style: null,
    brand_style: null,
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
    bundled_video_label: '内置视频',
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
    memories: [],
    scheduledTasks: [],
    storeDocs: defaultStoreDocs(),
    notifications: [],
    dismissedRecommendations: [],
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

  async listMemories(): Promise<JsonObject[]> {
    return (await this.read()).memories
  }

  async addMemory(input: { content: string; type?: string; source?: 'manual' | 'auto' | 'pending'; workingDir?: string | null }): Promise<JsonObject> {
    const memory = memoryItem(input)
    await this.update(state => {
      state.memories.push(memory)
      return state
    })
    return memory
  }

  async updateMemory(id: string, content: string): Promise<JsonObject | null> {
    let out: JsonObject | null = null
    await this.update(state => {
      state.memories = state.memories.map(item => {
        if (item.id !== id) return item
        out = { ...item, content }
        return out
      })
      return state
    })
    return out
  }

  async confirmMemory(id: string): Promise<JsonObject | null> {
    let out: JsonObject | null = null
    await this.update(state => {
      state.memories = state.memories.map(item => {
        if (item.id !== id) return item
        out = { ...item, source: 'manual', source_label: '店主定', confidence: 'high' }
        return out
      })
      return state
    })
    return out
  }

  async deleteMemory(id: string): Promise<void> {
    await this.update(state => {
      state.memories = state.memories.filter(item => item.id !== id)
      return state
    })
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
        out = { ...item, ...patch }
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
    const item = { id: Date.now(), title: input.title ?? '通知', body: input.body ?? '', kind: input.kind ?? 'info', meta: input.meta ?? {} }
    await this.update(state => {
      state.notifications.push(item)
      return state
    })
    return item
  }

  async notificationsAfter(after: number): Promise<JsonObject> {
    const items = (await this.read()).notifications.filter(item => typeof item.id === 'number' && item.id > after)
    return { items, cursor: items.at(-1)?.id ?? after }
  }

  async dashboardToday(): Promise<JsonObject> {
    const state = await this.read()
    const date = new Date()
    const iso = date.toISOString().slice(0, 10)
    return {
      date: iso,
      weekday: ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][date.getDay()],
      greeting: `${state.store.name ?? '店里'}今天可以先处理获客、会员和内容发布。`,
      store_completeness: state.store.completeness ?? 10,
      summary: { total_generations: 0, today_generations: 0, favorite_count: 0, good_count: 0, latest_generation_at: null },
      recommendations: defaultRecommendations(state.dismissedRecommendations),
      tips: ['先让 AI 看一份价目表或活动方案，能更快生成贴近门店的内容。'],
    }
  }

  async dismissRecommendation(id: string): Promise<JsonObject> {
    await this.update(state => {
      if (!state.dismissedRecommendations.includes(id)) state.dismissedRecommendations.push(id)
      return state
    })
    return { status: 'ok', rec_id: id }
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
        memories: Array.isArray(parsed.memories) ? parsed.memories.filter(isRecord) : [],
        scheduledTasks: Array.isArray(parsed.scheduledTasks) ? parsed.scheduledTasks.filter(isRecord) : [],
        storeDocs: isRecord(parsed.storeDocs) ? { ...defaults.storeDocs, ...parsed.storeDocs } : defaults.storeDocs,
        notifications: Array.isArray(parsed.notifications) ? parsed.notifications.filter(isRecord) : [],
        dismissedRecommendations: Array.isArray(parsed.dismissedRecommendations) ? parsed.dismissedRecommendations.filter((item): item is string => typeof item === 'string') : [],
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

function memoryItem(input: { content: string; type?: string; source?: 'manual' | 'auto' | 'pending'; workingDir?: string | null }): JsonObject {
  const source = input.source ?? 'manual'
  const scope = input.workingDir ? 'working_dir' : 'global'
  return {
    id: crypto.randomUUID(),
    type: input.type || 'semantic',
    type_label: input.type || '资料',
    content: input.content,
    confidence: source === 'pending' ? 'low' : 'high',
    source,
    source_label: source === 'pending' ? '待确认' : source === 'auto' ? 'AI学到' : '店主定',
    scope,
    scope_label: scope === 'working_dir' ? '当前项目' : '全局门店',
  }
}

function normalizeScheduledTask(input: JsonObject): JsonObject {
  return {
    id: crypto.randomUUID(),
    name: cleanString(input.name) ?? '定时任务',
    instruction: cleanString(input.instruction) ?? '',
    billiards_mode: input.billiards_mode !== false,
    schedule_kind: cleanString(input.schedule_kind) ?? 'daily',
    schedule_spec: isRecord(input.schedule_spec) ? input.schedule_spec : { hour: 9, minute: 0 },
    next_run_at: null,
    last_run_at: null,
    last_run_status: null,
    last_result_summary: null,
    enabled: input.enabled !== false,
  }
}

function defaultRecommendations(dismissed: string[]): JsonObject[] {
  const items = [
    { id: 'daily-content', title: '准备今日朋友圈', description: '生成一条适合今晚黄金档发布的台球房文案。', action_url: '/dashboard/chat', priority: 'high', category: 'focus' },
    { id: 'store-profile', title: '完善门店资料', description: '补充价目表、会员规则和营业时间后，AI 会更贴近你的店。', action_url: '/dashboard/chat', priority: 'medium', category: 'setup' },
  ]
  return items.filter(item => !dismissed.includes(item.id))
}
