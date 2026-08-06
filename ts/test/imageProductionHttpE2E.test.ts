import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createImageWorkbenchDomainApiHandler } from '../src/server/api/imageWorkbench.js'
import { ImageWorkbenchService } from '../src/server/services/imageWorkbenchService.js'
import { imageTicketRequest } from './helpers/imageUiTicket.js'
import {
  PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER,
  PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER,
  PROVIDER_OPERATION_RESULT_ID_HEADER,
} from '../shared/product/providerGateway.js'

const roots: string[] = []
const ticketSecret = '15-5e-http-e2e-ticket-secret-0123456789'
const gatewayHost = 'https://gateway.example.test/gw'
const relayHost = 'https://images.example.test/image-generation'

type ProviderCall = { method: string; path: string; headers: Headers; body: string }

async function fixturePng(): Promise<string> {
  return (await readFile(join(import.meta.dir, 'fixtures', 'image', 'valid-1x1.png.base64'), 'utf8')).trim()
}

async function root(label: string): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), `billiardbuddy-image-http-e2e-${label}-`))
  roots.push(value)
  return value
}

function jsonBody(response: Response): Promise<unknown> {
  return response.json() as Promise<unknown>
}

async function request(
  handler: ReturnType<typeof createImageWorkbenchDomainApiHandler>,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const url = new URL(path, 'http://127.0.0.1:3456')
  return await handler(imageTicketRequest(url, init), url, url.pathname.split('/').filter(Boolean))
}

function startRealHttpProvider(png: string): {
  server: ReturnType<typeof Bun.serve>
  calls: ProviderCall[]
  fetchImpl: typeof fetch
} {
  const calls: ProviderCall[] = []
  const tasks = new Map<string, string>()
  let sequence = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === 'POST' ? await request.text() : ''
      calls.push({ method: request.method, path: url.pathname, headers: new Headers(request.headers), body })

      if (url.pathname === '/gw/v1/image/reasoning' && request.method === 'POST') {
        const operationId = request.headers.get('X-BB-Operation-ID') ?? ''
        const fingerprint = createHash('sha256').update(`ImageAdvice\0${body}`).digest('hex')
        return Response.json({
          schema_version: 1,
          application_role: 'image_understanding',
          provider: 'qwen',
          model_id: 'qwen3-vl-flash',
          usage: { input_bytes: body.length, input_tokens: 20, output_tokens: 16 },
          output: {
            confidence: 'high',
            visible_facts: ['用户需要一张台球赛事宣传图'],
            preservation_risks: ['产品主体和 Logo 需要保留'],
            composition_suggestions: ['标题区与主体应有清晰层级'],
            missing_information: [],
          },
        }, { headers: {
          [PROVIDER_OPERATION_RESULT_ID_HEADER]: operationId,
          [PROVIDER_OPERATION_RESULT_CAPABILITY_HEADER]: 'ImageAdvice',
          [PROVIDER_OPERATION_RESULT_FINGERPRINT_HEADER]: fingerprint,
        } })
      }

      if (url.pathname === '/image-generation/v1/images/tasks' && request.method === 'POST') {
        const parsed = JSON.parse(body) as { idempotency_key?: string }
        const key = request.headers.get('Idempotency-Key') ?? parsed.idempotency_key ?? ''
        const taskId = tasks.get(key) ?? `http_e2e_task_${String(++sequence).padStart(4, '0')}`
        tasks.set(key, taskId)
        return Response.json({ task_id: taskId, status: 'queued', poll_after_seconds: 0, provider_receipt_hash: 'c'.repeat(64) })
      }

      const taskMatch = /^\/image-generation\/v1\/images\/tasks\/([^/]+)(?:\/ack)?$/.exec(url.pathname)
      if (taskMatch && request.method === 'GET') {
        const taskId = decodeURIComponent(taskMatch[1]!)
        return Response.json({
          task_id: taskId,
          status: 'succeeded',
          provider_receipt_hash: 'c'.repeat(64),
          result_urls: [`${relayHost}/v1/images/results/result.${'c'.repeat(64)}/0`],
        })
      }
      if (taskMatch && request.method === 'POST' && url.pathname.endsWith('/ack')) return new Response(null, { status: 204 })
      if (url.pathname.startsWith('/image-generation/v1/images/results/') && request.method === 'GET') {
        return Response.json({ data: [{ b64_json: png, mime_type: 'image/png' }] })
      }
      if (url.pathname.includes('/by-idempotency/') && request.method === 'GET') return new Response(null, { status: 404 })
      return Response.json({ error: 'not found' }, { status: 404 })
    },
  })

  const fetchImpl: typeof fetch = async (input, init) => {
    const original = new URL(input instanceof Request ? input.url : input.toString())
    const target = new URL(server.url)
    target.pathname = original.pathname
    target.search = original.search
    return await fetch(target, init)
  }
  return { server, calls, fetchImpl }
}

async function withProviderEnv<T>(action: () => Promise<T>): Promise<T> {
  const previous = {
    gateway: process.env.BB_GATEWAY_URL,
    relay: process.env.BB_IMAGE_RELAY_URL,
    token: process.env.BB_GATEWAY_TOKEN,
  }
  process.env.BB_GATEWAY_URL = gatewayHost
  process.env.BB_IMAGE_RELAY_URL = relayHost
  process.env.BB_GATEWAY_TOKEN = 'http-e2e-token-0123456789'
  try {
    return await action()
  } finally {
    if (previous.gateway === undefined) delete process.env.BB_GATEWAY_URL
    else process.env.BB_GATEWAY_URL = previous.gateway
    if (previous.relay === undefined) delete process.env.BB_IMAGE_RELAY_URL
    else process.env.BB_IMAGE_RELAY_URL = previous.relay
    if (previous.token === undefined) delete process.env.BB_GATEWAY_TOKEN
    else process.env.BB_GATEWAY_TOKEN = previous.token
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async value => await rm(value, { recursive: true, force: true })))
})

test('生产模拟环境通过真实 HTTP Provider、图片 API 完成建项到候选交付', async () => {
  const provider = startRealHttpProvider(await fixturePng())
  const imageRoot = await root('full-project')
  const legacyRoot = await root('full-project-legacy')
  const service = new ImageWorkbenchService({
    root: imageRoot,
    legacyMediaRoot: legacyRoot,
    now: () => new Date('2026-08-06T00:00:00.000Z'),
    fetchImpl: provider.fetchImpl,
  })
  try {
    const handler = createImageWorkbenchDomainApiHandler(service.applications, ticketSecret)
    await withProviderEnv(async () => {
      const headers = { 'Content-Type': 'application/json', 'X-BilliardBuddy-Media-Capability': ticketSecret }
      const preparedResponse = await request(handler, '/api/images/quick-create', {
        method: 'POST', headers,
        body: JSON.stringify({
          idempotency_key: 'bb-image-http-e2e-prepare-0001',
          prompt: '为台球门店夏季冠军赛制作专业宣传图。',
          output_preset: 'square',
          model_selection: 'gpt-image-2',
          reference_inputs: [],
        }),
      })
      expect(preparedResponse.status).toBe(202)
      const prepared = await jsonBody(preparedResponse) as { mode: string; project: { id: string; revision: number } }
      expect(prepared.mode).toBe('prepared')

      const adviceResponse = await request(handler, `/api/images/projects/${prepared.project.id}/understanding`, {
        method: 'POST', headers,
        body: JSON.stringify({ base_revision: prepared.project.revision, idempotency_key: 'bb-image-http-e2e-advice-0001' }),
      })
      expect(adviceResponse.status).toBe(200)
      const advice = await jsonBody(adviceResponse) as { suggestion: { execution_receipt_id: string } }
      expect(advice.suggestion.execution_receipt_id).toMatch(/^receipt_/)

      const planResponse = await request(handler, `/api/images/projects/${prepared.project.id}/creative-plans`, {
        method: 'POST', headers,
        body: JSON.stringify({
          base_revision: prepared.project.revision,
          idempotency_key: 'bb-image-http-e2e-plan-0001',
          accept_suggestion_receipt_id: advice.suggestion.execution_receipt_id,
        }),
      })
      expect(planResponse.status).toBe(201)
      const plan = await jsonBody(planResponse) as { plan: { id: string; directions: Array<{ id: string }> } }
      const directionId = plan.plan.directions[0]?.id
      if (!directionId) throw new Error('missing direction')

      const estimateResponse = await request(handler, `/api/images/projects/${prepared.project.id}/generation-rounds/estimate`, {
        method: 'POST', headers,
        body: JSON.stringify({ base_revision: prepared.project.revision, creative_plan_id: plan.plan.id, direction_ids: [directionId] }),
      })
      expect(estimateResponse.status).toBe(200)
      const estimate = await jsonBody(estimateResponse) as { estimate_hash: string; paid_operation_count: number; candidate_count_per_operation: number }
      expect(estimate).toMatchObject({ paid_operation_count: 1, candidate_count_per_operation: 1 })

      const roundResponse = await request(handler, `/api/images/projects/${prepared.project.id}/generation-rounds`, {
        method: 'POST', headers,
        body: JSON.stringify({
          base_revision: prepared.project.revision,
          idempotency_key: 'bb-image-http-e2e-round-0001',
          creative_plan_id: plan.plan.id,
          direction_ids: [directionId],
          estimate_hash: estimate.estimate_hash,
          confirm: true,
        }),
      })
      expect(roundResponse.status).toBe(202)
      const round = await jsonBody(roundResponse) as { operations: Array<{ id: string }> }
      expect(round.operations).toHaveLength(1)

      let projection: { project: { revision: number }; candidate_groups: Array<{ candidates: Array<{ id: string }> }>; delivery_spec: { artboards: Array<{ id: string; width: number; height: number; required: boolean; safe_area: { top: number; right: number; bottom: number; left: number }; output: { format: 'png'; transparent: boolean } }> } | null } | undefined
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const response = await request(handler, `/api/images/projects/${prepared.project.id}/projection`)
        projection = await jsonBody(response) as typeof projection
        if ((projection?.candidate_groups.length ?? 0) > 0) break
        await Bun.sleep(10)
      }
      const candidate = projection?.candidate_groups[0]?.candidates[0]
      expect(candidate).toBeDefined()

      const artboard = projection?.delivery_spec?.artboards[0]
      expect(artboard).toBeDefined()
      if (!candidate || !artboard) throw new Error('missing candidate or artboard')
      const adoption = await request(handler, `/api/images/projects/${prepared.project.id}/candidates/${candidate.id}/adoptions`, {
        method: 'POST', headers,
        body: JSON.stringify({
          base_revision: projection!.project.revision,
          idempotency_key: 'bb-image-http-e2e-adopt-0001',
          adoptions: [{ artboard_id: artboard.id, placement: { fit: 'contain', focus_x: 0.5, focus_y: 0.5 } }],
        }),
      })
      expect(adoption.status).toBe(200)
      const finalProjection = await jsonBody(await request(handler, `/api/images/projects/${prepared.project.id}/projection`)) as { canvases: Array<{ canvas_id: string }> }
      expect(finalProjection.canvases).toHaveLength(1)

      expect(provider.calls.some(call => call.path === '/gw/v1/image/reasoning' && call.method === 'POST')).toBeTrue()
      expect(provider.calls.filter(call => call.path === '/image-generation/v1/images/tasks' && call.method === 'POST')).toHaveLength(1)
      expect(provider.calls.some(call => call.path.includes('/image-generation/v1/images/tasks/') && call.method === 'GET')).toBeTrue()
      expect(provider.calls.some(call => call.path.includes('/image-generation/v1/images/results/') && call.method === 'GET')).toBeTrue()
    })
  } finally {
    service.repository.close()
    provider.server.stop(true)
  }
})
