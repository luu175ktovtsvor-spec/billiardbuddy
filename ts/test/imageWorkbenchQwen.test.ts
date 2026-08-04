import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createImageWorkbenchDomainApiHandler } from '../src/server/api/imageWorkbench.js'
import { ImageWorkbenchService } from '../src/server/services/imageWorkbenchService.js'
import { QwenImageReasoningGatewayError, requestQwenImageReasoning } from '../../gateway/qwenImageReasoning.js'
import {
  GATEWAY_PRODUCTION_CAPACITY_ENVIRONMENT_VARIABLES,
  validateDeploymentEnvironment,
} from '../../gateway/validate-deployment-env.js'
import { createGatewayFetch } from '../../gateway/app.js'
import { AuthAuthority } from '../../gateway/installationAuth.js'
import { PROVIDER_GATEWAY_PROTOCOL, PROVIDER_GATEWAY_PROTOCOL_HEADER } from '../shared/product/providerGateway.js'

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
        const result = role === 'image_understanding'
          ? { schema_version: 1, application_role: role, provider: 'qwen', model_id: 'qwen3-vl-flash', provider_request_id: 'qwen-understanding-0001', usage: { input_bytes: 512, input_tokens: 12, output_tokens: 8 }, output: { confidence: 'medium', visible_facts: ['可见一支台球杆'], preservation_risks: ['主体边缘不完整'], composition_suggestions: ['为标题预留顶部空间'], missing_information: ['请确认活动日期'] } }
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

test('15.4 Qwen understanding stores a bounded receipt/suggestion without overriding user facts or blocking Canvas', async () => {
  const gateway = qwenGateway()
  const workbench = await service('understanding', gateway.fetchImpl)
  await withGateway(async () => {
    const project = await workbench.createProject({ title: '台球海报', user_request: '保留原有品牌，制作赛事海报', size: '1024x1024', reference_images: [await fixtureDataUrl()], reference_roles: ['subject'] })
    const before = await workbench.getProject(project.id)
    const suggestion = await workbench.understandProject(project.id, { base_revision: before.revision, idempotency_key: 'bb-image-qwen-understanding-0001' })
    expect(suggestion).toMatchObject({ confidence: 'medium', visible_facts: ['可见一支台球杆'], missing_information: ['请确认活动日期'] })
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
    const plan = await workbench.createCreativePlan(project.id, { base_revision: after.revision, idempotency_key: 'bb-image-qwen-plan-0001' })
    const brief = await workbench.repository.latestGenerationBrief(project.id)
    expect(plan.source).toBe('deterministic')
    expect(brief).toMatchObject({ reasoning_receipt_id: suggestion.execution_receipt_id, missing_information: expect.arrayContaining(['请确认活动日期']) })
    const canvas = await workbench.createCanvas(project.id, { artboard_id: (await workbench.repository.currentDeliverySpec(project.id))!.artboards[0]!.id, base_revision: after.revision, idempotency_key: 'bb-image-qwen-canvas-0001' })
    expect(canvas.canvas.revision).toBe(0)
    expect(gateway.calls.filter(call => call.path === '/gw/v1/image/reasoning')).toHaveLength(1)
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
    const after = await workbench.getProject(project.id)
    expect(after.revision).toBe(before.revision)
    expect(after.current_versions_by_artboard).toEqual(before.current_versions_by_artboard)
    expect((await workbench.repository.getCandidate(project.id, candidate.id)).content_hash).toBe(candidate.content_hash)
    const handler = createImageWorkbenchDomainApiHandler(workbench, capability)
    const url = new URL(`http://127.0.0.1/api/images/projects/${project.id}/candidates/${candidate.id}/visual-assessments`)
    const response = await handler(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': capability }, body: JSON.stringify({ base_revision: before.revision, idempotency_key: 'bb-image-qwen-assessment-0001' }) }), url, ['api', 'images', 'projects', project.id, 'candidates', candidate.id, 'visual-assessments'])
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
      return Response.json({ id: 'qwen-gateway-0001', choices: [{ message: { content: JSON.stringify({ confidence: 'high', visible_facts: ['球桌'], preservation_risks: [], composition_suggestions: [], missing_information: [] }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } })
    },
  })
  expect(await response.json()).toMatchObject({ provider: 'qwen', application_role: 'image_understanding', output: { visible_facts: ['球桌'] } })
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
