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
  createImageProject: vi.fn(),
  updateImageProject: vi.fn(),
  addImageProjectReferences: vi.fn(),
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
import { ImageWorkbench } from './ImageWorkbench'

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
  brief_overrides: {},
  references: [],
  reference_images: [],
  reference_image_count: 0,
  task_id: 'task_unknown1',
  version_history: [],
  error: '上一次任务是否已被远程服务受理暂时无法确认',
}

const task: MediaTask = {
  schema_version: 1,
  id: 'task_unknown1',
  project_id: project.id,
  kind: 'image.generate',
  status: 'failed',
  status_sequence: 1,
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
  mediaApiMock.listDeletions.mockResolvedValue({ deletions: [] })
  mediaApiMock.getTask.mockResolvedValue({ task })
  mediaApiMock.waitForProjectEvents.mockImplementation((_projectId, _cursor, signal: AbortSignal) => (
    new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }))
  ))
  mediaApiMock.submitImageProject.mockResolvedValue({ task: { ...task, id: 'task_retry001' } })
  mediaApiMock.updateImageProject.mockImplementation(async (_id, input) => ({
    project: {
      ...project,
      revision: project.revision + 1,
      brief_overrides: input.brief_overrides ?? {},
    },
  }))
  mediaApiMock.saveImageOutput.mockResolvedValue({ path: '/tmp/saved.png' })
  desktopHostMock.save.mockResolvedValue('/tmp/saved.png')
  useMediaWorkbenchStore.setState({
    imageProjects: [],
    videoProjects: [],
    deletions: [],
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

  it('subscribes to the project event cursor instead of polling the task', async () => {
    render(<ImageWorkbench />)
    await waitFor(() => {
      expect(mediaApiMock.waitForProjectEvents).toHaveBeenCalledWith(project.id, 0, expect.any(AbortSignal))
    })
  })

  it('warns only before replacing an outcome-unknown operation', async () => {
    const confirm = vi.spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    render(<ImageWorkbench />)

    const retry = await screen.findByRole('button', { name: '确认后重新生成' })
    fireEvent.click(retry)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('而不是重用原提交编号查询状态'))
    expect(mediaApiMock.submitImageProject).not.toHaveBeenCalled()

    fireEvent.change(screen.getByLabelText('Brief 必须保留'), {
      target: { value: '人物五官不变\nLogo 原样保留' },
    })
    fireEvent.click(retry)
    await waitFor(() => {
      expect(mediaApiMock.updateImageProject).toHaveBeenCalledWith(project.id, expect.objectContaining({
        brief_overrides: expect.objectContaining({
          must_preserve: ['人物五官不变', 'Logo 原样保留'],
        }),
      }))
      expect(mediaApiMock.submitImageProject).toHaveBeenCalledWith(project.id, true)
    })
  })

  it('preserves an unsaved prompt when a task event refreshes the same project', async () => {
    render(<ImageWorkbench />)

    await screen.findByRole('button', { name: '确认后重新生成' })
    const prompt = screen.getByLabelText('画面需求')
    fireEvent.change(prompt, { target: { value: '保留用户尚未提交的新提示词' } })
    expect(prompt).toHaveValue('保留用户尚未提交的新提示词')

    act(() => {
      useMediaWorkbenchStore.setState(state => ({
        imageProjects: state.imageProjects.map(item => item.id === project.id
          ? { ...item, updated_at: '2026-07-18T00:02:00.000Z' }
          : item),
      }))
    })

    expect(screen.getByLabelText('画面需求')).toHaveValue('保留用户尚未提交的新提示词')
  })

  it('persists reference role changes from an editable project', async () => {
    const editable = {
      ...project,
      reference_image_count: 1,
      references: [{
        asset_id: 'ref_subject0001',
        role: 'subject' as const,
        image_path: `/api/media/images/projects/${project.id}/references/ref_subject0001/content`,
        mime_type: 'image/png' as const,
      }],
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [editable] })
    mediaApiMock.updateImageProject.mockImplementation(async (_id, input) => ({
      project: { ...editable, revision: editable.revision + 1, references: input.references },
    }))
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    render(<ImageWorkbench />)

    fireEvent.change(await screen.findByLabelText('ref_subject0001 的参考作用'), {
      target: { value: 'style' },
    })
    const addedFile = new File(['new-reference'], 'brand.png', { type: 'image/png' })
    fireEvent.change(screen.getByLabelText('添加参考图片'), { target: { files: [addedFile] } })
    fireEvent.change(await screen.findByLabelText('brand.png 的新增参考作用'), {
      target: { value: 'brand' },
    })
    fireEvent.click(screen.getByRole('button', { name: '确认后重新生成' }))
    await waitFor(() => expect(mediaApiMock.updateImageProject).toHaveBeenCalledWith(project.id, expect.objectContaining({
      references: [expect.objectContaining({ asset_id: 'ref_subject0001', role: 'style' })],
      new_reference_images: [expect.stringMatching(/^data:image\/png;base64,/)],
      new_reference_roles: ['brand'],
    })))
  })

  it('adds a new canvas reference after generation without restarting the image task', async () => {
    const ready = {
      ...project,
      state: 'ready' as const,
      task_id: undefined,
      error: undefined,
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [ready] })
    mediaApiMock.addImageProjectReferences.mockImplementation(async (_id, input) => ({
      project: {
        ...ready,
        revision: ready.revision + 1,
        reference_image_count: 1,
        references: [{
          asset_id: 'ref_logo0001',
          role: input.reference_roles[0],
          image_path: `/api/media/images/projects/${ready.id}/references/ref_logo0001/content`,
          mime_type: 'image/png',
        }],
      },
    }))
    render(<ImageWorkbench />)

    const file = new File(['new-logo'], 'logo.png', { type: 'image/png' })
    fireEvent.change(await screen.findByLabelText('添加参考图片'), { target: { files: [file] } })
    fireEvent.change(await screen.findByLabelText('logo.png 的新增参考作用'), { target: { value: 'logo' } })
    fireEvent.click(screen.getByRole('button', { name: '保存新增参考素材' }))

    await waitFor(() => expect(mediaApiMock.addImageProjectReferences).toHaveBeenCalledWith(ready.id, {
      revision: ready.revision,
      reference_images: [expect.stringMatching(/^data:image\/png;base64,/)],
      reference_roles: ['logo'],
    }))
    expect(mediaApiMock.submitImageProject).not.toHaveBeenCalled()
  })

  it('requires explicit confirmation before replacing an outcome-unknown edit operation', async () => {
    const version = {
      id: 'ver_result001',
      kind: 'generated' as const,
      asset_id: 'out_result001',
      image_path: `/api/media/assets/${project.id}/out_result001.png`,
      mime_type: 'image/png' as const,
      width: 1024,
      height: 1024,
      text_layers: [],
      image_layers: [],
      created_at: '2026-07-18T00:02:00.000Z',
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [{
      ...project,
      current_version_id: version.id,
      version_history: [version],
    }] })
    mediaApiMock.startImageOperation.mockResolvedValue({ task: { ...task, id: 'task_edit_retry001' } })
    const confirm = vi.spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
    render(<ImageWorkbench />)

    fireEvent.change(await screen.findByLabelText('图片编辑指令'), { target: { value: '只调整背景亮度' } })
    const submit = screen.getByRole('button', { name: '生成编辑版本' })
    fireEvent.click(submit)
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('新的付费操作'))
    expect(mediaApiMock.startImageOperation).not.toHaveBeenCalled()

    fireEvent.click(submit)
    await waitFor(() => expect(mediaApiMock.startImageOperation).toHaveBeenCalledWith(project.id, expect.objectContaining({
      kind: 'edit',
      confirm_unknown_retry: true,
    })))
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
        image_layers: [],
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
      width: 1024,
      height: 1024,
      text_layers: [{
        id: 'text_layer0001',
        text: '会员日',
        x: 512,
        y: 120,
        max_width: 800,
        fill: '#ffffff',
        font_family: 'PingFang SC',
        font_size: 64,
        font_weight: 'bold' as const,
        text_align: 'center' as const,
      }],
      image_layers: [],
      quality_assessment: {
        score: 92,
        summary: '主体和构图清晰',
        issues: [],
        suggestions: ['增加底部留白'],
      },
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
      reference_image_count: 1,
      references: [{
        asset_id: 'ref_subject0001',
        role: 'subject',
        image_path: `/api/media/images/projects/${project.id}/references/ref_subject0001/content`,
        mime_type: 'image/png',
      }],
      current_version_id: firstVersion.id,
      version_history: [firstVersion, secondVersion],
      error: undefined,
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [ready] })
    mediaApiMock.selectImageVersion.mockResolvedValue({
      project: { ...ready, revision: ready.revision + 1, current_version_id: secondVersion.id },
    })
    render(<ImageWorkbench />)

    expect(await screen.findByTestId('image-canvas-surface')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择文字图层 会员日' })).toBeInTheDocument()
    expect(screen.getByRole('img', { name: '主体参考图' })).toHaveAttribute(
      'src',
      `/api/media/images/projects/${project.id}/references/ref_subject0001/content`,
    )
    expect(screen.getByText('视觉质检 92/100')).toBeInTheDocument()
    expect(await screen.findByRole('button', { name: '继续编辑' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '局部重绘' })).toBeInTheDocument()
    expect(screen.getByLabelText('放大倍数')).toBeInTheDocument()
    expect(screen.getByRole('option', { name: '本机插值放大 2×' })).toBeInTheDocument()
    expect(screen.queryByText('本机高质量放大 2×')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '加入画布' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '保存图片组合版本' })).toBeDisabled()
    expect(screen.getByLabelText('精确文字图层')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '局部重绘' }))
    expect(screen.getByLabelText('局部重绘蒙版画布')).toBeInTheDocument()
    expect(screen.getByLabelText('蒙版笔刷大小')).toHaveValue('128')
    expect(screen.getByLabelText('上传透明 PNG 蒙版')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '查看版本 2' }))
    fireEvent.click(screen.getByRole('button', { name: '切换到此版本' }))
    await waitFor(() => {
      expect(mediaApiMock.selectImageVersion).toHaveBeenCalledWith(ready.id, {
        revision: ready.revision,
        version_id: secondVersion.id,
      })
    })
  })

  it('restores a persisted text layout from its parent instead of applying default positions again', async () => {
    const baseVersion = {
      id: 'ver_textbase01',
      kind: 'generated' as const,
      asset_id: 'out_textbase01',
      image_path: `/api/media/assets/${project.id}/out_textbase01.png`,
      mime_type: 'image/png' as const,
      width: 1024,
      height: 1024,
      text_layers: [],
      image_layers: [],
      created_at: '2026-07-18T00:02:00.000Z',
    }
    const textVersion = {
      ...baseVersion,
      id: 'ver_textlayout01',
      kind: 'text_layout' as const,
      parent_version_id: baseVersion.id,
      asset_id: 'out_textlayout01',
      image_path: `/api/media/assets/${project.id}/out_textlayout01.png`,
      text_layers: [{
        id: 'text_saved001',
        text: '会员日',
        x: 256,
        y: 320,
        max_width: 860,
        fill: '#ffcc00',
        font_family: 'PingFang SC',
        font_size: 72,
        font_weight: 'bold' as const,
        text_align: 'center' as const,
      }],
    }
    const ready: ImageWorkbenchProject = {
      ...project,
      state: 'ready',
      task_id: undefined,
      current_version_id: textVersion.id,
      version_history: [baseVersion, textVersion],
      error: undefined,
    }
    mediaApiMock.listProjects.mockResolvedValue({ projects: [ready] })
    render(<ImageWorkbench />)

    expect(await screen.findByLabelText('精确文字图层')).toHaveValue('会员日')
    expect(screen.getByLabelText('会员日 横向位置')).toHaveValue(25)
    expect(screen.getByLabelText('会员日 纵向位置')).toHaveValue(31.25)
    expect(screen.getByLabelText('会员日 字号')).toHaveValue(72)
    expect(screen.getByLabelText('会员日 颜色')).toHaveValue('#ffcc00')
    const save = screen.getByRole('button', { name: '保存文字排版版本' })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText('会员日 横向位置'), { target: { value: '30' } })
    expect(save).toBeEnabled()
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
