import { describe, expect, it } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RecruitmentService } from '../../recruitment/recruitmentService'
import { createRecruitmentRouteHandler } from './recruitmentRoutes'

async function makeHandler() {
  const service = new RecruitmentService(await mkdtemp(join(tmpdir(), 'recruitment-routes-')))
  return { handler: createRecruitmentRouteHandler({ service }), service }
}

function request(path: string, init?: RequestInit): [URL, Request] {
  const url = new URL(`http://127.0.0.1${path}`)
  return [url, new Request(url.toString(), init)]
}

const jsonInit = (method: string, body: unknown): RequestInit => ({
  method,
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
})

describe('recruitmentRoutes', () => {
  it('POST/GET candidates:登记、按 due=today 过滤', async () => {
    const { handler } = await makeHandler()
    const created = await handler(...request('/api/v1/recruitment/candidates', jsonInit('POST', {
      candidates: [
        { name: '张三', position: '助教', next_action_due: '2020-01-01T00:00:00.000Z' },
        { name: '李四', position: '助教', next_action_due: '2099-01-01T00:00:00.000Z' },
      ],
    })))
    expect(created?.status).toBe(201)
    const body = await created!.json() as { added: unknown[]; duplicates: unknown[] }
    expect(body.added).toHaveLength(2)

    const due = await handler(...request('/api/v1/recruitment/candidates?due=today'))
    const dueBody = await due!.json() as { candidates: Array<{ name: string }> }
    expect(dueBody.candidates.map(candidate => candidate.name)).toEqual(['张三'])
  })

  it('PATCH candidate:阶段流转;未知候选人 404;非法 body 400', async () => {
    const { handler, service } = await makeHandler()
    const { added } = await service.addCandidates([{ name: '王五', position: '店长' }])
    const patched = await handler(...request(`/api/v1/recruitment/candidates/${added[0]!.id}`, jsonInit('PATCH', { stage: 'invited', note: '周五面试' })))
    expect(patched?.status).toBe(200)
    expect(((await patched!.json()) as { stage: string }).stage).toBe('invited')

    const missing = await handler(...request('/api/v1/recruitment/candidates/nope', jsonInit('PATCH', { stage: 'invited' })))
    expect(missing?.status).toBe(404)

    const invalid = await handler(...request(`/api/v1/recruitment/candidates/${added[0]!.id}`, jsonInit('PATCH', {})))
    expect(invalid?.status).toBe(400)
  })

  it('草稿链:建草稿、sent 无证据 409、带证据 200', async () => {
    const { handler, service } = await makeHandler()
    const { added } = await service.addCandidates([{ name: '赵六', position: '服务员' }])
    const draftRes = await handler(...request('/api/v1/recruitment/drafts', jsonInit('POST', { candidate_id: added[0]!.id, content: '您好' })))
    expect(draftRes?.status).toBe(201)
    const draft = await draftRes!.json() as { id: string }

    const noEvidence = await handler(...request(`/api/v1/recruitment/drafts/${draft.id}`, jsonInit('PATCH', { status: 'sent' })))
    expect(noEvidence?.status).toBe(409)

    const sent = await handler(...request(`/api/v1/recruitment/drafts/${draft.id}`, jsonInit('PATCH', { status: 'sent', evidence: '官方 App 已见发送' })))
    expect(sent?.status).toBe(200)
    expect(((await sent!.json()) as { status: string }).status).toBe('sent')
  })

  it('positions 与 funnel', async () => {
    const { handler } = await makeHandler()
    const created = await handler(...request('/api/v1/recruitment/positions', jsonInit('POST', { title: '助教', openings: 2 })))
    expect(created?.status).toBe(201)
    const funnel = await handler(...request('/api/v1/recruitment/funnel'))
    const report = await funnel!.json() as { positions: Array<{ title: string; openings: number; hired: number }> }
    expect(report.positions).toEqual([{ title: '助教', openings: 2, hired: 0 }])
  })

  it('不匹配路径返回 null;未知阶段查询 400', async () => {
    const { handler } = await makeHandler()
    expect(await handler(...request('/api/v1/other'))).toBeNull()
    const bad = await handler(...request('/api/v1/recruitment/candidates?stage=ghosted'))
    expect(bad?.status).toBe(400)
  })
})
