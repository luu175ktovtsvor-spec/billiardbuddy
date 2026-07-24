import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mediaApiMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getTask: vi.fn(),
  getToolchain: vi.fn(),
  createVideoProject: vi.fn(),
  addVideoSource: vi.fn(),
  updateVideoTimeline: vi.fn(),
  renderVideo: vi.fn(),
  cancelTask: vi.fn(),
  deleteProject: vi.fn(),
  sourceUrl: vi.fn(() => 'http://127.0.0.1/source.mp4'),
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
  progress: 95,
  stage: '正在完成导出',
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:01:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mediaApiMock.listProjects.mockResolvedValue({ projects: [project] })
  mediaApiMock.getTask.mockResolvedValue({ task })
  mediaApiMock.getToolchain.mockResolvedValue({
    ffmpeg: { available: true },
    ffprobe: { available: true },
  })
  voiceApiMock.listEvidence.mockResolvedValue([])
  useMediaWorkbenchStore.setState({
    imageProjects: [],
    videoProjects: [project],
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
})
