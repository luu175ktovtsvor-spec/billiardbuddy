import { describe, expect, it, vi } from 'vitest'
import { MEDIA_UI_CAPABILITY_HEADER } from '../../../shared/contracts/media'
import { ElectronMediaActions } from './mediaActions'

const CAPABILITY = 'm'.repeat(43)

describe('ElectronMediaActions', () => {
  it('keeps the capability in main and forwards protected media actions', async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get(MEDIA_UI_CAPABILITY_HEADER)).toBe(CAPABILITY)
      return Response.json({ task: { id: 'task_media01' } }, { status: 202 })
    })
    const actions = new ElectronMediaActions({
      getServerUrl: async () => 'http://127.0.0.1:3456/',
      capability: CAPABILITY,
      fetchImpl,
    })

    await actions.submitImageProject('img_project01', true, true)
    await actions.startImageOperation('img_project01', {
      revision: 3,
      base_version_id: 'ver_base0001',
      kind: 'edit',
      instruction: '只调整背景色',
      confirm_unknown_retry: false,
    }, true)
    await actions.renderVideo('vid_project01', { revision: 2, output_path: '/tmp/final.mp4' })
    await actions.analyzeVideo('vid_project01', { base_revision: 2, user_goal: '剪成活动短片' })
    await actions.saveImageOutput('img_project01', { version_id: 'ver_result001', output_path: '/tmp/final.png' })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3456/api/media/images/projects/img_project01/submit')
    const submitBody = JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))
    expect(submitBody).toMatchObject({
      confirm_unknown_retry: true,
      data_egress_consent: {
        policy_revision: 'bb-04e-image-v1',
        acknowledged: true,
      },
    })
    expect(Number.isNaN(Date.parse(submitBody.data_egress_consent.acknowledged_at))).toBe(false)
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('http://127.0.0.1:3456/api/media/images/projects/img_project01/operations')
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toMatchObject({
      revision: 3,
      base_version_id: 'ver_base0001',
      kind: 'edit',
      instruction: '只调整背景色',
      data_egress_consent: { acknowledged: true },
    })
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('http://127.0.0.1:3456/api/media/videos/projects/vid_project01/render')
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({
      revision: 2,
      output_path: '/tmp/final.mp4',
    })
    expect(fetchImpl.mock.calls[3]?.[0]).toBe('http://127.0.0.1:3456/api/media/videos/projects/vid_project01/analyze')
    expect(JSON.parse(String(fetchImpl.mock.calls[3]?.[1]?.body))).toEqual({ base_revision: 2, user_goal: '剪成活动短片' })
    expect(fetchImpl.mock.calls[4]?.[0]).toBe('http://127.0.0.1:3456/api/media/images/projects/img_project01/versions/ver_result001/save')
    expect(JSON.parse(String(fetchImpl.mock.calls[4]?.[1]?.body))).toEqual({ output_path: '/tmp/final.png' })
  })

  it('rejects a weak process capability', () => {
    expect(() => new ElectronMediaActions({
      getServerUrl: async () => 'http://127.0.0.1:3456',
      capability: 'short',
    })).toThrow('too short')
  })

  it('never forwards raw media HTTP or transport errors through Electron IPC', async () => {
    const rawDetail = 'gateway provider rejected token=private-token for /private/ffmpeg.log'
    const actions = new ElectronMediaActions({
      getServerUrl: async () => 'http://127.0.0.1:3456',
      capability: CAPABILITY,
      fetchImpl: async () => Response.json({
        error: 'MEDIA_VIDEO_EXPORT_FAILED',
        message: rawDetail,
      }, { status: 502 }),
    })

    const projected = await actions.renderVideo('vid_project01', {
      revision: 2,
      output_path: '/tmp/final.mp4',
    }).catch(error => error)
    expect(projected).toBeInstanceOf(Error)
    expect((projected as Error).message).toBe('视频导出失败，请检查素材和导出位置后重试。')
    expect((projected as Error).message).not.toContain(rawDetail)

    const disconnected = new ElectronMediaActions({
      getServerUrl: async () => 'http://127.0.0.1:3456',
      capability: CAPABILITY,
      fetchImpl: async () => { throw new Error(rawDetail) },
    })
    await expect(disconnected.submitImageProject('img_project01')).rejects.toThrow(
      '媒体服务暂时不可用，请稍后重试。',
    )
  })
})
