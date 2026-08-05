import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageWorkbenchDomainApiHandler } from '../src/server/api/imageWorkbench.js'
import { ImageWorkbenchService } from '../src/server/services/imageWorkbenchService.js'

const roots: string[] = []
const services: ImageWorkbenchService[] = []
const capability = '15-5d-image-workflow-capability-0123456789'
const gatewayUrl = 'https://gateway.example.test/gw'
const imageRelayUrl = 'https://images.example.test/image-generation'
const gatewayToken = '15-5d-image-gateway-token-0123456789'

type CampaignPayload = {
  campaign: {
    id: string
    revision: number
    state: 'draft' | 'confirmed' | 'running' | 'completed' | 'cancelled'
    estimate_hash?: string
    confirmation_receipt_id?: string
  }
  items: Array<{
    id: string
    ordinal: number
    project_id?: string
    state: 'draft' | 'queued' | 'running' | 'ready' | 'failed' | 'cancelled'
    attempt: number
    safe_error_code?: string
    variable_values: Array<{ slot_id: string; value: string }>
  }>
  pending_retry_confirmations: Array<{
    item_id: string
    attempt: number
    estimate_hash: string
    confirmation_receipt_id: string
    expires_at: string
  }>
}

type EstimatePayload = {
  campaign: CampaignPayload['campaign']
  estimate: {
    id: string
    estimate_hash: string
    campaign_revision: number
    purpose: 'start' | 'retry'
    item_id?: string
    attempt?: number
    paid_operation_count: number
    concurrency: number
    price_upper_bound: {
      currency: string
      amount_minor: number
      usage_upper_bound: { requests: number; output_images: number }
    }
    expires_at: string
  }
}

type ConfirmationPayload = {
  campaign: CampaignPayload['campaign']
  confirmation: {
    id: string
    estimate_hash: string
    campaign_revision: number
    purpose: 'start' | 'retry'
    item_id?: string
    attempt?: number
  }
}

type ProjectProjectionPayload = {
  campaign_intent: {
    project_id: string
    campaign_id: string
    campaign_revision: number
    item_id: string
    attempt: number
    template_id?: string
    template_revision_id?: string
    slot_bindings: Array<{ slot_id: string; text?: string; qr_payload?: string }>
  } | null
}

type GatewayCall = {
  path: string
  method: string
  headers: Headers
  body: unknown
}

type Deferred = {
  promise: Promise<void>
  resolve(): void
}

type CampaignGateway = {
  calls: GatewayCall[]
  setTaskStatus(taskId: string, status: 'queued' | 'running' | 'succeeded' | 'cancelled'): void
  waitForBlockedPost(postNumber?: number): Promise<void>
  releaseBlockedPost(postNumber?: number): void
  fetchImpl: typeof fetch
}

type WorkbenchOptions = Omit<ConstructorParameters<typeof ImageWorkbenchService>[0], 'root' | 'legacyMediaRoot'>

async function root(label: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `billiardbuddy-image-workflow-d-${label}-`))
  roots.push(value)
  return value
}

async function workbench(label: string, options: WorkbenchOptions = {}): Promise<ImageWorkbenchService> {
  const value = new ImageWorkbenchService({
    root: await root(label),
    legacyMediaRoot: await root(`${label}-legacy`),
    ...options,
  })
  services.push(value)
  return value
}

async function request(
  handler: ReturnType<typeof createImageWorkbenchDomainApiHandler>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(path, 'http://127.0.0.1:3456')
  return await handler(new Request(url, init), url, url.pathname.split('/').filter(Boolean))
}

const headers = {
  'Content-Type': 'application/json',
  'X-BilliardBuddy-Media-Capability': capability,
}

async function withGateway<T>(action: () => Promise<T>): Promise<T> {
  const previousUrl = process.env.BB_GATEWAY_URL
  const previousImageRelayUrl = process.env.BB_IMAGE_RELAY_URL
  const previousToken = process.env.BB_GATEWAY_TOKEN
  process.env.BB_GATEWAY_URL = gatewayUrl
  process.env.BB_IMAGE_RELAY_URL = imageRelayUrl
  process.env.BB_GATEWAY_TOKEN = gatewayToken
  try {
    return await action()
  } finally {
    if (previousUrl === undefined) delete process.env.BB_GATEWAY_URL
    else process.env.BB_GATEWAY_URL = previousUrl
    if (previousImageRelayUrl === undefined) delete process.env.BB_IMAGE_RELAY_URL
    else process.env.BB_IMAGE_RELAY_URL = previousImageRelayUrl
    if (previousToken === undefined) delete process.env.BB_GATEWAY_TOKEN
    else process.env.BB_GATEWAY_TOKEN = previousToken
  }
}

function deferred(): Deferred {
  let resolve: (() => void) | undefined
  const promise = new Promise<void>(finish => {
    resolve = finish
  })
  return {
    promise,
    resolve: () => resolve?.(),
  }
}

function campaignGateway(options: { failPosts?: number[]; blockPosts?: number[] } = {}): CampaignGateway {
  const calls: GatewayCall[] = []
  const taskByIdempotencyKey = new Map<string, { id: string; status: 'queued' | 'running' | 'succeeded' | 'cancelled' }>()
  const taskById = new Map<string, { id: string; status: 'queued' | 'running' | 'succeeded' | 'cancelled' }>()
  const failPosts = new Set(options.failPosts ?? [])
  const blockedPosts = new Map<number, { entered: Deferred; release: Deferred }>((options.blockPosts ?? []).map(postNumber => [postNumber, {
    entered: deferred(),
    release: deferred(),
  }] as const))
  let postCount = 0
  const receipt = 'd'.repeat(64)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    const requestHeaders = new Headers(init?.headers)
    calls.push({ path: url.pathname, method, headers: requestHeaders, body })
    if (url.pathname === '/image-generation/v1/images/tasks' && method === 'POST') {
      postCount += 1
      const blocked = blockedPosts.get(postCount)
      if (blocked) {
        blocked.entered.resolve()
        await blocked.release.promise
      }
      if (failPosts.has(postCount)) {
        // A definite Relay rejection is an isolated failed item, unlike a
        // timeout/5xx whose paid outcome must remain unknown and cannot retry.
        return Response.json({ error: 'campaign fixture forces an isolated submission failure' }, { status: 400 })
      }
      const idempotencyKey = requestHeaders.get('Idempotency-Key') ?? ''
      const existing = taskByIdempotencyKey.get(idempotencyKey)
      if (existing) {
        return Response.json({
          task_id: existing.id,
          status: existing.status,
          reused: true,
          poll_after_seconds: 1,
          provider_receipt_hash: receipt,
        })
      }
      const task = {
        id: `relay_campaign_task_${String(taskById.size + 1).padStart(4, '0')}`,
        status: 'queued' as const,
      }
      taskByIdempotencyKey.set(idempotencyKey, task)
      taskById.set(task.id, task)
      return Response.json({ task_id: task.id, status: task.status, poll_after_seconds: 1, provider_receipt_hash: receipt })
    }
    const taskMatch = /^\/image-generation\/v1\/images\/tasks\/([^/]+)(?:\/(cancel))?$/.exec(url.pathname)
    if (taskMatch) {
      const task = taskById.get(decodeURIComponent(taskMatch[1]!))
      if (!task) return Response.json({ error: 'unknown task' }, { status: 404 })
      if (taskMatch[2] === 'cancel' && method === 'POST') {
        if (task.status === 'running') return Response.json({ status: 'running' }, { status: 409 })
        if (task.status === 'succeeded') return Response.json({ status: 'succeeded' }, { status: 409 })
        task.status = 'cancelled'
        return Response.json({ status: 'cancelled' })
      }
      if (method === 'GET') {
        return Response.json({
          task_id: task.id,
          status: task.status,
          poll_after_seconds: 1,
          provider_receipt_hash: receipt,
          ...(task.status === 'succeeded' ? { data: [{ b64_json: png, mime_type: 'image/png' }] } : {}),
        })
      }
    }
    if (url.pathname.includes('/by-idempotency/') && method === 'GET') {
      return Response.json({ error: 'no task was submitted' }, { status: 404 })
    }
    return Response.json({ error: `unexpected campaign fixture request: ${method} ${url.pathname}` }, { status: 500 })
  }

  return {
    calls,
    setTaskStatus(taskId, status) {
      const task = taskById.get(taskId)
      if (!task) throw new Error(`unknown fixture task ${taskId}`)
      task.status = status
    },
    async waitForBlockedPost(postNumber = 1) {
      const blocked = blockedPosts.get(postNumber)
      if (!blocked) throw new Error(`post ${postNumber} is not configured to block`)
      await blocked.entered.promise
    },
    releaseBlockedPost(postNumber = 1) {
      const blocked = blockedPosts.get(postNumber)
      if (!blocked) throw new Error(`post ${postNumber} is not configured to block`)
      blocked.release.resolve()
    },
    fetchImpl,
  }
}

function templateRevisionWithHeadlineSlot() {
  return {
    blueprint: {
      schema_version: 1,
      artboard: { width: 1024, height: 1024 },
      background: { kind: 'solid', color: '#ffffff' },
      layers: [{
        id: 'text_campaign_headline_0001',
        kind: 'text',
        text: '活动标题',
        font_family: 'PingFang SC',
        font_asset_id: 'font_builtin_0001',
        font_size: 72,
        font_weight: 700,
        font_style: 'normal',
        line_height: 1.2,
        letter_spacing: 0,
        fill: '#101820',
        position: { x: 80, y: 120 },
        rotation_degrees: 0,
        max_width: 864,
        max_height: 240,
        overflow: 'clip',
        locale: 'zh-CN',
        align: 'left',
        opacity: 1,
      }],
    },
    slots: [{ id: 'headline', layer_id: 'text_campaign_headline_0001', kind: 'text', required: true }],
    schema_version: 1,
  }
}

function templateRevisionWithTextAndQrSlots() {
  return {
    blueprint: {
      schema_version: 1,
      artboard: { width: 1024, height: 1024 },
      background: { kind: 'solid', color: '#ffffff' },
      layers: [
        {
          id: 'text_campaign_intent_headline_0001',
          kind: 'text',
          text: '活动标题',
          font_family: 'PingFang SC',
          font_asset_id: 'font_builtin_0001',
          font_size: 72,
          font_weight: 700,
          font_style: 'normal',
          line_height: 1.2,
          letter_spacing: 0,
          fill: '#101820',
          position: { x: 80, y: 120 },
          rotation_degrees: 0,
          max_width: 864,
          max_height: 240,
          overflow: 'clip',
          locale: 'zh-CN',
          align: 'left',
          opacity: 1,
        },
        {
          id: 'qrcode_campaign_intent_signup_0001',
          kind: 'qrcode',
          source: { kind: 'payload', value: 'https://example.test/template/placeholder' },
          transform: { x: 760, y: 760, width: 180, height: 180, rotation_degrees: 0, scale_x: 1, scale_y: 1 },
          error_correction: 'H',
          quiet_zone_modules: 4,
          verify_after_render: true,
        },
      ],
    },
    slots: [
      { id: 'headline', layer_id: 'text_campaign_intent_headline_0001', kind: 'text', required: true },
      { id: 'signup_qr', layer_id: 'qrcode_campaign_intent_signup_0001', kind: 'qrcode', required: true },
    ],
    schema_version: 1,
  }
}

async function createVariableTemplate(handler: ReturnType<typeof createImageWorkbenchDomainApiHandler>): Promise<{
  id: string
  revisionId: string
}> {
  const response = await request(handler, '/api/images/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotency_key: 'bb-image-15-5d-template-create-0001',
      name: 'Campaign 标题模板',
      revision: templateRevisionWithHeadlineSlot(),
    }),
  })
  expect(response.status).toBe(201)
  const payload = await response.json() as { template: { id: string }; revision: { id: string } }
  return { id: payload.template.id, revisionId: payload.revision.id }
}

async function createTextAndQrTemplate(handler: ReturnType<typeof createImageWorkbenchDomainApiHandler>): Promise<{
  id: string
  revisionId: string
}> {
  const response = await request(handler, '/api/images/templates', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      idempotency_key: 'bb-image-15-5d-template-text-qr-create-0001',
      name: 'Campaign 文本二维码模板',
      revision: templateRevisionWithTextAndQrSlots(),
    }),
  })
  expect(response.status).toBe(201)
  const payload = await response.json() as { template: { id: string }; revision: { id: string } }
  return { id: payload.template.id, revisionId: payload.revision.id }
}

function campaignInput(overrides: Record<string, unknown> = {}) {
  return {
    idempotency_key: 'bb-image-15-5d-campaign-create-0001',
    name: '春季门店海报 Campaign',
    shared_brief: {
      user_request: '为台球门店制作春季赛事宣传图，保留台球运动的专业感。',
      confirmed_facts: ['赛事在春季举办'],
      must_preserve: ['画面必须留出标题区域'],
    },
    output_preset: 'square',
    items: [
      { variable_values: [{ slot_id: 'headline', value: '春季公开赛' }] },
      { variable_values: [{ slot_id: 'headline', value: '城市资格赛' }] },
    ],
    ...overrides,
  }
}

function postCount(gateway: CampaignGateway): number {
  return gateway.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST').length
}

function repositoryDatabase(service: ImageWorkbenchService): Database {
  return (service.repository as unknown as { unitOfWork: { database: Database } }).unitOfWork.database
}

async function createCampaign(
  handler: ReturnType<typeof createImageWorkbenchDomainApiHandler>,
  input: Record<string, unknown>,
): Promise<{ response: Response; payload: CampaignPayload }> {
  const response = await request(handler, '/api/images/campaigns', {
    method: 'POST', headers, body: JSON.stringify(input),
  })
  return { response, payload: await response.json() as CampaignPayload }
}

afterEach(async () => {
  for (const service of services.splice(0)) {
    try {
      await service.listProjects()
      service.repository.close()
    } catch {
      // A recovery test deliberately closes the first instance before restart.
    }
  }
  await Promise.all(roots.splice(0).map(async value => await rm(value, { recursive: true, force: true })))
})

test('15.5D Campaign 仅接受受控 Template Slot 变量，并保持草稿/replace 的幂等和 revision 边界', async () => {
  const service = await workbench('draft', { now: () => new Date('2026-08-05T00:00:00.000Z') })
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)
  const template = await createVariableTemplate(handler)

  const unknownVariable = await request(handler, '/api/images/campaigns', {
    method: 'POST',
    headers,
    body: JSON.stringify(campaignInput({
      template_id: template.id,
      template_revision_id: template.revisionId,
      items: [{ variable_values: [{ slot_id: 'uncontrolled_prompt_field', value: '不要进入 Provider prompt' }] }],
    })),
  })
  expect(unknownVariable.status).toBe(409)
  expect(await unknownVariable.json()).toMatchObject({ error: 'MEDIA_IMAGE_REVISION_CONFLICT' })

  const input = campaignInput({ template_id: template.id, template_revision_id: template.revisionId })
  const created = await createCampaign(handler, input)
  expect(created.response.status).toBe(201)
  expect(created.payload).toMatchObject({
    campaign: { state: 'draft', revision: 0 },
    items: [
      { ordinal: 0, state: 'draft', attempt: 1, variable_values: [{ slot_id: 'headline', value: '春季公开赛' }] },
      { ordinal: 1, state: 'draft', attempt: 1 },
    ],
  })

  const replay = await createCampaign(handler, input)
  expect(replay.response.status).toBe(201)
  expect(replay.payload.campaign.id).toBe(created.payload.campaign.id)
  const idempotencyConflict = await request(handler, '/api/images/campaigns', {
    method: 'POST', headers, body: JSON.stringify({ ...input, name: '同一幂等键不能偷换 Campaign' }),
  })
  expect(idempotencyConflict.status).toBe(409)
  expect(await idempotencyConflict.json()).toMatchObject({ error: 'MEDIA_IMAGE_IDEMPOTENCY_CONFLICT' })

  const replaced = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/items/commands/replace`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_revision: created.payload.campaign.revision,
      idempotency_key: 'bb-image-15-5d-campaign-replace-0001',
      items: [
        { variable_values: [{ slot_id: 'headline', value: '总决赛主视觉' }] },
        { variable_values: [{ slot_id: 'headline', value: '分站赛主视觉' }] },
      ],
    }),
  })
  expect(replaced.status).toBe(200)
  const replacedPayload = await replaced.json() as CampaignPayload
  expect(replacedPayload).toMatchObject({ campaign: { revision: 1, state: 'draft' }, items: [{ attempt: 1 }, { attempt: 1 }] })
  const staleReplace = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/items/commands/replace`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      base_revision: 0,
      idempotency_key: 'bb-image-15-5d-campaign-replace-stale-0001',
      items: [{ variable_values: [{ slot_id: 'headline', value: '过期写入' }] }],
    }),
  })
  expect(staleReplace.status).toBe(409)
  expect(await staleReplace.json()).toMatchObject({ error: 'MEDIA_IMAGE_REVISION_CONFLICT' })

  const list = await request(handler, '/api/images/campaigns')
  expect(list.status).toBe(200)
  expect(await list.json()).toMatchObject({ campaigns: [expect.objectContaining({ id: created.payload.campaign.id, state: 'draft' })] })
})

test('15.5D Campaign 列表按本地分页返回，257 个项目不会触发远端轮询或响应越界', async () => {
  const service = await workbench('campaign-list-page', { now: () => new Date('2026-08-05T00:00:00.000Z') })
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)

  const createdIds: string[] = []
  for (let index = 0; index < 257; index += 1) {
    const created = await createCampaign(handler, campaignInput({
      idempotency_key: `bb-image-15-5d-campaign-page-${String(index).padStart(4, '0')}`,
      name: `分页 Campaign ${index}`,
      items: [{ variable_values: [] }],
    }))
    expect(created.response.status).toBe(201)
    createdIds.push(created.payload.campaign.id)
  }

  const seen = new Set<string>()
  let cursor: number | undefined
  let pageCount = 0
  do {
    const suffix = cursor === undefined ? '?limit=50' : `?limit=50&cursor=${cursor}`
    const response = await request(handler, `/api/images/campaigns${suffix}`)
    expect(response.status).toBe(200)
    const page = await response.json() as { campaigns: Array<{ id: string }>; next_cursor?: number }
    expect(page.campaigns.length).toBeLessThanOrEqual(50)
    for (const campaign of page.campaigns) seen.add(campaign.id)
    cursor = page.next_cursor
    pageCount += 1
  } while (cursor !== undefined)

  expect(pageCount).toBe(6)
  expect(seen.size).toBe(createdIds.length)
  const rejectedLimit = await request(handler, '/api/images/campaigns?limit=51')
  expect(rejectedLimit.status).toBe(400)
})

test('15.5D Campaign 报价、确认、逐项启动和失败重试均走持久化的普通 Quick Create', async () => {
  let nowMs = Date.parse('2026-08-05T00:00:00.000Z')
  const gateway = campaignGateway({ failPosts: [2] })
  const service = await workbench('estimate-start', { now: () => new Date(nowMs), fetchImpl: gateway.fetchImpl })
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)

  await withGateway(async () => {
    const insufficient = await createCampaign(handler, campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-budget-0001',
      budget_limit: { currency: 'USD', amount_minor: 1 },
      items: [{ variable_values: [] }, { variable_values: [] }],
    }))
    expect(insufficient.response.status).toBe(201)
    const rejectedEstimate = await request(handler, `/api/images/campaigns/${insufficient.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: insufficient.payload.campaign.revision }),
    })
    expect(rejectedEstimate.status).toBe(422)
    expect(await rejectedEstimate.json()).toMatchObject({ error: 'MEDIA_IMAGE_BUDGET_EXCEEDED' })

    const template = await createTextAndQrTemplate(handler)
    const firstHeadline = '春季公开赛'
    const firstSignupQr = 'https://example.test/campaign/spring-open'
    const secondHeadline = '城市资格赛'
    const secondSignupQr = 'https://example.test/campaign/city-qualifier'
    const created = await createCampaign(handler, campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-start-create-0001',
      template_id: template.id,
      template_revision_id: template.revisionId,
      items: [
        { variable_values: [
          { slot_id: 'headline', value: firstHeadline },
          { slot_id: 'signup_qr', value: firstSignupQr },
        ] },
        { variable_values: [
          { slot_id: 'headline', value: secondHeadline },
          { slot_id: 'signup_qr', value: secondSignupQr },
        ] },
      ],
    }))
    expect(created.response.status).toBe(201)
    const estimateResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: created.payload.campaign.revision }),
    })
    expect(estimateResponse.status).toBe(200)
    const estimate = await estimateResponse.json() as EstimatePayload
    expect(estimate.estimate).toMatchObject({
      campaign_revision: 0,
      paid_operation_count: 2,
      price_upper_bound: { currency: 'USD', usage_upper_bound: { requests: 2, output_images: 6 } },
    })
    expect(estimate.estimate.concurrency).toBeGreaterThan(0)

    nowMs += 5 * 60 * 1_000 + 1
    const expiredConfirm = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-confirm-expired-0001',
        estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    expect(expiredConfirm.status).toBe(409)
    expect(await expiredConfirm.json()).toMatchObject({ error: 'MEDIA_IMAGE_REVISION_CONFLICT' })

    const renewedEstimateResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: created.payload.campaign.revision }),
    })
    expect(renewedEstimateResponse.status).toBe(200)
    const renewed = await renewedEstimateResponse.json() as EstimatePayload
    expect(renewed.estimate.estimate_hash).not.toBe(estimate.estimate.estimate_hash)

    const confirmedResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-confirm-0001',
        estimate_hash: renewed.estimate.estimate_hash,
      }),
    })
    expect(confirmedResponse.status).toBe(200)
    const confirmed = await confirmedResponse.json() as ConfirmationPayload
    expect(confirmed).toMatchObject({ campaign: { state: 'confirmed', estimate_hash: renewed.estimate.estimate_hash }, confirmation: { estimate_hash: renewed.estimate.estimate_hash } })
    const confirmationReplay = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-confirm-0001',
        estimate_hash: renewed.estimate.estimate_hash,
      }),
    })
    expect(confirmationReplay.status).toBe(200)
    expect((await confirmationReplay.json() as ConfirmationPayload).confirmation.id).toBe(confirmed.confirmation.id)

    const wrongReceiptStart = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: confirmed.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-start-wrong-receipt-0001',
        estimate_hash: renewed.estimate.estimate_hash,
        confirmation_receipt_id: 'receipt_campaign_wrong_0001',
      }),
    })
    expect(wrongReceiptStart.status).toBe(409)
    expect(await wrongReceiptStart.json()).toMatchObject({ error: 'MEDIA_IMAGE_REVISION_CONFLICT' })

    const startInput = {
      base_revision: confirmed.campaign.revision,
      idempotency_key: 'bb-image-15-5d-campaign-start-0001',
      estimate_hash: renewed.estimate.estimate_hash,
      confirmation_receipt_id: confirmed.confirmation.id,
    }
    const startedResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST', headers, body: JSON.stringify(startInput),
    })
    expect(startedResponse.status).toBe(202)
    const started = await startedResponse.json() as CampaignPayload
    expect(started).toMatchObject({ campaign: { state: 'running' } })
    expect(started.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ ordinal: 0, state: 'queued', attempt: 1, project_id: expect.any(String) }),
      expect.objectContaining({ ordinal: 1, state: 'failed', attempt: 1, project_id: expect.any(String), safe_error_code: expect.any(String) }),
    ]))
    expect(postCount(gateway)).toBe(2)
    const submitted = gateway.calls.find(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')
    expect((submitted?.body as { prompt?: string } | undefined)?.prompt).toContain('春季赛事宣传图')
    for (const prompt of gateway.calls
      .filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')
      .map(call => (call.body as { prompt?: string } | undefined)?.prompt ?? '')) {
      expect(prompt).not.toContain(firstHeadline)
      expect(prompt).not.toContain(firstSignupQr)
      expect(prompt).not.toContain(secondHeadline)
      expect(prompt).not.toContain(secondSignupQr)
    }

    const failedItem = started.items.find(item => item.state === 'failed')
    const queuedItem = started.items.find(item => item.state === 'queued')
    if (!failedItem?.project_id || !queuedItem?.project_id) throw new Error('expected isolated Campaign projects')
    const failedOperations = await service.repository.listGenerationOperations(failedItem.project_id)
    const queuedOperations = await service.repository.listGenerationOperations(queuedItem.project_id)
    expect(failedOperations).toHaveLength(1)
    expect(failedOperations[0]).toMatchObject({ status: 'failed', cost_state: 'submitted_charge_possible' })
    expect(queuedOperations).toHaveLength(1)
    expect(queuedOperations[0]).toMatchObject({ status: 'queued', cost_state: 'submitted_charge_possible' })
    const firstAttemptProjectionResponse = await request(handler, `/api/images/projects/${failedItem.project_id}/projection`)
    expect(firstAttemptProjectionResponse.status).toBe(200)
    const firstAttemptProjection = await firstAttemptProjectionResponse.json() as ProjectProjectionPayload
    expect(firstAttemptProjection.campaign_intent).toMatchObject({
      project_id: failedItem.project_id,
      campaign_id: created.payload.campaign.id,
      item_id: failedItem.id,
      attempt: 1,
      template_id: template.id,
      template_revision_id: template.revisionId,
      slot_bindings: [
        { slot_id: 'headline', text: secondHeadline },
        { slot_id: 'signup_qr', qr_payload: secondSignupQr },
      ],
    })
    const immutableFirstAttemptIntent = JSON.parse(JSON.stringify(firstAttemptProjection.campaign_intent))

    const missingRetryConfirmation = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/items/${failedItem.id}/commands/retry`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: started.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-retry-without-receipt-0001',
      }),
    })
    expect(missingRetryConfirmation.status).toBe(400)

    const retryEstimateResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ base_revision: started.campaign.revision, item_id: failedItem.id }),
    })
    expect(retryEstimateResponse.status).toBe(200)
    const retryEstimate = await retryEstimateResponse.json() as EstimatePayload
    expect(retryEstimate.estimate).toMatchObject({
      purpose: 'retry',
      item_id: failedItem.id,
      attempt: 2,
      paid_operation_count: 1,
    })
    const retryConfirmationResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/items/${failedItem.id}/commands/confirm-retry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: started.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-retry-confirm-0001',
        estimate_hash: retryEstimate.estimate.estimate_hash,
      }),
    })
    expect(retryConfirmationResponse.status).toBe(200)
    const retryConfirmation = await retryConfirmationResponse.json() as ConfirmationPayload
    expect(retryConfirmation.confirmation).toMatchObject({
      purpose: 'retry',
      item_id: failedItem.id,
      attempt: 2,
      estimate_hash: retryEstimate.estimate.estimate_hash,
    })
    const retryConfirmationReplay = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/items/${failedItem.id}/commands/confirm-retry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: started.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-retry-confirm-0001',
        estimate_hash: retryEstimate.estimate.estimate_hash,
      }),
    })
    expect(retryConfirmationReplay.status).toBe(200)
    expect((await retryConfirmationReplay.json() as ConfirmationPayload).confirmation.id).toBe(retryConfirmation.confirmation.id)

    nowMs += 5 * 60 * 1_000 + 1
    const expiredRetry = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/items/${failedItem.id}/commands/retry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: started.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-retry-expired-receipt-0001',
        estimate_hash: retryEstimate.estimate.estimate_hash,
        confirmation_receipt_id: retryConfirmation.confirmation.id,
      }),
    })
    expect(expiredRetry.status).toBe(409)
    expect(await expiredRetry.json()).toMatchObject({ error: 'MEDIA_IMAGE_REVISION_CONFLICT' })
    expect(postCount(gateway)).toBe(2)

    const refreshedRetryEstimateResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ base_revision: started.campaign.revision, item_id: failedItem.id }),
    })
    expect(refreshedRetryEstimateResponse.status).toBe(200)
    const refreshedRetryEstimate = await refreshedRetryEstimateResponse.json() as EstimatePayload
    const refreshedRetryConfirmationResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/items/${failedItem.id}/commands/confirm-retry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: started.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-retry-confirm-refreshed-0001',
        estimate_hash: refreshedRetryEstimate.estimate.estimate_hash,
      }),
    })
    expect(refreshedRetryConfirmationResponse.status).toBe(200)
    const refreshedRetryConfirmation = await refreshedRetryConfirmationResponse.json() as ConfirmationPayload

    const retryInput = {
      base_revision: started.campaign.revision,
      idempotency_key: 'bb-image-15-5d-campaign-retry-0001',
      estimate_hash: refreshedRetryEstimate.estimate.estimate_hash,
      confirmation_receipt_id: refreshedRetryConfirmation.confirmation.id,
    }
    const retryResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/items/${failedItem.id}/commands/retry`, {
      method: 'POST', headers, body: JSON.stringify(retryInput),
    })
    expect(retryResponse.status).toBe(202)
    const retried = await retryResponse.json() as CampaignPayload
    const retriedItem = retried.items.find(item => item.id === failedItem.id)
    expect(retriedItem).toMatchObject({ state: 'queued', attempt: 2 })
    expect(typeof retriedItem?.project_id).toBe('string')
    if (!retriedItem?.project_id) throw new Error('expected second Campaign attempt Project')
    expect(retriedItem.project_id).not.toBe(failedItem.project_id)
    expect(postCount(gateway)).toBe(3)
    const firstAttemptAfterRetryResponse = await request(handler, `/api/images/projects/${failedItem.project_id}/projection`)
    expect(firstAttemptAfterRetryResponse.status).toBe(200)
    expect((await firstAttemptAfterRetryResponse.json() as ProjectProjectionPayload).campaign_intent).toEqual(immutableFirstAttemptIntent)
    const secondAttemptProjectionResponse = await request(handler, `/api/images/projects/${retriedItem.project_id}/projection`)
    expect(secondAttemptProjectionResponse.status).toBe(200)
    expect((await secondAttemptProjectionResponse.json() as ProjectProjectionPayload).campaign_intent).toMatchObject({
      project_id: retriedItem.project_id,
      campaign_id: created.payload.campaign.id,
      item_id: failedItem.id,
      attempt: 2,
      template_id: template.id,
      template_revision_id: template.revisionId,
      slot_bindings: [
        { slot_id: 'headline', text: secondHeadline },
        { slot_id: 'signup_qr', qr_payload: secondSignupQr },
      ],
    })
    for (const prompt of gateway.calls
      .filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')
      .map(call => (call.body as { prompt?: string } | undefined)?.prompt ?? '')) {
      expect(prompt).not.toContain(firstHeadline)
      expect(prompt).not.toContain(firstSignupQr)
      expect(prompt).not.toContain(secondHeadline)
      expect(prompt).not.toContain(secondSignupQr)
    }
    const retryReplay = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/items/${failedItem.id}/commands/retry`, {
      method: 'POST', headers, body: JSON.stringify(retryInput),
    })
    expect(retryReplay.status).toBe(202)
    expect((await retryReplay.json() as CampaignPayload).items.find(item => item.id === failedItem.id)?.attempt).toBe(2)
    expect(postCount(gateway)).toBe(3)
  })
})

test('15.5D Campaign 只会取消 queued 项目，running 竞态返回 409 且不得宣称取消成功', async () => {
  const gateway = campaignGateway()
  const service = await workbench('cancel', { now: () => new Date('2026-08-05T00:00:00.000Z'), fetchImpl: gateway.fetchImpl })
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)

  await withGateway(async () => {
    const queuedCampaign = await createCampaign(handler, campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-queued-cancel-0001',
      items: [{ variable_values: [] }],
    }))
    const queuedEstimateResponse = await request(handler, `/api/images/campaigns/${queuedCampaign.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: queuedCampaign.payload.campaign.revision }),
    })
    const queuedEstimate = await queuedEstimateResponse.json() as EstimatePayload
    const queuedConfirmResponse = await request(handler, `/api/images/campaigns/${queuedCampaign.payload.campaign.id}/commands/confirm`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: queuedCampaign.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-queued-confirm-0001',
        estimate_hash: queuedEstimate.estimate.estimate_hash,
      }),
    })
    const queuedConfirm = await queuedConfirmResponse.json() as ConfirmationPayload
    const queuedStartResponse = await request(handler, `/api/images/campaigns/${queuedCampaign.payload.campaign.id}/commands/start`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: queuedConfirm.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-queued-start-0001',
        estimate_hash: queuedEstimate.estimate.estimate_hash,
        confirmation_receipt_id: queuedConfirm.confirmation.id,
      }),
    })
    expect(queuedStartResponse.status).toBe(202)
    const queuedStarted = await queuedStartResponse.json() as CampaignPayload
    const queuedProjectId = queuedStarted.items[0]?.project_id
    if (!queuedProjectId) throw new Error('expected queued Campaign Project')
    const trackedOperation = (await service.repository.listGenerationOperations(queuedProjectId))[0]
    if (!trackedOperation) throw new Error('expected Campaign mapped generation operation')
    // A later unrelated formal Operation must not become the Campaign's
    // status source merely because it sorts last in the child Project.
    await service.repository.saveGenerationOperation({
      ...trackedOperation,
      id: 'op_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      transport_task_id: undefined,
      idempotency_key: 'bb-image-15-5d-unrelated-operation-0001',
      request_hash: `sha256:${'a'.repeat(64)}`,
      status: 'failed',
      safe_error: { code: 'MEDIA_IMAGE_UNAVAILABLE', message: '图片服务暂不可用，请稍后重试' },
      completed_at: '2026-08-05T00:00:01.000Z',
      created_at: '2026-08-05T00:00:01.000Z',
      updated_at: '2026-08-05T00:00:01.000Z',
    })
    const preciseStatus = await request(handler, `/api/images/campaigns/${queuedCampaign.payload.campaign.id}`)
    expect(preciseStatus.status).toBe(200)
    expect((await preciseStatus.json() as CampaignPayload).items[0]).toMatchObject({ state: 'queued', attempt: 1 })
    const queuedCancel = await request(handler, `/api/images/campaigns/${queuedCampaign.payload.campaign.id}/commands/cancel`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: queuedStarted.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-queued-cancel-command-0001',
      }),
    })
    expect(queuedCancel.status).toBe(200)
    expect(await queuedCancel.json()).toMatchObject({ campaign: { state: 'cancelled' }, items: [{ state: 'cancelled' }] })
    expect(gateway.calls.filter(call => call.path.endsWith('/cancel') && call.method === 'POST')).toHaveLength(1)

    const runningCampaign = await createCampaign(handler, campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-running-cancel-0001',
      items: [{ variable_values: [] }],
    }))
    const runningEstimateResponse = await request(handler, `/api/images/campaigns/${runningCampaign.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: runningCampaign.payload.campaign.revision }),
    })
    const runningEstimate = await runningEstimateResponse.json() as EstimatePayload
    const runningConfirmResponse = await request(handler, `/api/images/campaigns/${runningCampaign.payload.campaign.id}/commands/confirm`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: runningCampaign.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-running-confirm-0001',
        estimate_hash: runningEstimate.estimate.estimate_hash,
      }),
    })
    const runningConfirm = await runningConfirmResponse.json() as ConfirmationPayload
    const runningStartResponse = await request(handler, `/api/images/campaigns/${runningCampaign.payload.campaign.id}/commands/start`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: runningConfirm.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-running-start-0001',
        estimate_hash: runningEstimate.estimate.estimate_hash,
        confirmation_receipt_id: runningConfirm.confirmation.id,
      }),
    })
    const runningStarted = await runningStartResponse.json() as CampaignPayload
    expect(runningStarted.items[0]?.project_id).toEqual(expect.any(String))
    const operation = await service.repository.listGenerationOperations(runningStarted.items[0]!.project_id!)
    const transportId = operation[0]?.transport_task_id
    if (!transportId) throw new Error('expected Campaign transport task')
    const transport = await service.repository.getOperation(transportId)
    if (!transport.remote_task_id) throw new Error('expected remote Campaign task')
    gateway.setTaskStatus(transport.remote_task_id, 'running')

    const runningCancel = await request(handler, `/api/images/campaigns/${runningCampaign.payload.campaign.id}/commands/cancel`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: runningStarted.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-running-cancel-command-0001',
      }),
    })
    expect(runningCancel.status).toBe(409)
    const cancellationReceipt = repositoryDatabase(service).query(`SELECT status,result_json
      FROM image_workflow_command_receipts
      WHERE scope='campaign-cancel' AND aggregate_id=? AND idempotency_key=?`).get(
      runningCampaign.payload.campaign.id,
      'bb-image-15-5d-campaign-running-cancel-command-0001',
    ) as { status: string; result_json: string } | null
    expect(cancellationReceipt).toMatchObject({ status: 'complete' })
    expect(JSON.parse(cancellationReceipt?.result_json ?? '{}')).toMatchObject({
      kind: 'campaign_cancellation_outcome',
      outcome: 'cancellation_too_late',
    })
    const afterRace = await request(handler, `/api/images/campaigns/${runningCampaign.payload.campaign.id}`)
    expect(afterRace.status).toBe(200)
    expect(await afterRace.json()).toMatchObject({ campaign: { state: 'running' }, items: [{ state: 'running' }] })
    expect(gateway.calls.filter(call => call.path.endsWith('/cancel') && call.method === 'POST')).toHaveLength(1)

    // A late cancellation receipt is terminal even when the accepted remote
    // task finishes after the 409 race.  Recovery must not reopen the
    // prepared workflow intent or reinterpret the item as a successful cancel.
    gateway.setTaskStatus(transport.remote_task_id, 'succeeded')
    const afterCompletion = await request(handler, `/api/images/campaigns/${runningCampaign.payload.campaign.id}`)
    expect(afterCompletion.status).toBe(200)
    expect(await afterCompletion.json()).toMatchObject({ campaign: { state: 'completed' }, items: [{ state: 'ready' }] })
    const completedCancellationReceipt = repositoryDatabase(service).query(`SELECT status,result_json
      FROM image_workflow_command_receipts
      WHERE scope='campaign-cancel' AND aggregate_id=? AND idempotency_key=?`).get(
      runningCampaign.payload.campaign.id,
      'bb-image-15-5d-campaign-running-cancel-command-0001',
    ) as { status: string; result_json: string } | null
    expect(completedCancellationReceipt).toMatchObject({ status: 'complete' })
    expect(JSON.parse(completedCancellationReceipt?.result_json ?? '{}')).toMatchObject({
      kind: 'campaign_cancellation_outcome',
      outcome: 'cancellation_too_late',
    })
  })
})

test('15.5D Campaign 远端 POST 已发起但未响应时取消不得假成功，释放后启动可收敛', async () => {
  const gateway = campaignGateway({ blockPosts: [1] })
  const service = await workbench('post-in-flight-cancel', {
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fetchImpl: gateway.fetchImpl,
  })
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)

  await withGateway(async () => {
    const created = await createCampaign(handler, campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-post-in-flight-create-0001',
      items: [{ variable_values: [] }],
    }))
    expect(created.response.status).toBe(201)
    const estimateResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: created.payload.campaign.revision }),
    })
    expect(estimateResponse.status).toBe(200)
    const estimate = await estimateResponse.json() as EstimatePayload
    const confirmResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-post-in-flight-confirm-0001',
        estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    expect(confirmResponse.status).toBe(200)
    const confirmation = await confirmResponse.json() as ConfirmationPayload
    const startInput = {
      base_revision: confirmation.campaign.revision,
      idempotency_key: 'bb-image-15-5d-campaign-post-in-flight-start-0001',
      estimate_hash: estimate.estimate.estimate_hash,
      confirmation_receipt_id: confirmation.confirmation.id,
    }
    const startPromise = request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST', headers, body: JSON.stringify(startInput),
    })

    try {
      await gateway.waitForBlockedPost()
      expect(postCount(gateway)).toBe(1)

      const duringPostResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}`)
      expect(duringPostResponse.status).toBe(200)
      const duringPost = await duringPostResponse.json() as CampaignPayload
      const boundItem = duringPost.items[0]
      expect(duringPost.campaign.state).toBe('running')
      expect(boundItem).toMatchObject({ state: 'queued', attempt: 1 })
      expect(typeof boundItem?.project_id).toBe('string')
      if (!boundItem?.project_id) throw new Error('Campaign item must bind its Project before the remote POST response')
      expect(boundItem.project_id).toMatch(/^[a-z0-9][a-z0-9_-]{7,79}$/)
      expect(await service.repository.listGenerationOperations(boundItem.project_id)).toHaveLength(1)

      const cancelResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/cancel`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base_revision: duringPost.campaign.revision,
          idempotency_key: 'bb-image-15-5d-campaign-post-in-flight-cancel-0001',
        }),
      })
      expect(cancelResponse.status).toBe(409)
      expect(await cancelResponse.json()).toMatchObject({ error: 'MEDIA_STATE_CONFLICT' })

      const afterRefusedCancelResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}`)
      expect(afterRefusedCancelResponse.status).toBe(200)
      const afterRefusedCancel = await afterRefusedCancelResponse.json() as CampaignPayload
      expect(afterRefusedCancel).toMatchObject({ campaign: { state: 'running' }, items: [{ project_id: boundItem.project_id }] })
      expect(afterRefusedCancel.items[0]?.state).not.toBe('cancelled')

      gateway.releaseBlockedPost()
      const startedResponse = await startPromise
      expect(startedResponse.status).toBe(202)
      const started = await startedResponse.json() as CampaignPayload
      expect(started).toMatchObject({
        campaign: { state: 'running' },
        items: [{ state: 'queued', project_id: boundItem.project_id, attempt: 1 }],
      })
      expect(postCount(gateway)).toBe(1)
    } finally {
      gateway.releaseBlockedPost()
      await startPromise.catch(() => undefined)
    }
  })
})

test('15.5D 取消事务写入失败后重启优先消费取消回执，排队 Operation 不得首次 POST', async () => {
  const gateway = campaignGateway()
  let interruptBeforePost = true
  const rootPath = await root('cancel-atomic-recovery')
  const legacyRoot = await root('cancel-atomic-recovery-legacy')
  const first = new ImageWorkbenchService({
    root: rootPath,
    legacyMediaRoot: legacyRoot,
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fetchImpl: gateway.fetchImpl,
    crashInjector: point => {
      if (point === 'after_generation_round_persisted_before_post' && interruptBeforePost) {
        interruptBeforePost = false
        throw new Error('INJECTED_CAMPAIGN_ROUND_BEFORE_POST')
      }
    },
  })
  services.push(first)
  const firstHandler = createImageWorkbenchDomainApiHandler(first.applications, capability)

  await withGateway(async () => {
    const created = await createCampaign(firstHandler, campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-cancel-atomic-create-0001',
      items: [{ variable_values: [] }],
    }))
    const estimateResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: created.payload.campaign.revision }),
    })
    const estimate = await estimateResponse.json() as EstimatePayload
    const confirmationResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-cancel-atomic-confirm-0001',
        estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    const confirmation = await confirmationResponse.json() as ConfirmationPayload
    const startedResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: confirmation.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-cancel-atomic-start-0001',
        estimate_hash: estimate.estimate.estimate_hash,
        confirmation_receipt_id: confirmation.confirmation.id,
      }),
    })
    expect(startedResponse.status).toBe(202)
    const started = await startedResponse.json() as CampaignPayload
    const item = started.items[0]
    if (!item?.project_id) throw new Error('expected persisted Campaign child Project')
    expect(postCount(gateway)).toBe(0)
    const formalBefore = (await first.repository.listGenerationOperations(item.project_id))[0]
    if (!formalBefore?.transport_task_id) throw new Error('expected formal generation transport')
    expect(formalBefore).toMatchObject({ status: 'queued', cost_state: 'not_submitted' })
    const transportBefore = await first.repository.getOperation(formalBefore.transport_task_id)
    expect(transportBefore).toMatchObject({ status: 'queued' })

    type RepositoryInternals = {
      updateCampaignAttemptLocked(attempt: unknown): unknown
    }
    const internals = first.repository as unknown as RepositoryInternals
    const originalUpdateAttempt = internals.updateCampaignAttemptLocked
    internals.updateCampaignAttemptLocked = function (attempt: unknown): unknown {
      const state = (attempt as { state?: string }).state
      if (state === 'cancelled') throw new Error('INJECTED_CANCEL_TRANSACTION_ROLLBACK')
      return originalUpdateAttempt.call(first.repository, attempt)
    }
    let interruptedCancel: Response | undefined
    try {
      interruptedCancel = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/cancel`, {
        method: 'POST', headers, body: JSON.stringify({
          base_revision: started.campaign.revision,
          idempotency_key: 'bb-image-15-5d-campaign-cancel-atomic-cancel-0001',
        }),
      })
    } finally {
      internals.updateCampaignAttemptLocked = originalUpdateAttempt
    }
    expect(interruptedCancel?.status).toBe(500)
    expect(postCount(gateway)).toBe(0)
    const formalAfterRollback = await first.repository.getGenerationOperation(item.project_id, formalBefore.id)
    const transportAfterRollback = await first.repository.getOperation(formalBefore.transport_task_id)
    expect(formalAfterRollback).toMatchObject({ status: 'queued', cost_state: 'not_submitted' })
    expect(transportAfterRollback).toMatchObject({ status: 'queued' })
    expect(repositoryDatabase(first).query(`SELECT state FROM image_campaign_attempts
      WHERE campaign_id=? AND item_id=? AND attempt=?`).get(
      created.payload.campaign.id, item.id, 1,
    )).toMatchObject({ state: 'bound' })
    expect(repositoryDatabase(first).query(`SELECT status FROM image_workflow_command_receipts
      WHERE scope='campaign-cancel' AND aggregate_id=? AND idempotency_key=?`).get(
      created.payload.campaign.id,
      'bb-image-15-5d-campaign-cancel-atomic-cancel-0001',
    )).toMatchObject({ status: 'prepared' })

    first.repository.close()
    services.splice(services.indexOf(first), 1)
    const recovered = new ImageWorkbenchService({
      root: rootPath,
      legacyMediaRoot: legacyRoot,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      fetchImpl: gateway.fetchImpl,
    })
    services.push(recovered)
    const recoveredHandler = createImageWorkbenchDomainApiHandler(recovered.applications, capability)
    await recovered.recoverInterruptedOperations()
    expect(postCount(gateway)).toBe(0)
    const state = await request(recoveredHandler, `/api/images/campaigns/${created.payload.campaign.id}`)
    expect(state.status).toBe(200)
    expect(await state.json()).toMatchObject({ campaign: { state: 'cancelled' }, items: [{ state: 'cancelled', attempt: 1 }] })
    const formalAfterRecovery = await recovered.repository.getGenerationOperation(item.project_id, formalBefore.id)
    const transportAfterRecovery = await recovered.repository.getOperation(formalBefore.transport_task_id)
    expect(formalAfterRecovery).toMatchObject({ status: 'cancelled', cost_state: 'not_submitted' })
    expect(transportAfterRecovery).toMatchObject({ status: 'cancelled' })
    expect(repositoryDatabase(recovered).query(`SELECT status FROM image_workflow_command_receipts
      WHERE scope='campaign-cancel' AND aggregate_id=? AND idempotency_key=?`).get(
      created.payload.campaign.id,
      'bb-image-15-5d-campaign-cancel-atomic-cancel-0001',
    )).toMatchObject({ status: 'complete' })
  })
})

test('15.5D 旧版本 formal 已取消但 transport 未落库时恢复不得重新 POST 或复活 formal', async () => {
  const gateway = campaignGateway()
  let interruptBeforePost = true
  const rootPath = await root('cancel-formal-partial-recovery')
  const legacyRoot = await root('cancel-formal-partial-recovery-legacy')
  const first = new ImageWorkbenchService({
    root: rootPath,
    legacyMediaRoot: legacyRoot,
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fetchImpl: gateway.fetchImpl,
    crashInjector: point => {
      if (point === 'after_generation_round_persisted_before_post' && interruptBeforePost) {
        interruptBeforePost = false
        throw new Error('INJECTED_CAMPAIGN_ROUND_BEFORE_POST')
      }
    },
  })
  services.push(first)
  const firstHandler = createImageWorkbenchDomainApiHandler(first.applications, capability)

  await withGateway(async () => {
    const created = await createCampaign(firstHandler, campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-cancel-formal-partial-create-0001',
      items: [{ variable_values: [] }],
    }))
    const estimateResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: created.payload.campaign.revision }),
    })
    const estimate = await estimateResponse.json() as EstimatePayload
    const confirmationResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-cancel-formal-partial-confirm-0001',
        estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    const confirmation = await confirmationResponse.json() as ConfirmationPayload
    const startedResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: confirmation.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-cancel-formal-partial-start-0001',
        estimate_hash: estimate.estimate.estimate_hash,
        confirmation_receipt_id: confirmation.confirmation.id,
      }),
    })
    expect(startedResponse.status).toBe(202)
    const started = await startedResponse.json() as CampaignPayload
    const item = started.items[0]
    if (!item?.project_id) throw new Error('expected persisted Campaign child Project')
    const formalBefore = (await first.repository.listGenerationOperations(item.project_id))[0]
    if (!formalBefore?.transport_task_id) throw new Error('expected formal generation transport')
    expect(formalBefore).toMatchObject({ status: 'queued', cost_state: 'not_submitted' })
    expect(await first.repository.getOperation(formalBefore.transport_task_id)).toMatchObject({ status: 'queued' })

    // This is the state left by the pre-atomic cancellation writer: the
    // formal record says cancellation is confirmed, while its transport row
    // is still queued.  The restart path must repair the transport locally,
    // never treat the formal operation as queued, and never POST to Relay.
    await first.repository.updateGenerationOperation({
      ...formalBefore,
      status: 'cancelled',
      cost_state: 'not_submitted',
      cancellation: {
        requested_at: '2026-08-05T00:00:01.000Z',
        remote_state: 'confirmed',
        late_result_policy: 'retain_as_unadopted',
      },
      completed_at: '2026-08-05T00:00:01.000Z',
      updated_at: '2026-08-05T00:00:01.000Z',
    })
    first.repository.close()
    services.splice(services.indexOf(first), 1)

    const recovered = new ImageWorkbenchService({
      root: rootPath,
      legacyMediaRoot: legacyRoot,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      fetchImpl: gateway.fetchImpl,
    })
    services.push(recovered)
    const recoveredHandler = createImageWorkbenchDomainApiHandler(recovered.applications, capability)
    await recovered.recoverInterruptedOperations()
    expect(postCount(gateway)).toBe(0)
    const formalAfterRecovery = await recovered.repository.getGenerationOperation(item.project_id, formalBefore.id)
    const transportAfterRecovery = await recovered.repository.getOperation(formalBefore.transport_task_id)
    expect(formalAfterRecovery).toMatchObject({
      status: 'cancelled',
      cost_state: 'not_submitted',
      cancellation: { remote_state: 'confirmed' },
    })
    expect(transportAfterRecovery).toMatchObject({ status: 'cancelled' })
    const state = await request(recoveredHandler, `/api/images/campaigns/${created.payload.campaign.id}`)
    expect(state.status).toBe(200)
    expect(await state.json()).toMatchObject({ items: [{ state: 'cancelled', attempt: 1 }] })
  })
})

test('15.5D v10 Campaign SQLite 升级 v12 后，以绑定回执重建不可变 Template intent 与精确尝试映射', async () => {
  const gateway = campaignGateway()
  const rootPath = await root('campaign-intent-v10-v11')
  const legacyRoot = await root('campaign-intent-v10-v11-legacy')
  const first = new ImageWorkbenchService({
    root: rootPath,
    legacyMediaRoot: legacyRoot,
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fetchImpl: gateway.fetchImpl,
  })
  services.push(first)
  const firstHandler = createImageWorkbenchDomainApiHandler(first.applications, capability)

  await withGateway(async () => {
    const template = await createTextAndQrTemplate(firstHandler)
    const headline = '迁移后仍可追溯的文本变量'
    const signupQr = 'https://example.test/campaign/migration-signup'
    const created = await createCampaign(firstHandler, campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-v10-intent-create-0001',
      template_id: template.id,
      template_revision_id: template.revisionId,
      items: [{ variable_values: [
        { slot_id: 'headline', value: headline },
        { slot_id: 'signup_qr', value: signupQr },
      ] }],
    }))
    expect(created.response.status).toBe(201)
    const estimateResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: created.payload.campaign.revision }),
    })
    expect(estimateResponse.status).toBe(200)
    const estimate = await estimateResponse.json() as EstimatePayload
    const confirmResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-v10-intent-confirm-0001',
        estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    expect(confirmResponse.status).toBe(200)
    const confirmation = await confirmResponse.json() as ConfirmationPayload
    const startedResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: confirmation.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-v10-intent-start-0001',
        estimate_hash: estimate.estimate.estimate_hash,
        confirmation_receipt_id: confirmation.confirmation.id,
      }),
    })
    expect(startedResponse.status).toBe(202)
    const started = await startedResponse.json() as CampaignPayload
    const child = started.items[0]
    if (!child?.project_id) throw new Error('expected v10 Campaign item to retain its child Project pointer')
    const legacyCampaignRevision = started.campaign.revision
    expect(postCount(gateway)).toBe(1)
    const providerPost = gateway.calls.find(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')
    const providerPrompt = (providerPost?.body as { prompt?: string } | undefined)?.prompt ?? ''
    expect(providerPrompt).not.toContain(headline)
    expect(providerPrompt).not.toContain(signupQr)

    // Simulate an on-disk v10 database: all v10 rows remain, while the
    // immutable intent and exact attempt mapping migrations have not run.
    first.repository.close()
    services.splice(services.indexOf(first), 1)
    const v10 = new Database(join(rootPath, 'metadata', 'metadata.sqlite'))
    try {
      v10.exec('DROP TABLE image_campaign_attempts')
      v10.exec('DROP TABLE image_campaign_project_intents')
      v10.query('DELETE FROM image_metadata_schema_migrations WHERE version=11').run()
      v10.query('DELETE FROM image_metadata_schema_migrations WHERE version=12').run()
      expect(v10.query('SELECT version FROM image_metadata_schema_migrations WHERE version=11').get()).toBeNull()
      expect(v10.query('SELECT version FROM image_metadata_schema_migrations WHERE version=12').get()).toBeNull()
      expect(v10.query('SELECT project_id FROM image_campaign_items WHERE id=?').get(child.id)).toMatchObject({ project_id: child.project_id })
    } finally {
      v10.close()
    }

    const upgraded = new ImageWorkbenchService({
      root: rootPath,
      legacyMediaRoot: legacyRoot,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      fetchImpl: gateway.fetchImpl,
    })
    services.push(upgraded)
    const upgradedHandler = createImageWorkbenchDomainApiHandler(upgraded.applications, capability)
    const projectionResponse = await request(upgradedHandler, `/api/images/projects/${child.project_id}/projection`)
    expect(projectionResponse.status).toBe(200)
    const projection = await projectionResponse.json() as ProjectProjectionPayload
    expect(projection.campaign_intent).toEqual({
      project_id: child.project_id,
      campaign_id: created.payload.campaign.id,
      // The binding command is itself the revision after the durable intent
      // write. A later mutable Campaign row must never rewrite this receipt.
      campaign_revision: legacyCampaignRevision - 1,
      item_id: child.id,
      attempt: 1,
      template_id: template.id,
      template_revision_id: template.revisionId,
      slot_bindings: [
        { slot_id: 'headline', text: headline },
        { slot_id: 'signup_qr', qr_payload: signupQr },
      ],
    })

    const persistedRound = (await upgraded.repository.listGenerationRounds(child.project_id))[0]
    const persistedOperation = (await upgraded.repository.listGenerationOperations(child.project_id))[0]
    if (!persistedRound || !persistedOperation) throw new Error('expected migrated Campaign Round and Operation facts')
    upgraded.repository.close()
    services.splice(services.indexOf(upgraded), 1)

    // Keep the historical v11 intent table and marker, but corrupt the
    // mutable revision it originally derived and remove only v12.  v12 must
    // repair that row from the immutable binding receipt, then bind the exact
    // persisted Round and formal Operation rather than guessing from current
    // Campaign state.
    const historicalV11 = new Database(join(rootPath, 'metadata', 'metadata.sqlite'))
    try {
      const intentRow = historicalV11.query('SELECT document_json FROM image_campaign_project_intents WHERE project_id=?').get(child.project_id) as { document_json: string } | null
      if (!intentRow) throw new Error('expected historical v11 intent')
      const corruptedDocument = JSON.parse(intentRow.document_json) as Record<string, unknown>
      corruptedDocument.campaign_revision = 999
      historicalV11.query('UPDATE image_campaign_project_intents SET campaign_revision=?,document_json=? WHERE project_id=?')
        .run(999, JSON.stringify(corruptedDocument), child.project_id)
      historicalV11.exec('DROP TABLE image_campaign_attempts')
      historicalV11.query('DELETE FROM image_metadata_schema_migrations WHERE version=12').run()
      expect(historicalV11.query('SELECT version FROM image_metadata_schema_migrations WHERE version=11').get()).toMatchObject({ version: 11 })
      expect(historicalV11.query('SELECT version FROM image_metadata_schema_migrations WHERE version=12').get()).toBeNull()
    } finally {
      historicalV11.close()
    }

    const repaired = new ImageWorkbenchService({
      root: rootPath,
      legacyMediaRoot: legacyRoot,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      fetchImpl: gateway.fetchImpl,
    })
    services.push(repaired)
    const repairedHandler = createImageWorkbenchDomainApiHandler(repaired.applications, capability)
    const repairedProjectionResponse = await request(repairedHandler, `/api/images/projects/${child.project_id}/projection`)
    expect(repairedProjectionResponse.status).toBe(200)
    const repairedProjection = await repairedProjectionResponse.json() as ProjectProjectionPayload
    expect(repairedProjection.campaign_intent?.campaign_revision).toBe(legacyCampaignRevision - 1)
    repaired.repository.close()
    services.splice(services.indexOf(repaired), 1)

    const inspected = new Database(join(rootPath, 'metadata', 'metadata.sqlite'), { readonly: true })
    try {
      expect(inspected.query('SELECT version FROM image_metadata_schema_migrations WHERE version=11').get()).toMatchObject({ version: 11 })
      expect(inspected.query('SELECT version FROM image_metadata_schema_migrations WHERE version=12').get()).toMatchObject({ version: 12 })
      expect(inspected.query('SELECT document_json FROM image_campaign_project_intents WHERE project_id=?').get(child.project_id)).not.toBeNull()
      expect(inspected.query(`SELECT generation_round_id,generation_operation_id,state FROM image_campaign_attempts
        WHERE campaign_id=? AND item_id=? AND attempt=1`).get(created.payload.campaign.id, child.id)).toMatchObject({
          generation_round_id: persistedRound.id,
          generation_operation_id: persistedOperation.id,
          state: 'bound',
        })
    } finally {
      inspected.close()
    }
  })
})

test('15.5D Campaign 旧 attempt 的 existingRound 恢复不能绑定到已启动的 retry attempt', async () => {
  const gateway = campaignGateway()
  let injectedCrash = false
  const service = await workbench('attempt-bind-race', {
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fetchImpl: gateway.fetchImpl,
    crashInjector: point => {
      if (point === 'after_generation_round_persisted_before_post' && !injectedCrash) {
        injectedCrash = true
        throw new Error('INJECTED_OLD_ATTEMPT_ROUND_BEFORE_POST')
      }
    },
  })
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)

  await withGateway(async () => {
    const template = await createTextAndQrTemplate(handler)
    const headline = 'attempt-2 不得接收旧项目的标题'
    const signupQr = 'https://example.test/campaign/attempt-two-signup'
    const input = campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-attempt-race-create-0001',
      template_id: template.id,
      template_revision_id: template.revisionId,
      items: [{ variable_values: [
        { slot_id: 'headline', value: headline },
        { slot_id: 'signup_qr', value: signupQr },
      ] }],
    })
    const created = await createCampaign(handler, input)
    expect(created.response.status).toBe(201)
    const initialItem = created.payload.items[0]
    if (!initialItem) throw new Error('expected first Campaign item')

    const estimateResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: created.payload.campaign.revision }),
    })
    expect(estimateResponse.status).toBe(200)
    const estimate = await estimateResponse.json() as EstimatePayload
    expect(estimate.estimate.price_upper_bound.amount_minor % estimate.estimate.paid_operation_count).toBe(0)
    const confirmResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-attempt-race-confirm-0001',
        estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    expect(confirmResponse.status).toBe(200)
    const confirmation = await confirmResponse.json() as ConfirmationPayload

    const firstAttemptKey = `bb-image-campaign-${created.payload.campaign.id}-${initialItem.id}-attempt-1`
    let precreatedCrash: unknown
    try {
      await service.quickCreate({
        idempotency_key: firstAttemptKey,
        title: `${input.name} 1`,
        prompt: input.shared_brief.user_request,
        output_preset: 'square',
        budget_limit: {
          currency: estimate.estimate.price_upper_bound.currency,
          amount_minor: estimate.estimate.price_upper_bound.amount_minor / estimate.estimate.paid_operation_count,
        },
        reference_inputs: [],
      }, {
        brief_overrides: {
          confirmed_facts: input.shared_brief.confirmed_facts,
          must_preserve: input.shared_brief.must_preserve,
        },
      })
    } catch (error) {
      precreatedCrash = error
    }
    expect(injectedCrash).toBe(true)
    expect(precreatedCrash).toBeInstanceOf(Error)
    expect(postCount(gateway)).toBe(0)
    const oldProject = (await service.listProjects()).find(project => project.title === `${input.name} 1`)
    if (!oldProject) throw new Error('expected persisted Project for the interrupted first attempt')

    const oldBindEntered = deferred()
    const releaseOldBind = deferred()
    const originalRecordProject = service.repository.recordCampaignItemProjectCommand
    let oldBindIsDelayed = true
    service.repository.recordCampaignItemProjectCommand = async command => {
      if (
        oldBindIsDelayed
        && command.campaign_id === created.payload.campaign.id
        && command.item_id === initialItem.id
        && command.expected_attempt === 1
      ) {
        oldBindIsDelayed = false
        oldBindEntered.resolve()
        await releaseOldBind.promise
      }
      return await originalRecordProject.call(service.repository, command)
    }

    let delayedFirstStart: Promise<Response> | undefined
    try {
      const startInput = {
        base_revision: confirmation.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-attempt-race-start-one-0001',
        estimate_hash: estimate.estimate.estimate_hash,
        confirmation_receipt_id: confirmation.confirmation.id,
      }
      delayedFirstStart = request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
        method: 'POST', headers, body: JSON.stringify(startInput),
      })
      await oldBindEntered.promise

      const beforeCancelResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}`)
      const beforeCancel = await beforeCancelResponse.json() as CampaignPayload
      expect(beforeCancel).toMatchObject({ campaign: { state: 'running' }, items: [{ attempt: 1, state: 'queued' }] })
      expect(beforeCancel.items[0]?.project_id).toBeUndefined()

      const cancelResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/cancel`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base_revision: beforeCancel.campaign.revision,
          idempotency_key: 'bb-image-15-5d-campaign-attempt-race-cancel-one-0001',
        }),
      })
      expect(cancelResponse.status).toBe(200)
      const cancelled = await cancelResponse.json() as CampaignPayload
      expect(cancelled).toMatchObject({ campaign: { state: 'cancelled' }, items: [{ attempt: 1, state: 'cancelled' }] })

      const retryEstimateResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ base_revision: cancelled.campaign.revision, item_id: initialItem.id }),
      })
      expect(retryEstimateResponse.status).toBe(200)
      const retryEstimate = await retryEstimateResponse.json() as EstimatePayload
      expect(retryEstimate.estimate).toMatchObject({ purpose: 'retry', item_id: initialItem.id, attempt: 2 })
      const retryConfirmationResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/items/${initialItem.id}/commands/confirm-retry`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base_revision: cancelled.campaign.revision,
          idempotency_key: 'bb-image-15-5d-campaign-attempt-race-confirm-two-0001',
          estimate_hash: retryEstimate.estimate.estimate_hash,
        }),
      })
      expect(retryConfirmationResponse.status).toBe(200)
      const retryConfirmation = await retryConfirmationResponse.json() as ConfirmationPayload
      const retryResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/items/${initialItem.id}/commands/retry`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base_revision: cancelled.campaign.revision,
          idempotency_key: 'bb-image-15-5d-campaign-attempt-race-start-two-0001',
          estimate_hash: retryEstimate.estimate.estimate_hash,
          confirmation_receipt_id: retryConfirmation.confirmation.id,
        }),
      })
      expect(retryResponse.status).toBe(202)
      const retried = await retryResponse.json() as CampaignPayload
      const retriedItem = retried.items.find(item => item.id === initialItem.id)
      if (!retriedItem?.project_id) throw new Error('expected second attempt to bind its own child Project')
      expect(retriedItem).toMatchObject({ attempt: 2, state: 'queued' })
      expect(retriedItem.project_id).not.toBe(oldProject.id)

      const oldProjectionBeforeReleaseResponse = await request(handler, `/api/images/projects/${oldProject.id}/projection`)
      expect(oldProjectionBeforeReleaseResponse.status).toBe(200)
      expect((await oldProjectionBeforeReleaseResponse.json() as ProjectProjectionPayload).campaign_intent).toBeNull()
      const secondProjectionResponse = await request(handler, `/api/images/projects/${retriedItem.project_id}/projection`)
      expect(secondProjectionResponse.status).toBe(200)
      const secondProjection = await secondProjectionResponse.json() as ProjectProjectionPayload
      expect(secondProjection.campaign_intent).toEqual({
        project_id: retriedItem.project_id,
        campaign_id: created.payload.campaign.id,
        campaign_revision: retried.campaign.revision - 1,
        item_id: initialItem.id,
        attempt: 2,
        template_id: template.id,
        template_revision_id: template.revisionId,
        slot_bindings: [
          { slot_id: 'headline', text: headline },
          { slot_id: 'signup_qr', qr_payload: signupQr },
        ],
      })

      releaseOldBind.resolve()
      const delayedStartResponse = await delayedFirstStart
      expect(delayedStartResponse.status).toBe(202)
      expect(await delayedStartResponse.json()).toMatchObject({
        items: [{ id: initialItem.id, attempt: 2, project_id: retriedItem.project_id }],
      })
      const finalResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}`)
      expect(finalResponse.status).toBe(200)
      const finalCampaign = await finalResponse.json() as CampaignPayload
      expect(finalCampaign.items).toEqual([expect.objectContaining({
        id: initialItem.id,
        attempt: 2,
        project_id: retriedItem.project_id,
      })])
      expect(postCount(gateway)).toBe(1)
      const providerPost = gateway.calls.find(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')
      const providerPrompt = (providerPost?.body as { prompt?: string } | undefined)?.prompt ?? ''
      expect(providerPrompt).not.toContain(headline)
      expect(providerPrompt).not.toContain(signupQr)
      const oldProjectionAfterReleaseResponse = await request(handler, `/api/images/projects/${oldProject.id}/projection`)
      expect(oldProjectionAfterReleaseResponse.status).toBe(200)
      expect((await oldProjectionAfterReleaseResponse.json() as ProjectProjectionPayload).campaign_intent).toBeNull()
    } finally {
      releaseOldBind.resolve()
      service.repository.recordCampaignItemProjectCommand = originalRecordProject
      await delayedFirstStart?.catch(() => undefined)
    }
  })
})

test('15.5D Campaign 已绑定且 running 的同 attempt 恢复回调必须幂等复用 Project intent', async () => {
  const gateway = campaignGateway()
  const service = await workbench('running-bind-idempotency', {
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fetchImpl: gateway.fetchImpl,
  })
  const handler = createImageWorkbenchDomainApiHandler(service.applications, capability)

  await withGateway(async () => {
    const input = campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-running-bind-create-0001',
      items: [{ variable_values: [] }],
    })
    const created = await createCampaign(handler, input)
    expect(created.response.status).toBe(201)
    const item = created.payload.items[0]
    if (!item) throw new Error('expected Campaign item for idempotent binding')
    const estimateResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: created.payload.campaign.revision }),
    })
    const estimate = await estimateResponse.json() as EstimatePayload
    const confirmationResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-running-bind-confirm-0001',
        estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    expect(confirmationResponse.status).toBe(200)
    const confirmation = await confirmationResponse.json() as ConfirmationPayload
    const startInput = {
      base_revision: confirmation.campaign.revision,
      idempotency_key: 'bb-image-15-5d-campaign-running-bind-start-0001',
      estimate_hash: estimate.estimate.estimate_hash,
      confirmation_receipt_id: confirmation.confirmation.id,
    }
    const firstStartResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST', headers, body: JSON.stringify(startInput),
    })
    expect(firstStartResponse.status).toBe(202)
    const firstStart = await firstStartResponse.json() as CampaignPayload
    const firstItem = firstStart.items.find(candidate => candidate.id === item.id)
    if (!firstItem?.project_id) throw new Error('expected initial Campaign Project binding')
    const operations = await service.repository.listGenerationOperations(firstItem.project_id)
    const transportId = operations[0]?.transport_task_id
    if (!transportId) throw new Error('expected Campaign transport operation')
    const transport = await service.repository.getOperation(transportId)
    if (!transport.remote_task_id) throw new Error('expected Campaign remote task')
    gateway.setTaskStatus(transport.remote_task_id, 'running')

    // Replay first moves the persisted Campaign item to running through the
    // ordinary synchronization path, while retaining the same child Project.
    const runningReplayResponse = await request(handler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST', headers, body: JSON.stringify(startInput),
    })
    expect(runningReplayResponse.status).toBe(202)
    const runningReplay = await runningReplayResponse.json() as CampaignPayload
    const runningItem = runningReplay.items.find(candidate => candidate.id === item.id)
    expect(runningItem).toMatchObject({ state: 'running', attempt: 1, project_id: firstItem.project_id })
    const projectCountBefore = (await service.listProjects()).length
    const intentBeforeResponse = await request(handler, `/api/images/projects/${firstItem.project_id}/projection`)
    expect(intentBeforeResponse.status).toBe(200)
    const intentBefore = await intentBeforeResponse.json() as ProjectProjectionPayload
    expect(intentBefore.campaign_intent).toMatchObject({
      project_id: firstItem.project_id,
      campaign_id: created.payload.campaign.id,
      item_id: item.id,
      attempt: 1,
      slot_bindings: [],
    })

    // This is the callback boundary used by a recovered existingRound. Its
    // idempotency must be independent of the item's later running projection.
    const rebound = await service.recoveryApplication.reconcileCampaignItemProjectBinding(
      created.payload.campaign.id,
      item.id,
      1,
      firstItem.project_id,
    )
    expect(rebound).toBeDefined()
    expect((await service.listProjects())).toHaveLength(projectCountBefore)
    expect(postCount(gateway)).toBe(1)
    const intentAfterResponse = await request(handler, `/api/images/projects/${firstItem.project_id}/projection`)
    expect(intentAfterResponse.status).toBe(200)
    expect((await intentAfterResponse.json() as ProjectProjectionPayload).campaign_intent).toEqual(intentBefore.campaign_intent)
    const inspected = new Database(join(service.repository.paths().root, 'metadata', 'metadata.sqlite'), { readonly: true })
    try {
      expect(inspected.query(`SELECT COUNT(*) AS count FROM image_campaign_project_intents
        WHERE campaign_id=? AND item_id=?`).get(created.payload.campaign.id, item.id)).toMatchObject({ count: 1 })
    } finally {
      inspected.close()
    }
  })
})

test('15.5D Campaign 公开 pending retry confirmation，并可在重启后用同一收据启动 retry', async () => {
  const gateway = campaignGateway()
  const rootPath = await root('pending-retry-confirmation')
  const legacyRoot = await root('pending-retry-confirmation-legacy')
  const first = new ImageWorkbenchService({
    root: rootPath,
    legacyMediaRoot: legacyRoot,
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fetchImpl: gateway.fetchImpl,
  })
  services.push(first)
  const firstHandler = createImageWorkbenchDomainApiHandler(first.applications, capability)

  await withGateway(async () => {
    const created = await createCampaign(firstHandler, campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-pending-retry-create-0001',
      items: [{ variable_values: [] }],
    }))
    expect(created.response.status).toBe(201)
    const item = created.payload.items[0]
    if (!item) throw new Error('expected Campaign item for pending retry receipt')
    const estimateResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: created.payload.campaign.revision }),
    })
    expect(estimateResponse.status).toBe(200)
    const estimate = await estimateResponse.json() as EstimatePayload
    const confirmationResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-pending-retry-confirm-start-0001',
        estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    expect(confirmationResponse.status).toBe(200)
    const confirmation = await confirmationResponse.json() as ConfirmationPayload
    const startedResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: confirmation.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-pending-retry-start-one-0001',
        estimate_hash: estimate.estimate.estimate_hash,
        confirmation_receipt_id: confirmation.confirmation.id,
      }),
    })
    expect(startedResponse.status).toBe(202)
    const started = await startedResponse.json() as CampaignPayload
    const startedItem = started.items.find(candidate => candidate.id === item.id)
    if (!startedItem?.project_id) throw new Error('expected first Campaign attempt Project')
    const cancelledResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/cancel`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: started.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-pending-retry-cancel-one-0001',
      }),
    })
    expect(cancelledResponse.status).toBe(200)
    const cancelled = await cancelledResponse.json() as CampaignPayload
    expect(cancelled).toMatchObject({ campaign: { state: 'cancelled' }, items: [{ id: item.id, attempt: 1, state: 'cancelled' }] })

    const retryEstimateResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ base_revision: cancelled.campaign.revision, item_id: item.id }),
    })
    expect(retryEstimateResponse.status).toBe(200)
    const retryEstimate = await retryEstimateResponse.json() as EstimatePayload
    expect(retryEstimate.estimate).toMatchObject({ purpose: 'retry', item_id: item.id, attempt: 2 })
    const retryConfirmationResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/items/${item.id}/commands/confirm-retry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: cancelled.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-pending-retry-confirm-two-0001',
        estimate_hash: retryEstimate.estimate.estimate_hash,
      }),
    })
    expect(retryConfirmationResponse.status).toBe(200)
    const retryConfirmation = await retryConfirmationResponse.json() as ConfirmationPayload
    const pending = {
      item_id: item.id,
      attempt: 2,
      estimate_hash: retryEstimate.estimate.estimate_hash,
      confirmation_receipt_id: retryConfirmation.confirmation.id,
      expires_at: retryEstimate.estimate.expires_at,
    }
    const visiblePendingResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}`)
    expect(visiblePendingResponse.status).toBe(200)
    expect((await visiblePendingResponse.json() as CampaignPayload).pending_retry_confirmations).toEqual([pending])

    first.repository.close()
    services.splice(services.indexOf(first), 1)
    const recovered = new ImageWorkbenchService({
      root: rootPath,
      legacyMediaRoot: legacyRoot,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      fetchImpl: gateway.fetchImpl,
    })
    services.push(recovered)
    const recoveredHandler = createImageWorkbenchDomainApiHandler(recovered.applications, capability)
    const restoredPendingResponse = await request(recoveredHandler, `/api/images/campaigns/${created.payload.campaign.id}`)
    expect(restoredPendingResponse.status).toBe(200)
    const restored = await restoredPendingResponse.json() as CampaignPayload
    expect(restored.pending_retry_confirmations).toEqual([pending])

    const retryResponse = await request(recoveredHandler, `/api/images/campaigns/${created.payload.campaign.id}/items/${item.id}/commands/retry`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: restored.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-pending-retry-start-two-0001',
        estimate_hash: pending.estimate_hash,
        confirmation_receipt_id: pending.confirmation_receipt_id,
      }),
    })
    expect(retryResponse.status).toBe(202)
    const retried = await retryResponse.json() as CampaignPayload
    expect(retried.items).toEqual([expect.objectContaining({ id: item.id, attempt: 2, state: 'queued', project_id: expect.any(String) })])
    expect(retried.pending_retry_confirmations).toEqual([])
    expect(postCount(gateway)).toBe(2)
  })
})

test('15.5D Campaign 已绑定且 Round 已入库时重启或重复 start 可恢复，不重复提交付费请求', async () => {
  const gateway = campaignGateway()
  const rootPath = await root('recovery')
  const legacyRoot = await root('recovery-legacy')
  let crashed = false
  const first = new ImageWorkbenchService({
    root: rootPath,
    legacyMediaRoot: legacyRoot,
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fetchImpl: gateway.fetchImpl,
    crashInjector: point => {
      if (point === 'after_generation_round_persisted_before_post' && !crashed) {
        crashed = true
        throw new Error('INJECTED_CAMPAIGN_ROUND_BEFORE_POST')
      }
    },
  })
  services.push(first)
  const firstHandler = createImageWorkbenchDomainApiHandler(first.applications, capability)

  await withGateway(async () => {
    const created = await createCampaign(firstHandler, campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-recovery-create-0001',
      items: [{ variable_values: [] }],
    }))
    const estimateResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: created.payload.campaign.revision }),
    })
    const estimate = await estimateResponse.json() as EstimatePayload
    const confirmResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST', headers, body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-recovery-confirm-0001',
        estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    const confirmation = await confirmResponse.json() as ConfirmationPayload
    const startInput = {
      base_revision: confirmation.campaign.revision,
      idempotency_key: 'bb-image-15-5d-campaign-recovery-start-0001',
      estimate_hash: estimate.estimate.estimate_hash,
      confirmation_receipt_id: confirmation.confirmation.id,
    }
    const interrupted = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST', headers, body: JSON.stringify(startInput),
    })
    // The dispatcher records the item/project association after discovering
    // the durable Round, but no paid POST has started at this injected point.
    expect(interrupted.status).toBe(202)
    const interruptedPayload = await interrupted.json() as CampaignPayload
    const interruptedItem = interruptedPayload.items[0]
    expect(interruptedPayload.campaign.state).toBe('running')
    expect(interruptedItem).toMatchObject({ state: 'queued', attempt: 1 })
    expect(typeof interruptedItem?.project_id).toBe('string')
    if (!interruptedItem?.project_id) throw new Error('expected Campaign Project binding before restart')
    const boundProjectId = interruptedItem.project_id
    const projectCountBeforeRestart = (await first.listProjects()).length
    expect(await first.repository.listGenerationOperations(boundProjectId)).toHaveLength(1)
    expect(postCount(gateway)).toBe(0)
    first.repository.close()
    services.splice(services.indexOf(first), 1)

    const recovered = new ImageWorkbenchService({
      root: rootPath,
      legacyMediaRoot: legacyRoot,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      fetchImpl: gateway.fetchImpl,
    })
    services.push(recovered)
    const recoveredHandler = createImageWorkbenchDomainApiHandler(recovered.applications, capability)
    const restoredBeforeRecovery = await request(recoveredHandler, `/api/images/campaigns/${created.payload.campaign.id}`)
    expect(restoredBeforeRecovery.status).toBe(200)
    expect((await restoredBeforeRecovery.json() as CampaignPayload).items).toEqual([
      expect.objectContaining({ project_id: boundProjectId, attempt: 1, state: 'queued' }),
    ])
    await recovered.recoverInterruptedOperations()
    expect(postCount(gateway)).toBe(1)
    const replay = await request(recoveredHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST', headers, body: JSON.stringify(startInput),
    })
    expect(replay.status).toBe(202)
    expect(await replay.json()).toMatchObject({ campaign: { state: 'running' }, items: [{ state: 'queued', attempt: 1 }] })
    const repeatReplay = await request(recoveredHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST', headers, body: JSON.stringify(startInput),
    })
    expect(repeatReplay.status).toBe(202)
    expect((await repeatReplay.json() as CampaignPayload).items).toEqual([
      expect.objectContaining({ project_id: boundProjectId, attempt: 1, state: 'queued' }),
    ])
    expect((await recovered.listProjects())).toHaveLength(projectCountBeforeRestart)
    expect(postCount(gateway)).toBe(1)
  })
})

test('15.5D Campaign 取消在逐项完成后崩溃时保留 intent，并以原幂等键恢复完成', async () => {
  const gateway = campaignGateway()
  const rootPath = await root('cancel-intent-recovery')
  const legacyRoot = await root('cancel-intent-recovery-legacy')
  let crashOnce = true
  const first = new ImageWorkbenchService({
    root: rootPath,
    legacyMediaRoot: legacyRoot,
    now: () => new Date('2026-08-05T00:00:00.000Z'),
    fetchImpl: gateway.fetchImpl,
    crashInjector: point => {
      if (point === 'after_campaign_cancel_item_before_completion' && crashOnce) {
        crashOnce = false
        throw new Error('INJECTED_CAMPAIGN_CANCEL_AFTER_ITEM')
      }
    },
  })
  services.push(first)
  const firstHandler = createImageWorkbenchDomainApiHandler(first.applications, capability)

  await withGateway(async () => {
    const created = await createCampaign(firstHandler, campaignInput({
      idempotency_key: 'bb-image-15-5d-campaign-cancel-intent-create-0001',
      items: [{ variable_values: [] }],
    }))
    const estimateResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/estimate`, {
      method: 'POST', headers, body: JSON.stringify({ base_revision: created.payload.campaign.revision }),
    })
    const estimate = await estimateResponse.json() as EstimatePayload
    const confirmResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/confirm`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: created.payload.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-cancel-intent-confirm-0001',
        estimate_hash: estimate.estimate.estimate_hash,
      }),
    })
    const confirmation = await confirmResponse.json() as ConfirmationPayload
    const startedResponse = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/start`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        base_revision: confirmation.campaign.revision,
        idempotency_key: 'bb-image-15-5d-campaign-cancel-intent-start-0001',
        estimate_hash: estimate.estimate.estimate_hash,
        confirmation_receipt_id: confirmation.confirmation.id,
      }),
    })
    const started = await startedResponse.json() as CampaignPayload
    const cancelInput = {
      base_revision: started.campaign.revision,
      idempotency_key: 'bb-image-15-5d-campaign-cancel-intent-cancel-0001',
    }
    const interrupted = await request(firstHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/cancel`, {
      method: 'POST', headers, body: JSON.stringify(cancelInput),
    })
    expect(interrupted.status).toBe(500)
    expect(gateway.calls.filter(call => call.path.endsWith('/cancel') && call.method === 'POST')).toHaveLength(1)

    first.repository.close()
    services.splice(services.indexOf(first), 1)
    const recovered = new ImageWorkbenchService({
      root: rootPath,
      legacyMediaRoot: legacyRoot,
      now: () => new Date('2026-08-05T00:00:00.000Z'),
      fetchImpl: gateway.fetchImpl,
    })
    services.push(recovered)
    const recoveredHandler = createImageWorkbenchDomainApiHandler(recovered.applications, capability)
    await recovered.recoverInterruptedOperations()
    const recoveredState = await request(recoveredHandler, `/api/images/campaigns/${created.payload.campaign.id}`)
    expect(recoveredState.status).toBe(200)
    expect(await recoveredState.json()).toMatchObject({ campaign: { state: 'cancelled' }, items: [{ state: 'cancelled', attempt: 1 }] })
    const replay = await request(recoveredHandler, `/api/images/campaigns/${created.payload.campaign.id}/commands/cancel`, {
      method: 'POST', headers, body: JSON.stringify(cancelInput),
    })
    expect(replay.status).toBe(200)
    expect(await replay.json()).toMatchObject({ campaign: { state: 'cancelled' }, items: [{ state: 'cancelled', attempt: 1 }] })
    expect(gateway.calls.filter(call => call.path.endsWith('/cancel') && call.method === 'POST')).toHaveLength(1)
  })
})
