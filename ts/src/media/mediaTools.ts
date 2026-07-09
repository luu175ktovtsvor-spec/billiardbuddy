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

interface EditImageToolInput {
  /** 原图标识(必带其一):之前用生图工具产出的图片 id(优先)。 */
  source_generation_id?: string
  /** 原图标识(必带其一):本机一张已有图片的绝对路径。 */
  source_image_path?: string
  /** 说明要怎么改这张图(改背景/换颜色/去水印/改文字/局部替换等)。 */
  description: string
  /** 文字类修正传 text_fix(改错别字/改文案),画面内容改动传 content;不传按描述自动判。 */
  edit_type?: 'text_fix' | 'content'
  /** 只改画面某一块时,传一张遮罩图(本机路径)做局部重绘。 */
  mask_path?: string
  ratio?: string
  count?: number
  image_model?: string
  image_prompt?: string
  /** 追加参考图(本机绝对路径),做风格/元素参照。 */
  reference_image_paths?: string[]
  /** 追加参考图(之前生成图片的 id)。 */
  reference_generation_ids?: string[]
  poster_text?: Record<string, unknown>
  portrait?: boolean
  portrait_consent?: boolean
}

function nonEmptyStrings(...values: Array<string | string[] | undefined>): string[] {
  const out: string[] = []
  for (const value of values) {
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === 'string' && item.trim()) out.push(item.trim())
    } else if (typeof value === 'string' && value.trim()) {
      out.push(value.trim())
    }
  }
  return out
}

/** 有没有"原图标识":生成 id / 本机图片路径 / 参考图 任一都算带图。缺则不能改图(不退化成文字重生)。 */
function hasOriginalImage(input: EditImageToolInput): boolean {
  return nonEmptyStrings(
    input.source_generation_id,
    input.source_image_path,
    input.reference_generation_ids,
    input.reference_image_paths,
  ).length > 0
}

function editImageBody(input: EditImageToolInput, ctx: ToolContext): Record<string, unknown> {
  // 本机可读图片(原图/遮罩/参考图)登记进受信任白名单,后端只放行这些绝对路径。
  const trustedPaths = nonEmptyStrings(input.source_image_path, input.mask_path, input.reference_image_paths)
  // 本机原图并入 reference_image_paths(以 'reference' 角色入 refs),满足后端"改图必须有底图"硬闸。
  const referenceImagePaths = nonEmptyStrings(input.source_image_path, input.reference_image_paths)
  return {
    // 后端 collectImageReferences 在 edit 模式下以 source_generation_id 为 'source' 底图;
    // 缺可读底图后端会硬报错"改图需要可读取的 source_generation_id 底图",绝不退化为文字重生。
    source_generation_id: input.source_generation_id?.trim() || undefined,
    prompt: input.description,
    image_prompt: input.image_prompt ?? input.description,
    edit_type: input.edit_type,
    mask_path: input.mask_path,
    ratio: input.ratio ?? '3:4',
    count: input.count ?? 1,
    image_model: input.image_model,
    reference_image_paths: referenceImagePaths.length ? referenceImagePaths : undefined,
    reference_generation_ids: input.reference_generation_ids,
    poster_text: input.poster_text,
    portrait: input.portrait === true,
    portrait_consent: input.portrait_consent === true,
    _trusted_image_paths: trustedPaths.length ? trustedPaths : undefined,
    conversation_id: ctx.conversationId,
  }
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

  const editImage: Tool<EditImageToolInput> = {
    name: 'edit_image',
    description: '基于一张已生成或已有的图片做调整/局部重绘(改背景、换颜色、去除或替换某处、改画面文字、抠图重构等),不是重新生成一张新图。必须提供原图标识:source_generation_id(之前用生图工具产出的图片 id,优先)或 source_image_path(本机图片的绝对路径);只改画面某一块时用 mask_path 传一张遮罩图做局部重绘。edit_type 可选:改错别字/改文案传 "text_fix",画面内容改动传 "content",不传按描述自动判断。何时用:用户说"把这张图…改成/换成/去掉/加上/局部重画/修一下"时用本工具;用户要全新一张图才用 generate_image。铁律:改图必须带原图——缺原图请先让用户指定是哪张,绝不凭文字凭空重画一张。真人肖像优化同样需要授权,若返回要求 consent,确认用户持有使用权且当事人同意后再带 portrait_consent:true 重跑。',
    inputSchema: {
      type: 'object',
      properties: {
        source_generation_id: { type: 'string' },
        source_image_path: { type: 'string' },
        description: { type: 'string' },
        edit_type: { type: 'string', enum: ['text_fix', 'content'] },
        mask_path: { type: 'string' },
        ratio: { type: 'string' },
        count: { type: 'number' },
        image_model: { type: 'string' },
        image_prompt: { type: 'string' },
        reference_image_paths: { type: 'array', items: { type: 'string' } },
        reference_generation_ids: { type: 'array', items: { type: 'string' } },
        poster_text: { type: 'object' },
        portrait: { type: 'boolean' },
        portrait_consent: { type: 'boolean' },
      },
      required: ['description'],
    },
    isReadOnly: false,
    async execute(input, ctx) {
      if (!input?.description?.trim()) throw new Error('edit_image 需要 description(说明要怎么改这张图)')
      // 反逻辑硬闸(工具层):改图必须带原图标识,缺原图直接报错,绝不退化成凭文字重新生成一张。
      if (!hasOriginalImage(input)) {
        throw new Error('改图必须带上原图:请传 source_generation_id(之前生成/已有图片的 id)或 source_image_path(本机图片绝对路径)。缺原图不能凭文字重新生成一张,请先让用户指定要修改哪张图,再调用 edit_image。')
      }
      const started = await media.startStudioEdit(editImageBody(input, ctx), {
        conversationId: ctx.conversationId,
        workspaceRoot: ctx.workspace.root,
      })
      return mediaStarted(started.job_id, 'edit', `已开始修改图片:${input.description.slice(0, 80)}`)
    },
  }

  return [makePoster, generateImage, editImage]
}
