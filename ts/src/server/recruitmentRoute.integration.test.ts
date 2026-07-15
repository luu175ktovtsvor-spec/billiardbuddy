// 招聘 REST 在完整 server 装配里的接通性:登记→草稿→sent 证据闸→漏斗,一条链打真 HTTP。
// 业务规则细节由 recruitment/ 与 routes/ 的单测覆盖,这里只验装配与端到端可用。

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startServer } from './index'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

test('招聘链路:REST 登记候选人、存草稿、sent 无证据 409、带证据成功、漏斗可读', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recruitment-server-'))
  const server = startServer({ port: 0, transcriptRoot: root })
  cleanups.push(() => {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.port}/api/v1/recruitment`

  const created = await fetch(`${base}/candidates`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ candidates: [{ name: '张三', position: '助教', external_ref: '张三·教练·5年' }] }),
  })
  expect(created.status).toBe(201)
  const { added } = await created.json() as { added: Array<{ id: string }> }

  const draftRes = await fetch(`${base}/drafts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ candidate_id: added[0]!.id, content: '您好,想和您聊聊助教岗位。' }),
  })
  expect(draftRes.status).toBe(201)
  const draft = await draftRes.json() as { id: string }

  const noEvidence = await fetch(`${base}/drafts/${draft.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'sent' }),
  })
  expect(noEvidence.status).toBe(409)

  const sent = await fetch(`${base}/drafts/${draft.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'sent', evidence: 'BOSS 会话可见已发送(用户回填)' }),
  })
  expect(sent.status).toBe(200)

  const funnel = await fetch(`${base}/funnel`)
  expect(funnel.status).toBe(200)
  const report = await funnel.json() as { totalCandidates: number }
  expect(report.totalCandidates).toBe(1)
})
