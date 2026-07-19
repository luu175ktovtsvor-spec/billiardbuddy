import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mediaApiMock = vi.hoisted(() => ({
  listProjects: vi.fn(),
  getTask: vi.fn(),
  getToolchain: vi.fn(),
  createImageProject: vi.fn(),
  updateImageProject: vi.fn(),
  submitImageProject: vi.fn(),
  createVideoProject: vi.fn(),
  addVideoSource: vi.fn(),
  updateVideoTimeline: vi.fn(),
  renderVideo: vi.fn(),
  cancelTask: vi.fn(),
  deleteProject: vi.fn(),
  saveImageOutput: vi.fn(),
  assetUrl: vi.fn((path: string) => path),
}))

const desktopHostMock = vi.hoisted(() => ({
  save: vi.fn(),
}))

vi.mock('../../lib/desktopHost', () => ({
  getDesktopHost: () => ({ dialogs: { save: desktopHostMock.save } }),
}))

vi.mock('../../api/media', async importOriginal => ({
  ...(await importOriginal<typeof import('../../api/media')>()),
  mediaApi: mediaApiMock,
}))

import type { ImageWorkbenchProject, MediaTask } from '../../api/media'
import { useMediaWorkbenchStore } from '../../stores/mediaWorkbenchStore'
import { ImageWorkbench, imageTaskPollDelayMs } from './ImageWorkbench'

const project: ImageWorkbenchProject = {
  schema_version: 1,
  id: 'img_unknown01',
  kind: 'image',
  title: '活动海报',
  revision: 1,
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:01:00.000Z',
  state: 'failed',
  mode: 'generate',
  prompt: '活动海报',
  size: '1024x1024',
  count: 1,
  reference_images: [],
  reference_image_count: 0,
  task_id: 'task_unknown1',
  outputs: [],
  error: '上一次任务可能已经产生费用',
}

const task: MediaTask = {
  schema_version: 1,
  id: 'task_unknown1',
  project_id: project.id,
  kind: 'image.generate',
  status: 'failed',
  progress: 20,
  stage: '结果待确认',
  remote_task_id: 'remote-unknown',
  outcome_unknown: true,
  created_at: '2026-07-18T00:00:00.000Z',
  updated_at: '2026-07-18T00:01:00.000Z',
}

beforeEach(() => {
  vi.clearAllMocks()
  mediaApiMock.listProjects.mockResolvedValue({ projects: [project] })
  mediaApiMock.getTask.mockResolvedValue({ task })
  mediaApiMock.submitImageProject.mockResolvedValue({ task: { ...task, id: 'task_retry001' } })
  mediaApiMock.saveImageOutput.mockResolvedValue({ path: '/tmp/saved.png' })
  desktopHostMock.save.mockResolvedValue('/tmp/saved.png')
  useMediaWorkbenchStore.setState({
    imageProjects: [],
    videoProjects: [],
    tasks: {},
    toolchain: null,
    activeImageId: null,
    activeVideoId: null,
    loading: false,
    error: null,
  })

})

describe('ImageWorkbench unknown paid result', () => {
  it('backs queued image polls off while keeping running image polls responsive', () => {
    const queued = imageTaskPollDelayMs('task_queue001', 'queued', 30)
    const running = imageTaskPollDelayMs('task_queue001', 'generating', 3)
    expect(queued).toBeGreaterThanOrEqual(30_000)
    expect(queued).toBeLessThan(33_000)
    expect(running).toBeGreaterThanOrEqual(3_000)
    expect(running).toBeLessThan(3_300)
  })

  it('warns before creating another paid task and forwards explicit confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    render(<ImageWorkbench />)

    const retry = await screen.findByRole('button', { name: '确认后重新生成' })
    fireEvent.click(retry)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('可能再次扣费'))
    expect(mediaApiMock.submitImageProject).not.toHaveBeenCalled()

    fireEvent.click(retry)
    await waitFor(() => {
      expect(mediaApiMock.submitImageProject).toHaveBeenCalledWith(project.id, true)
    })
  })

  it('saves a local result through the native dialog and protected media action', async () => {
    const ready: ImageWorkbenchProject = {
      ...project,
      state: 'ready',
      task_id: undefined,
      outputs: [{
        id: 'out_result001',
        mime_type: 'image/png',
        asset_path: `/api/media/assets/${project.id}/out_result001.png`,
      }],
      error: undefined,
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [ready] })
    render(<ImageWorkbench />)

    fireEvent.click(await screen.findByRole('button', { name: '下载图片' }))
    await waitFor(() => {
      expect(mediaApiMock.saveImageOutput).toHaveBeenCalledWith(ready.id, {
        output_id: 'out_result001',
        output_path: '/tmp/saved.png',
      })
    })
  })

  it('renders a stable product error instead of a persisted upstream detail', async () => {
    const rawDetail = 'gateway provider rejected token=private-token for /private/source.png'
    mediaApiMock.listProjects.mockResolvedValue({
      projects: [{
        ...project,
        error: rawDetail,
        error_code: 'MEDIA_IMAGE_UNAVAILABLE',
      }],
    })
    render(<ImageWorkbench />)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('图片生成暂时不可用，请稍后重试。')
    expect(alert).not.toHaveTextContent(rawDetail)
  })
})
