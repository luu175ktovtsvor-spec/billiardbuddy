import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createVideoWorkbenchDomainApiHandler } from '../src/server/api/videoWorkbench.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'
import { MEDIA_UI_CAPABILITY_HEADER } from '../shared/contracts/media.js'

const roots: string[] = []
const capability = 'c'.repeat(32)
const hash = `sha256:${'b'.repeat(64)}`
async function root() { const value = await mkdtemp(join(tmpdir(), 'billiardbuddy-consent-')); roots.push(value); return value }
afterEach(async () => await Promise.all(roots.splice(0).map(async value => await rm(value, { recursive: true, force: true }))))
function segments(url: URL) { return url.pathname.split('/').filter(Boolean).map((part, index) => index === 0 ? 'api' : part) }

test('remote analysis API persists estimate, immutable consent revision and revocation without disabling local project', async () => {
  const service = new VideoWorkbenchService({ root: await root(), now: () => new Date('2026-08-03T00:00:00.000Z') })
  const created = await service.createProject({ title: '远程分析预算' })
  await service.repository.saveProject({ ...created, state: 'ready', revision: 1, sources: [{ id: 'src_00000001', path: '/fixture.mp4', name: 'fixture.mp4', duration_ms: 10_000, width: 1920, height: 1080, has_audio: true, rotation: 0, video_stream_count: 1, audio_stream_count: 1, missing: false, content_changed: false }] })
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (pathname: string, body: unknown) => { const url = new URL(`http://localhost${pathname}`); return await handler(new Request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', [MEDIA_UI_CAPABILITY_HEADER]: capability }, body: JSON.stringify(body) }), url, segments(url)) }
  const estimateResponse = await request(`/api/videos/projects/${created.id}/analysis-estimates`, { purposes: ['asr', 'semantic_search'], source_ids: ['src_00000001'] })
  expect(estimateResponse.status).toBe(201)
  const estimate = await estimateResponse.json() as { estimate: { estimate_hash: string; asr_seconds: number } }
  expect(estimate.estimate.asr_seconds).toBe(10)
  const consentBody = { purposes: ['asr', 'semantic_search'], data_kinds: ['audio_extract', 'transcript'], coverage: [{ source_id: 'src_00000001', ranges: [{ start: { ticks: '0', tick_rate: { num: 1000, den: 1 } }, duration: { ticks: '10000', tick_rate: { num: 1000, den: 1 } } }] }], acknowledged_estimate_hash: estimate.estimate.estimate_hash }
  const granted = await request(`/api/videos/projects/${created.id}/remote-analysis-consent`, consentBody)
  expect(granted.status).toBe(201)
  const grantedBody = await granted.json() as { consent: { revision: number; state: string } }
  expect(grantedBody.consent).toMatchObject({ revision: 1, state: 'active' })
  const revoked = await request(`/api/videos/projects/${created.id}/remote-analysis-consent/revoke`, { revision: 1 })
  expect(revoked.status).toBe(200)
  const project = await service.getProject(created.id)
  expect(project.state).toBe('ready')
  expect(project.remote_analysis_consents).toMatchObject([{ revision: 1, state: 'revoked' }])
  expect(project.remote_analysis_budgets[0]?.state).toBe('reserved')
  expect(hash).toMatch(/^sha256:/)
})
