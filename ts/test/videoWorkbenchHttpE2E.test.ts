import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createVideoWorkbenchDomainApiHandler } from '../src/server/api/videoWorkbench.js'
import { fastVideoIdentity, videoFingerprint } from '../src/server/services/videoExecution.js'
import { VideoWorkbenchService } from '../src/server/services/videoWorkbenchService.js'
import { mediaTimeBase, rationalTime, sourceTimeRange, tickRateForTimeBase } from '../src/server/video/domain/mediaFacts/time.js'
import { MEDIA_UI_CAPABILITY_HEADER } from '../shared/contracts/media.js'

const at = '2026-08-06T00:00:00.000Z'
const capability = 'video-http-e2e-capability-0123456789abcdef'

type ScenarioStep = Readonly<{
  method: string
  path: string
  status: number
  ok: boolean
  note?: string
}>

export type VideoWorkbenchHttpE2EReport = Readonly<{
  generated_at: string
  transport: 'real-http-loopback'
  provider_mode: 'local-deterministic-facts'
  execution_mode: 'simulated-toolchain'
  fixture: string
  steps: readonly ScenarioStep[]
  assertions: Readonly<{
    project_id: string
    draft_id: string
    timeline_version_id: string
    variant_id: string
    planning_origin: 'provider' | 'local_conservative'
    toolchain: Readonly<{ ffmpeg: boolean; ffprobe: boolean }>
    preflight_status: number
    preview_status: number
    render_status: number
    output_content_hash?: string
    preflight_error?: string
  }>
  result: 'passed' | 'blocked_by_local_toolchain' | 'failed'
  failure?: string
}>

function simulatedMediaProcessRunner(command: readonly string[]) {
  if (command.includes('-version')) return Promise.resolve({ exitCode: 0, stdout: 'ffmpeg simulated 7.0', stderr: '' })
  if (command.includes('-encoders')) return Promise.resolve({ exitCode: 0, stdout: ' libx264 prores_ks ', stderr: '' })
  if (command.includes('-filters')) {
    return Promise.resolve({ exitCode: 0, stdout: ' TSC afftdn A->A\n T.. subtitles V->V\n T.. zscale V->V\n T.. tonemap V->V ', stderr: '' })
  }
  if (command.includes('-show_format') && command.includes('-show_streams')) {
    const duration = '30.000'
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({
        format: { duration, format_name: 'mov,mp4,m4a,3gp,3g2,mj2', tags: { major_brand: 'isom' } },
        streams: [
          {
            codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920, duration,
            avg_frame_rate: '30/1', pix_fmt: 'yuv420p', color_space: 'bt709', color_transfer: 'bt709',
            color_primaries: 'bt709', color_range: 'tv', sample_aspect_ratio: '1:1', display_aspect_ratio: '9:16',
          },
          { codec_type: 'audio', codec_name: 'aac', duration, sample_rate: '48000', channels: 2, channel_layout: 'stereo' },
        ],
      }),
      stderr: '',
    })
  }
  if (command.includes('-show_packets')) {
    return Promise.resolve({
      exitCode: 0,
      stdout: JSON.stringify({ packets: [
        { stream_index: 0, dts: '0' }, { stream_index: 0, dts: '90000' },
        { stream_index: 1, dts: '0' }, { stream_index: 1, dts: '48000' },
      ] }),
      stderr: '',
    })
  }
  if (command.some(part => part.includes('ebur128'))) return Promise.resolve({ exitCode: 0, stdout: '', stderr: 'I: -24.0 LUFS\nTrue peak: -3.0' })
  if (command.some(part => part.includes('blackdetect')) || command.some(part => part.includes('silencedetect'))) return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
  if (command.includes('-f') && command.includes('null')) return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
  const output = command.at(-1)
  if (output && output.startsWith('/') && output !== '-') {
    return mkdir(dirname(output), { recursive: true })
      .then(async () => await writeFile(output, 'simulated-media-output'))
      .then(() => ({ exitCode: 0, stdout: '', stderr: '' }))
  }
  return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
}

function requestSegments(url: URL): string[] {
  return url.pathname.split('/').filter(Boolean).map((part, index) => index === 0 ? 'api' : part)
}

test('项目音频资产导入只产生受管资产，不直接写入正式时间线', async () => {
  const root = await mkdtemp(join(tmpdir(), 'billiardbuddy-video-asset-api-'))
  const audioPath = join(root, 'narration.mp3')
  await writeFile(audioPath, 'narration-bytes')
  const service = new VideoWorkbenchService({ root, now: () => new Date(at), platform: 'linux', runProcess: simulatedMediaProcessRunner })
  const handler = createVideoWorkbenchDomainApiHandler(service, capability)
  const request = async (url: URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    headers.set(MEDIA_UI_CAPABILITY_HEADER, capability)
    return await handler(new Request(url, { ...init, headers }), url, requestSegments(url))
  }
  try {
    const projectUrl = new URL('http://localhost/api/videos/projects')
    const created = await request(projectUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '旁白资产 API 合同' }),
    })
    expect(created.status).toBe(201)
    const projectId = String((await created.json() as { project: { id: string } }).project.id)
    const assetUrl = new URL(`http://localhost/api/videos/projects/${projectId}/assets`)
    const imported = await request(assetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: audioPath,
        asset_kind: 'voice_over',
        provenance: 'user_import',
        license_attestation: '用户自有录音，允许本项目使用',
      }),
    })
    expect(imported.status).toBe(201)
    const body = await imported.json() as { asset: { id: string; asset_kind: string; content_hash: string; mime_type: string }; project: { project_assets: Array<{ id: string }>; current_editorial_timeline_version_id?: string } }
    expect(body.asset).toMatchObject({ asset_kind: 'voice_over', mime_type: 'audio/mpeg' })
    expect(body.asset.content_hash).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(body.project.project_assets).toEqual(expect.arrayContaining([expect.objectContaining({ id: body.asset.id })]))
    expect(body.project.current_editorial_timeline_version_id).toBeUndefined()
    const replay = await request(assetUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: audioPath,
        asset_kind: 'voice_over',
        provenance: 'user_import',
        license_attestation: '用户自有录音，允许本项目使用',
      }),
    })
    expect(replay.status).toBe(200)
    expect((await replay.json() as { reused: boolean }).reused).toBe(true)
  } finally {
    service.repository.close()
    await rm(root, { recursive: true, force: true })
  }
})

function defaultAudioTrack(durationMs: number) {
  return {
    stream_index: 1,
    time_base: mediaTimeBase(1, 48_000),
    start_time: rationalTime('0', { num: 48_000, den: 1 }),
    duration: rationalTime(String(durationMs * 48), { num: 48_000, den: 1 }),
    codec: 'aac',
    sample_rate: 48_000,
    channels: 2,
    disposition_default: true,
  }
}

function sdrVideoColor() {
  return {
    color_space: 'bt709',
    color_transfer: 'bt709',
    color_primaries: 'bt709',
    color_range: 'tv',
    pixel_format: 'yuv420p',
    hdr_kind: 'sdr' as const,
  }
}

function jsonText(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

async function writeReport(path: string | undefined, report: VideoWorkbenchHttpE2EReport): Promise<void> {
  if (!path) return
  const markdown = [
    '# Video Workbench 真实 HTTP 端到端演练',
    '',
    `- 生成时间：${report.generated_at}`,
    `- 传输：${report.transport}`,
    `- Provider 模式：${report.provider_mode}`,
    `- 执行模式：${report.execution_mode}`,
    `- 本地素材：${report.fixture}`,
    `- 结果：${report.result}`,
    '',
    '## 链路步骤',
    '',
    '| 方法 | 路径 | HTTP | 结果 | 说明 |',
    '| --- | --- | ---: | --- | --- |',
    ...report.steps.map(step => `| ${step.method} | \`${step.path}\` | ${step.status} | ${step.ok ? '通过' : '失败'} | ${step.note ?? ''} |`),
    '',
    '## 核心断言',
    '',
    '```json',
    jsonText(report.assertions),
    '```',
    '',
    '## 边界说明',
    '',
    '- 这次使用真实 loopback HTTP 请求，实际经过视频 API 路由、JSON 校验、SQLite Project/Operation/Event 写入和恢复投影。',
    '- 为避免未经确认的付费云调用，Provider 使用本地确定性媒体事实；没有访问 DashScope、OSS 或公网 Relay。',
    '- FFmpeg/FFprobe 使用受控的确定性模拟执行器，仍经过真实预检、预览、输出校验和发布状态机；这不等同于生产机编解码 smoke。',
    '- 如果本机没有 ffmpeg/ffprobe，预检必须失败关闭；这不是伪造“渲染成功”，而是生产前置条件缺失的真实结果。',
    report.failure ? `- 失败信息：${report.failure}` : '',
    '',
  ].filter(Boolean).join('\n')
  await Bun.write(path, markdown)
}

/** Runs a real loopback HTTP project journey. The only direct repository write
 * is fixture setup after project creation; every user-facing mutation below
 * goes through fetch() and the public video API. */
export async function runVideoWorkbenchHttpE2E(reportPath = process.env.VIDEO_E2E_REPORT_PATH): Promise<VideoWorkbenchHttpE2EReport> {
  const root = await mkdtemp(join(tmpdir(), 'billiardbuddy-video-http-e2e-'))
  const fixture = join(import.meta.dir, '../../website/public/luma-product-film-v1.mp4')
  const steps: ScenarioStep[] = []
  let server: { port: number; stop(closeActiveConnections?: boolean): void } | undefined
  let service: VideoWorkbenchService | undefined
  let projectId = ''
  let draftId = ''
  let timelineVersionId = ''
  let variantId = ''
  let toolchain = { ffmpeg: false, ffprobe: false }
  let preflightStatus = 0
  let previewStatus = 0
  let renderStatus = 0
  let planningOrigin: 'provider' | 'local_conservative' = 'local_conservative'
  let outputContentHash: string | undefined
  let preflightError: string | undefined
  let failure: string | undefined

  const record = (method: string, path: string, status: number, ok: boolean, note?: string) => {
    steps.push({ method, path, status, ok, ...(note ? { note } : {}) })
  }
  const markLastExpected = (note: string) => {
    const index = steps.length - 1
    const last = steps[index]
    if (last) steps[index] = { ...last, ok: true, note }
  }

  try {
    service = new VideoWorkbenchService({ root, now: () => new Date(at), platform: 'linux', runProcess: simulatedMediaProcessRunner })
    const handler = createVideoWorkbenchDomainApiHandler(service, capability)
    server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: async request => {
        const url = new URL(request.url)
        return await handler(request, url, requestSegments(url))
      },
    })
    const base = `http://127.0.0.1:${server.port}`

    const requestJson = async (method: string, path: string, body?: unknown, idempotencyKey?: string, shouldRecord = true) => {
      const headers = new Headers({ [MEDIA_UI_CAPABILITY_HEADER]: capability })
      if (body !== undefined) headers.set('Content-Type', 'application/json')
      if (idempotencyKey) headers.set('Idempotency-Key', idempotencyKey)
      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      let json: unknown = undefined
      try { json = text ? JSON.parse(text) : undefined } catch { /* binary or malformed error body */ }
      const errorBody = typeof json === 'object' && json ? json as { error?: unknown; message?: unknown } : undefined
      if (shouldRecord) record(method, path, response.status, response.ok, errorBody?.error
        ? [String(errorBody.error), errorBody.message ? String(errorBody.message) : ''].filter(Boolean).join(': ')
        : response.ok ? undefined : text.slice(0, 300))
      return { response, json }
    }

    const createdResponse = await requestJson('POST', '/api/videos/projects', { title: '真实 HTTP 编排演练' })
    expect(createdResponse.response.status).toBe(201)
    projectId = String((createdResponse.json as { project?: { id?: string } }).project?.id ?? '')
    expect(projectId).toMatch(/^vid_/)

    const sourceId = 'src_http_00000001'
    const fingerprint = await videoFingerprint(fixture)
    const identity = await fastVideoIdentity(fixture)
    const timeBase = mediaTimeBase(1, 1000)
    const tickRate = tickRateForTimeBase(timeBase)
    await service.repository.saveFact({
      id: sourceId,
      project_id: projectId,
      path: fixture,
      name: 'luma-product-film-v1.mp4',
      fast_identity: identity,
      fingerprint,
      fingerprint_state: 'ready',
      primary_video_stream: {
        stream_index: 0,
        time_base: timeBase,
        start_time: rationalTime('0', tickRate),
        duration: rationalTime('30000', tickRate),
        codec: 'h264',
        width: 1920,
        height: 1080,
        rotation: 0,
        ...sdrVideoColor(),
        variable_frame_rate: false,
      },
      presentation_duration: rationalTime('30000', tickRate),
      audio_tracks: [defaultAudioTrack(30_000)],
      video_stream_count: 1,
      state: 'ready',
      created_at: at,
      updated_at: at,
    })
    await service.repository.saveProject({
      ...await service.getProject(projectId),
      state: 'ready',
      revision: 1,
      sources: [{
        id: sourceId,
        path: fixture,
        name: 'luma-product-film-v1.mp4',
        duration_ms: 30_000,
        width: 1920,
        height: 1080,
        fps: 30,
        has_audio: true,
        fingerprint,
        rotation: 0,
        video_stream_count: 1,
        audio_stream_count: 1,
        missing: false,
        content_changed: false,
      }],
    })
    const segments = [
      { id: 'segment_http_open', start: '0', text: '普通开场和场地介绍', kind: 'visual' as const },
      { id: 'segment_http_action', start: '10000', text: '关键进球，母球和目标球同时入袋', kind: 'action' as const },
      { id: 'segment_http_result', start: '20000', text: '比赛结果和选手庆祝', kind: 'visual' as const },
    ]
    for (const segment of segments) {
      const range = sourceTimeRange(rationalTime(segment.start, tickRate), rationalTime('10000', tickRate))
      await service.repository.saveFact({
        id: segment.id,
        project_id: projectId,
        source_id: sourceId,
        source_fingerprint: fingerprint,
        range,
        camera_shot_ids: [],
        segmentation_source: 'manual',
        created_at: at,
      })
      await service.repository.saveFact({
        id: `evidence_${segment.id}`,
        project_id: projectId,
        source_id: sourceId,
        source_fingerprint: fingerprint,
        content_segment_id: segment.id,
        range,
        derivative_ids: [],
        confidence: segment.kind === 'action' ? 0.95 : 0.6,
        facts_schema_version: 1,
        prompt_version: 'http-e2e-local-v1',
        basis_hash: fingerprint,
        created_at: at,
        ...(segment.kind === 'action'
          ? { kind: 'action' as const, payload: { label: segment.text, phase: 'complete' as const } }
          : { kind: 'visual' as const, payload: { summary: segment.text, subjects: [], warnings: [] } }),
      })
    }
    const compactEvidence = segments.map((segment, index) => ({
      id: `evidence_projection_${String(index + 1).padStart(8, '0')}`,
      kind: 'source_role' as const,
      source_id: sourceId,
      source_fingerprint: fingerprint,
      in_ms: Number(segment.start),
      out_ms: Number(segment.start) + 10_000,
      text: segment.text,
      confidence: segment.kind === 'action' ? 0.95 : 0.6,
      warnings: [],
      created_at: at,
    }))
    await service.repository.saveProject({
      ...await service.getProject(projectId),
      evidence: compactEvidence,
      revision: (await service.getProject(projectId)).revision + 1,
      updated_at: at,
    })

    const sourceResponse = await fetch(`${base}/api/videos/projects/${projectId}/sources/${sourceId}/content`, { headers: { Range: 'bytes=0-31' } })
    const sourceBytes = new Uint8Array(await sourceResponse.arrayBuffer())
    record('GET', `/api/videos/projects/${projectId}/sources/${sourceId}/content`, sourceResponse.status, sourceResponse.ok && sourceBytes.byteLength > 0, `读取 ${sourceBytes.byteLength} bytes`)
    expect(sourceResponse.ok).toBeTrue()
    expect(sourceBytes.byteLength).toBeGreaterThan(0)

    const projects = await requestJson('GET', '/api/videos/projects')
    expect(projects.response.status).toBe(200)
    const workspaceBefore = await requestJson('GET', `/api/videos/projects/${projectId}/workspace?event_cursor=0`)
    expect(workspaceBefore.response.status).toBe(200)

    let project = await service.getProject(projectId)
    const brief = await requestJson('PUT', `/api/videos/projects/${projectId}/creation-brief`, {
      base_revision: project.revision,
      use_case: 'sports_highlight',
      user_request: '做一条竖屏短片，开头先放最精彩的一杆，保留关键过程并配中文字幕。',
      audience: '第一次看台球视频的观众',
      distribution: 'vertical_short',
      tone: 'energetic',
      pace: 'fast',
      caption_preference: 'burn_in',
      hook_strategy: 'strongest_moment',
      story_structure: 'highlight_reel',
      selection_focus: 'action',
      must_preserve: ['关键进球'],
    })
    expect(brief.response.status).toBe(200)

    project = await service.getProject(projectId)
    const intent = await requestJson('PUT', `/api/videos/projects/${projectId}/delivery-intent`, {
      base_revision: project.revision,
      goal: '优先保留关键进球，生成一条 15 秒高光。',
      duration_mode: 'target',
      target_duration: rationalTime('15', { num: 1, den: 1 }),
      coverage_preference: 'highlights',
      editing_strategy: 'highlights',
    })
    expect(intent.response.status).toBe(200)

    const session = await requestJson('POST', `/api/videos/projects/${projectId}/creative-sessions`, {
      title: '高光剪辑建议会话',
    }, 'http-e2e-session-0001')
    expect(session.response.status).toBe(201)
    const sessionId = String((session.json as { session?: { id?: string } }).session?.id ?? '')
    expect(sessionId).toMatch(/^creative_session_/)

    project = await service.getProject(projectId)
    const suggestionInput = {
      base_revision: project.revision,
      user_goal: '做一条竖屏短片，开头先放最精彩的一杆，保留关键过程并配中文字幕。',
      brief: {
        use_case: 'sports_highlight' as const,
        audience: '第一次看台球视频的观众',
        distribution: 'vertical_short' as const,
        tone: 'energetic' as const,
        pace: 'fast' as const,
        caption_preference: 'burn_in' as const,
        hook_strategy: 'strongest_moment' as const,
        story_structure: 'highlight_reel' as const,
        selection_focus: 'action' as const,
        must_preserve: ['关键进球'],
      },
      planning: {
        target_duration_seconds: 15.5,
        coverage_preference: 'highlights' as const,
        editing_strategy: 'highlights' as const,
      },
      creative_direction: {
        narrative_voice: 'cinematic',
        emotional_arc: 'tension_release',
        audio_mode: 'narration_after_review',
        voiceover_persona: 'calm_guide',
        caption_strategy: 'spoken_rhythm',
        keep_natural_pauses: true,
        human_notes: '先保留现场声音，再由用户审核旁白脚本。',
      },
    }
    const analyze = await requestJson('POST', `/api/videos/projects/${projectId}/creative-sessions/${sessionId}/suggest`, suggestionInput, 'http-e2e-suggest-0001')
    expect(analyze.response.status).toBe(202)
    const analyzeTaskId = String((analyze.json as { task?: { id?: string } }).task?.id ?? '')
    expect(analyzeTaskId).toMatch(/^task_/)
    expect((analyze.json as { task?: { result?: { creative_session_id?: string } } }).task?.result?.creative_session_id).toBe(sessionId)
    const replay = await requestJson('POST', `/api/videos/projects/${projectId}/creative-sessions/${sessionId}/suggest`, suggestionInput, 'http-e2e-suggest-0001')
    expect(replay.response.status).toBe(202)
    expect((replay.json as { task?: { id?: string } }).task?.id).toBe(analyzeTaskId)
    const conflict = await requestJson('POST', `/api/videos/projects/${projectId}/creative-sessions/${sessionId}/suggest`, {
      ...suggestionInput,
      user_goal: '换一个完全不同的创作目标。',
    }, 'http-e2e-suggest-0001')
    expect(conflict.response.status).toBe(409)

    let analyzedWorkspace: any
    let analyzedPlanTask: any
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const currentWorkspace = await requestJson('GET', `/api/videos/projects/${projectId}/workspace?event_cursor=0`, undefined, undefined, false)
      analyzedWorkspace = currentWorkspace.json
      const operations = (analyzedWorkspace?.operations ?? []) as Array<{ kind: string; status: string; result?: Record<string, unknown> }>
      analyzedPlanTask = operations.find(candidate => candidate.kind === 'video.plan')
      if (analyzedPlanTask && ['succeeded', 'failed', 'cancelled'].includes(analyzedPlanTask.status)) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    expect(analyzedPlanTask?.status).toBe('succeeded')
    expect(analyzedWorkspace?.project?.task_id).toBeUndefined()
    const analyzedDrafts = (analyzedWorkspace?.timeline_drafts ?? []) as Array<{ id: string; planning_origin?: string; items: Array<{ id: string }> }>
    draftId = analyzedDrafts[0]?.id ?? ''
    expect(draftId).toMatch(/^draft_/)
    planningOrigin = analyzedDrafts[0]?.planning_origin === 'provider' ? 'provider' : 'local_conservative'
    expect(planningOrigin).toBe('local_conservative')
    expect(analyzedPlanTask?.result?.planning_origin).toBe('local_conservative')
    expect(analyzedPlanTask?.result?.workflow).toMatchObject({
      phase: 'awaiting_confirmation',
      completed_units: 4,
      total_units: 4,
      next_action: 'review_suggestions',
      interpreted_goal: '做一条竖屏短片，开头先放最精彩的一杆，保留关键过程并配中文字幕。',
    })
    expect(analyzedWorkspace?.project?.creation_brief?.creative_direction).toMatchObject({
      narrative_voice: 'cinematic',
      emotional_arc: 'tension_release',
      audio_mode: 'narration_after_review',
      voiceover_persona: 'calm_guide',
      caption_strategy: 'spoken_rhythm',
      keep_natural_pauses: true,
      human_notes: '先保留现场声音，再由用户审核旁白脚本。',
    })
    expect(analyzedWorkspace?.project?.creation_brief).toMatchObject({
      use_case: 'sports_highlight',
      audience: '第一次看台球视频的观众',
      distribution: 'vertical_short',
      story_structure: 'highlight_reel',
      selection_focus: 'action',
      must_preserve: ['关键进球'],
    })
    expect(analyzedWorkspace?.project?.delivery_intent).toMatchObject({
      duration_mode: 'target',
      // The user supplied 15.5s planning hint is intentionally ignored here:
      // this project already has an explicitly saved DeliveryIntent at 15s.
      target_duration: { ticks: '15', tick_rate: { num: 1, den: 1 } },
      coverage_preference: 'highlights',
      editing_strategy: 'highlights',
    })

    const workspaceAfterPlan = await requestJson('GET', `/api/videos/projects/${projectId}/workspace?event_cursor=0`)
    expect(workspaceAfterPlan.response.status).toBe(200)
    const events = await requestJson('GET', `/api/videos/projects/${projectId}/events?cursor=0&limit=200&wait_ms=0`)
    expect(events.response.status).toBe(200)
    const eventRows = (events.json as { events?: Array<{ task?: { id?: string; kind?: string; status?: string } }> }).events ?? []
    expect(eventRows.some(event => event.task?.id === analyzeTaskId && event.task.status === 'succeeded')).toBeTrue()
    expect(eventRows.some(event => event.task?.kind === 'video.plan' && event.task.status === 'succeeded')).toBeTrue()

    project = await service.getProject(projectId)
    const accept = await requestJson('POST', `/api/videos/projects/${projectId}/timeline-drafts/${draftId}/accept`, {
      base_timeline_version_id: project.current_editorial_timeline_version_id,
    }, 'http-e2e-accept-0001')
    expect(accept.response.status).toBe(200)
    const acceptedBody = accept.json as { timeline?: { id: string; items: Array<{ id: string }> } }
    timelineVersionId = acceptedBody.timeline?.id ?? ''
    expect(timelineVersionId).toMatch(/^editorial_timeline_/)

    const timelineItems = acceptedBody.timeline?.items ?? []
    if (timelineItems.length > 0) {
      const command = await requestJson('POST', `/api/videos/projects/${projectId}/timelines/${timelineVersionId}/commands`, {
        commands: [{ kind: 'lock', item_ids: [timelineItems[0]!.id], locked: true }],
      }, 'http-e2e-lock-0001')
      expect(command.response.status).toBe(200)
    }

    project = await service.getProject(projectId)
    const variant = await requestJson('POST', `/api/videos/projects/${projectId}/delivery-variants`, {
      name: 'HTTP 竖屏交付',
      editorial_timeline_version_id: project.current_editorial_timeline_version_id,
    }, 'http-e2e-variant-0001')
    expect(variant.response.status).toBe(201)
    const variantBody = variant.json as { variant?: { id: string }; version?: { id: string } }
    variantId = variantBody.variant?.id ?? ''
    expect(variantId).toMatch(/^variant_/)

    const toolchainBody = await service.toolchainStatus()
    toolchain = { ffmpeg: toolchainBody.ffmpeg.available, ffprobe: toolchainBody.ffprobe.available }

    project = await service.getProject(projectId)
    const preflight = await requestJson('POST', `/api/videos/projects/${projectId}/delivery-variants/${variantId}/preflight`, {
      base_revision: project.revision,
      base_variant_version_id: variantBody.version?.id,
    }, 'http-e2e-preflight-0001')
    preflightStatus = preflight.response.status
    if (!preflight.response.ok) preflightError = typeof preflight.json === 'object' && preflight.json && 'error' in preflight.json ? String((preflight.json as { error?: unknown }).error) : undefined
    expect(toolchain).toEqual({ ffmpeg: true, ffprobe: true })
    expect(preflight.response.status).toBe(201)

    project = await service.getProject(projectId)
    const preview = await requestJson('POST', `/api/videos/projects/${projectId}/delivery-variants/${variantId}/preview`, {
      base_revision: project.revision,
      base_variant_version_id: variantBody.version?.id,
    }, 'http-e2e-preview-0001')
    previewStatus = preview.response.status
    expect(preview.response.status).toBe(202)
    const previewTaskId = String((preview.json as { task?: { id?: string } }).task?.id ?? '')
    expect(previewTaskId).toMatch(/^task_/)

    const waitForOperation = async (operationId: string, terminalKind: string) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        const snapshotResponse = await requestJson('GET', `/api/videos/projects/${projectId}/workspace?event_cursor=0`, undefined, undefined, false)
        const snapshot = snapshotResponse.json as { operations?: Array<{ id: string; kind: string; status: string; result?: Record<string, unknown> }>; project?: { output_content_hash?: string; output_verification?: unknown } }
        const operation = snapshot.operations?.find(candidate => candidate.id === operationId)
        if (operation && ['succeeded', 'failed', 'cancelled'].includes(operation.status)) {
          expect(operation.kind).toBe(terminalKind)
          return { snapshot, operation }
        }
        await new Promise(resolve => setTimeout(resolve, 5))
      }
      throw new Error(`${terminalKind} operation ${operationId} did not settle`)
    }
    const previewResult = await waitForOperation(previewTaskId, 'video.preview')
    expect(previewResult.operation.status).toBe('succeeded')
    const previewWorkspace = await requestJson('GET', `/api/videos/projects/${projectId}/workspace?event_cursor=0`)
    expect(previewWorkspace.response.status).toBe(200)

    project = await service.getProject(projectId)
    const outputPath = join(root, 'exports', 'http-e2e-final.mp4')
    const render = await requestJson('POST', `/api/videos/projects/${projectId}/delivery-variants/${variantId}/render`, {
      base_revision: project.revision,
      base_variant_version_id: variantBody.version?.id,
      output_path: outputPath,
    }, 'http-e2e-render-0001')
    renderStatus = render.response.status
    expect(render.response.status).toBe(202)
    const renderTaskId = String((render.json as { task?: { id?: string } }).task?.id ?? '')
    expect(renderTaskId).toMatch(/^task_/)
    const renderResult = await waitForOperation(renderTaskId, 'video.render')
    expect(renderResult.operation.status).toBe('succeeded')
    outputContentHash = typeof renderResult.snapshot.project?.output_content_hash === 'string'
      ? renderResult.snapshot.project.output_content_hash
      : undefined
    expect(outputContentHash).toMatch(/^sha256:[a-f0-9]{64}$/)
    const finalWorkspace = await requestJson('GET', `/api/videos/projects/${projectId}/workspace?event_cursor=0`)
    expect(finalWorkspace.response.status).toBe(200)
    expect(finalWorkspace.json).toMatchObject({ project: { state: 'complete' }, output_verification: { decoded: true, packet_timestamps_monotonic: true } })

    const invalidFactCursor = await requestJson('GET', `/api/videos/projects/${projectId}/facts/source?cursor=%00`)
    expect(invalidFactCursor.response.status).toBe(400)
    markLastExpected('预期 400：无效 Facts cursor 被安全拒绝')
    const invalidSearchCursor = await requestJson('GET', `/api/videos/projects/${projectId}/search?q=关键&cursor=%00`)
    expect(invalidSearchCursor.response.status).toBe(400)
    markLastExpected('预期 400：无效 Search cursor 被安全拒绝')

    const report: VideoWorkbenchHttpE2EReport = {
      generated_at: new Date().toISOString(),
      transport: 'real-http-loopback',
      provider_mode: 'local-deterministic-facts',
      execution_mode: 'simulated-toolchain',
      fixture,
      steps,
      assertions: {
        project_id: projectId,
        draft_id: draftId,
        timeline_version_id: timelineVersionId,
        variant_id: variantId,
        planning_origin: planningOrigin,
        toolchain,
        preflight_status: preflightStatus,
        preview_status: previewStatus,
        render_status: renderStatus,
        ...(outputContentHash ? { output_content_hash: outputContentHash } : {}),
        ...(preflightError ? { preflight_error: preflightError } : {}),
      },
      result: !toolchain.ffmpeg || !toolchain.ffprobe ? 'blocked_by_local_toolchain' : 'passed',
    }
    await writeReport(reportPath, report)
    return report
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    const report: VideoWorkbenchHttpE2EReport = {
      generated_at: new Date().toISOString(),
      transport: 'real-http-loopback',
      provider_mode: 'local-deterministic-facts',
      execution_mode: 'simulated-toolchain',
      fixture,
      steps,
      assertions: {
        project_id: projectId,
        draft_id: draftId,
        timeline_version_id: timelineVersionId,
        variant_id: variantId,
        planning_origin: planningOrigin,
        toolchain,
        preflight_status: preflightStatus,
        preview_status: previewStatus,
        render_status: renderStatus,
        ...(outputContentHash ? { output_content_hash: outputContentHash } : {}),
        ...(preflightError ? { preflight_error: preflightError } : {}),
      },
      result: 'failed',
      failure,
    }
    await writeReport(reportPath, report)
    throw error
  } finally {
    server?.stop(true)
    service?.repository.close()
    await rm(root, { recursive: true, force: true })
  }
}

test('真实 HTTP 视频工作台从目标澄清、候选草稿、确认版本到预览和正式导出的完整旅程', async () => {
  const report = await runVideoWorkbenchHttpE2E()
  expect(report.steps.length).toBeGreaterThanOrEqual(12)
  expect(report.assertions.project_id).toMatch(/^vid_/)
  expect(report.assertions.draft_id).toMatch(/^draft_/)
  expect(report.assertions.timeline_version_id).toMatch(/^editorial_timeline_/)
  expect(report.assertions.variant_id).toMatch(/^variant_/)
})

export type VideoWorkbenchHttpLoadReport = Readonly<{
  generated_at: string
  transport: 'real-http-loopback'
  concurrency: number
  duration_ms: number
  passed: number
  failed: number
  runs: readonly Readonly<{
    index: number
    result: 'passed' | 'failed'
    project_id?: string
    output_content_hash?: string
    failure?: string
  }>[]
}>

function loadConcurrency(): number {
  const raw = process.env.VIDEO_E2E_LOAD_CONCURRENCY ?? '4'
  const value = Number(raw)
  if (!Number.isSafeInteger(value) || value < 1 || value > 16) {
    throw new Error('VIDEO_E2E_LOAD_CONCURRENCY must be an integer from 1 to 16')
  }
  return value
}

/**
 * Runs several complete user journeys concurrently through the real loopback
 * HTTP API. This is deliberately separate from the production Provider smoke:
 * it exercises project/Operation/Event concurrency and the full accept →
 * preflight → preview → render chain without pretending local deterministic
 * provider facts are a DashScope receipt.
 */
export async function runVideoWorkbenchHttpLoad(reportPath = process.env.VIDEO_E2E_LOAD_REPORT_PATH): Promise<VideoWorkbenchHttpLoadReport> {
  const concurrency = loadConcurrency()
  const startedAt = Date.now()
  const settled = await Promise.allSettled(
    Array.from({ length: concurrency }, async (_, index) => {
      const result = await runVideoWorkbenchHttpE2E('')
      return { index, result }
    }),
  )
  const runs = settled.map((entry, index) => entry.status === 'fulfilled'
    ? {
        index: entry.value.index,
        result: 'passed' as const,
        project_id: entry.value.result.assertions.project_id,
        ...(entry.value.result.assertions.output_content_hash ? { output_content_hash: entry.value.result.assertions.output_content_hash } : {}),
      }
    : {
        index,
        result: 'failed' as const,
        failure: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
      })
  const report: VideoWorkbenchHttpLoadReport = {
    generated_at: new Date().toISOString(),
    transport: 'real-http-loopback',
    concurrency,
    duration_ms: Date.now() - startedAt,
    passed: runs.filter(run => run.result === 'passed').length,
    failed: runs.filter(run => run.result === 'failed').length,
    runs,
  }
  if (reportPath) {
    await Bun.write(reportPath, [
      '# Video Workbench 并发用户旅程演练',
      '',
      `- 生成时间：${report.generated_at}`,
      `- 传输：${report.transport}`,
      `- 并发完整项目数：${report.concurrency}`,
      `- 总耗时：${report.duration_ms} ms`,
      `- 通过：${report.passed}`,
      `- 失败：${report.failed}`,
      '',
      '## 结果',
      '',
      '| 场景 | 结果 | Project | 输出 hash | 错误 |',
      '| ---: | --- | --- | --- | --- |',
      ...report.runs.map(run => `| ${run.index + 1} | ${run.result} | ${run.project_id ?? ''} | ${run.output_content_hash ?? ''} | ${run.failure ?? ''} |`),
      '',
      '## 边界说明',
      '',
      '- 每个场景都通过真实 loopback `fetch`，经过视频 API、SQLite Project/Operation/Event、Draft 接受、CommandSet、Preflight、Preview、Render 和输出校验。',
      '- Provider 仍使用本地确定性事实和受控媒体执行器；这份报告证明项目 API 的并发编排，不冒充真实 DashScope/OSS 计费结果。',
    ].join('\n'))
  }
  if (report.failed) throw new Error(`video HTTP load journey failed: ${report.failed}/${report.concurrency}`)
  return report
}

test('真实 HTTP 并发用户旅程同时完成多个项目，不共享 Project/Operation/Event 状态', async () => {
  const report = await runVideoWorkbenchHttpLoad()
  expect(report.failed).toBe(0)
  expect(report.passed).toBe(report.concurrency)
  expect(new Set(report.runs.map(run => run.project_id)).size).toBe(report.concurrency)
})
