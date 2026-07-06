import type { Tool, ToolContext } from '../tools/Tool'
import type { MediaJobService } from './mediaJobs'

interface ImageToolInput {
  description: string
  style?: string
  ratio?: string
  count?: number
  image_model?: string
  image_prompt?: string
  reference_image_paths?: string[]
  reference_generation_ids?: string[]
  poster_text?: Record<string, unknown>
  print_mode?: boolean
}

interface VideoToolInput {
  description: string
  first_frame?: string
  ratio?: string
  duration?: number
  generate_audio?: boolean
  image_refs?: string[]
}

function inputRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
}

function imageBody(input: ImageToolInput, ctx: ToolContext): Record<string, unknown> {
  return {
    prompt: input.description,
    style: input.style,
    ratio: input.ratio ?? '3:4',
    count: input.count ?? 1,
    image_model: input.image_model,
    image_prompt: input.image_prompt ?? input.description,
    reference_image_paths: input.reference_image_paths,
    reference_generation_ids: input.reference_generation_ids,
    poster_text: input.poster_text,
    print_mode: input.print_mode === true,
    conversation_id: ctx.conversationId,
  }
}

function mediaStarted(id: string, kind: string, title: string): string {
  return [
    `<media_job_started id="${id}" kind="${kind}">`,
    title,
    '可用 list_background_tasks/read_background_task 或 /api/v1/agent/media-jobs 查询进度。',
    '</media_job_started>',
  ].join('\n')
}

function normalizeVideoRatio(input: VideoToolInput): string {
  const raw = input.ratio?.trim()
  if (raw === '9:16' || raw === '16:9' || raw === '1:1') return raw
  const text = input.description ?? ''
  if (/(横版|横屏|大屏|电视|投屏|16:9)/.test(text)) return '16:9'
  if (/(方形|方图|1:1)/.test(text)) return '1:1'
  return '9:16'
}

export function createMediaTools(media: MediaJobService): Tool[] {
  const makePoster: Tool<ImageToolInput> = {
    name: 'make_poster',
    description: 'Generate a marketing poster/image for the store as a background media job. Expand the user request into a concrete Chinese visual prompt. Input: { description, style?, ratio?, count?, image_prompt?, reference_image_paths?, reference_generation_ids?, poster_text?, print_mode? }.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        style: { type: 'string' },
        ratio: { type: 'string' },
        count: { type: 'number' },
        image_model: { type: 'string' },
        image_prompt: { type: 'string' },
        reference_image_paths: { type: 'array', items: { type: 'string' } },
        reference_generation_ids: { type: 'array', items: { type: 'string' } },
        poster_text: { type: 'object' },
        print_mode: { type: 'boolean' },
      },
      required: ['description'],
    },
    isReadOnly: false,
    async execute(input, ctx) {
      if (!input?.description?.trim()) throw new Error('make_poster 需要 description')
      const started = await media.startStudioGenerate(imageBody(input, ctx), {
        conversationId: ctx.conversationId,
        workspaceRoot: ctx.workspace.root,
      })
      return mediaStarted(started.job_id, 'generate', `已开始生成海报:${input.description.slice(0, 80)}`)
    },
  }

  const generateImage: Tool<ImageToolInput> = {
    ...makePoster,
    name: 'generate_image',
    description: 'Generate a general image/poster/illustration as a background media job. Do not assume uploaded images are logos; pass explicit reference_image_paths or structured roles only when the user says so. Input is the same as make_poster.',
    async execute(input, ctx) {
      if (!input?.description?.trim()) throw new Error('generate_image 需要 description')
      const started = await media.startStudioGenerate(imageBody(input, ctx), {
        conversationId: ctx.conversationId,
        workspaceRoot: ctx.workspace.root,
      })
      return mediaStarted(started.job_id, 'generate', `已开始生成图片:${input.description.slice(0, 80)}`)
    },
  }

  const generateVideo: Tool<VideoToolInput> = {
    name: 'generate_video',
    description: 'Generate a short AI video (text-to-video or image-to-video) as a media job. Use first_frame for image-to-video. Video generation is slower and more expensive, so it requires explicit approval. Input: { description, first_frame?, ratio?, duration?, generate_audio?, image_refs? }.',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        first_frame: { type: 'string' },
        ratio: { type: 'string' },
        duration: { type: 'number' },
        generate_audio: { type: 'boolean' },
        image_refs: { type: 'array', items: { type: 'string' } },
      },
      required: ['description'],
    },
    isReadOnly: false,
    requiresApproval: true,
    approvalClass: 'spend',
    forceConfirm: true,
    approvalReasonFor(input) {
      const args = inputRecord(input) as Partial<VideoToolInput>
      const duration = typeof args.duration === 'number' ? args.duration : 5
      const ratio = normalizeVideoRatio({ description: args.description ?? '', ratio: args.ratio })
      return {
        what: `生成一条约 ${duration} 秒的 ${ratio} 短视频`,
        why: '视频生成耗时更长且会调用付费媒体模型，需要先确认。',
        impact: '确认后会作为后台媒体任务执行，完成后可在任务/作品里查看结果。',
      }
    },
    async execute(input, ctx) {
      if (!input?.description?.trim()) throw new Error('generate_video 需要 description')
      const body = {
        first_frame: input.first_frame,
        prompt: input.description,
        ratio: normalizeVideoRatio(input),
        duration: input.duration ?? 5,
        generate_audio: input.generate_audio === true,
        image_refs: input.image_refs,
        conversation_id: ctx.conversationId,
      }
      const started = await media.startStudioI2v(body, {
        conversationId: ctx.conversationId,
        workspaceRoot: ctx.workspace.root,
      })
      return mediaStarted(started.job_id, 'i2v', `已开始生成视频:${input.description.slice(0, 80)}`)
    },
  }

  return [makePoster, generateImage, generateVideo]
}
