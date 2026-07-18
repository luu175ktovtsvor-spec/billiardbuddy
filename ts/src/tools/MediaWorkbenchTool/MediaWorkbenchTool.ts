import { z } from 'zod/v4'
import { randomUUID } from 'node:crypto'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'

const inputSchema = lazySchema(() => z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('create_image_project'),
    prompt: z.string().min(1).max(8000),
    title: z.string().min(1).max(160).optional(),
    workspace_root: z.string().min(1).max(4096).optional(),
    size: z.enum(['1024x1024', '1536x1024', '1024x1536']).optional(),
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

function localServerBase(): string {
  const raw = process.env.BB_DESKTOP_SERVER_URL?.trim()
  if (!raw) throw new Error('媒体工作台只在 BilliardBuddy 桌面会话中可用')
  const url = new URL(raw)
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
          prompt: input.prompt,
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

function sanitizeToolResult(value: Record<string, unknown>): Record<string, unknown> {
  const project = value.project
  if (!project || typeof project !== 'object' || Array.isArray(project)) return value
  const record = project as Record<string, unknown>
  if (record.kind !== 'image') return value
  const references = Array.isArray(record.reference_images) && record.reference_images.length > 0
    ? record.reference_images.length
    : typeof record.reference_image_count === 'number'
      ? record.reference_image_count
      : 0
  const outputs = Array.isArray(record.outputs)
    ? record.outputs.map(output => {
        if (!output || typeof output !== 'object' || Array.isArray(output)) return output
        const { data_url: _dataUrl, ...safe } = output as Record<string, unknown>
        return safe
      })
    : []
  return {
    ...value,
    project: {
      ...record,
      reference_images: undefined,
      reference_image_count: references,
      outputs,
    },
  }
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

- create_image_project prepares an image-generation draft. It does not spend image-generation credits or accept reference-image bytes; reference-image edits are created manually in the workbench.
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
    const response = await fetch(`${localServerBase()}${request.path}`, {
      method: request.method,
      headers: request.body ? { 'Content-Type': 'application/json' } : undefined,
      body: request.body ? JSON.stringify(request.body) : undefined,
      signal: context.abortController.signal,
    })
    const rawResult = await response.json().catch(() => ({})) as Record<string, unknown>
    if (!response.ok) {
      const message = typeof rawResult.message === 'string' ? rawResult.message : `媒体服务返回 HTTP ${response.status}`
      throw new Error(message)
    }
    const result = sanitizeToolResult(rawResult)
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
