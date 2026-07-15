import { open, stat } from 'node:fs/promises'
import { extname } from 'node:path'
import type { Tool, ToolContext } from '../tools/Tool'
import { relativeToWorkspace, resolveToolPath } from '../permissions/filePathRules'
import { detectImageFormat, getImageDimensions } from '../tools/imageRead'
import type { MediaJobService } from './mediaJobs'
import { summarizeVideoPlan, type VideoEditingService } from './video-edit/service'

const MAX_VISUAL_CANDIDATES = 8
const MAX_PROVIDER_REFERENCE_IMAGES = 4
const MAX_CANDIDATE_SCAN = 2_000
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif'])

interface ImageToolInput {
  description: string
  style?: string
  ratio?: string
  count?: number
  quality?: 'draft' | 'standard' | 'final'
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
  quality?: 'draft' | 'standard' | 'final'
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
  video_paths?: string[]
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

interface ListMediaProjectsInput {
  kind?: 'all' | 'image' | 'video'
}

interface UpscaleImageToolInput {
  /** 原图标识(必带其一):之前生图工具产出的图片 id(优先)。 */
  source_generation_id?: string
  /** 原图标识(必带其一):本机图片绝对路径。 */
  source_image_path?: string
  /** 放大倍数 2/3/4,默认 4。 */
  scale?: number
}

interface SelectImageCandidatesInput {
  path?: string
  goal?: string
  limit?: number
}

interface ImageCandidate {
  path: string
  size: number
  modifiedMs: number
  width?: number
  height?: number
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

/** 参考图不能冒充要被修改的原图。 */
function hasOriginalImage(input: EditImageToolInput): boolean {
  return nonEmptyStrings(input.source_generation_id, input.source_image_path).length > 0
}

function localImagePaths(input: Pick<EditImageToolInput, 'source_image_path' | 'mask_path' | 'reference_image_paths'> | Pick<ImageToolInput, 'reference_image_paths'>): string[] {
  return nonEmptyStrings(
    'source_image_path' in input ? input.source_image_path : undefined,
    'mask_path' in input ? input.mask_path : undefined,
    input.reference_image_paths,
  )
}

function unreviewedLocalImagePaths(paths: string[], ctx: ToolContext): string[] {
  if (!paths.length) return []
  const reads = ctx.fileReads
  if (!reads?.size) return paths
  return paths.filter(path => !reads.has(path) && ![...reads.values()].some(snapshot => snapshot.path === path))
}

function assertImagesWereVisuallyReviewed(paths: string[], ctx: ToolContext): void {
  const unreviewed = unreviewedLocalImagePaths(paths, ctx)
  if (!unreviewed.length) return
  throw new Error(`图片尚未经过视觉查看，不能直接提交处理:请先用 read_file 查看 ${unreviewed.join('、')}，确认画面内容后再继续。`)
}

function assertReferenceBudget(input: ImageToolInput | EditImageToolInput): void {
  const sourceCount = 'source_generation_id' in input && nonEmptyStrings(input.source_generation_id, input.source_image_path).length > 0 ? 1 : 0
  const referenceCount = nonEmptyStrings(input.reference_image_paths, input.reference_generation_ids).length
  if (sourceCount + referenceCount <= MAX_PROVIDER_REFERENCE_IMAGES) return
  const available = MAX_PROVIDER_REFERENCE_IMAGES - sourceCount
  throw new Error(`一次最多提交 ${MAX_PROVIDER_REFERENCE_IMAGES} 张图片给图片服务${sourceCount ? `(已包含 1 张原图，最多再选 ${available} 张参考图)` : ''}；请只保留对本次任务最关键的图片。`)
}

function imageActionPreview(input: EditImageToolInput | ImageToolInput): string {
  if (!('source_image_path' in input)) {
    const references = nonEmptyStrings(input.reference_image_paths, input.reference_generation_ids)
    return `生成要求:\n${input.description}\n\n参考图:\n${references.join('\n') || '无'}`
  }
  const source = input.source_image_path?.trim() || input.source_generation_id?.trim() || '未选择'
  const references = nonEmptyStrings(input.reference_image_paths, input.reference_generation_ids)
  return [
    `要修改的原图:\n${source}`,
    references.length ? `附加参考图:\n${references.join('\n')}` : '',
    input.mask_path?.trim() ? `局部遮罩:\n${input.mask_path.trim()}` : '',
    `修改要求:\n${input.description}`,
  ].filter(Boolean).join('\n\n')
}

function editImageBody(input: EditImageToolInput, ctx: ToolContext): Record<string, unknown> {
  // 本机可读图片(原图/遮罩/参考图)登记进受信任白名单,后端只放行这些绝对路径。
  const trustedPaths = nonEmptyStrings(input.source_image_path, input.mask_path, input.reference_image_paths)
  return {
    // 后端 collectImageReferences 在 edit 模式下以 source_generation_id 为 'source' 底图;
    // 缺可读底图后端会硬报错"改图需要可读取的 source_generation_id 底图",绝不退化为文字重生。
    source_generation_id: input.source_generation_id?.trim() || undefined,
    source_image_path: input.source_image_path?.trim() || undefined,
    prompt: input.description,
    edit_type: input.edit_type,
    mask_path: input.mask_path,
    ratio: input.ratio ?? '3:4',
    count: input.count ?? 1,
    quality: input.quality ?? 'standard',
    reference_image_paths: input.reference_image_paths?.length ? input.reference_image_paths : undefined,
    reference_generation_ids: input.reference_generation_ids,
    poster_text: input.poster_text,
    portrait: input.portrait === true,
    portrait_consent: input.portrait_consent === true,
    _trusted_image_paths: trustedPaths.length ? trustedPaths : undefined,
    conversation_id: ctx.conversationId,
  }
}

function imageBody(input: ImageToolInput, ctx: ToolContext): Record<string, unknown> {
  const trustedPaths = localImagePaths(input)
  return {
    prompt: input.description,
    style: input.style,
    ratio: input.ratio ?? '3:4',
    count: input.count ?? 3,
    quality: input.quality ?? 'standard',
    reference_image_paths: input.reference_image_paths,
    reference_generation_ids: input.reference_generation_ids,
    poster_text: input.poster_text,
    print_mode: input.print_mode === true,
    portrait: input.portrait === true,
    portrait_consent: input.portrait_consent === true,
    _trusted_image_paths: trustedPaths.length ? trustedPaths : undefined,
    conversation_id: ctx.conversationId,
  }
}

async function selectImageCandidates(input: SelectImageCandidatesInput, ctx: ToolContext): Promise<string> {
  const base = resolveToolPath(ctx, 'select_image_candidates', input.path ?? '.', 'read')
  const requested = Math.max(1, Math.min(MAX_VISUAL_CANDIDATES, Math.floor(input.limit ?? MAX_VISUAL_CANDIDATES)))
  const remaining = Math.max(0, ctx.imageCandidateBudget ?? MAX_VISUAL_CANDIDATES)
  const limit = Math.min(requested, remaining)
  if (limit === 0) return '本回合已列出 8 张图片候选。请只查看已有候选并做推荐，不要继续遍历其余图片。'
  ctx.imageCandidateBudget = remaining - limit
  const glob = new Bun.Glob('**/*')
  const candidates: ImageCandidate[] = []
  let scanned = 0
  let truncated = false
  for await (const path of glob.scan({ cwd: base, absolute: true, onlyFiles: true, dot: false })) {
    if (!IMAGE_EXTENSIONS.has(extname(path).toLowerCase())) continue
    scanned++
    if (scanned > MAX_CANDIDATE_SCAN) {
      truncated = true
      break
    }
    const candidate = await readCandidateMetadata(path)
    if (candidate) candidates.push(candidate)
  }

  if (!candidates.length) {
    ctx.imageCandidateBudget += limit
    return '没有找到可用的图片候选。'
  }
  const preferred = preferredOrientation(input.goal)
  candidates.sort((a, b) => candidateScore(b, preferred) - candidateScore(a, preferred) || b.modifiedMs - a.modifiedMs || a.path.localeCompare(b.path))
  const selected = candidates.slice(0, limit)
  ctx.imageCandidateBudget += limit - selected.length
  return [
    `<image_candidates scanned="${Math.min(scanned, MAX_CANDIDATE_SCAN)}" selected="${selected.length}"${truncated ? ' truncated="true"' : ''}>`,
    `这是本地元数据初筛，不是视觉结论。只用 read_file 查看下列 ${selected.length} 张预览，再推荐 1-3 张并说明理由；回复时按本回合实际成功的 read_file 数量准确说“查看了 N 张候选”，不得声称看遍了整个目录。不要继续遍历其余图片。如果都不合适，请用户缩小目录或说明偏好。如果用户已经要求修图，推荐后同一回合直接调用 edit_image，由系统展示确认卡，不要在正文里重复询问。`,
    ...selected.map(candidate => {
      const relativePath = relativeToWorkspace(ctx.workspace.root, candidate.path) || candidate.path
      const dimensions = candidate.width && candidate.height ? `${candidate.width}x${candidate.height}` : 'unknown'
      return `<candidate path="${xmlAttr(relativePath)}" dimensions="${dimensions}" bytes="${candidate.size}" modified_ms="${Math.floor(candidate.modifiedMs)}" />`
    }),
    '</image_candidates>',
  ].join('\n')
}

async function readCandidateMetadata(path: string): Promise<ImageCandidate | null> {
  try {
    const info = await stat(path)
    if (!info.isFile() || info.size < 16 * 1024 || info.size > 50 * 1024 * 1024) return null
    const handle = await open(path, 'r')
    try {
      const header = Buffer.alloc(Math.min(info.size, 256 * 1024))
      const { bytesRead } = await handle.read(header, 0, header.length, 0)
      const bytes = header.subarray(0, bytesRead)
      const format = detectImageFormat(bytes)
      if (!format) return null
      const dimensions = getImageDimensions(bytes, format)
      if (dimensions && (dimensions.width < 320 || dimensions.height < 320)) return null
      return { path, size: info.size, modifiedMs: info.mtimeMs, width: dimensions?.width, height: dimensions?.height }
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}

function preferredOrientation(goal: string | undefined): 'portrait' | 'landscape' | undefined {
  if (/朋友圈|竖图|竖版|小红书|抖音|portrait/iu.test(goal ?? '')) return 'portrait'
  if (/横图|横版|封面|banner|landscape/iu.test(goal ?? '')) return 'landscape'
  return undefined
}

function candidateScore(candidate: ImageCandidate, preferred: 'portrait' | 'landscape' | undefined): number {
  const pixels = (candidate.width ?? 0) * (candidate.height ?? 0)
  const orientation = candidate.width && candidate.height
    ? candidate.height > candidate.width ? 'portrait' : candidate.width > candidate.height ? 'landscape' : 'square'
    : 'unknown'
  const orientationBonus = preferred && orientation === preferred ? 1_000_000_000 : 0
  return orientationBonus + Math.min(pixels, 100_000_000) + Math.log2(Math.max(1, candidate.size)) * 1_000
}

function xmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function mediaStarted(id: string, kind: string, title: string): string {
  return [
    `<media_job_started id="${id}" kind="${kind}">`,
    title,
    `使用 TaskOutput({task_id:"${id}",block:true,timeout:120000}) 等待完成并读取结果。`,
    '任务结果会直接返回成品 URL；不要用 find、glob 或目录遍历猜测输出位置。',
    '</media_job_started>',
  ].join('\n')
}

export function createMediaTools(media: MediaJobService, deps: { videoEditing?: VideoEditingService } = {}): Tool[] {
  const listMediaProjects: Tool<ListMediaProjectsInput> = {
    name: 'list_media_projects',
    description: '列出当前工作文件夹中由对话 Agent 或图片/视频工作台创建的媒体项目。用户说“继续刚才的图”“打开工作台项目”“继续剪这个视频”时先调用，不得猜测 project 或 generation id。不会列出其他工作文件夹的项目。',
    inputSchema: {
      type: 'object',
      properties: { kind: { type: 'string', enum: ['all', 'image', 'video'] } },
    },
    isReadOnly: true,
    async execute(input, ctx) {
      const kind = input?.kind ?? 'all'
      const [imageProjects, videoProjects] = await Promise.all([
        kind === 'video' ? Promise.resolve([]) : media.listWorkbenchProjects(ctx.workspace.root),
        kind === 'image' || !deps.videoEditing ? Promise.resolve([]) : deps.videoEditing.store.list({ workingDir: ctx.workspace.root }),
      ])
      return JSON.stringify({
        working_dir: ctx.workspace.root,
        image_projects: imageProjects.map(project => {
          const current = project.versions.find(version => version.id === project.current_version_id) ?? project.versions.at(-1)
          return {
            project: project.project_id,
            title: project.title,
            updated_at: project.updated_at,
            source_generation_id: current?.generation_id ?? project.source_generation_id,
            image_url: current?.image_url,
            conversation_id: project.conversation_id,
          }
        }),
        video_projects: videoProjects.map(project => ({
          project: project.project_id,
          title: project.name,
          updated_at: project.updated_at,
          status: project.status.phase,
          scene_count: project.scenes.filter(scene => !scene.deleted).length,
          conversation_id: project.conversation_id,
        })),
      })
    },
  }

  const candidateSelector: Tool<SelectImageCandidatesInput> = {
    name: 'select_image_candidates',
    description: '从图片很多的工作区目录做本地元数据初筛，最多返回 8 张候选。用户让你“从文件夹挑一张”时先用它，再用 read_file 真正查看这些少量预览；不要对整个目录逐张读图。',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        goal: { type: 'string' },
        limit: { type: 'number', minimum: 1, maximum: MAX_VISUAL_CANDIDATES },
      },
    },
    isReadOnly: true,
    execute: selectImageCandidates,
  }

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
        quality: { type: 'string', enum: ['draft', 'standard', 'final'] },
        reference_image_paths: { type: 'array', items: { type: 'string' }, maxItems: MAX_PROVIDER_REFERENCE_IMAGES },
        reference_generation_ids: { type: 'array', items: { type: 'string' }, maxItems: MAX_PROVIDER_REFERENCE_IMAGES },
        poster_text: { type: 'object' },
        print_mode: { type: 'boolean' },
        portrait: { type: 'boolean' },
        portrait_consent: { type: 'boolean' },
      },
      required: ['description'],
    },
    isReadOnly: false,
    approvalClass: 'outreach',
    requiresApprovalFor: input => localImagePaths(input).length > 0,
    requiresUserInteractionFor: input => localImagePaths(input).length > 0,
    approvalReasonFor: input => ({
      what: '使用已选本地图片作为生成参考',
      why: '确认模型选中的参考图和生成要求无误',
      impact: '确认后只会把下方列出的图片提交给图片生成服务，原文件不会被覆盖',
    }),
    previewFor: async input => imageActionPreview(input),
    async execute(input, ctx) {
      if (!input?.description?.trim()) throw new Error('make_poster 需要 description')
      assertReferenceBudget(input)
      assertImagesWereVisuallyReviewed(localImagePaths(input), ctx)
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
      assertReferenceBudget(input)
      assertImagesWereVisuallyReviewed(localImagePaths(input), ctx)
      const started = await media.startStudioGenerate(imageBody(input, ctx), {
        conversationId: ctx.conversationId,
        workspaceRoot: ctx.workspace.root,
      })
      return mediaStarted(started.job_id, 'generate', `已开始生成图片:${input.description.slice(0, 80)}`)
    },
  }

  const editImage: Tool<EditImageToolInput> = {
    name: 'edit_image',
    description: '基于一张已生成或已有的图片做调整/局部重绘。处理本地图片时，先用 read_file 真正查看候选画面，再选出一张并说明选择理由；不得只按文件名或元数据猜测。完成选择后直接调用 edit_image，由系统展示选定图片和修改方案的确认卡；不要先用正文询问后等下一回合。图片优化/修图必须走该受控图片编辑服务，服务会自动将调亮/对比度/轻锐化路由到本地确定性处理，将换背景/增删内容/换装/重绘路由到生成式图片引擎。不得自行调用 run_command、FFmpeg、ImageMagick 或创建临时预览目录。必须提供 source_generation_id 或 source_image_path；缺原图绝不凭文字重画。真人肖像的生成式修改还需要用户持有使用权且当事人同意。',
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
        quality: { type: 'string', enum: ['draft', 'standard', 'final'] },
        reference_image_paths: { type: 'array', items: { type: 'string' }, maxItems: MAX_PROVIDER_REFERENCE_IMAGES - 1 },
        reference_generation_ids: { type: 'array', items: { type: 'string' }, maxItems: MAX_PROVIDER_REFERENCE_IMAGES - 1 },
        poster_text: { type: 'object' },
        portrait: { type: 'boolean' },
        portrait_consent: { type: 'boolean' },
      },
      required: ['description'],
    },
    isReadOnly: false,
    requiresApproval: true,
    approvalClass: 'outreach',
    requiresUserInteraction: true,
    approvalReasonFor: () => ({
      what: '修改选中的图片',
      why: '确认模型选中的原图和修改方案无误',
      impact: '确认后只会把下方列出的图片提交给图片编辑服务，并生成新文件；原图不会被覆盖',
    }),
    previewFor: async input => imageActionPreview(input),
    async execute(input, ctx) {
      if (!input?.description?.trim()) throw new Error('edit_image 需要 description(说明要怎么改这张图)')
      // 反逻辑硬闸(工具层):改图必须带原图标识,缺原图直接报错,绝不退化成凭文字重新生成一张。
      if (!hasOriginalImage(input)) {
        throw new Error('改图必须带上原图:请传 source_generation_id(之前生成/已有图片的 id)或 source_image_path(本机图片绝对路径)。缺原图不能凭文字重新生成一张,请先让用户指定要修改哪张图,再调用 edit_image。')
      }
      assertReferenceBudget(input)
      assertImagesWereVisuallyReviewed(localImagePaths(input), ctx)
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
    },
    isReadOnly: false,
    async execute(input, ctx) {
      const paths = nonEmptyStrings(input?.video_paths)
      const requestedProjectId = input.project?.trim()
      if (!paths.length && !requestedProjectId) throw new Error('plan_video 需要 video_paths(新项目)或 project(当前工作文件夹中的已有项目)。')
      if (!deps.videoEditing) throw new Error('视频 V2 编辑服务未连接')
      const userRequest = input.goal?.trim() || '根据这些真实素材剪成一条完整、自然的视频'
      const preferredView = input.mode === 'speech' ? 'talking' : input.mode === 'ambient' ? 'ambient' : undefined
      const ratio = input.aspect === '1:1' || input.aspect === '16:9' ? input.aspect : '9:16'
      const targetDurationMs = typeof input.target_duration_s === 'number' ? Math.round(input.target_duration_s * 1000) : undefined
      let projectId = requestedProjectId
      let started: { job_id: string; project_id: string }
      if (projectId) {
        await deps.videoEditing.store.loadForWorkspace(projectId, ctx.workspace.root)
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
    requiresApprovalFor: input => input.preview !== true,
    requiresUserInteractionFor: input => input.preview !== true,
    approvalReasonFor: () => ({
      what: '生成完整视频',
      why: '确认当前草稿、素材缺口和候选取舍无误',
      impact: '确认后会锁定当前版本并在本机生成新的 MP4，不会改动原视频',
    }),
    previewFor: async (input, ctx) => {
      const projectId = input.project?.trim()
      if (!projectId || !deps.videoEditing) return `视频项目:${projectId || '未选择'}`
      const current = await deps.videoEditing.store.loadForWorkspace(projectId, ctx.workspace.root)
      const summary = summarizeVideoPlan(current)
      return [
        `视频项目:${projectId}`,
        `当前版本:${current.revision}`,
        `系统理解:${summary.understanding}`,
        `片段:${summary.scene_count} 段 / 约 ${summary.total_duration_s} 秒`,
        summary.missing_coverage.length ? `素材缺口:${summary.missing_coverage.join('、')}` : '素材缺口:无',
      ].join('\n')
    },
    async execute(input, ctx) {
      const project = typeof input?.project === 'string' ? input.project.trim() : ''
      if (!project) throw new Error('render_video 需要 project(plan_video 返回的项目名)。')
      if (!deps.videoEditing) throw new Error('视频 V2 编辑服务未连接')
      const current = await deps.videoEditing.store.loadForWorkspace(project, ctx.workspace.root)
      const started = await deps.videoEditing.startRender(project, { revision: current.revision, preview: input.preview === true }, {
        conversationId: ctx.conversationId,
        workspaceRoot: ctx.workspace.root,
      })
      return mediaStarted(started.job_id, 'video_v2_render', `已锁定项目 ${project} revision ${current.revision} 并开始${input.preview === true ? '预览' : '正式'}导出`)
    },
  }

  const upscaleImageTool: Tool<UpscaleImageToolInput> = {
    name: 'upscale_image',
    description: '把一张已生成或本机图片做 2/3/4 倍高清尺寸放大，使用本地 Lanczos 缩放和轻锐化，保持画面内容并生成新文件，不覆盖原图。它不会恢复原图中不存在的细节；用户要修复真实模糊、重绘内容或提升画质时改用 edit_image。入参:source_generation_id(之前生图工具产出的图片 id,优先)或 source_image_path(本机图片绝对路径);scale 默认 4。组件未就绪时原任务会等待后台准备。',
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

  return [listMediaProjects, candidateSelector, makePoster, generateImage, editImage, upscaleImageTool, planVideo, renderVideo]
}
