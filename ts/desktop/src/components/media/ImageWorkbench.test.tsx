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
  startImageOperation: vi.fn(),
  commitImageVersion: vi.fn(),
  selectImageVersion: vi.fn(),
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
  size: '1024x1024',
  candidate_count: 3,
  brief: {
    schema_version: 1,
    user_request: '活动海报',
    confirmed_facts: [],
    must_preserve: [],
    may_change: ['未明确指定的视觉表现'],
    missing_information: [],
    exact_text: [],
    compiler_version: 'image-brief-v1',
  },
  references: [],
  reference_images: [],
  reference_image_count: 0,
  task_id: 'task_unknown1',
  version_history: [],
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
  it('shows provider-neutral canvas choices without model controls', async () => {
    mediaApiMock.listProjects.mockResolvedValue({ projects: [] })
    render(<ImageWorkbench />)

    const canvas = await screen.findByLabelText('画布')
    expect(canvas).toHaveValue('1024x1024')
    expect(screen.getByRole('option', { name: '2K 短视频 9:16 · 1600×2848' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '2K 电影宽屏 21:9 · 3136×1344' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '4K 短视频 9:16 · 3040×5504' })).toBeInTheDocument()
    expect(screen.queryByText('生图模型')).not.toBeInTheDocument()
  })

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
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('美国 Relay'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('ImageGeneration'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('3 个候选'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('最多保留 7 天'))
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('可能产生费用'))
    expect(mediaApiMock.submitImageProject).not.toHaveBeenCalled()

    fireEvent.click(retry)
    await waitFor(() => {
      expect(mediaApiMock.submitImageProject).toHaveBeenCalledWith(project.id, true, true)
    })
  })

  it('saves a local result through the native dialog and protected media action', async () => {
    const ready: ImageWorkbenchProject = {
      ...project,
      state: 'ready',
      task_id: undefined,
      current_version_id: 'ver_result001',
      version_history: [{
        id: 'ver_result001',
        kind: 'generated',
        asset_id: 'out_result001',
        image_path: `/api/media/assets/${project.id}/out_result001.png`,
        mime_type: 'image/png',
        text_layers: [],
        created_at: '2026-07-18T00:02:00.000Z',
      }],
      error: undefined,
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [ready] })
    render(<ImageWorkbench />)

    fireEvent.click(await screen.findByRole('button', { name: '导出当前预览' }))
    await waitFor(() => {
      expect(mediaApiMock.saveImageOutput).toHaveBeenCalledWith(ready.id, {
        version_id: 'ver_result001',
        output_path: '/tmp/saved.png',
      })
    })
  })

  it('uses persisted versions for selection, rollback, editing, upscale, and exact text controls', async () => {
    const firstVersion = {
      id: 'ver_result001',
      kind: 'generated' as const,
      asset_id: 'out_result001',
      image_path: `/api/media/assets/${project.id}/out_result001.png`,
      mime_type: 'image/png' as const,
      text_layers: [],
      created_at: '2026-07-18T00:02:00.000Z',
    }
    const secondVersion = {
      ...firstVersion,
      id: 'ver_result002',
      asset_id: 'out_result002',
      image_path: `/api/media/assets/${project.id}/out_result002.png`,
    }
    const ready: ImageWorkbenchProject = {
      ...project,
      state: 'ready',
      task_id: undefined,
      current_version_id: firstVersion.id,
      version_history: [firstVersion, secondVersion],
      error: undefined,
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [ready] })
    mediaApiMock.selectImageVersion.mockResolvedValue({
      project: { ...ready, revision: ready.revision + 1, current_version_id: secondVersion.id },
    })
    render(<ImageWorkbench />)

    expect(await screen.findByRole('button', { name: '继续编辑' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '局部重绘' })).toBeInTheDocument()
    expect(screen.getByLabelText('放大倍数')).toBeInTheDocument()
    expect(screen.getByLabelText('精确文字图层')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看版本 2' }))
    fireEvent.click(screen.getByRole('button', { name: '切换到此版本' }))
    await waitFor(() => {
      expect(mediaApiMock.selectImageVersion).toHaveBeenCalledWith(ready.id, {
        revision: ready.revision,
        version_id: secondVersion.id,
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
