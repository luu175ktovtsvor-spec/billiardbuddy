import { extname } from 'node:path'
import { existsSync } from 'node:fs'
import {
  videoAnalyzeRequestSchema,
  videoBriefCompileRequestSchema,
  videoBriefCompileResponseSchema,
  videoCreateProjectRequestSchema,
  videoJobSchema,
  videoProjectSchema,
  videoRenderRequestSchema,
  type VideoBriefCompileInput,
  type VideoCreateProjectInput,
  type VideoJob,
  type VideoProject,
  type VideoRenderInput,
} from '../../../shared/contracts/video-edit'
import { TaskService, type TaskMeta, type TaskRunnerContext } from '../../tasks/taskService'
import { gateMediaAssets, type MediaBinaryNeed } from '../mediaBinaries'
import { compileVideoBrief } from './briefCompiler'
import { VideoEvidenceService } from './evidence/analysisService'
import { VideoDraftPlanner } from './planning/planner'
import { VideoProjectError, VideoProjectStore } from './projectStore'
import { VideoRenderer } from './render/renderer'

type JobKind = VideoJob['kind']
type JobStatus = VideoJob['status']

const VIDEO_TASK_PREFIX = 'video_v2_'
const PLAN_SUMMARY_SCENE_LIMIT = 16

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function params(task: TaskMeta): Record<string, unknown> {
  return isRecord(task.params) ? task.params : {}
}

function stringParam(task: TaskMeta, key: string): string {
  const value = params(task)[key]
  return typeof value === 'string' ? value : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

function delayWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(new DOMException('cancelled', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function videoStatus(task: TaskMeta): JobStatus {
  const explicit = stringParam(task, 'video_status')
  const allowed: JobStatus[] = ['queued', 'preparing', 'analyzing', 'planning', 'rendering', 'blocked', 'cancelled', 'interrupted', 'error', 'done', 'done_with_warnings']
  if (allowed.includes(explicit as JobStatus)) return explicit as JobStatus
  if (task.status === 'cancelled') return 'cancelled'
  if (task.status === 'failed') return 'error'
  if (task.status === 'completed') return 'done'
  return task.status === 'running' ? 'preparing' : 'queued'
}

function taskToVideoJob(task: TaskMeta): VideoJob {
  const taskParams = params(task)
  const status = videoStatus(task)
  const result = isRecord(task.result) ? task.result : undefined
  return videoJobSchema.parse({
    id: task.id,
    project_id: stringParam(task, 'project_id'),
    kind: stringParam(task, 'video_kind'),
    status,
    progress: task.progress ?? 0,
    stage: task.stage ?? '',
    checkpoint: isRecord(taskParams.checkpoint) ? taskParams.checkpoint : {},
    retry_of: stringParam(task, 'retry_of') || undefined,
    retryable: taskParams.retryable === true || status === 'interrupted' || status === 'error',
    affected_source_ids: stringArray(taskParams.affected_source_ids),
    warnings: stringArray(taskParams.warnings),
    ...(task.error && status === 'error' ? { error: { code: stringParam(task, 'error_code') || 'video_job_failed', message: task.error, retryable: taskParams.retryable !== false } } : {}),
    ...(result ? { result } : {}),
    created_at: task.createdAt,
    updated_at: task.updatedAt,
  })
}

function mediaType(path: string): string {
  const extension = extname(path).toLowerCase()
  if (extension === '.png') return 'image/png'
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg'
  if (extension === '.webp') return 'image/webp'
  if (extension === '.mov') return 'video/quicktime'
  if (extension === '.webm') return 'video/webm'
  if (extension === '.json') return 'application/json; charset=utf-8'
  return 'video/mp4'
}

function seconds(ms: number): number {
  return Math.round(ms / 10) / 100
}

function compactText(value: string | undefined, max = 180): string | undefined {
  const text = value?.replace(/\s+/g, ' ').trim()
  if (!text) return undefined
  return text.length > max ? `${text.slice(0, max)}...` : text
}

export function summarizeVideoPlan(project: VideoProject, warnings: string[] = []) {
  const scenes = project.scenes.filter(scene => !scene.deleted).sort((a, b) => a.order - b.order)
  const sourceNames = new Map(project.sources.map(source => [source.id, source.name]))
  const selectedScenes = scenes.slice(0, PLAN_SUMMARY_SCENE_LIMIT).map(scene => {
    const primary = scene.video_layers.find(layer => layer.enabled && layer.role === 'primary') ?? scene.video_layers.find(layer => layer.enabled) ?? scene.video_layers[0]
    const range = primary?.source_range ?? scene.source_ranges[0]
    return {
      order: scene.order + 1,
      story_role: scene.story_role,
      visual_role: scene.visual_role,
      source_name: range ? sourceNames.get(range.source_id) ?? '未知素材' : '未知素材',
      ...(range ? { source_in_s: seconds(range.in_ms), source_out_s: seconds(range.out_ms) } : {}),
      output_duration_s: seconds(Math.max(0, scene.output_range.end_ms - scene.output_range.start_ms)),
      ...(compactText(scene.dialogue?.display_text, 140) ? { dialogue_preview: compactText(scene.dialogue?.display_text, 140) } : {}),
      rationale: compactText(scene.rationale) ?? '基于当前真实素材生成',
      review_notes: scene.needs_review.slice(0, 3),
    }
  })
  return {
    understanding: project.creative_brief?.understanding ?? project.creative_brief?.user_request ?? project.name,
    preferred_view: project.creative_brief?.preferred_view ?? project.goal,
    source_count: project.sources.length,
    scene_count: scenes.length,
    total_duration_s: seconds(scenes.reduce((total, scene) => total + Math.max(0, scene.output_range.end_ms - scene.output_range.start_ms), 0)),
    selected_scenes: selectedScenes,
    omitted_scene_count: Math.max(0, scenes.length - selectedScenes.length),
    alternatives: project.alternatives.map(alternative => ({
      id: alternative.id,
      name: alternative.name,
      tradeoff: alternative.tradeoff,
      changed_scene_count: alternative.changed_scene_ids.length,
    })),
    missing_coverage: project.status.missing_coverage,
    warnings: [...new Set([...project.status.warnings, ...warnings])].slice(0, 30),
  }
}

function rangeResponse(path: string, request: Request): Response {
  if (!existsSync(path)) return new Response(null, { status: 404 })
  const file = Bun.file(path)
  const range = request.headers.get('range')
  if (!range) return new Response(file, { headers: { 'Content-Type': mediaType(path), 'Accept-Ranges': 'bytes' } })
  const match = /^bytes=(\d*)-(\d*)$/i.exec(range.trim())
  if (!match) return new Response(null, { status: 416 })
  const size = file.size
  if (size <= 0) return new Response(null, { status: 416, headers: { 'Content-Range': 'bytes */0' } })
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : 0
  const start = suffixLength > 0 ? Math.max(0, size - suffixLength) : match[1] ? Number(match[1]) : 0
  const end = suffixLength > 0 ? size - 1 : match[2] ? Math.min(Number(match[2]), size - 1) : size - 1
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: {
      'Content-Type': mediaType(path),
      'Accept-Ranges': 'bytes',
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    },
  })
}

export interface VideoEditingServiceOptions {
  stateRoot: string
  tasks: TaskService
  env?: Record<string, string | undefined>
  gateAssets?: typeof gateMediaAssets
}

export class VideoEditingService {
  readonly store: VideoProjectStore
  readonly evidence: VideoEvidenceService
  readonly planner: VideoDraftPlanner
  private readonly activeJobs = new Set<string>()
  private readonly env: Record<string, string | undefined>
  private readonly gateAssets: typeof gateMediaAssets

  constructor(private readonly options: VideoEditingServiceOptions) {
    this.env = options.env ?? process.env
    this.gateAssets = options.gateAssets ?? gateMediaAssets
    this.store = new VideoProjectStore(options.stateRoot)
    this.evidence = new VideoEvidenceService(this.store, { env: this.env })
    this.planner = new VideoDraftPlanner(this.evidence)
  }

  async createProject(input: VideoCreateProjectInput) {
    const parsed = videoCreateProjectRequestSchema.parse(input)
    const project = await this.store.create(parsed)
    const job = await this.startAnalyze(project.project_id, { conversationId: input.conversation_id, workspaceRoot: input.working_dir })
    return { project, analysis_job: job }
  }

  async createPlannedProject(input: VideoCreateProjectInput, rawBrief: VideoBriefCompileInput) {
    const parsed = videoCreateProjectRequestSchema.parse(input)
    const briefInput = videoBriefCompileRequestSchema.parse(rawBrief)
    const created = await this.store.create(parsed)
    const job = await this.startJob('drafts', created.project_id, {
      conversationId: parsed.conversation_id,
      workspaceRoot: parsed.working_dir,
    }, async ctx => {
      await this.setJobStage(ctx.taskId, 'analyzing', { checkpoint: { phase: 'analysis_started' } })
      await ctx.runner.progress(8, '正在分析真实素材')
      const analyzed = await this.evidence.analyze(created.project_id, ctx.runner, {
        transcription: briefInput.preferred_view === 'talking'
          ? 'required'
          : briefInput.preferred_view === 'ambient'
            ? 'skip'
            : 'auto',
      })
      const compiled = compileVideoBrief(briefInput, analyzed.sources)
      const withBrief = await this.store.saveBrief(created.project_id, compiled.brief, analyzed.revision)
      await this.setJobStage(ctx.taskId, 'planning', { checkpoint: { phase: 'brief_compiled', revision: withBrief.revision } })
      await ctx.runner.progress(58, '正在检查故事覆盖并编排 Scene')
      const planned = await this.planner.plan(withBrief)
      if (!planned.scenes.length) throw new VideoProjectError('真实素材不足以生成草稿，请补充素材或调整目标', 'no_draft_scenes', 409)
      const saved = await this.store.replaceDrafts(created.project_id, planned.scenes, planned.alternatives, planned.missingCoverage, withBrief.revision)
      const warnings = [...withBrief.status.warnings, ...planned.missingCoverage.map(slot => `缺少故事覆盖:${slot}`)]
      await this.setJobStage(ctx.taskId, warnings.length ? 'done_with_warnings' : 'done', { checkpoint: { phase: 'drafts_done', revision: saved.revision }, warnings })
      return {
        project_id: created.project_id,
        revision: saved.revision,
        alternative_ids: saved.alternatives.map(item => item.id),
        warnings,
        plan_summary: summarizeVideoPlan(saved, warnings),
      }
    }, ['ffmpeg', 'ffprobe'])
    return { project: created, job }
  }

  async compileBrief(projectId: string, raw: VideoBriefCompileInput) {
    const project = await this.store.load(projectId)
    const compiled = compileVideoBrief(videoBriefCompileRequestSchema.parse(raw), project.sources)
    const saved = await this.store.saveBrief(projectId, compiled.brief, raw.base_revision)
    return videoBriefCompileResponseSchema.parse({
      brief: saved.creative_brief,
      recommendation_reason: compiled.recommendationReason,
      missing_facts: compiled.missingFacts,
      missing_coverage: compiled.missingCoverage,
    })
  }

  async startAnalyze(projectId: string, opts: { conversationId?: string; workspaceRoot?: string; retryOf?: string; sourceIds?: string[] } = {}) {
    const analyzeInput = videoAnalyzeRequestSchema.parse({ source_ids: opts.sourceIds })
    return await this.startJob('analyze', projectId, opts, async ctx => {
      await this.setJobStage(ctx.taskId, 'analyzing', { checkpoint: { phase: 'analysis_started' } })
      const current = await this.store.load(projectId)
      const project = await this.evidence.analyze(projectId, ctx.runner, {
        sourceIds: analyzeInput.source_ids,
        transcription: current.creative_brief?.preferred_view === 'talking' || current.goal === 'talking'
          ? 'required'
          : 'skip',
        onCheckpoint: async (checkpoint, affectedSourceIds) => {
          await this.setJobStage(ctx.taskId, 'analyzing', { checkpoint, affected_source_ids: affectedSourceIds })
        },
      })
      const warnings = project.status.warnings
      await this.setJobStage(ctx.taskId, warnings.length ? 'done_with_warnings' : 'done', { checkpoint: { phase: 'analysis_done' }, warnings })
      return { project_id: projectId, revision: project.revision, warnings }
    }, ['ffmpeg', 'ffprobe'])
  }

  async startDrafts(projectId: string, opts: { conversationId?: string; workspaceRoot?: string; retryOf?: string } = {}) {
    return await this.startJob('drafts', projectId, opts, async ctx => {
      await this.setJobStage(ctx.taskId, 'planning', { checkpoint: { phase: 'planning_started' } })
      await ctx.runner.progress(15, '正在检查故事覆盖')
      let project = await this.store.load(projectId)
      if (project.creative_brief?.preferred_view === 'talking' && !project.evidence.some(ref => ref.kind === 'transcript')) {
        await this.setJobStage(ctx.taskId, 'analyzing', { checkpoint: { phase: 'transcription_required' } })
        project = await this.evidence.analyze(projectId, ctx.runner, { transcription: 'required' })
        await this.setJobStage(ctx.taskId, 'planning', { checkpoint: { phase: 'planning_started' } })
      }
      if (project.music.enabled) project = await this.evidence.analyzeMusic(projectId, ctx.runner)
      const planned = await this.planner.plan(project)
      if (!planned.scenes.length) throw new VideoProjectError('真实素材不足以生成草稿，请重新分析或补充素材', 'no_draft_scenes', 409)
      await ctx.runner.progress(70, '正在生成可比较候选')
      const saved = await this.store.replaceDrafts(projectId, planned.scenes, planned.alternatives, planned.missingCoverage, project.revision)
      const warnings = planned.missingCoverage.map(slot => `缺少故事覆盖:${slot}`)
      await this.setJobStage(ctx.taskId, warnings.length ? 'done_with_warnings' : 'done', { checkpoint: { phase: 'drafts_done' }, warnings })
      return {
        project_id: projectId,
        revision: saved.revision,
        alternative_ids: saved.alternatives.map(item => item.id),
        warnings,
        plan_summary: summarizeVideoPlan(saved, warnings),
      }
    })
  }

  async startRender(projectId: string, request: VideoRenderInput, opts: { conversationId?: string; workspaceRoot?: string; retryOf?: string } = {}) {
    const parsedRequest = videoRenderRequestSchema.parse(request)
    const current = await this.store.load(projectId)
    const lockedRequest = videoRenderRequestSchema.parse({ ...parsedRequest, revision: parsedRequest.revision ?? current.revision })
    const started = await this.startJob('render', projectId, opts, async ctx => {
      await this.setJobStage(ctx.taskId, 'rendering', { checkpoint: { phase: 'render_started' } })
      const project = await this.store.load(projectId)
      const renderer = new VideoRenderer({
        stateRoot: this.options.stateRoot,
        env: this.env,
        signal: ctx.runner.signal,
        onProgress: (progress, stage) => ctx.runner.progress(progress, stage),
      })
      const result = await renderer.render(project, lockedRequest)
      if (!lockedRequest.preview) await this.store.recordExportUsage(project)
      await this.setJobStage(ctx.taskId, result.warnings.length ? 'done_with_warnings' : 'done', { checkpoint: { phase: 'render_done', revision: result.revision }, warnings: result.warnings })
      return result
    }, ['ffmpeg'])
    const task = await this.options.tasks.get(started.job_id)
    if (task) await this.options.tasks.touch(task.id, { params: { ...params(task), render_request: lockedRequest } })
    return started
  }

  async getJob(id: string): Promise<VideoJob | null> {
    let task = await this.options.tasks.get(id)
    if (!task || !task.kind?.startsWith(VIDEO_TASK_PREFIX)) return null
    if ((task.status === 'queued' || task.status === 'running') && !this.activeJobs.has(id)) {
      task = await this.options.tasks.touch(id, {
        status: 'failed',
        error: '应用退出导致任务中断，可从已保存 checkpoint 继续',
        params: { ...params(task), video_status: 'interrupted', retryable: true },
      })
    }
    return taskToVideoJob(task)
  }

  async cancelJob(id: string): Promise<VideoJob> {
    const task = await this.options.tasks.get(id)
    if (!task || !task.kind?.startsWith(VIDEO_TASK_PREFIX)) throw new VideoProjectError('找不到视频任务', 'job_not_found', 404)
    await this.options.tasks.cancel(id)
    const next = await this.options.tasks.touch(id, { params: { ...params(task), video_status: 'cancelled', retryable: true } })
    return taskToVideoJob(next)
  }

  async retryJob(id: string): Promise<{ job_id: string; project_id: string }> {
    const job = await this.getJob(id)
    if (!job) throw new VideoProjectError('找不到视频任务', 'job_not_found', 404)
    if (!job.retryable && !['cancelled', 'interrupted', 'error'].includes(job.status)) throw new VideoProjectError('当前任务不可重试', 'job_not_retryable', 409)
    if (job.kind === 'analyze') return await this.startAnalyze(job.project_id, { retryOf: id, sourceIds: job.affected_source_ids })
    if (job.kind === 'drafts') return await this.startDrafts(job.project_id, { retryOf: id })
    const previous = await this.options.tasks.get(id)
    const raw = isRecord(previous?.params?.render_request) ? previous.params.render_request : {}
    return await this.startRender(job.project_id, raw, { retryOf: id })
  }

  async sourceResponse(projectId: string, sourceId: string, request: Request): Promise<Response> {
    const project = await this.store.load(projectId)
    const source = project.sources.find(item => item.id === sourceId)
    if (!source || source.missing) throw new VideoProjectError('素材已离线', 'source_missing', 404)
    return rangeResponse(source.file_uri, request)
  }

  async exportResponse(projectId: string, fileName: string, request: Request): Promise<Response> {
    if (!/^[a-zA-Z0-9._-]+\.(?:mp4|json)$/.test(fileName)) throw new VideoProjectError('导出文件名不合法', 'invalid_export_path', 400)
    const project = await this.store.load(projectId)
    const path = `${this.store.projectDirectory(project.project_id)}/exports/${fileName}`
    if (!Bun.file(path).size) throw new VideoProjectError('找不到导出文件', 'export_not_found', 404)
    return rangeResponse(path, request)
  }

  async brandLogoResponse(projectId: string, request: Request): Promise<Response> {
    const project = await this.store.load(projectId)
    if (!project.brand.logo_path) throw new VideoProjectError('项目没有 Logo', 'logo_not_found', 404)
    return rangeResponse(project.brand.logo_path, request)
  }

  private async startJob(
    kind: JobKind,
    projectId: string,
    opts: { conversationId?: string; workspaceRoot?: string; retryOf?: string },
    runner: (ctx: { taskId: string; runner: TaskRunnerContext }) => Promise<unknown>,
    requiredAssets: MediaBinaryNeed[] = [],
  ): Promise<{ job_id: string; project_id: string }> {
    await this.store.load(projectId)
    const task = await this.options.tasks.create({
      title: kind === 'analyze' ? '视频素材分析' : kind === 'drafts' ? '视频草稿规划' : '视频正式导出',
      kind: `${VIDEO_TASK_PREFIX}${kind}`,
      conversationId: opts.conversationId,
      workspaceRoot: opts.workspaceRoot,
      params: {
        project_id: projectId,
        video_kind: kind,
        video_status: 'queued',
        checkpoint: {},
        retry_of: opts.retryOf,
      },
    })
    this.activeJobs.add(task.id)
    this.options.tasks.start(task.id, async taskContext => {
      try {
        await this.setJobStage(task.id, 'preparing')
        let assetGate = this.gateAssets(this.env, requiredAssets)
        while (assetGate) {
          const message = typeof assetGate.message === 'string' ? assetGate.message : '所需组件正在后台准备'
          const progress = typeof assetGate.asset_progress === 'number' ? assetGate.asset_progress : 0
          await this.setJobStage(task.id, 'blocked', { checkpoint: assetGate, retryable: true, warnings: [message] })
          await taskContext.progress(Math.max(1, Math.min(99, progress)), message)
          await delayWithSignal(750, taskContext.signal)
          assetGate = this.gateAssets(this.env, requiredAssets)
        }
        await this.setJobStage(task.id, 'preparing', { checkpoint: { phase: 'assets_ready' }, retryable: false, warnings: [] })
        return await runner({ taskId: task.id, runner: taskContext })
      } catch (error) {
        if (taskContext.signal.aborted) await this.setJobStage(task.id, 'cancelled', { retryable: true })
        else await this.setJobStage(task.id, 'error', { retryable: true, error_code: error instanceof VideoProjectError ? error.code : 'video_job_failed' })
        throw error
      } finally {
        this.activeJobs.delete(task.id)
      }
    })
    return { job_id: task.id, project_id: projectId }
  }

  private async setJobStage(id: string, status: JobStatus, patch: Record<string, unknown> = {}) {
    const task = await this.options.tasks.get(id)
    if (!task) return
    await this.options.tasks.touch(id, { params: { ...params(task), ...patch, video_status: status } })
  }
}
