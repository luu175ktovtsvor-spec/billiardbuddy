import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaJobService } from './mediaJobs'
import { createMediaTools } from './mediaTools'
import { TaskService } from '../tasks/taskService'
import { Workspace } from '../workspace/workspace'

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 1000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('waitFor timeout')
}

test('generate_image tool starts a media task in the current conversation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-'))
  try {
    const tasks = new TaskService(root)
    const media = new MediaJobService({ tasks, stateRoot: root, pollIntervalMs: 1 })
    const tool = createMediaTools(media).find(t => t.name === 'generate_image')
    expect(tool).toBeTruthy()
    const output = await tool!.execute({ description: '做一张周末促销海报', ratio: '3:4' }, {
      workspace: new Workspace(root),
      conversationId: 'c-media',
      permissionMode: 'full',
    })
    expect(output).toContain('<media_job_started')
    const done = await waitFor(async () => {
      const list = await tasks.list({ conversationId: 'c-media' })
      return list[0]?.status === 'completed' ? list[0] : null
    })
    expect(done.kind).toBe('generate')
    expect(done.result).toMatchObject({ local_preview: true })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generate_video tool requires spend approval before execution', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-video-tool-'))
  try {
    const media = new MediaJobService({ tasks: new TaskService(root), stateRoot: root })
    const tool = createMediaTools(media).find(t => t.name === 'generate_video')
    expect(tool?.requiresApproval).toBe(true)
    expect(tool?.approvalClass).toBe('spend')
    expect(tool?.forceConfirm).toBe(true)
    const reason = tool?.approvalReasonFor?.({ description: '让这张海报动起来', duration: 5 }, {
      workspace: new Workspace(root),
    })
    expect(reason?.what).toContain('5 秒')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
