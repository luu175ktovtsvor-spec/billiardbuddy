import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageWorkbenchDomainApiHandler } from '../src/server/api/imageWorkbench.js'
import { ImageWorkbenchService } from '../src/server/services/imageWorkbenchService.js'
import { requestQwenImageReasoning as requestImageAdviceClient } from '../src/server/services/qwenImageReasoningAdapter.js'
import { QwenImageReasoningGatewayError, requestQwenImageReasoning } from '../../gateway/qwenImageReasoning.js'
import {
  GATEWAY_PRODUCTION_CAPACITY_ENVIRONMENT_VARIABLES,
  validateDeploymentEnvironment,
} from '../../gateway/validate-deployment-env.js'
import { createGatewayFetch } from '../../gateway/app.js'
import { AuthAuthority } from '../../gateway/installationAuth.js'
import {
  PROVIDER_GATEWAY_PROTOCOL,
  PROVIDER_GATEWAY_PROTOCOL_HEADER,
  PROVIDER_IMAGE_ADVICE_RESULT_PATH,
  PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER,
  PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER,
  PROVIDER_OPERATION_RESULT_ID_HEADER,
} from '../shared/product/providerGateway.js'
import { imageTicketRequest } from './helpers/imageUiTicket.js'

const roots: string[] = []
const at = '2026-08-04T00:00:00.000Z'
const gatewayUrl = 'https://gateway.example.test/gw'
const imageRelayUrl = 'https://relay.example.test/image-generation'
const gatewayToken = 'qwen-gateway-token-0123456789abcdef'
const capability = 'qwen-desktop-capability-0123456789abcdef'

function gatewayProductionPolicyFixture(): Record<string, string> {
  const capacity = Object.fromEntries(GATEWAY_PRODUCTION_CAPACITY_ENVIRONMENT_VARIABLES.map(name => [name, '1']))
  const quota = Object.fromEntries(
    ['TEXT_REASONING', 'VISUAL_EVIDENCE', 'MEDIA_REASONING', 'IMAGE_ADVICE', 'SPEECH_TRANSCRIPTION']
      .flatMap(capabilityName => ['PRINCIPAL', 'INSTALLATION'].flatMap(scope =>
        ['REQUESTS', 'INPUT_BYTES', 'OUTPUT_UNITS', 'TOTAL_TOKENS'].map(axis => [`GW_QUOTA_${capabilityName}_${scope}_${axis}`, '1000']),
      )),
  )
  return {
    ...capacity,
    ...quota,
    GW_CAPACITY_POLICY_REVISION: 'gateway-qwen-test-v1',
    GW_QUOTA_POLICY_REVISION: 'gateway-qwen-test-v1',
    // MiMo owns one physical account split into two non-empty lanes.
    GW_MIMO_CONC: '2',
    GW_MIMO_MEDIA_CONC: '1',
    GW_VISION_CONC: '1',
    GW_SERVER_IDLE_TIMEOUT_SECONDS: '30',
  }
}

async function root(label: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `billiardbuddy-qwen-${label}-`))
  roots.push(value)
  return value
}

async function fixtureDataUrl(): Promise<string> {
  const encoded = await readFile(join(import.meta.dir, 'fixtures', 'image', 'valid-1x1.png.base64'), 'utf8')
  return `data:image/png;base64,${encoded.trim()}`
}

function qwenGateway(options: { fail?: boolean; ackResponse?: () => Response } = {}): { calls: Array<{ path: string; body: Record<string, unknown> }>; fetchImpl: typeof fetch } {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = []
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='
  return {
    calls,
    fetchImpl: async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      const headers = new Headers(init?.headers)
      calls.push({ path: url.pathname, body })
      if (url.pathname === '/gw/v1/image/reasoning') {
        if (options.fail) return Response.json({ error: 'unavailable' }, { status: 503 })
        const role = body.application_role
        const reasoningInput = body.input as { references?: unknown[] } | undefined
        const isPromptPlanning = role === 'image_understanding' && Array.isArray(reasoningInput?.references) && reasoningInput.references.length === 0
        const result = role === 'image_understanding'
          ? { schema_version: 1, application_role: role, provider: 'qwen', model_id: 'qwen3-vl-flash', provider_request_id: isPromptPlanning ? 'qwen-planning-0001' : 'qwen-understanding-0001', usage: { input_bytes: 512, input_tokens: 12, output_tokens: 8 }, output: isPromptPlanning ? { confidence: 'medium', visible_facts: [], preservation_risks: ['不要在生成阶段绘制精确文字'], composition_suggestions: ['采用留白明确的中心构图，并将主体置于视觉焦点'], missing_information: [], user_intent: { purpose: 'promote', audience: '台球爱好者', channel: 'social_feed', subject: '夏季联赛', desired_effect: '让用户快速理解赛事并产生参与兴趣', style_keywords: ['清晰', '有动感'], priority_order: ['subject', 'text', 'layout'] } } : { confidence: 'medium', visible_facts: ['可见一支台球杆'], preservation_risks: ['主体边缘不完整'], composition_suggestions: ['为标题预留顶部空间'], missing_information: ['请确认活动日期'], user_intent: { purpose: 'announce', audience: '赛事参与者和观众', channel: 'poster', subject: '台球赛事', desired_effect: '清楚传达赛事信息', style_keywords: ['清晰', '有层级'], priority_order: ['subject', 'text', 'brand'] } } }
          : { schema_version: 1, application_role: role, provider: 'qwen', model_id: 'qwen3-vl-flash', provider_request_id: 'qwen-assessment-0001', usage: { input_bytes: 256, input_tokens: 8, output_tokens: 6 }, output: { confidence: 'low', observations: ['主体清晰'], risks: ['背景存在轻微伪影'], repair_actions: [{ kind: 'derive', rationale: '保持主体并优化背景' }] } }
        return Response.json(result, {
          headers: {
            'X-BB-Result-Operation': headers.get('X-BB-Operation-ID') ?? '',
            'X-BB-Result-Capability': 'ImageAdvice',
            'X-BB-Result-Fingerprint': createHash('sha256').update(`ImageAdvice\0${String(init?.body)}`).digest('hex'),
          },
        })
      }
      if (url.pathname === '/image-generation/v1/images/tasks') return Response.json({ task_id: 'qwen_candidate_task', status: 'queued', provider_receipt_hash: 'a'.repeat(64) })
      if (url.pathname === '/image-generation/v1/images/tasks/qwen_candidate_task') return Response.json({ task_id: 'qwen_candidate_task', status: 'succeeded', provider_receipt_hash: 'a'.repeat(64), data: [{ b64_json: png, mime_type: 'image/png' }] })
      if (url.pathname === '/image-generation/v1/images/tasks/qwen_candidate_task/ack') return Response.json({ result_acknowledged: true })
      if (url.pathname === '/gw/v1/operations/ack' && init?.method === 'POST') return options.ackResponse?.() ?? new Response(null, { status: 204 })
      return Response.json({ error: 'unexpected' }, { status: 500 })
    },
  }
}

async function withGateway<T>(run: () => Promise<T>): Promise<T> {
  const oldUrl = process.env.BB_GATEWAY_URL
  const oldImageRelayUrl = process.env.BB_IMAGE_RELAY_URL
  const oldToken = process.env.BB_GATEWAY_TOKEN
  process.env.BB_GATEWAY_URL = gatewayUrl
  process.env.BB_IMAGE_RELAY_URL = imageRelayUrl
  process.env.BB_GATEWAY_TOKEN = gatewayToken
  try { return await run() } finally {
    if (oldUrl === undefined) delete process.env.BB_GATEWAY_URL
    else process.env.BB_GATEWAY_URL = oldUrl
    if (oldImageRelayUrl === undefined) delete process.env.BB_IMAGE_RELAY_URL
    else process.env.BB_IMAGE_RELAY_URL = oldImageRelayUrl
    if (oldToken === undefined) delete process.env.BB_GATEWAY_TOKEN
    else process.env.BB_GATEWAY_TOKEN = oldToken
  }
}

async function service(label: string, fetchImpl: typeof fetch): Promise<ImageWorkbenchService> {
  return new ImageWorkbenchService({ root: await root(label), legacyMediaRoot: await root(`${label}-legacy`), now: () => new Date(at), fetchImpl })
}

afterEach(async () => await Promise.all(roots.splice(0).map(async value => await rm(value, { recursive: true, force: true }))))

test('Qwen 理解在不改写用户事实的前提下，为创作方向提供受约束的构图建议', async () => {
  const gateway = qwenGateway()
  const workbench = await service('understanding', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await workbench.createProject({ title: '台球海报', user_request: '保留原有品牌，制作赛事海报', size: '1024x1024', reference_images: [await fixtureDataUrl()], reference_roles: ['subject'] })
    const before = await workbench.getProject(project.id)
    const suggestion = await workbench.understandProject(project.id, { base_revision: before.revision, idempotency_key: 'bb-image-qwen-understanding-0001' })
    expect(suggestion).toMatchObject({
      project_revision: before.revision,
      confidence: 'medium',
      visible_facts: ['可见一支台球杆'],
      missing_information: ['请确认活动日期'],
      user_intent: { purpose: 'announce', audience: '赛事参与者和观众', channel: 'poster', priority_order: ['subject', 'text', 'brand'] },
    })
    expect(await workbench.understandProject(project.id, { base_revision: before.revision, idempotency_key: 'bb-image-qwen-understanding-0001' })).toEqual(suggestion)
    const after = await workbench.getProject(project.id)
    expect(after.revision).toBe(before.revision)
    expect(after.brief?.confirmed_facts).toEqual(before.brief?.confirmed_facts)
    const receipt = await workbench.repository.getExecutionReceipt(project.id, suggestion.execution_receipt_id)
    expect(receipt).toMatchObject({
      capability: 'image_understanding', registry_capability: 'VisualEvidence', provider: 'qwen', model_id: 'qwen3-vl-flash', completed_at: at,
      gateway_result_acknowledged_at: at,
      usage: { input_bytes: 512, input_tokens: 12, output_tokens: 8 },
    })
    const plan = await workbench.createCreativePlan(project.id, {
      base_revision: after.revision,
      idempotency_key: 'bb-image-qwen-plan-0001',
      accept_suggestion_receipt_id: suggestion.execution_receipt_id,
    })
    const brief = await workbench.repository.latestGenerationBrief(project.id)
    expect(plan).toMatchObject({
      source: 'assisted',
      suggestion_receipt_id: suggestion.execution_receipt_id,
      directions: [{ generation_intent: {
        composition_goal: expect.stringMatching(/目标：发布通知或活动信息[\s\S]*目标受众：赛事参与者和观众[\s\S]*为标题预留顶部空间/u),
        visual_tone: expect.stringContaining('希望达到：清楚传达赛事信息'),
      } }],
    })
    expect(brief).toMatchObject({ reasoning_receipt_id: suggestion.execution_receipt_id, missing_information: expect.arrayContaining(['请确认活动日期']) })
    const canvas = await workbench.createCanvas(project.id, { artboard_id: (await workbench.repository.currentDeliverySpec(project.id))!.artboards[0]!.id, base_revision: after.revision, idempotency_key: 'bb-image-qwen-canvas-0001' })
    expect(canvas.canvas.revision).toBe(0)
    expect(gateway.calls.filter(call => call.path === '/gw/v1/image/reasoning')).toHaveLength(1)
  })
})

test('同一项目修订换用新的理解幂等键也只复用已持久化建议', async () => {
  const gateway = qwenGateway()
  const workbench = await service('canonical-advice-idempotency', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await workbench.createProject({ title: '理解重试', user_request: '制作一张台球赛事海报', size: '1024x1024', reference_images: [], reference_roles: [] })
    const first = await workbench.understandProject(project.id, { base_revision: project.revision, idempotency_key: 'bb-image-advice-random-key-0001' })
    const replay = await workbench.understandProject(project.id, { base_revision: project.revision, idempotency_key: 'bb-image-advice-random-key-0002' })
    expect(replay).toEqual(first)
    expect(gateway.calls.filter(call => call.path === '/gw/v1/image/reasoning')).toHaveLength(1)
    expect(gateway.calls[0]?.body.idempotency_key).toMatch(/^bb-image-advice-[a-f0-9]{64}$/u)
  })
})

test('Gateway 已完成但桌面端丢失响应时，下一次理解只恢复原结果且 Provider 只调用一次', async () => {
  const authority = new AuthAuthority({ dbPath: ':memory:', signingKey: 's'.repeat(32) })
  const session = authority.bootstrap('qwen-dropped-response-test-0001')
  let providerCalls = 0
  let dropped = false
  const gateway = createGatewayFetch({
    authority,
    env: {
      BB_GATEWAY_MODEL: 'deepseek-v4-flash', GW_AUTH_SIGNING_KEY: 's'.repeat(32), GW_DB: ':memory:',
      GW_IMAGE_RELAY_INTROSPECTION_TOKEN: 'image-relay-introspection-token-0123456789',
      GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: 'video-relay-introspection-token-0123456789',
      GW_DEEPSEEK_KEY: 'deepseek-key', GW_MIMO_KEY: 'mimo-key', GW_QWEN_KEY: 'qwen-key',
      GW_FUNASR_KEY: 'funasr-key', GW_QWEN_BASE: 'https://qwen.example.test/v1', GW_QWEN_ENABLED: '1',
    },
    fetchImpl: async (_input, init) => {
      providerCalls += 1
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe('qwen3-vl-flash')
      return Response.json({
        id: 'qwen-dropped-response-result-0001',
        choices: [{ message: { content: JSON.stringify({
          confidence: 'high', visible_facts: ['可见台球桌'], preservation_risks: [],
          composition_suggestions: ['主体居中并预留文字区'], missing_information: [],
          user_intent: { purpose: 'promote', channel: 'social_feed', style_keywords: ['清晰'], priority_order: ['subject', 'text'] },
        }) } }],
        usage: { prompt_tokens: 9, completion_tokens: 6 },
      })
    },
  })
  const oldUrl = process.env.BB_GATEWAY_URL
  const oldToken = process.env.BB_GATEWAY_TOKEN
  process.env.BB_GATEWAY_URL = gatewayUrl
  process.env.BB_GATEWAY_TOKEN = session.accessToken
  const transport = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init)
    // The production reverse proxy strips /gw before the Gateway app sees the
    // request; reproduce that boundary while keeping the desktop adapter URL.
    const gatewayUrlForTest = new URL(request.url)
    gatewayUrlForTest.pathname = gatewayUrlForTest.pathname.replace(/^\/gw/u, '') || '/'
    const response = await gateway(new Request(gatewayUrlForTest, request))
    if (!dropped && request.url.endsWith('/gw/v1/image/reasoning')) {
      dropped = true
      throw new Error('simulated_desktop_response_drop')
    }
    return response
  }
  try {
    const workbench = await service('qwen-dropped-response', transport)
    const project = await workbench.createProject({ title: '丢响应恢复', user_request: '制作一张赛事宣传图', size: '1024x1024', reference_images: [], reference_roles: [] })
    await expect(workbench.understandProject(project.id, { base_revision: project.revision, idempotency_key: 'bb-image-dropped-call-0001' })).rejects.toMatchObject({ code: 'IMAGE_QWEN_UNAVAILABLE' })
    const recovered = await workbench.understandProject(project.id, { base_revision: project.revision, idempotency_key: 'bb-image-dropped-call-0002' })
    expect(recovered).toMatchObject({ visible_facts: ['可见台球桌'] })
    expect(providerCalls).toBe(1)
  } finally {
    if (oldUrl === undefined) delete process.env.BB_GATEWAY_URL
    else process.env.BB_GATEWAY_URL = oldUrl
    if (oldToken === undefined) delete process.env.BB_GATEWAY_TOKEN
    else process.env.BB_GATEWAY_TOKEN = oldToken
  }
})

test('创作方向会做一次受约束的内部提示词规划，但公开结果不泄露内部 LLM', async () => {
  const gateway = qwenGateway()
  const workbench = await service('automatic-prompt-planning', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await workbench.createProject({
      title: '无参考图活动海报', user_request: '制作一张面向台球爱好者的夏季联赛宣传图。',
      generation_preferences: { model_selection: 'auto', output_preset: 'social_landscape' },
      reference_images: [], reference_roles: [],
    })
    const suggestion = await workbench.understandProject(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-qwen-automatic-planning-advice-0001',
    })
    const plan = await workbench.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-qwen-automatic-planning-0001',
      accept_suggestion_receipt_id: suggestion.execution_receipt_id,
    })
    expect(plan).toMatchObject({
      source: 'assisted',
      directions: [{ generation_intent: { composition_goal: expect.stringMatching(/(?=[\s\S]*中心构图)(?=[\s\S]*目标：宣传推广)(?=[\s\S]*使用场景：社交信息流)/u) } }],
    })
    expect(JSON.stringify(plan)).not.toContain('qwen3-vl-flash')
    const calls = gateway.calls.filter(call => call.path === '/gw/v1/image/reasoning')
    expect(calls).toHaveLength(1)
    expect((calls[0]!.body.input as { references?: unknown[] }).references).toEqual([])
    expect(await workbench.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-qwen-automatic-planning-0001',
      accept_suggestion_receipt_id: suggestion.execution_receipt_id,
    })).toEqual(plan)
    expect(gateway.calls.filter(call => call.path === '/gw/v1/image/reasoning')).toHaveLength(1)
  })
})

test('付费前的创作方向必须绑定同一项目修订的 AI 建议确认收据', async () => {
  const gateway = qwenGateway()
  const workbench = await service('explicit-advice-confirmation', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await workbench.createProject({
      title: '显式确认建议', user_request: '制作一张台球赛事宣传图', size: '1024x1024', reference_images: [], reference_roles: [],
    })
    const suggestion = await workbench.understandProject(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-explicit-advice-0001',
    })
    await expect(workbench.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-explicit-plan-bad-0001',
    })).rejects.toMatchObject({ code: 'IMAGE_ADVICE_CONFIRMATION_REQUIRED' })
    await expect(workbench.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-explicit-plan-wrong-0001',
      accept_suggestion_receipt_id: 'receipt_wrong_000000000000000000000000000000',
    })).rejects.toMatchObject({ code: 'IMAGE_ADVICE_CONFIRMATION_REQUIRED' })
    const handler = createImageWorkbenchDomainApiHandler(workbench.applications, capability)
    const planUrl = new URL(`http://127.0.0.1/api/images/projects/${project.id}/creative-plans`)
    const planResponse = await handler(imageTicketRequest(planUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability },
      body: JSON.stringify({ base_revision: project.revision, idempotency_key: 'bb-image-explicit-plan-api-0001' }),
    }), planUrl, ['api', 'images', 'projects', project.id, 'creative-plans'])
    expect(planResponse.status).toBe(409)
    expect(await planResponse.json()).toMatchObject({ error: 'MEDIA_IMAGE_ADVICE_CONFIRMATION_REQUIRED' })
    const plan = await workbench.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-explicit-plan-good-0001',
      accept_suggestion_receipt_id: suggestion.execution_receipt_id,
    })
    expect(plan).toMatchObject({ source: 'assisted', suggestion_receipt_id: suggestion.execution_receipt_id })
    const projection = await workbench.getProjectProjection(project.id)
    expect(projection.latest_understanding_suggestion).toEqual(suggestion)
  })
})

test('公开创作方向不会因缺少建议而偷偷触发付费 Qwen 规划', async () => {
  const gateway = qwenGateway()
  const workbench = await service('public-plan-no-hidden-qwen', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await workbench.createProject({
      title: '公开计划无隐藏调用', user_request: '制作一张台球赛事宣传图', size: '1024x1024', reference_images: [], reference_roles: [],
    })
    const plan = await workbench.createCreativePlan(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-public-plan-no-hidden-qwen-0001',
    })
    expect(plan.source).toBe('deterministic')
    expect(gateway.calls.filter(call => call.path === '/gw/v1/image/reasoning')).toHaveLength(0)
  })
})

test('公开确定性 Plan 的幂等重放不会触发隐藏规划请求', async () => {
  const successfulGateway = qwenGateway()
  let reasoningCalls = 0
  let failFirst = true
  const workbench = await service('deterministic-plan-replay', async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString())
    if (url.pathname === '/gw/v1/image/reasoning') {
      reasoningCalls += 1
      if (failFirst) {
        failFirst = false
        return Response.json({ error: 'temporary planning outage' }, { status: 503 })
      }
    }
    return await successfulGateway.fetchImpl(input, init)
  })
  await withGateway(async () => {
    const project = await workbench.createProject({
      title: '规划恢复重放', user_request: '制作一张不依赖隐藏规划的宣传图', size: '1024x1024', reference_images: [], reference_roles: [],
    })
    const command = { base_revision: project.revision, idempotency_key: 'bb-image-deterministic-plan-replay-0001' }
    const first = await workbench.createCreativePlan(project.id, command)
    expect(first.source).toBe('deterministic')
    const second = await workbench.createCreativePlan(project.id, command)
    expect(second).toEqual(first)
    expect(reasoningCalls).toBe(0)
    expect(successfulGateway.calls.filter(call => call.path === '/gw/v1/image/reasoning')).toHaveLength(0)
    await workbench.updateProject(project.id, {
      revision: project.revision,
      user_request: '项目升版后的其他需求',
      size: '1024x1024',
    })
    expect(await workbench.createCreativePlan(project.id, command)).toEqual(first)
    expect(reasoningCalls).toBe(0)
  })
})

test('项目升版后不会复用旧的内部构图建议', async () => {
  const gateway = qwenGateway()
  const workbench = await service('revision-scoped-prompt-planning', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await workbench.createProject({
      title: '赛事海报', user_request: '制作夏季台球赛事海报', size: '1024x1024', reference_images: [], reference_roles: [],
    })
    const firstSuggestion = await workbench.understandProject(project.id, {
      base_revision: project.revision,
      idempotency_key: 'bb-image-qwen-revision-advice-0001',
    })
    const first = await workbench.createCreativePlan(project.id, {
      base_revision: project.revision, idempotency_key: 'bb-image-qwen-revision-plan-0001', accept_suggestion_receipt_id: firstSuggestion.execution_receipt_id,
    })
    expect(first.source).toBe('assisted')
    const changed = await workbench.updateProject(project.id, {
      revision: project.revision,
      user_request: '制作秋季台球赛事海报',
      size: '1024x1024',
    })
    const secondSuggestion = await workbench.understandProject(project.id, {
      base_revision: changed.revision,
      idempotency_key: 'bb-image-qwen-revision-advice-0002',
    })
    const second = await workbench.createCreativePlan(project.id, {
      base_revision: changed.revision, idempotency_key: 'bb-image-qwen-revision-plan-0002', accept_suggestion_receipt_id: secondSuggestion.execution_receipt_id,
    })
    expect(second.source).toBe('assisted')
    expect(gateway.calls.filter(call => call.path === '/gw/v1/image/reasoning')).toHaveLength(2)
    const latest = await workbench.repository.latestUnderstandingSuggestion(project.id)
    expect(latest?.project_revision).toBe(changed.revision)
  })
})

test('15.4 candidate visual assessment is public-safe advice and cannot change Candidate or working pointer', async () => {
  const gateway = qwenGateway()
  const workbench = await service('assessment', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await workbench.createProject({ title: '候选评估', user_request: '生成台球比赛海报', size: '1024x1024', reference_images: [], reference_roles: [] })
    const submitted = await workbench.submitProject(project.id)
    for (let attempt = 0; attempt < 8; attempt += 1) await workbench.recoverInterruptedOperations()
    const completed = await workbench.getOperation(submitted.id)
    const formal = await workbench.findGenerationOperation(completed.operation_id!)
    expect(formal?.result).toMatchObject({ kind: 'candidate_group' })
    const groupId = formal?.result?.kind === 'candidate_group' ? formal.result.candidate_group_id : ''
    const candidate = (await workbench.getCandidateGroup(project.id, groupId)).candidates[0]!
    const before = await workbench.getProject(project.id)
    const assessment = await workbench.assessCandidateVisual(project.id, candidate.id, { base_revision: before.revision, idempotency_key: 'bb-image-qwen-assessment-0001' })
    expect(assessment).toMatchObject({ candidate_id: candidate.id, repair_actions: [{ kind: 'derive', rationale: '保持主体并优化背景' }] })
    const assessmentCalls = gateway.calls.filter(call => call.path === '/gw/v1/image/reasoning').length
    expect(gateway.calls.find(call => call.path === '/gw/v1/image/reasoning' && /^bb-image-assessment-[a-f0-9]{64}$/u.test(String(call.body.idempotency_key)))?.body.idempotency_key).toMatch(/^bb-image-assessment-[a-f0-9]{64}$/u)
    const assessmentReplay = await workbench.assessCandidateVisual(project.id, candidate.id, { base_revision: before.revision, idempotency_key: 'bb-image-qwen-assessment-new-handle-0002' })
    expect(assessmentReplay).toEqual(assessment)
    expect(gateway.calls.filter(call => call.path === '/gw/v1/image/reasoning')).toHaveLength(assessmentCalls)
    const after = await workbench.getProject(project.id)
    expect(after.revision).toBe(before.revision)
    expect(after.current_versions_by_artboard).toEqual(before.current_versions_by_artboard)
    expect((await workbench.repository.getCandidate(project.id, candidate.id)).content_hash).toBe(candidate.content_hash)
    const handler = createImageWorkbenchDomainApiHandler(workbench.applications, capability)
    const url = new URL(`http://127.0.0.1/api/images/projects/${project.id}/candidates/${candidate.id}/visual-assessments`)
    const response = await handler(imageTicketRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability }, body: JSON.stringify({ base_revision: before.revision, idempotency_key: 'bb-image-qwen-assessment-0001' }) }), url, ['api', 'images', 'projects', project.id, 'candidates', candidate.id, 'visual-assessments'])
    expect(response.status).toBe(200)
    const json = await response.json() as { assessment: unknown }
    expect(JSON.stringify(json)).not.toContain('data:image')
    expect(JSON.stringify(json)).not.toContain('internal')

    const delivery = await workbench.repository.currentDeliverySpec(project.id)
    const adopted = await workbench.adoptCandidate(project.id, candidate.id, {
      base_revision: after.revision,
      idempotency_key: 'bb-image-qwen-final-adoption-0001',
      adoptions: [{ artboard_id: delivery!.artboards[0]!.id, placement: { fit: 'cover', focus_x: 0.5, focus_y: 0.5 } }],
    })
    const versionId = adopted.adoptions[0]!.version_id
    const finalBefore = await workbench.getProject(project.id)
    const finalAssessment = await workbench.assessVersionVisual(project.id, versionId, {
      base_revision: finalBefore.revision,
      idempotency_key: 'bb-image-qwen-final-assessment-0001',
    })
    expect(finalAssessment).toMatchObject({ version_id: versionId, observations: ['主体清晰'] })
    const finalAfter = await workbench.getProject(project.id)
    expect(finalAfter.revision).toBe(finalBefore.revision)
    expect(finalAfter.current_versions_by_artboard).toEqual(finalBefore.current_versions_by_artboard)
    const versionReplay = await workbench.assessVersionVisual(project.id, versionId, {
      base_revision: finalBefore.revision,
      idempotency_key: 'bb-image-qwen-final-assessment-new-handle-0002',
    })
    expect(versionReplay).toEqual(finalAssessment)
  })
})

test('15.4 Qwen failure is explicit but deterministic Canvas stays available', async () => {
  const gateway = qwenGateway({ fail: true })
  const workbench = await service('degrade', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await workbench.createProject({ title: '降级', user_request: '制作海报', size: '1024x1024', reference_images: [await fixtureDataUrl()], reference_roles: ['subject'] })
    const before = await workbench.getProject(project.id)
    await expect(workbench.understandProject(project.id, { base_revision: before.revision, idempotency_key: 'bb-image-qwen-failure-0001' })).rejects.toMatchObject({ code: 'IMAGE_QWEN_UNAVAILABLE' })
    const canvas = await workbench.createCanvas(project.id, { artboard_id: (await workbench.repository.currentDeliverySpec(project.id))!.artboards[0]!.id, base_revision: before.revision, idempotency_key: 'bb-image-qwen-degrade-canvas-0001' })
    expect(canvas.canvas.revision).toBe(0)
  })
})

test('15.4 Qwen receipt commits before ACK and recovery retries only the ACK', async () => {
  let ackFails = true
  const gateway = qwenGateway({ ackResponse: () => ackFails ? Response.json({ error: 'temporary' }, { status: 503 }) : new Response(null, { status: 204 }) })
  const workbench = await service('qwen-ack-recovery', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await workbench.createProject({ title: '回执恢复', user_request: '分析参考图', size: '1024x1024', reference_images: [await fixtureDataUrl()], reference_roles: ['subject'] })
    const before = await workbench.getProject(project.id)
    const suggestion = await workbench.understandProject(project.id, { base_revision: before.revision, idempotency_key: 'bb-image-qwen-ack-recovery-0001' })
    expect((await workbench.repository.getExecutionReceipt(project.id, suggestion.execution_receipt_id)).gateway_result_acknowledged_at).toBeUndefined()
    ackFails = false
    await workbench.recoverInterruptedOperations()
    expect(await workbench.repository.getExecutionReceipt(project.id, suggestion.execution_receipt_id)).toMatchObject({ gateway_result_acknowledged_at: at })
    expect(gateway.calls.filter(call => call.path === '/gw/v1/image/reasoning')).toHaveLength(1)
    expect(gateway.calls.filter(call => call.path === '/gw/v1/operations/ack')).toHaveLength(2)
  })
})

test('15.4 Gateway locks Qwen model and rejects unbounded/unknown visual output fields', async () => {
  const image = await fixtureDataUrl()
  // Qwen image advice has an isolated route and contract; it must not alter
  // the generic MiMo VisualEvidence registry entry.
  const response = await requestQwenImageReasoning(JSON.stringify({
    schema_version: 1, application_role: 'image_understanding', idempotency_key: 'bb-image-qwen-gateway-contract-0001',
    input: { user_request: '仅分析可见事实', confirmed_facts: [], must_preserve: [], references: [{ content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'subject', influence_strength: 'high', preservation: 'must_preserve', priority: 0, data_url: image }] },
  }), {
    baseUrl: 'https://qwen.example.test/v1', providerAuthorization: 'Bearer qwen-secret-not-returned', modelId: 'qwen3-vl-flash', timeoutMs: 1_000,
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({ model: 'qwen3-vl-flash', response_format: { type: 'json_object' } })
      expect(JSON.stringify(body)).not.toContain('qwen-secret-not-returned')
      const userContent = body.messages[1].content as Array<{ type: string; text?: string }>
      expect(userContent[0]?.text).not.toContain('data:image')
      expect(userContent.filter(item => item.type === 'image_url')).toHaveLength(1)
      return Response.json({ id: 'qwen-gateway-0001', choices: [{ message: { content: JSON.stringify({ confidence: 'high', visible_facts: ['球桌'], preservation_risks: [], composition_suggestions: [], missing_information: [], user_intent: { purpose: 'promote', audience: '台球爱好者', channel: 'social_feed', subject: '赛事主视觉', desired_effect: '促成报名', style_keywords: ['清晰'], priority_order: ['subject', 'text'] } }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    },
  })
  expect(await response.json()).toMatchObject({ provider: 'qwen', application_role: 'image_understanding', output: { visible_facts: ['球桌'], user_intent: { purpose: 'promote', channel: 'social_feed' } } })
  const numericConfidence = await requestQwenImageReasoning(JSON.stringify({
    schema_version: 1, application_role: 'image_understanding', idempotency_key: 'bb-image-qwen-gateway-contract-numeric-confidence',
    input: { user_request: '仅分析可见事实', confirmed_facts: [], must_preserve: [], references: [{ content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'subject', influence_strength: 'high', preservation: 'must_preserve', priority: 0, data_url: image }] },
  }), {
    baseUrl: 'https://qwen.example.test/v1', providerAuthorization: 'Bearer key', modelId: 'qwen3-vl-flash', timeoutMs: 1_000,
    fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ confidence: 0.2, visible_facts: [], preservation_risks: [], composition_suggestions: [], missing_information: [], user_intent: { purpose: 'promote', channel: 'poster|social_feed', style_keywords: [], priority_order: [] } }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  })
  expect(await numericConfidence.json()).toMatchObject({ output: { confidence: 'low', user_intent: { channel: 'poster' } } })
  await expect(requestQwenImageReasoning(JSON.stringify({
    schema_version: 1, application_role: 'image_understanding', idempotency_key: 'bb-image-qwen-gateway-contract-0003',
    input: { user_request: '仅分析可见事实', confirmed_facts: [], must_preserve: [], references: [{ content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'subject', influence_strength: 'high', preservation: 'must_preserve', priority: 0, data_url: image }] },
  }), {
    baseUrl: 'https://qwen.example.test/v1', providerAuthorization: 'Bearer key', modelId: 'forged-model', timeoutMs: 1_000,
    fetchImpl: async () => { throw new Error('must not call upstream') },
  })).rejects.toBeInstanceOf(QwenImageReasoningGatewayError)
  await expect(requestQwenImageReasoning(JSON.stringify({
    schema_version: 1, application_role: 'image_understanding', idempotency_key: 'bb-image-qwen-gateway-contract-usage',
    input: { user_request: '仅分析可见事实', confirmed_facts: [], must_preserve: [], references: [{ content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'subject', influence_strength: 'high', preservation: 'must_preserve', priority: 0, data_url: image }] },
  }), {
    baseUrl: 'https://qwen.example.test/v1', providerAuthorization: 'Bearer key', modelId: 'qwen3-vl-flash', timeoutMs: 1_000,
    fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ confidence: 'high', visible_facts: [], preservation_risks: [], composition_suggestions: [], missing_information: [] }) } }] }),
  })).rejects.toMatchObject({ publicMessage: 'Qwen 图片理解返回缺少用量回执' })
  await expect(requestQwenImageReasoning(JSON.stringify({
    schema_version: 1, application_role: 'image_understanding', idempotency_key: 'bb-image-qwen-gateway-contract-intent',
    input: { user_request: '仅分析可见事实', confirmed_facts: [], must_preserve: [], references: [{ content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'subject', influence_strength: 'high', preservation: 'must_preserve', priority: 0, data_url: image }] },
  }), {
    baseUrl: 'https://qwen.example.test/v1', providerAuthorization: 'Bearer key', modelId: 'qwen3-vl-flash', timeoutMs: 1_000,
    fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ confidence: 'high', visible_facts: [], preservation_risks: [], composition_suggestions: [], missing_information: [], user_intent: { purpose: 'promote', channel: 'social_feed', style_keywords: [], priority_order: [], forged: true } }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }),
  })).rejects.toMatchObject({ publicMessage: 'Qwen 图片理解输出不符合合同' })
  await expect(requestQwenImageReasoning(JSON.stringify({
    schema_version: 1, application_role: 'image_visual_assessment', idempotency_key: 'bb-image-qwen-gateway-contract-0002',
    input: { user_request: '评估', confirmed_facts: [], must_preserve: [], candidate: { content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', data_url: image } },
  }), {
    baseUrl: 'https://qwen.example.test/v1', providerAuthorization: 'Bearer key', modelId: 'qwen3-vl-flash', timeoutMs: 1_000,
    fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ confidence: 'low', observations: [], risks: [], repair_actions: [], forged: true }) } }] }),
  })).rejects.toBeInstanceOf(QwenImageReasoningGatewayError)
  await expect(requestQwenImageReasoning(JSON.stringify({
    schema_version: 1, application_role: 'image_visual_assessment', idempotency_key: 'bb-image-qwen-gateway-contract-0004',
    input: { user_request: '评估', confirmed_facts: [], must_preserve: [], candidate: { content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', data_url: image } },
  }), {
    baseUrl: 'https://qwen.example.test/v1', providerAuthorization: 'Bearer key', modelId: 'qwen3-vl-flash', timeoutMs: 1_000,
    fetchImpl: async () => new Response(`${JSON.stringify({ choices: [] })}${' '.repeat(64 * 1024)}`, { headers: { 'Content-Type': 'application/json' } }),
  })).rejects.toMatchObject({ publicMessage: 'Qwen 图片理解响应超过资源上限' })
})

test('Qwen adapter checks the capacity fence immediately before the paid fetch', async () => {
  const image = await fixtureDataUrl()
  let fetches = 0
  let fenceChecks = 0
  await expect(requestQwenImageReasoning(JSON.stringify({
    schema_version: 1, application_role: 'image_understanding', idempotency_key: 'bb-image-qwen-fence-before-fetch-0001',
    input: { user_request: '仅分析可见事实', confirmed_facts: [], must_preserve: [], references: [{ content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'subject', influence_strength: 'high', preservation: 'must_preserve', priority: 0, data_url: image }] },
  }), {
    baseUrl: 'https://qwen.example.test/v1', providerAuthorization: 'Bearer key', modelId: 'qwen3-vl-flash', timeoutMs: 1_000,
    assertCurrent: () => { fenceChecks += 1; throw new Error('lease expired before fetch') },
    fetchImpl: async () => { fetches += 1; return Response.json({}) },
  })).rejects.toMatchObject({ status: 503 })
  expect(fenceChecks).toBe(1)
  expect(fetches).toBe(0)
})

test('15.4 deployment validation requires a server-side Qwen credential without exposing it', () => {
  const environment = {
    ...gatewayProductionPolicyFixture(),
    BB_GATEWAY_MODEL: 'deepseek-v4-flash',
    GW_AUTH_SIGNING_KEY: 'a'.repeat(32),
    GW_ADMIN_TOKEN: 'admin-token',
    GW_IMAGE_RELAY_INTROSPECTION_TOKEN: 'image-relay-introspection-token-0123456789',
    GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: 'video-relay-introspection-token-0123456789',
    GW_DB: '/tmp/gateway.db',
    GW_DEEPSEEK_KEY: 'deepseek-key',
    GW_MIMO_KEY: 'mimo-key',
    GW_QWEN_KEY: 'qwen-key',
    GW_FUNASR_KEY: 'funasr-key',
    GW_QWEN_ENABLED: '1',
    GW_QWEN_BASE: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  }
  expect(() => validateDeploymentEnvironment(environment)).not.toThrow()
  expect(() => validateDeploymentEnvironment({ ...environment, GW_QWEN_KEY: '' })).toThrow('GW_QWEN_KEY is required')
})

test('15.4 authenticated Gateway route enforces the Qwen schema and returns only bounded advice', async () => {
  const authority = new AuthAuthority({ dbPath: ':memory:', signingKey: 's'.repeat(32) })
  const session = authority.bootstrap('qwen-gateway-test-0001')
  let qwenCalls = 0
  const gateway = createGatewayFetch({
    authority,
    env: {
      BB_GATEWAY_MODEL: 'deepseek-v4-flash', GW_AUTH_SIGNING_KEY: 's'.repeat(32), GW_DB: ':memory:',
      GW_IMAGE_RELAY_INTROSPECTION_TOKEN: 'image-relay-introspection-token-0123456789',
      GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: 'video-relay-introspection-token-0123456789',
      GW_DEEPSEEK_KEY: 'deepseek-key', GW_MIMO_KEY: 'mimo-key', GW_QWEN_KEY: 'qwen-key',
      GW_FUNASR_KEY: 'funasr-key', GW_QWEN_BASE: 'https://qwen.example.test/v1',
      GW_QWEN_ENABLED: '1',
    },
    fetchImpl: async (input, init) => {
      qwenCalls += 1
      expect(input.toString()).toBe('https://qwen.example.test/v1/chat/completions')
      const body = JSON.parse(String(init?.body))
      expect(body.model).toBe('qwen3-vl-flash')
      return Response.json({
        id: 'qwen-image-route-0001',
        choices: [{ message: { content: JSON.stringify({ confidence: 'low', observations: ['存在轻微压缩痕迹'], risks: [], repair_actions: [] }) } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      })
    },
  })
  const image = await fixtureDataUrl()
  const requestBody = JSON.stringify({
    schema_version: 1, application_role: 'image_visual_assessment', idempotency_key: 'bb-image-qwen-gateway-route-0001',
    input: { user_request: '评估成稿', confirmed_facts: [], must_preserve: [], candidate: { content_hash: `sha256:${'a'.repeat(64)}`, data_url: image } },
  })
  const requestHeaders = {
    Authorization: `Bearer ${session.accessToken}`,
    'Content-Type': 'application/json',
    [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    'X-BB-Operation-ID': 'bb-image-qwen-gateway-route-0001',
  }
  const response = await gateway(new Request('https://gateway.example.test/v1/image/reasoning', {
    method: 'POST',
    headers: requestHeaders,
    body: requestBody,
  }))
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({
    schema_version: 1, application_role: 'image_visual_assessment', provider: 'qwen', model_id: 'qwen3-vl-flash',
    usage: expect.objectContaining({ input_bytes: expect.any(Number) }),
    output: { confidence: 'low', observations: ['存在轻微压缩痕迹'], risks: [], repair_actions: [] },
  })
  const replay = await gateway(new Request('https://gateway.example.test/v1/image/reasoning', {
    method: 'POST', headers: requestHeaders, body: requestBody,
  }))
  expect(replay.status).toBe(200)
  expect(qwenCalls).toBe(1)
  const acknowledgement = await gateway(new Request('https://gateway.example.test/v1/operations/ack', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${session.accessToken}`,
      [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
      'X-BB-Operation-ID': 'unused',
      'X-BB-Result-Operation': response.headers.get('X-BB-Result-Operation')!,
      'X-BB-Result-Capability': response.headers.get('X-BB-Result-Capability')!,
      'X-BB-Result-Fingerprint': response.headers.get('X-BB-Result-Fingerprint')!,
    },
  }))
  expect(acknowledgement.status).toBe(204)
})

test('Qwen 同一操作在途时只读恢复，不重复调用 Provider 或预留额度', async () => {
  const authority = new AuthAuthority({ dbPath: ':memory:', signingKey: 's'.repeat(32) })
  const session = authority.bootstrap('qwen-in-progress-test-0001')
  let qwenCalls = 0
  let markStarted!: () => void
  let releaseProvider!: () => void
  const providerStarted = new Promise<void>(resolve => { markStarted = resolve })
  const providerRelease = new Promise<void>(resolve => { releaseProvider = resolve })
  const gateway = createGatewayFetch({
    authority,
    env: {
      BB_GATEWAY_MODEL: 'deepseek-v4-flash', GW_AUTH_SIGNING_KEY: 's'.repeat(32), GW_DB: ':memory:',
      GW_IMAGE_RELAY_INTROSPECTION_TOKEN: 'image-relay-introspection-token-0123456789',
      GW_VIDEO_MEDIA_RELAY_INTROSPECTION_TOKEN: 'video-relay-introspection-token-0123456789',
      GW_DEEPSEEK_KEY: 'deepseek-key', GW_MIMO_KEY: 'mimo-key', GW_QWEN_KEY: 'qwen-key',
      GW_FUNASR_KEY: 'funasr-key', GW_QWEN_BASE: 'https://qwen.example.test/v1', GW_QWEN_ENABLED: '1',
    },
    fetchImpl: async () => {
      qwenCalls += 1
      markStarted()
      await providerRelease
      return Response.json({
        id: 'qwen-in-progress-result-0001',
        choices: [{ message: { content: JSON.stringify({
          confidence: 'medium', visible_facts: ['可见台球桌'], preservation_risks: [],
          composition_suggestions: ['保留主体留白'], missing_information: [],
          user_intent: { purpose: 'promote', channel: 'social_feed', style_keywords: ['清晰'], priority_order: ['subject'] },
        }) } }],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      })
    },
  })
  const operationId = 'bb-image-qwen-in-progress-0001'
  const requestBody = JSON.stringify({
    schema_version: 1, application_role: 'image_understanding', idempotency_key: operationId,
    input: { user_request: '制作赛事宣传图', confirmed_facts: [], must_preserve: [], references: [] },
  })
  const baseHeaders = {
    Authorization: `Bearer ${session.accessToken}`,
    'Content-Type': 'application/json',
    [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    'X-BB-Operation-ID': operationId,
  }
  const first = gateway(new Request('https://gateway.example.test/v1/image/reasoning', { method: 'POST', headers: baseHeaders, body: requestBody }))
  await providerStarted
  const second = await gateway(new Request('https://gateway.example.test/v1/image/reasoning', { method: 'POST', headers: baseHeaders, body: requestBody }))
  expect(second.status).toBe(409)
  expect(await second.json()).toMatchObject({ detail: 'OPERATION_IN_PROGRESS' })
  const fingerprint = createHash('sha256').update(`ImageAdvice\0${requestBody}`).digest('hex')
  const lookupHeaders = {
    Authorization: `Bearer ${session.accessToken}`,
    [PROVIDER_GATEWAY_PROTOCOL_HEADER]: PROVIDER_GATEWAY_PROTOCOL.headerValue,
    [PROVIDER_OPERATION_RESULT_ID_HEADER]: operationId,
    [PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER]: 'ImageAdvice',
    [PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER]: fingerprint,
  }
  const inProgress = await gateway(new Request(`https://gateway.example.test${PROVIDER_IMAGE_ADVICE_RESULT_PATH}`, { method: 'GET', headers: lookupHeaders }))
  expect(inProgress.status).toBe(409)
  expect(await inProgress.json()).toMatchObject({ detail: 'OPERATION_IN_PROGRESS' })
  releaseProvider()
  const firstResponse = await first
  expect(firstResponse.status).toBe(200)
  const recovered = await gateway(new Request(`https://gateway.example.test${PROVIDER_IMAGE_ADVICE_RESULT_PATH}`, { method: 'GET', headers: lookupHeaders }))
  expect(recovered.status).toBe(200)
  expect(await recovered.json()).toMatchObject({ application_role: 'image_understanding', output: { visible_facts: ['可见台球桌'] } })
  expect(qwenCalls).toBe(1)
})

test('Qwen 适配器遇到在途 409 时只走结果查询，不再次 POST', async () => {
  const image = await fixtureDataUrl()
  const request = {
    schema_version: 1 as const,
    application_role: 'image_understanding' as const,
    idempotency_key: 'bb-image-qwen-adapter-recovery-0001',
    input: { user_request: '制作赛事宣传图', confirmed_facts: [], must_preserve: [], references: [{
      content_hash: `sha256:${'a'.repeat(64)}`, role: 'subject' as const, influence_strength: 'high' as const,
      preservation: 'must_preserve' as const, priority: 0, data_url: image,
    }] },
  }
  const body = JSON.stringify(request)
  const fingerprint = createHash('sha256').update(`ImageAdvice\0${body}`).digest('hex')
  const result = {
    schema_version: 1, application_role: 'image_understanding', provider: 'qwen', model_id: 'qwen3-vl-flash',
    usage: { input_bytes: 10, input_tokens: 2, output_tokens: 3 },
    output: { confidence: 'high', visible_facts: ['可见台球桌'], preservation_risks: [], composition_suggestions: [], missing_information: [] },
  }
  const calls: string[] = []
  const recovered = await requestImageAdviceClient(request, {
    operationId: 'bb-image-qwen-adapter-recovery-op-0001',
    env: { BB_GATEWAY_URL: 'https://gateway.example.test/gw', BB_GATEWAY_TOKEN: 'gateway-token' },
    fetchImpl: async input => {
      const url = new URL(input instanceof Request ? input.url : input.toString())
      calls.push(`${url.pathname}:${url.search}`)
      if (url.pathname === '/gw/v1/image/reasoning') return Response.json({ error: 'OPERATION_IN_PROGRESS' }, { status: 409 })
      expect(url.pathname).toBe(`/gw${PROVIDER_IMAGE_ADVICE_RESULT_PATH}`)
      return Response.json(result, {
        headers: {
          [PROVIDER_OPERATION_RESULT_ID_HEADER]: 'bb-image-qwen-adapter-recovery-op-0001',
          [PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER]: 'ImageAdvice',
          [PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER]: fingerprint,
        },
      })
    },
  })
  expect(recovered.response).toMatchObject({ output: { visible_facts: ['可见台球桌'] } })
  expect(calls).toEqual(['/gw/v1/image/reasoning:', `/gw${PROVIDER_IMAGE_ADVICE_RESULT_PATH}:`])
})
