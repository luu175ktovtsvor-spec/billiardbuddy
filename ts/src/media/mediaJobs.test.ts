import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaJobService } from './mediaJobs'
import { TaskService } from '../tasks/taskService'

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

test('MediaJobService creates local preview image jobs when no backend is configured', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-local-'))
  try {
    const service = new MediaJobService({ tasks: new TaskService(root), stateRoot: root, pollIntervalMs: 1 })
    const started = await service.startStudioGenerate({ prompt: '开业活动海报', ratio: '9:16', count: 2 })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    expect(done.kind).toBe('generate')
    expect(done.progress).toBe(100)
    expect(done.result?.local_preview).toBe(true)
    expect(done.result?.urls).toHaveLength(2)

    const url = (done.result?.urls as string[])[0]!
    const served = service.serveUpload(url)
    expect(served?.status).toBe(200)
    expect(served?.headers.get('content-type')).toContain('image/svg+xml')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('MediaJobService bridges legacy media backend and stores normalized result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-proxy-'))
  const calls: string[] = []
  try {
    const service = new MediaJobService({
      tasks: new TaskService(root),
      stateRoot: root,
      backendUrl: 'http://legacy.example',
      pollIntervalMs: 1,
      fetchImpl: async input => {
        const url = String(input)
        calls.push(url)
        if (url.endsWith('/api/v1/studio/generate')) {
          return Response.json({ job_id: 'legacy-job-1' })
        }
        if (url.endsWith('/api/v1/agent/media-jobs/legacy-job-1')) {
          return Response.json({
            id: 'legacy-job-1',
            kind: 'generate',
            status: calls.filter(c => c.includes('media-jobs')).length > 1 ? 'done' : 'running',
            progress: calls.filter(c => c.includes('media-jobs')).length > 1 ? 100 : 30,
            stage: '正在出图',
            result: calls.filter(c => c.includes('media-jobs')).length > 1 ? { urls: ['/uploads/posters/a.jpg'] } : null,
            error: null,
          })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
    })
    const started = await service.startStudioGenerate({ prompt: '会员日海报' })
    const done = await waitFor(async () => {
      const status = await service.status(started.job_id)
      return status?.status === 'done' ? status : null
    })
    expect(done.result).toEqual({ urls: ['/uploads/posters/a.jpg'] })
    expect(calls.some(c => c.endsWith('/api/v1/studio/generate'))).toBe(true)
    expect(calls.filter(c => c.includes('/api/v1/agent/media-jobs/legacy-job-1')).length).toBeGreaterThanOrEqual(2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
