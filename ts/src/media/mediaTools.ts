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
  portrait?: boolean
  portrait_consent?: boolean
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
    portrait: input.portrait === true,
    portrait_consent: input.portrait_consent === true,
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

export function createMediaTools(media: MediaJobService): Tool[] {
  const makePoster: Tool<ImageToolInput> = {
    name: 'make_poster',
    description: 'Generate a marketing poster/image for the store as a background media job. Expand the user request into a concrete Chinese visual prompt. Input: { description, style?, ratio?, count?, image_prompt?, reference_image_paths?, reference_generation_ids?, poster_text?, print_mode?, portrait?, portrait_consent? }. When optimizing a real person\'s photo (portrait/headshot from an uploaded reference), the job first requires portrait authorization: if the result asks for consent, tell the user and only re-run with portrait_consent:true after they confirm they hold usage rights and the subject agreed. Do not sell face-swap/deepfake as a feature.',
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
        portrait: { type: 'boolean' },
        portrait_consent: { type: 'boolean' },
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

  return [makePoster, generateImage]
}
