import type { Tool, ToolContext } from '../tools/Tool'
import type { MediaJobService } from './mediaJobs'
import type { VideoEditingService } from './video-edit/service'

interface ImageToolInput {
  description: string
  style?: string
  ratio?: string
  count?: number
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
  /** 追加参考图(本机绝对路径),做风格/元素参照。 */
  reference_image_paths?: string[]
  /** 追加参考图(之前生成图片的 id)。 */
  reference_generation_ids?: string[]
  poster_text?: Record<string, unknown>
  portrait?: boolean
  portrait_consent?: boolean
}

interface PlanVideoToolInput {
  /** 要剪的本机视频素材绝对路径(必填,可多段)。 */
  video_paths: string[]
  /** 自然语言意图(如"剪成 30 秒抖音、去开头空镜、配点节奏感");供你自己判参,引擎按结构化参数干活。 */
  goal?: string
  /** 目标时长(秒)。 */
  target_duration_s?: number
  /** 画面比例:9:16 竖 / 1:1 方 / 16:9 横;不传按素材。 */
  aspect?: string
  /** 剪法:'speech' 口播(转写驱动)/ 'ambient' 环境氛围(视觉五步);不传自动判。 */
  mode?: 'speech' | 'ambient'
  /** 项目名(续剪/再调时带上同一个)。 */
  project?: string
}

interface RenderVideoToolInput {
  /** plan_video 返回的项目名(必填)。 */
  project: string
  /** true=快速低清预览;不传出正式成片。 */
  preview?: boolean
}

interface UpscaleImageToolInput {
  /** 原图标识(必带其一):之前生图工具产出的图片 id(优先)。 */
  source_generation_id?: string
  /** 原图标识(必带其一):本机图片绝对路径。 */
  source_image_path?: string
  /** 放大倍数 2/3/4,默认 4。 */
  scale?: number
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
    edit_type: input.edit_type,
    mask_path: input.mask_path,
    ratio: input.ratio ?? '3:4',
    count: input.count ?? 1,
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
    count: input.count ?? 3,
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

export function createMediaTools(media: MediaJobService, deps: { videoEditing?: VideoEditingService } = {}): Tool[] {
  const makePoster: Tool<ImageToolInput> = {
    name: 'make_poster',
    description: '生成海报或图片后台任务。description 只传用户真实提出的画面需求，不要扩写成运营方案，不要引入用户未提供的领域知识、知识库内容或营销信息；后端会通过系统统一编译 CreativeBrief、路由模型并优化最终 Prompt。可按用户明确要求传 style、ratio、参考图和精确海报文字。真人照片优化必须先确认用户持有使用权且当事人同意；不得把换脸或深伪作为功能。',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string' },
        style: { type: 'string' },
        ratio: { type: 'string' },
        count: { type: 'number' },
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
    description: '生成通用图片、海报或插画后台任务。description 必须忠实保留用户真实画面需求，不引入用户未提供的领域知识、运营方案或营销内容；系统统一编译 CreativeBrief、路由模型并生成最终 Prompt。不要把上传图片擅自当作 Logo，只有用户明确说明时才传对应参考图。',
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

  const planVideo: Tool<PlanVideoToolInput> = {
    name: 'plan_video',
    description: '把用户提供的真实视频素材编排成可解释草稿。goal 必须忠实保留用户原始目标，不得注入 PPT、台球运营打法、价格、人物设定、CTA 或用户未提供的营销事实。后端统一编译 VideoCreativeBrief，再分析素材并生成共享 Scene/Timeline v2 和 3 个候选；mode 只决定先从“讲清一件事”或“展示环境与氛围”视图开始，两种视图共用同一项目。返回异步任务后查询进度并向用户复述理解、素材缺口和候选取舍；用户确认后再调用 render_video。',
    inputSchema: {
      type: 'object',
      properties: {
        video_paths: { type: 'array', items: { type: 'string' } },
        goal: { type: 'string' },
        target_duration_s: { type: 'number' },
        aspect: { type: 'string' },
        mode: { type: 'string', enum: ['speech', 'ambient'] },
        project: { type: 'string' },
      },
      required: ['video_paths'],
    },
    isReadOnly: false,
    async execute(input, ctx) {
      const paths = nonEmptyStrings(input?.video_paths)
      if (!paths.length) throw new Error('plan_video 需要 video_paths(要剪的本机视频绝对路径,至少一段)。')
      if (!deps.videoEditing) throw new Error('视频 V2 编辑服务未连接')
      const userRequest = input.goal?.trim() || '根据这些真实素材剪成一条完整、自然的视频'
      const preferredView = input.mode === 'speech' ? 'talking' : input.mode === 'ambient' ? 'ambient' : undefined
      const ratio = input.aspect === '1:1' || input.aspect === '16:9' ? input.aspect : '9:16'
      const targetDurationMs = typeof input.target_duration_s === 'number' ? Math.round(input.target_duration_s * 1000) : undefined
      let projectId = input.project?.trim()
      let started: { job_id: string; project_id: string }
      if (projectId) {
        await deps.videoEditing.compileBrief(projectId, { user_request: userRequest, preferred_view: preferredView, ratio, target_duration_ms: targetDurationMs })
        started = await deps.videoEditing.startDrafts(projectId, { conversationId: ctx.conversationId, workspaceRoot: ctx.workspace.root })
      } else {
        const planned = await deps.videoEditing.createPlannedProject({
          video_paths: paths,
          user_request: userRequest,
          goal: preferredView,
          ratio,
          target_duration_ms: targetDurationMs,
          conversation_id: ctx.conversationId,
          working_dir: ctx.workspace.root,
        }, { user_request: userRequest, preferred_view: preferredView, ratio, target_duration_ms: targetDurationMs })
        projectId = planned.project.project_id
        started = planned.job
      }
      return mediaStarted(started.job_id, 'video_v2_drafts', `项目 ${projectId} 已开始分析素材并生成草稿:${userRequest.slice(0, 80)}`)
    },
  }

  const renderVideo: Tool<RenderVideoToolInput> = {
    name: 'render_video',
    description: '把用户已经确认的 Scene/Timeline v2 项目确定性渲染成 MP4。project 是 plan_video 返回的稳定项目 ID；preview=true 生成快速预览，否则锁定当前 revision 后正式导出。必须在用户看过 Brief、素材缺口和草稿后调用。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        preview: { type: 'boolean' },
      },
      required: ['project'],
    },
    isReadOnly: false,
    async execute(input, ctx) {
      const project = typeof input?.project === 'string' ? input.project.trim() : ''
      if (!project) throw new Error('render_video 需要 project(plan_video 返回的项目名)。')
      if (!deps.videoEditing) throw new Error('视频 V2 编辑服务未连接')
      const current = await deps.videoEditing.store.load(project)
      const started = await deps.videoEditing.startRender(project, { revision: current.revision, preview: input.preview === true }, {
        conversationId: ctx.conversationId,
        workspaceRoot: ctx.workspace.root,
      })
      return mediaStarted(started.job_id, 'video_v2_render', `已锁定项目 ${project} revision ${current.revision} 并开始${input.preview === true ? '预览' : '正式'}导出`)
    },
  }

  const upscaleImageTool: Tool<UpscaleImageToolInput> = {
    name: 'upscale_image',
    description: '把一张已生成或本机的图片超分放大到高清(2/3/4 倍),给要拿去印刷(易拉宝/喷绘/大幅海报)或嫌不够清晰的图去糊、提清晰度。入参:source_generation_id(之前生图工具产出的图片 id,优先)或 source_image_path(本机图片绝对路径);scale 放大倍数(2/3/4,默认 4)。何时用:用户说"这张放大点/印出来会糊/要高清大图/清晰度不够/拿去打印"。这是本机处理工具,按当前任务直接执行。铁律:必须带原图,缺原图报错,绝不凭空生成新图。组件没下好会返回"正在准备组件 x%",如实告诉用户稍等。',
    inputSchema: {
      type: 'object',
      properties: {
        source_generation_id: { type: 'string' },
        source_image_path: { type: 'string' },
        scale: { type: 'number' },
      },
    },
    isReadOnly: false,
    async execute(input, ctx) {
      const genId = input?.source_generation_id?.trim()
      const path = input?.source_image_path?.trim()
      if (!genId && !path) throw new Error('upscale_image 需要原图:请传 source_generation_id(之前生成图的 id)或 source_image_path(本机图片绝对路径)。')
      const started = await media.startUpscale({
        source_generation_id: genId || undefined,
        source_image_path: path || undefined,
        scale: input.scale,
        _trusted_image_paths: path ? [path] : undefined,
        conversation_id: ctx.conversationId,
      }, { conversationId: ctx.conversationId, workspaceRoot: ctx.workspace.root })
      return mediaStarted(started.job_id, 'upscale', `已开始放大图片${input.scale ? `(${input.scale} 倍)` : ''}`)
    },
  }

  return [makePoster, generateImage, editImage, upscaleImageTool, planVideo, renderVideo]
}
