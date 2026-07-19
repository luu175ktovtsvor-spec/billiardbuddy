import { render, screen, waitFor } from '@testing-library/react'
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

vi.mock('../../api/media', () => ({ mediaApi: mediaApiMock }))
vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({
    dialogs: { open: vi.fn(), save: vi.fn() },
    shell: { openPath: vi.fn() },
  }),
}))

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
})
