import { expect, test } from 'bun:test'
import { Buffer } from 'node:buffer'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MediaJobService } from './mediaJobs'
import { createMediaTools } from './mediaTools'
import { TaskService } from '../tasks/taskService'
import { Workspace } from '../workspace/workspace'
import { VideoEditingService } from './video-edit/service'
import { resolvePermission } from '../permissions/resolve'
import { fileReadTool } from '../tools/fileReadTool'
import type { ToolContext } from '../tools/Tool'

async function waitFor<T>(fn: () => Promise<T | null>, timeoutMs = 5000): Promise<T> {
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
    expect(tool!.inputSchema.properties).not.toHaveProperty('image_prompt')
    expect(tool!.inputSchema.properties).not.toHaveProperty('image_model')
    expect(tool!.description).toContain('系统统一编译')
    const output = await tool!.execute({
      description: '做一张周末促销海报',
      ratio: '3:4',
      image_prompt: '注入 PPT 运营逻辑和未要求的营销活动',
      image_model: 'force-provider-model',
    } as never, {
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
    expect(done.params?.count).toBe(1)
    expect(done.params?.quality).toBe('standard')
    expect(done.params?.image_model).toBeUndefined()
    expect(String(done.params?.image_prompt)).toContain('做一张周末促销海报')
    expect(String(done.params?.image_prompt)).not.toContain('PPT 运营逻辑')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generate_image compiles the user request and registers real candidates in the workbench', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-workbench-'))
  const projects: Array<Record<string, unknown>> = []
  try {
    const tasks = new TaskService(root)
    const media = new MediaJobService({
      tasks,
      stateRoot: root,
      pollIntervalMs: 1,
      env: {
        QF_GATEWAY_URL: 'http://image-gateway.example/gw/v1',
        QF_GATEWAY_TOKEN: 'app-token',
        IMAGE_MODEL_NAME: 'doubao-seedream-4-5-251128',
      },
      fetchImpl: async input => {
        if (String(input).endsWith('/ark/images/generations')) {
          return Response.json({
            data: Array.from({ length: 3 }, (_, index) => ({
              b64_json: Buffer.from(`candidate-${index + 1}`).toString('base64'),
            })),
          })
        }
        return Response.json({ detail: 'not found' }, { status: 404 })
      },
      workbenchStore: {
        async createProject(input) {
          const project = input as Record<string, unknown>
          projects.push(project)
          return { project_id: `project-${projects.length}`, current_version_id: `version-${projects.length}` }
        },
      },
    })
    const tool = createMediaTools(media).find(t => t.name === 'generate_image')!
    await tool.execute({ description: '做一张海边音乐节海报，画面中有朋友跳舞，不要文字' }, {
      workspace: new Workspace(root),
      conversationId: 'c-media-workbench',
      permissionMode: 'full',
    })

    const done = await waitFor(async () => {
      const list = await tasks.list({ conversationId: 'c-media-workbench' })
      return list[0]?.status === 'completed' ? list[0] : null
    })
    expect((done.result as Record<string, unknown> | undefined)?.workbench_project_ids).toHaveLength(3)
    expect(projects).toHaveLength(3)
    expect(projects[0]?.user_request).toBe('做一张海边音乐节海报，画面中有朋友跳舞，不要文字')
    expect((projects[0]?.creative_brief as Record<string, unknown>)?.user_request).toBe(projects[0]?.user_request)
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
    expect(tool!.inputSchema.properties).not.toHaveProperty('image_prompt')
    expect(tool!.inputSchema.properties).not.toHaveProperty('image_model')
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
    expect(done.params?.count).toBe(1)
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
    // 缺原图标识(source_generation_id / source_image_path)→ 工具层直接报错，参考图不能冒充原图。
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

test('edit_image requires visual review and explicit user confirmation even in full access mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-review-'))
  try {
    const source = join(root, 'candidate.png')
    const png = Buffer.alloc(24)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
    png.write('IHDR', 12, 'ascii')
    png.writeUInt32BE(640, 16)
    png.writeUInt32BE(960, 20)
    writeFileSync(source, png)

    let submitted: Record<string, unknown> | undefined
    const media = {
      async startStudioEdit(body: Record<string, unknown>) {
        submitted = body
        return { job_id: 'edit-reviewed' }
      },
    } as unknown as MediaJobService
    const tool = createMediaTools(media).find(item => item.name === 'edit_image')!
    const input = { source_image_path: source, description: '自然提亮并保持真实长相' }
    const ctx: ToolContext = {
      workspace: new Workspace(root),
      conversationId: 'c-reviewed-edit',
      permissionMode: 'bypassPermissions',
      fileReads: new Map(),
    }

    expect(resolvePermission(tool, input, ctx)).toMatchObject({
      behavior: 'ask',
      reason: { type: 'requiresUserInteraction' },
      approvalReason: { what: '修改选中的图片' },
    })
    expect(await tool.previewFor!(input, ctx)).toContain('candidate.png')
    expect(await tool.previewFor!(input, ctx)).toContain('自然提亮')
    await expect(tool.execute(input, ctx)).rejects.toThrow(/尚未经过视觉查看/)
    expect(submitted).toBeUndefined()

    await fileReadTool.execute({ path: source }, ctx)
    const output = await tool.execute(input, ctx)
    expect(output).toContain('edit-reviewed')
    expect(submitted?.source_image_path).toBe(source)
    expect(submitted?.reference_image_paths).toBeUndefined()
    expect(submitted?._trusted_image_paths).toEqual([source])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('select_image_candidates scans locally but returns at most eight metadata candidates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-candidates-'))
  try {
    for (let index = 0; index < 12; index++) {
      const portrait = index % 2 === 0
      const png = Buffer.alloc(20 * 1024)
      png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
      png.write('IHDR', 12, 'ascii')
      png.writeUInt32BE(portrait ? 900 : 1600, 16)
      png.writeUInt32BE(portrait ? 1600 : 900, 20)
      writeFileSync(join(root, `photo-${String(index).padStart(2, '0')}.png`), png)
    }
    const tool = createMediaTools({} as MediaJobService).find(item => item.name === 'select_image_candidates')!
    const ctx: ToolContext = {
      workspace: new Workspace(root),
      permissionMode: 'bypassPermissions',
      imageCandidateBudget: 8,
    }
    const output = await tool.execute({ goal: '挑一张适合朋友圈的照片' }, ctx)
    expect(output).toContain('scanned="12"')
    expect(output).toContain('selected="8"')
    expect((output.match(/<candidate /g) ?? [])).toHaveLength(8)
    expect(output).toContain('不要继续遍历其余图片')
    expect(output).toContain('按本回合实际成功的 read_file 数量')
    expect(output).toContain('同一回合直接调用 edit_image')
    const first = output.split('\n').find(line => line.startsWith('<candidate '))
    expect(first).toContain('dimensions="900x1600"')
    const exhausted = await tool.execute({ goal: '再筛一批', limit: 8 }, ctx)
    expect(exhausted).toContain('本回合已列出 8 张')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('select_image_candidates shares its eight-item budget across calls in one user turn', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-candidate-budget-'))
  try {
    for (let index = 0; index < 12; index++) {
      const png = Buffer.alloc(20 * 1024)
      png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
      png.write('IHDR', 12, 'ascii')
      png.writeUInt32BE(900, 16)
      png.writeUInt32BE(1600, 20)
      writeFileSync(join(root, `photo-${String(index).padStart(2, '0')}.png`), png)
    }
    const tool = createMediaTools({} as MediaJobService).find(item => item.name === 'select_image_candidates')!
    const ctx: ToolContext = {
      workspace: new Workspace(root),
      permissionMode: 'bypassPermissions',
      imageCandidateBudget: 8,
    }

    const first = await tool.execute({ goal: '挑选朋友圈照片', limit: 3 }, ctx)
    const second = await tool.execute({ goal: '继续筛选', limit: 8 }, ctx)
    const exhausted = await tool.execute({ goal: '再找一批', limit: 1 }, ctx)

    expect((first.match(/<candidate /g) ?? [])).toHaveLength(3)
    expect((second.match(/<candidate /g) ?? [])).toHaveLength(5)
    expect(ctx.imageCandidateBudget).toBe(0)
    expect(exhausted).toContain('本回合已列出 8 张')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('image tools reject too many provider references before starting a paid request', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-reference-limit-'))
  try {
    let called = false
    const media = {
      async startStudioEdit() {
        called = true
        return { job_id: 'should-not-start' }
      },
    } as unknown as MediaJobService
    const tool = createMediaTools(media).find(item => item.name === 'edit_image')!
    await expect(tool.execute({
      source_generation_id: 'source-1',
      description: '综合这些参考图修改',
      reference_generation_ids: ['ref-1', 'ref-2', 'ref-3', 'ref-4'],
    }, {
      workspace: new Workspace(root),
      permissionMode: 'bypassPermissions',
    })).rejects.toThrow(/一次最多提交 4 张/)
    expect(called).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generate_image only requires confirmation when local reference images will be submitted', () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-reference-'))
  try {
    const media = {} as MediaJobService
    const tool = createMediaTools(media).find(item => item.name === 'generate_image')!
    const ctx: ToolContext = { workspace: new Workspace(root), permissionMode: 'bypassPermissions' }
    expect(resolvePermission(tool, { description: '生成一张新海报' }, ctx).behavior).toBe('allow')
    expect(resolvePermission(tool, {
      description: '参考这张图生成海报',
      reference_image_paths: [join(root, 'reference.png')],
    }, ctx)).toMatchObject({ behavior: 'ask', reason: { type: 'requiresUserInteraction' } })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('plan_video tool compiles the shared brief and starts a v2 draft task', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-'))
  try {
    const source = join(root, 'clip.mp4')
    const ffmpeg = join(root, 'ffmpeg.sh')
    const ffprobe = join(root, 'ffprobe.sh')
    writeFileSync(source, 'video-source')
    writeFileSync(ffmpeg, '#!/bin/sh\nexit 0\n')
    writeFileSync(ffprobe, '#!/bin/sh\nprintf %s \'{"format":{"duration":"3"},"streams":[{"codec_type":"video","width":320,"height":180,"avg_frame_rate":"24/1","r_frame_rate":"24/1"}]}\'\n')
    chmodSync(ffmpeg, 0o755)
    chmodSync(ffprobe, 0o755)
    const tasks = new TaskService(root)
    const media = new MediaJobService({ tasks, stateRoot: root, pollIntervalMs: 1 })
    const videoEditing = new VideoEditingService({ stateRoot: root, tasks, env: { PATH: '', FFMPEG_BIN: ffmpeg, FFPROBE_BIN: ffprobe, WHISPER_CLI: '/missing' } })
    const tool = createMediaTools(media, { videoEditing }).find(t => t.name === 'plan_video')
    expect(tool).toBeTruthy()
    expect(tool!.description).not.toContain('门店卖点')
    expect(tool!.description).not.toContain('PPT 正文')
    const output = await tool!.execute({ video_paths: [source], goal: '展示真实环境', mode: 'ambient', target_duration_s: 12 }, {
      workspace: new Workspace(root),
      conversationId: 'c-plan',
      permissionMode: 'full',
    })
    expect(output).toContain('<media_job_started')
    expect(output).toContain('kind="video_v2_drafts"')
    await waitFor(async () => {
      const task = (await tasks.list({ conversationId: 'c-plan' }))[0]
      return task?.status === 'completed' ? task : null
    })
    const projects = await videoEditing.store.list()
    expect(projects).toHaveLength(1)
    expect(projects[0]?.creative_brief?.user_request).toBe('展示真实环境')
    expect(projects[0]?.creative_brief?.preferred_view).toBe('ambient')
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

test('render_video tool locks the current v2 revision before rendering', async () => {
  const root = mkdtempSync(join(tmpdir(), 'media-tools-'))
  try {
    const source = join(root, 'clip.mp4')
    writeFileSync(source, 'video-source')
    const tasks = new TaskService(root)
    const media = new MediaJobService({ tasks, stateRoot: root, pollIntervalMs: 1 })
    const videoEditing = new VideoEditingService({ stateRoot: root, tasks, env: { PATH: '', FFMPEG_BIN: '/missing' } })
    const project = await videoEditing.store.create({ video_paths: [source], goal: 'ambient' })
    const tool = createMediaTools(media, { videoEditing }).find(t => t.name === 'render_video')
    expect(tool).toBeTruthy()
    const output = await tool!.execute({ project: project.project_id }, {
      workspace: new Workspace(root),
      conversationId: 'c-render',
      permissionMode: 'full',
    })
    expect(output).toContain('<media_job_started')
    expect(output).toContain('kind="video_v2_render"')
    expect(output).toContain(`revision ${project.revision}`)
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
