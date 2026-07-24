import { z } from 'zod/v4'
import { randomUUID } from 'node:crypto'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

const inputSchema = lazySchema(() => z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create_image_project'),
    user_request: z.string().min(1).max(8000),
    title: z.string().min(1).max(160).optional(),
    workspace_root: z.string().min(1).max(4096).optional(),
    size: z.enum([
      '1024x1024', '1536x1024', '1024x1536',
      '2048x1152', '3840x2160', '2160x3840',
      '2304x1728', '1728x2304', '2848x1600',
      '1600x2848', '2496x1664', '1664x2496',
      '3136x1344', '4096x4096', '4704x3520',
      '3520x4704', '5504x3040', '3040x5504',
      '4992x3328', '3328x4992', '6240x2656',
      '2048x2048', '2352x1568', '1568x2352',
      '1680x2240', '2240x1680', '1536x2736',
      '2736x1536', '1216x3040', '3040x1216',
    ]).optional(),
  }),
  z.strictObject({
    action: z.literal('create_video_project'),
    title: z.string().min(1).max(160).optional(),
    workspace_root: z.string().min(1).max(4096).optional(),
    output: z.strictObject({
      width: z.number().int().min(320).max(3840),
      height: z.number().int().min(320).max(3840),
      fps: z.number().int().min(12).max(60),
    }).optional(),
  }),
  z.strictObject({
    action: z.literal('update_video_timeline'),
    project_id: z.string().min(8).max(80),
    revision: z.number().int().nonnegative(),
    clips: z.array(z.strictObject({
      source_id: z.string().min(8).max(80),
      in_ms: z.number().int().nonnegative(),
      out_ms: z.number().int().positive(),
    }).refine(clip => clip.out_ms > clip.in_ms, {
      message: 'out_ms must be greater than in_ms',
    })).max(500),
  }),
  z.strictObject({
    action: z.literal('add_video_source'),
    project_id: z.string().min(8).max(80),
    path: z.string().min(1).max(4096),
  }),
  z.strictObject({
    action: z.literal('get_project'),
    project_id: z.string().min(8).max(80),
  }),
  z.strictObject({
    action: z.literal('get_task'),
    task_id: z.string().min(8).max(80),
  }),
]))
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() => z.object({
  status: z.number().int(),
  result: z.record(z.string(), z.unknown()),
}))
type OutputSchema = ReturnType<typeof outputSchema>
type Output = z.infer<OutputSchema>

const mediaIdPattern = /^[a-z0-9][a-z0-9_-]{7,79}$/
const imageStates = new Set(['draft', 'queued', 'generating', 'ready', 'failed'])
const videoStates = new Set(['draft', 'ready', 'rendering', 'complete', 'failed'])
const taskKinds = new Set(['image.generate', 'video.probe', 'video.render'])
const taskStatuses = new Set(['queued', 'running', 'committing', 'succeeded', 'failed', 'cancelled'])
const imageSizes = new Set([
  '1024x1024', '1536x1024', '1024x1536',
  '2048x1152', '3840x2160', '2160x3840',
  '2304x1728', '1728x2304', '2848x1600',
  '1600x2848', '2496x1664', '1664x2496',
  '3136x1344', '4096x4096', '4704x3520',
  '3520x4704', '5504x3040', '3040x5504',
  '4992x3328', '3328x4992', '6240x2656',
  '2048x2048', '2352x1568', '1568x2352',
  '1680x2240', '2240x1680', '1536x2736',
  '2736x1536', '1216x3040', '3040x1216',
])
const inputFidelityStatuses = new Set(['accepted', 'unsupported'])

function localServerBase(): string {
  const raw = process.env.BB_DESKTOP_SERVER_URL?.trim()
  if (!raw) throw new Error('媒体工作台只在 BilliardBuddy 桌面会话中可用')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('媒体工作台连接配置无效')
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(url.hostname)) {
    throw new Error('媒体工作台拒绝连接非本机服务')
  }
  return url.origin
}

function requestFor(input: z.infer<InputSchema>): { method: string; path: string; body?: unknown } {
  switch (input.action) {
    case 'create_image_project':
      return {
        method: 'POST',
        path: '/api/media/images/projects',
        body: {
          user_request: input.user_request,
          title: input.title,
          workspace_root: input.workspace_root,
          size: input.size,
        },
      }
    case 'create_video_project':
      return {
        method: 'POST',
        path: '/api/media/videos/projects',
        body: { title: input.title, workspace_root: input.workspace_root, output: input.output },
      }
    case 'add_video_source':
      return {
        method: 'POST',
        path: `/api/media/videos/projects/${encodeURIComponent(input.project_id)}/sources`,
        body: { path: input.path },
      }
    case 'update_video_timeline':
      return {
        method: 'PUT',
        path: `/api/media/videos/projects/${encodeURIComponent(input.project_id)}/timeline`,
        body: {
          revision: input.revision,
          clips: input.clips.map(clip => ({
            id: `clip_${randomUUID().replaceAll('-', '')}`,
            ...clip,
          })),
        },
      }
    case 'get_project':
      return { method: 'GET', path: `/api/media/project/${encodeURIComponent(input.project_id)}` }
    case 'get_task':
      return { method: 'GET', path: `/api/media/tasks/${encodeURIComponent(input.task_id)}` }
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function safeMediaId(value: unknown): string | undefined {
  return typeof value === 'string' && mediaIdPattern.test(value) ? value : undefined
}

function safeString(value: unknown, maxLength: number): string | undefined {
  return typeof value === 'string' && value.length <= maxLength ? value : undefined
}

function safeEnum(value: unknown, allowed: Set<string>): string | undefined {
  return typeof value === 'string' && allowed.has(value) ? value : undefined
}

function safeInteger(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : undefined
}

function safeNumber(value: unknown, min: number, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
    ? value
    : undefined
}

function setMediaId(target: Record<string, unknown>, key: string, value: unknown): void {
  const id = safeMediaId(value)
  if (id !== undefined) target[key] = id
}

function setString(target: Record<string, unknown>, key: string, value: unknown, maxLength: number): void {
  const text = safeString(value, maxLength)
  if (text !== undefined) target[key] = text
}

function setInteger(target: Record<string, unknown>, key: string, value: unknown, min: number, max: number): void {
  const number = safeInteger(value, min, max)
  if (number !== undefined) target[key] = number
}

function sanitizeVideoSources(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const sources: Record<string, unknown>[] = []
  for (const item of value.slice(0, 200)) {
    const source = asRecord(item)
    const id = source ? safeMediaId(source.id) : undefined
    if (!source || !id) continue
    const safeSource: Record<string, unknown> = { id }
    const name = safeString(source.name, 500)
    if (name !== undefined && !/[\\/]/.test(name)) safeSource.name = name
    setInteger(safeSource, 'duration_ms', source.duration_ms, 0, Number.MAX_SAFE_INTEGER)
    setInteger(safeSource, 'width', source.width, 0, 3840)
    setInteger(safeSource, 'height', source.height, 0, 3840)
    const fps = safeNumber(source.fps, 0, 240)
    if (fps !== undefined) safeSource.fps = fps
    if (typeof source.has_audio === 'boolean') safeSource.has_audio = source.has_audio
    sources.push(safeSource)
  }
  return sources
}

function sanitizeVideoTimeline(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return []
  const timeline: Record<string, unknown>[] = []
  for (const item of value.slice(0, 500)) {
    const clip = asRecord(item)
    const sourceId = clip ? safeMediaId(clip.source_id) : undefined
    const inMs = clip ? safeInteger(clip.in_ms, 0, Number.MAX_SAFE_INTEGER) : undefined
    const outMs = clip ? safeInteger(clip.out_ms, 1, Number.MAX_SAFE_INTEGER) : undefined
    if (!clip || !sourceId || inMs === undefined || outMs === undefined || outMs <= inMs) continue
    const safeClip: Record<string, unknown> = { source_id: sourceId, in_ms: inMs, out_ms: outMs }
    setMediaId(safeClip, 'id', clip.id)
    timeline.push(safeClip)
  }
  return timeline
}

function sanitizeProject(project: Record<string, unknown>): Record<string, unknown> | null {
  const id = safeMediaId(project.id)
  if (!id) return null

  if (project.kind === 'image') {
    const state = safeEnum(project.state, imageStates)
    if (!state) return null
    const safeProject: Record<string, unknown> = { id, kind: 'image', state }
    setString(safeProject, 'title', project.title, 160)
    setInteger(safeProject, 'revision', project.revision, 0, Number.MAX_SAFE_INTEGER)
    setString(safeProject, 'mode', safeEnum(project.mode, new Set(['generate', 'edit'])), 16)
    const brief = asRecord(project.brief)
    if (brief) {
      const safeBrief: Record<string, unknown> = {}
      setString(safeBrief, 'user_request', brief.user_request, 8000)
      for (const key of ['confirmed_facts', 'must_preserve', 'may_change', 'missing_information', 'exact_text']) {
        const values = brief[key]
        if (Array.isArray(values)) safeBrief[key] = values.filter(value => typeof value === 'string').slice(0, 40)
      }
      safeProject.brief = safeBrief
    }
    setString(safeProject, 'size', safeEnum(project.size, imageSizes), 16)
    setInteger(safeProject, 'candidate_count', project.candidate_count, 3, 3)
    setString(safeProject, 'current_version_id', project.current_version_id, 80)
    if (Array.isArray(project.version_history)) {
      safeProject.version_count = Math.min(project.version_history.length, 1000)
    }
    const referenceCount = safeInteger(project.reference_image_count, 0, 8)
      ?? (Array.isArray(project.reference_images) ? Math.min(project.reference_images.length, 8) : undefined)
    if (referenceCount !== undefined) safeProject.reference_image_count = referenceCount
    setMediaId(safeProject, 'task_id', project.task_id)
    if (Array.isArray(project.outputs)) safeProject.output_count = Math.min(project.outputs.length, 16)
    return safeProject
  }

  if (project.kind === 'video') {
    const state = safeEnum(project.state, videoStates)
    if (!state) return null
    const safeProject: Record<string, unknown> = { id, kind: 'video', state }
    setString(safeProject, 'title', project.title, 160)
    setInteger(safeProject, 'revision', project.revision, 0, Number.MAX_SAFE_INTEGER)
    safeProject.sources = sanitizeVideoSources(project.sources)
    safeProject.timeline = sanitizeVideoTimeline(project.timeline)
    const output = asRecord(project.output)
    if (output) {
      const safeOutput: Record<string, unknown> = {}
      setInteger(safeOutput, 'width', output.width, 320, 3840)
      setInteger(safeOutput, 'height', output.height, 320, 3840)
      setInteger(safeOutput, 'fps', output.fps, 12, 60)
      if (Object.keys(safeOutput).length > 0) safeProject.output = safeOutput
    }
    setMediaId(safeProject, 'task_id', project.task_id)
    return safeProject
  }

  return null
}

function sanitizeTaskResult(kind: string, value: unknown): Record<string, unknown> | null {
  const result = asRecord(value)
  if (!result) return null
  const safeResult: Record<string, unknown> = {}
  if (kind === 'image.generate') {
    setInteger(safeResult, 'output_count', result.output_count, 0, 16)
    const inputFidelityStatus = safeEnum(result.input_fidelity_status, inputFidelityStatuses)
    if (inputFidelityStatus !== undefined) safeResult.input_fidelity_status = inputFidelityStatus
  } else if (kind === 'video.probe') {
    setMediaId(safeResult, 'source_id', result.source_id)
  } else if (kind === 'video.render') {
    setInteger(safeResult, 'render_revision', result.render_revision, 0, Number.MAX_SAFE_INTEGER)
  }
  return Object.keys(safeResult).length > 0 ? safeResult : null
}

function sanitizeTask(task: Record<string, unknown>): Record<string, unknown> | null {
  const id = safeMediaId(task.id)
  const kind = safeEnum(task.kind, taskKinds)
  if (!id || !kind) return null
  const safeTask: Record<string, unknown> = { id, kind }
  setMediaId(safeTask, 'project_id', task.project_id)
  const status = safeEnum(task.status, taskStatuses)
  if (status !== undefined) safeTask.status = status
  const progress = safeNumber(task.progress, 0, 100)
  if (progress !== undefined) safeTask.progress = progress
  if (typeof task.outcome_unknown === 'boolean') safeTask.outcome_unknown = task.outcome_unknown
  const result = sanitizeTaskResult(kind, task.result)
  if (result) safeTask.result = result
  return safeTask
}

/**
 * Tool output is sent back into the Agent context. Keep the project state that
 * supports the next media action, but never expose local paths, reference-image
 * bytes, paid-task credentials, or raw process errors to that context.
 */
export function sanitizeMediaWorkbenchResult(value: Record<string, unknown>): Record<string, unknown> {
  const safeResult: Record<string, unknown> = {}
  const project = asRecord(value.project)
  const task = asRecord(value.task)
  if (project) {
    const safeProject = sanitizeProject(project)
    if (safeProject) safeResult.project = safeProject
  }
  if (task) {
    const safeTask = sanitizeTask(task)
    if (safeTask) safeResult.task = safeTask
  }
  return safeResult
}

function safeMediaFailureMessage(status: number): string {
  if (status === 400) return '媒体操作参数无效，请检查后重试'
  if (status === 403) return '此操作需要在桌面媒体工作台中确认'
  if (status === 404) return '未找到对应的媒体项目或任务'
  if (status === 409) return '媒体项目状态已变化，请重新读取后再操作'
  if (status === 422) return '媒体素材暂时无法读取，请在工作台检查后重试'
  if (status >= 500) return '媒体服务暂时不可用，请稍后重试'
  return '媒体工作台暂时无法完成此操作，请稍后重试'
}

export const MediaWorkbenchTool = buildTool({
  name: 'MediaWorkbench',
  searchHint: 'prepare image and local video workbench projects',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  async description() {
    return 'Prepare or inspect a dedicated image or video workbench project.'
  },
  async prompt() {
    return `Use this tool to prepare BilliardBuddy image and video projects without replacing the coding-agent loop.

- create_image_project compiles the user's original request into a reviewable Brief and prepares a provider-neutral three-candidate draft. It does not spend image-generation credits or accept reference-image bytes; reference-image edits are created manually in the workbench.
- create_video_project prepares a local editing project.
- add_video_source reads local metadata with ffprobe and adds one source to the timeline.
- update_video_timeline applies reviewed trim ranges and ordering to the draft; inspect the current project first so source ids, durations, and revision are accurate.
- get_project/get_task inspect current deterministic state.
- Paid image submission and final FFmpeg export remain explicit user actions in the workbench.`
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    return Boolean(process.env.BB_DESKTOP_SERVER_URL?.trim())
  },
  isConcurrencySafe(input) {
    return input.action === 'get_project' || input.action === 'get_task'
  },
  isReadOnly(input) {
    return input.action === 'get_project' || input.action === 'get_task'
  },
  toAutoClassifierInput(input) {
    if (input.action === 'add_video_source') return `${input.action}: ${input.path}`
    return input.action
  },
  renderToolUseMessage(input) {
    if (input.action === 'create_image_project') return '准备生图工作台'
    if (input.action === 'create_video_project') return '准备视频工作台'
    if (input.action === 'add_video_source') return '读取视频素材'
    if (input.action === 'update_video_timeline') return '整理视频时间线'
    return '读取媒体项目'
  },
  async call(input, context) {
    const request = requestFor(input)
    const base = localServerBase()
    let response: Response
    try {
      response = await fetch(`${base}${request.path}`, {
        method: request.method,
        headers: request.body ? { 'Content-Type': 'application/json' } : undefined,
        body: request.body ? JSON.stringify(request.body) : undefined,
        redirect: 'error',
        signal: context.abortController.signal,
      })
    } catch {
      if (context.abortController.signal.aborted) throw new Error('媒体操作已取消')
      throw new Error('媒体工作台暂时无法连接，请稍后重试')
    }
    const rawResult = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      throw new Error(safeMediaFailureMessage(response.status))
    }
    const result = sanitizeMediaWorkbenchResult(rawResult)
    return { data: { status: response.status, result } }
  },
  mapToolResultToToolResultBlockParam(output: Output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: JSON.stringify(output.result),
    }
  },
} satisfies ToolDef<InputSchema, Output>)
