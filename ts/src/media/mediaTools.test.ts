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

test('edit_image tool routes to the backend edit channel carrying the source image id', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-'))
  try {
    const tasks = new TaskService(root)
    const media = new MediaJobService({ tasks, stateRoot: root, pollIntervalMs: 1 })
    const tool = createMediaTools(media).find(t => t.name === 'edit_image')
    expect(tool).toBeTruthy()
    const output = await tool!.execute({
      source_generation_id: 'local-poster-42',
      description: '把这张海报的背景换成蓝色',
      ratio: '3:4',
    }, {
      workspace: new Workspace(root),
      conversationId: 'c-edit',
      permissionMode: 'full',
    })
    expect(output).toContain('<media_job_started')
    expect(output).toContain('kind="edit"')
    const done = await waitFor(async () => {
      const list = await tasks.list({ conversationId: 'c-edit' })
      return list[0]?.status === 'completed' ? list[0] : null
    })
    // 走的是后端"改图"通道(edit),不是"生成"通道;原图 id 与 edit 模式标记都带到了 body。
    expect(done.kind).toBe('edit')
    expect(done.params?.source_generation_id).toBe('local-poster-42')
    expect(done.params?._image_mode).toBe('edit')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('edit_image tool rejects a missing original image instead of regenerating from text', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-'))
  try {
    const tasks = new TaskService(root)
    const media = new MediaJobService({ tasks, stateRoot: root, pollIntervalMs: 1 })
    const tool = createMediaTools(media).find(t => t.name === 'edit_image')
    expect(tool).toBeTruthy()
    // 缺原图标识(source_generation_id / source_image_path / 参考图都没有)→ 工具层直接报错。
    await expect(tool!.execute({ description: '把背景换成蓝色' }, {
      workspace: new Workspace(root),
      conversationId: 'c-edit-missing',
      permissionMode: 'full',
    })).rejects.toThrow(/改图必须带上原图/)
    // 反逻辑保护:没有原图时绝不退化成"凭文字重新生成一张",因此不应启动任何媒体任务。
    const list = await tasks.list({ conversationId: 'c-edit-missing' })
    expect(list.length).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan_video tool 起 video_auto_plan 任务(对话里剪视频的楼梯)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-'))
  try {
    const tasks = new TaskService(root)
    const media = new MediaJobService({ tasks, stateRoot: root, pollIntervalMs: 1 })
    const tool = createMediaTools(media).find(t => t.name === 'plan_video')
    expect(tool).toBeTruthy()
    const output = await tool!.execute({ video_paths: ['/abs/clip.mp4'], mode: 'ambient', target_duration_s: 12 }, {
      workspace: new Workspace(root),
      conversationId: 'c-plan',
      permissionMode: 'full',
    })
    // 走 video_auto_plan(→ planEdit 真五步),不是占位;返回后台任务标记让模型轮询复述方案。
    expect(output).toContain('<media_job_started')
    expect(output).toContain('kind="video_auto_plan"')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan_video 缺 video_paths 直接报错、不起任务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-'))
  try {
    const tasks = new TaskService(root)
    const media = new MediaJobService({ tasks, stateRoot: root, pollIntervalMs: 1 })
    const tool = createMediaTools(media).find(t => t.name === 'plan_video')!
    await expect(tool.execute({ video_paths: [] }, {
      workspace: new Workspace(root),
      conversationId: 'c-plan-empty',
      permissionMode: 'full',
    })).rejects.toThrow(/video_paths/)
    expect((await tasks.list({ conversationId: 'c-plan-empty' })).length).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('render_video tool 起 video_render 任务(方案确认后出片)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-'))
  try {
    const tasks = new TaskService(root)
    const media = new MediaJobService({ tasks, stateRoot: root, pollIntervalMs: 1 })
    const tool = createMediaTools(media).find(t => t.name === 'render_video')
    expect(tool).toBeTruthy()
    const output = await tool!.execute({ project: 'local_plan_1' }, {
      workspace: new Workspace(root),
      conversationId: 'c-render',
      permissionMode: 'full',
    })
    expect(output).toContain('<media_job_started')
    expect(output).toContain('kind="video_render"')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('render_video 缺 project 直接报错', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-'))
  try {
    const tasks = new TaskService(root)
    const media = new MediaJobService({ tasks, stateRoot: root, pollIntervalMs: 1 })
    const tool = createMediaTools(media).find(t => t.name === 'render_video')!
    await expect(tool.execute({ project: '' }, {
      workspace: new Workspace(root),
      conversationId: 'c-render-empty',
      permissionMode: 'full',
    })).rejects.toThrow(/project/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upscale_image tool 起 upscale 任务(超分放大·印刷不糊)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-'))
  try {
    const tasks = new TaskService(root)
    const media = new MediaJobService({ tasks, stateRoot: root, pollIntervalMs: 1 })
    const tool = createMediaTools(media).find(t => t.name === 'upscale_image')
    expect(tool).toBeTruthy()
    const output = await tool!.execute({ source_generation_id: 'local-poster-7', scale: 4 }, {
      workspace: new Workspace(root),
      conversationId: 'c-up',
      permissionMode: 'full',
    })
    expect(output).toContain('<media_job_started')
    expect(output).toContain('kind="upscale"')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('upscale_image 缺原图直接报错、不起任务', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-'))
  try {
    const tasks = new TaskService(root)
    const media = new MediaJobService({ tasks, stateRoot: root, pollIntervalMs: 1 })
    const tool = createMediaTools(media).find(t => t.name === 'upscale_image')!
    await expect(tool.execute({}, {
      workspace: new Workspace(root),
      conversationId: 'c-up-empty',
      permissionMode: 'full',
    })).rejects.toThrow(/原图/)
    expect((await tasks.list({ conversationId: 'c-up-empty' })).length).toBe(0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
