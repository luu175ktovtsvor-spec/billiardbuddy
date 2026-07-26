import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mediaApiMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  listDeletions: vi.fn(),
  restoreProject: vi.fn(),
  getProject: vi.fn(),
  getTask: vi.fn(),
  waitForProjectEvents: vi.fn(),
  getToolchain: vi.fn(),
  createVideoProject: vi.fn(),
  addVideoSource: vi.fn(),
  updateVideoTimeline: vi.fn(),
  selectVideoTimelineVersion: vi.fn(),
  analyzeVideo: vi.fn(),
  lockVideoScene: vi.fn(),
  applyVideoAlternative: vi.fn(),
  previewVideo: vi.fn(),
  renderVideo: vi.fn(),
  cancelTask: vi.fn(),
  deleteProject: vi.fn(),
  sourceUrl: vi.fn(() => 'http://127.0.0.1/source.mp4'),
  assetUrl: vi.fn(() => 'http://127.0.0.1/preview.mp4'),
}))
const voiceApiMock = vi.hoisted(() => ({
  listEvidence: vi.fn(),
  transcribe: vi.fn(),
  revise: vi.fn(),
  bind: vi.fn(),
}))

vi.mock('../../api/media', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/media')>()),
  mediaApi: mediaApiMock,
}))
vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({
    dialogs: { open: vi.fn(), save: vi.fn() },
    shell: { openPath: vi.fn() },
  }),
}))
vi.mock('../../product/api/voice', () => ({ productVoiceApi: voiceApiMock }))

import type { MediaTask, VideoStudioProject } from '../../api/media'
import { useMediaWorkbenchStore } from '../../stores/mediaWorkbenchStore'
import { VideoStudio } from './VideoStudio'

const project: VideoStudioProject = {
  schema_version: 1,
  id: 'vid_project01',
  kind: 'video',
  title: '测试视频',
  revision: 1,
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:01:00.000Z',
  state: 'rendering',
  sources: [],
  timeline: [],
  evidence: [],
  timeline_versions: [],
  alternatives: [],
  output: { width: 1080, height: 1920, fps: 30 },
  task_id: 'task_render001',
  output_path: '/tmp/final.mp4',
}

const task: MediaTask = {
  schema_version: 1,
  id: 'task_render001',
  project_id: project.id,
  kind: 'video.render',
  status: 'committing',
  status_sequence: 3,
  progress: 95,
  stage: '正在完成导出',
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:01:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mediaApiMock.listProjects.mockResolvedValue({ projects: [project] })
  mediaApiMock.listDeletions.mockResolvedValue({ deletions: [] })
  mediaApiMock.getTask.mockResolvedValue({ task })
  mediaApiMock.waitForProjectEvents.mockImplementation((_projectId, _cursor, signal: AbortSignal) => (
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
  ))
  mediaApiMock.getToolchain.mockResolvedValue({
    ffmpeg: { available: true },
    ffprobe: { available: true },
  })
  voiceApiMock.listEvidence.mockResolvedValue([])
  useMediaWorkbenchStore.setState({
    imageProjects: [],
    videoProjects: [project],
    deletions: [],
    tasks: { [task.id]: task },
    toolchain: null,
    activeImageId: null,
    activeVideoId: project.id,
    loading: false,
    error: null,
  })
})

describe('VideoStudio committing state', () => {
  it('keeps the editor locked without presenting a cancel action that the server rejects', async () => {
    render(<VideoStudio />)
    await waitFor(() => expect(screen.getByText('正在导出')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '取消导出' })).not.toBeInTheDocument()
  })

  it('renders a stable product error instead of persisted process output', async () => {
    const rawDetail = 'ffmpeg stderr /private/Movies/source.mp4 token=private-token'
    mediaApiMock.listProjects.mockResolvedValue({
      projects: [{
        ...project,
        state: 'failed',
        error: rawDetail,
        error_code: 'MEDIA_VIDEO_EXPORT_FAILED',
      }],
    })
    render(<VideoStudio />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('视频导出失败，请检查素材和导出位置后重试。')
    expect(alert).not.toHaveTextContent(rawDetail)
  })

  it('shows the persisted metadata and hash proof for a verified export', async () => {
    const complete: VideoStudioProject = {
      ...project,
      state: 'complete',
      task_id: undefined,
      output_verification: {
        timeline_version_id: 'timeline_export01',
        byte_size: 2_621_440,
        duration_ms: 12_500,
        video_stream_count: 1,
        audio_stream_count: 1,
        width: 1080,
        height: 1920,
        fps: 30,
        content_hash: `sha256:${'c'.repeat(64)}`,
        verified_at: project.updated_at,
      },
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [complete] })
    useMediaWorkbenchStore.setState({ videoProjects: [complete], tasks: {}, activeVideoId: complete.id })

    render(<VideoStudio />)

    expect(await screen.findByText('导出已通过本机校验')).toBeInTheDocument()
    expect(screen.getByText('12.50 秒')).toBeInTheDocument()
    expect(screen.getByText('2.5 MB')).toBeInTheDocument()
    expect(screen.getByText('1 视频 / 1 音频')).toBeInTheDocument()
    expect(screen.getByText('1080×1920 · 30 fps')).toBeInTheDocument()
    expect(screen.getByTitle(`sha256:${'c'.repeat(64)}`)).toBeInTheDocument()
  })

  it('can add the same source again and split clips before saving the timeline', async () => {
    const editable: VideoStudioProject = {
      ...project,
      state: 'ready',
      task_id: undefined,
      output_path: undefined,
      sources: [{
        id: 'src_video001',
        name: 'source.mp4',
        duration_ms: 10_000,
        width: 1920,
        height: 1080,
        fps: 30,
        has_audio: true,
        rotation: 0,
        video_stream_count: 1,
        audio_stream_count: 1,
        missing: false,
      }],
      timeline: [{
        id: 'clip_video01',
        source_id: 'src_video001',
        in_ms: 0,
        out_ms: 10_000,
      }],
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [editable] })
    mediaApiMock.updateVideoTimeline.mockImplementation(async (_projectId, input) => ({
      project: { ...editable, revision: 2, timeline: input.clips },
    }))
    useMediaWorkbenchStore.setState({
      videoProjects: [editable],
      tasks: {},
      activeVideoId: editable.id,
      toolchain: {
        ffmpeg: { available: true },
        ffprobe: { available: true },
      },
    })

    render(<VideoStudio />)
    fireEvent.click(await screen.findByRole('button', { name: '将 source.mp4 加入时间线' }))
    const splitButtons = screen.getAllByRole('button', { name: '拆分片段' })
    fireEvent.click(splitButtons[0]!)
    fireEvent.click(screen.getByRole('button', { name: '保存' }))

    await waitFor(() => {
      expect(mediaApiMock.updateVideoTimeline).toHaveBeenCalledWith(
        editable.id,
        expect.objectContaining({ clips: expect.any(Array) }),
      )
    })
    const saved = mediaApiMock.updateVideoTimeline.mock.calls[0]?.[1]
    expect(saved.clips).toHaveLength(3)
    expect(saved.clips[0]).toMatchObject({ in_ms: 0, out_ms: 5_000 })
    expect(saved.clips[1]).toMatchObject({ in_ms: 5_000, out_ms: 10_000 })
  })

  it('preserves unsaved edits across task refreshes and blocks export while preview is running', async () => {
    const editable: VideoStudioProject = {
      ...project,
      state: 'ready',
      task_id: undefined,
      output_path: undefined,
      revision: 3,
      sources: [{
        id: 'src_video001',
        name: 'source.mp4',
        duration_ms: 10_000,
        width: 1920,
        height: 1080,
        fps: 30,
        has_audio: true,
        rotation: 0,
        video_stream_count: 1,
        audio_stream_count: 1,
        missing: false,
      }],
      timeline: [{
        id: 'clip_video01',
        source_id: 'src_video001',
        in_ms: 0,
        out_ms: 10_000,
      }],
      timeline_versions: [{
        id: 'timeline_current1',
        project_revision: 3,
        evidence_revision: `sha256:${'a'.repeat(64)}`,
        created_at: project.updated_at,
        scenes: [{
          id: 'clip_video01',
          source_id: 'src_video001',
          in_ms: 0,
          out_ms: 10_000,
          story_role: 'hook',
          evidence_ids: [],
          rationale: '用户时间线',
          needs_review: false,
          locked: false,
        }],
      }],
      current_timeline_version_id: 'timeline_current1',
      preview_task_id: 'task_preview01',
    }
    const previewTask: MediaTask = {
      ...task,
      id: 'task_preview01',
      project_id: editable.id,
      kind: 'video.preview',
      status: 'running',
      progress: 50,
      stage: '正在生成预览',
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [editable] })
    mediaApiMock.getTask.mockResolvedValue({ task: previewTask })
    mediaApiMock.updateVideoTimeline.mockImplementation(async (_projectId, input) => ({
      project: { ...editable, revision: 4, timeline: input.clips },
    }))
    useMediaWorkbenchStore.setState({
      videoProjects: [editable],
      tasks: { [previewTask.id]: previewTask },
      activeVideoId: editable.id,
      toolchain: { ffmpeg: { available: true }, ffprobe: { available: true } },
    })

    render(<VideoStudio />)
    const goal = await screen.findByLabelText('剪辑目标')
    fireEvent.change(goal, { target: { value: '保留我正在输入的目标' } })
    fireEvent.click(screen.getByRole('button', { name: '将 source.mp4 加入时间线' }))
    expect(screen.getByRole('button', { name: '导出视频' })).toBeDisabled()

    act(() => {
      useMediaWorkbenchStore.setState({
        videoProjects: [{ ...editable, updated_at: '2026-07-26T00:02:00.000Z' }],
      })
    })

    expect(goal).toHaveValue('保留我正在输入的目标')
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(mediaApiMock.updateVideoTimeline).toHaveBeenCalledWith(
      editable.id,
      expect.objectContaining({ clips: expect.arrayContaining([
        expect.objectContaining({ id: 'clip_video01' }),
      ]) }),
    ))
    expect(mediaApiMock.updateVideoTimeline.mock.calls[0]?.[1].clips).toHaveLength(2)
  })

  it('shows evidence-based plans and exposes analyze, lock, and alternative operations', async () => {
    const planned: VideoStudioProject = {
      ...project,
      state: 'ready',
      task_id: undefined,
      output_path: undefined,
      revision: 4,
      sources: [{
        id: 'src_video001', name: 'source.mp4', duration_ms: 10_000,
        width: 1920, height: 1080, fps: 30, has_audio: false,
        fingerprint: `sha256:${'a'.repeat(64)}`, rotation: 0,
        video_stream_count: 1, audio_stream_count: 0, missing: false,
      }],
      evidence: [{
        id: 'evidence_video01', kind: 'visual', source_id: 'src_video001',
        source_fingerprint: `sha256:${'a'.repeat(64)}`, in_ms: 0, out_ms: 5_000,
        text: '人物完成击球', confidence: 0.9, warnings: [], created_at: project.updated_at,
      }],
      evidence_revision: `sha256:${'b'.repeat(64)}`,
      timeline: [{ id: 'scene_video001', source_id: 'src_video001', in_ms: 0, out_ms: 5_000 }],
      timeline_versions: [{
        id: 'timeline_video01', project_revision: 4,
        evidence_revision: `sha256:${'b'.repeat(64)}`, created_at: project.updated_at,
        scenes: [{
          id: 'scene_video001', source_id: 'src_video001', in_ms: 0, out_ms: 5_000,
          story_role: 'hook', evidence_ids: ['evidence_video01'], rationale: '动作开场',
          needs_review: false, locked: false,
        }],
      }],
      current_timeline_version_id: 'timeline_video01',
      brief: {
        schema_version: 1, user_goal: '突出进球瞬间', content_type: '活动短片',
        output_channel: '竖屏社交媒体', must_preserve_text: [], recommended_direction: '先结果后过程',
        rationale: ['画面证据支持'], gaps: [], compiler_version: 'video-brief-v1',
      },
      alternatives: [{
        id: 'alternative_video01', base_timeline_version_id: 'timeline_video01',
        label: '过程优先', tradeoff: '信息更完整但开头较慢',
        scenes: [{
          id: 'scene_alt0001', source_id: 'src_video001', in_ms: 0, out_ms: 5_000,
          story_role: 'context', evidence_ids: ['evidence_video01'], rationale: '先交代过程',
          needs_review: false, locked: false,
        }],
      }],
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [planned] })
    mediaApiMock.analyzeVideo.mockResolvedValue({ task: { ...task, id: 'task_analyze01', kind: 'video.analyze', status: 'running' } })
    mediaApiMock.lockVideoScene.mockResolvedValue({ project: planned })
    mediaApiMock.applyVideoAlternative.mockResolvedValue({ project: { ...planned, alternatives: [] } })
    useMediaWorkbenchStore.setState({
      videoProjects: [planned], tasks: {}, activeVideoId: planned.id,
      toolchain: { ffmpeg: { available: true }, ffprobe: { available: true } },
    })

    render(<VideoStudio />)
    expect(await screen.findByText('先结果后过程')).toBeInTheDocument()
    expect(screen.getByText(/已核验 1 条 Evidence/)).toBeInTheDocument()
    fireEvent.click(screen.getByText(/画面理解 · 0.00–5.00s · 90%/))
    expect(screen.getByText('人物完成击球')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /来源：source\.mp4 · 指纹 aaaaaaaa/ })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '锁定场景' }))
    await waitFor(() => expect(mediaApiMock.lockVideoScene).toHaveBeenCalledWith(
      planned.id,
      'scene_video001',
      expect.objectContaining({ locked: true }),
    ))
    fireEvent.click(screen.getByRole('button', { name: '采用' }))
    await waitFor(() => expect(mediaApiMock.applyVideoAlternative).toHaveBeenCalledWith(
      planned.id,
      'alternative_video01',
      expect.any(Object),
    ))
    fireEvent.click(screen.getByRole('button', { name: '重新分析并生成方案' }))
    await waitFor(() => expect(mediaApiMock.analyzeVideo).toHaveBeenCalledWith(
      planned.id,
      { base_revision: planned.revision, user_goal: '突出进球瞬间' },
    ))
  })

  it('shows a version-bound program preview separately from source playback', async () => {
    const previewed: VideoStudioProject = {
      ...project,
      state: 'ready',
      task_id: undefined,
      output_path: undefined,
      revision: 5,
      sources: [{
        id: 'src_video001', name: 'source.mp4', duration_ms: 10_000,
        width: 1920, height: 1080, fps: 30, has_audio: false,
        rotation: 0, video_stream_count: 1, audio_stream_count: 0, missing: false,
      }],
      timeline: [{ id: 'clip_video01', source_id: 'src_video001', in_ms: 0, out_ms: 5_000 }],
      timeline_versions: [{
        id: 'timeline_current1', project_revision: 5,
        evidence_revision: `sha256:${'b'.repeat(64)}`, created_at: project.updated_at,
        scenes: [{
          id: 'clip_video01', source_id: 'src_video001', in_ms: 0, out_ms: 5_000,
          story_role: 'hook', evidence_ids: [], rationale: '用户时间线', needs_review: false, locked: false,
        }],
      }],
      current_timeline_version_id: 'timeline_current1',
      preview: {
        timeline_version_id: 'timeline_previous1',
        asset_id: 'preview_asset001',
        asset_path: '/api/media/assets/vid_project01/preview_asset001.mp4',
        content_hash: `sha256:${'c'.repeat(64)}`,
        created_at: project.updated_at,
      },
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [previewed] })
    useMediaWorkbenchStore.setState({
      videoProjects: [previewed],
      tasks: {},
      activeVideoId: previewed.id,
      toolchain: { ffmpeg: { available: true }, ffprobe: { available: true } },
    })

    render(<VideoStudio />)
    fireEvent.click(await screen.findByRole('button', { name: '节目预览' }))
    await waitFor(() => expect(document.querySelector('video')).toHaveAttribute('src', 'http://127.0.0.1/preview.mp4'))
    expect(screen.getByText(/这是旧时间线的预览/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '刷新节目预览' })).toBeInTheDocument()
  })

  it('restores an immutable timeline version and keeps later editing branchable', async () => {
    const earlier = {
      id: 'timeline_earlier1',
      project_revision: 4,
      evidence_revision: `sha256:${'a'.repeat(64)}`,
      created_at: '2026-07-18T00:00:00.000Z',
      scenes: [{
        id: 'clip_video01', source_id: 'src_video001', in_ms: 0, out_ms: 4_000,
        story_role: 'hook' as const, evidence_ids: [], rationale: '较早版本', needs_review: false, locked: false,
      }],
    }
    const current = {
      id: 'timeline_current1',
      parent_version_id: earlier.id,
      project_revision: 5,
      evidence_revision: `sha256:${'b'.repeat(64)}`,
      created_at: '2026-07-18T00:01:00.000Z',
      scenes: [{
        id: 'clip_video01', source_id: 'src_video001', in_ms: 500, out_ms: 5_000,
        story_role: 'hook' as const, evidence_ids: [], rationale: '当前版本', needs_review: false, locked: false,
      }],
    }
    const editable: VideoStudioProject = {
      ...project,
      state: 'ready',
      task_id: undefined,
      output_path: undefined,
      revision: 5,
      sources: [{
        id: 'src_video001', name: 'source.mp4', duration_ms: 10_000,
        width: 1920, height: 1080, fps: 30, has_audio: false,
        rotation: 0, video_stream_count: 1, audio_stream_count: 0, missing: false,
      }],
      timeline: [{ id: 'clip_video01', source_id: 'src_video001', in_ms: 500, out_ms: 5_000 }],
      timeline_versions: [earlier, current],
      current_timeline_version_id: current.id,
    }
    const restored = {
      ...editable,
      revision: 6,
      timeline: [{ id: 'clip_video01', source_id: 'src_video001', in_ms: 0, out_ms: 4_000 }],
      current_timeline_version_id: earlier.id,
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [editable] })
    mediaApiMock.selectVideoTimelineVersion.mockResolvedValue({ project: restored })
    useMediaWorkbenchStore.setState({
      videoProjects: [editable], tasks: {}, activeVideoId: editable.id,
      toolchain: { ffmpeg: { available: true }, ffprobe: { available: true } },
    })

    render(<VideoStudio />)
    fireEvent.click(await screen.findByRole('button', { name: '撤销到父版本' }))

    await waitFor(() => expect(mediaApiMock.selectVideoTimelineVersion).toHaveBeenCalledWith(
      editable.id,
      { revision: editable.revision, version_id: earlier.id },
    ))
    expect(await screen.findByText(/恢复只切换当前版本/)).toBeInTheDocument()
  })
})
