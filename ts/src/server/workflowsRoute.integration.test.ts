// 经营工作流 REST 在完整 server 装配里的接通性:路由挂载、内置定义披露、运行历史与 404。
// 不触发真实运行(那需要 provider);运行编排语义由 workflows/ 与 services/workflowRuntime 的单测覆盖。

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workflowListResponseSchema, workflowRunListResponseSchema } from '../../shared/contracts/workflows'
import { startServer } from './index'

const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function makeServer() {
  const root = mkdtempSync(join(tmpdir(), 'workflow-route-'))
  const server = startServer({ port: 0, transcriptRoot: root })
  cleanups.push(() => {
    server.stop(true)
    rmSync(root, { recursive: true, force: true })
  })
  return server
}

test('GET /api/v1/workflows:返回契约合法的内置工作流定义', async () => {
  const server = makeServer()
  const res = await fetch(`http://127.0.0.1:${server.port}/api/v1/workflows`)
  expect(res.status).toBe(200)
  const body = workflowListResponseSchema.parse(await res.json())
  const ids = body.workflows.map(workflow => workflow.id)
  expect(ids).toContain('venue-daily-report')
  expect(ids).toContain('recruitment-daily-prep')
  expect(body.workflows.every(workflow => workflow.source === 'bundled')).toBe(true)
})

test('GET /api/v1/workflows/runs:初始为空;未知运行与未知工作流分别 404', async () => {
  const server = makeServer()
  const runs = await fetch(`http://127.0.0.1:${server.port}/api/v1/workflows/runs`)
  expect(runs.status).toBe(200)
  expect(workflowRunListResponseSchema.parse(await runs.json()).runs).toEqual([])

  const missingRun = await fetch(`http://127.0.0.1:${server.port}/api/v1/workflows/runs/nope`)
  expect(missingRun.status).toBe(404)

  const missingWorkflow = await fetch(`http://127.0.0.1:${server.port}/api/v1/workflows/missing/run`, { method: 'POST' })
  expect(missingWorkflow.status).toBe(404)
})
