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

    await actions.submitImageProject('img_project01', true)
    await actions.renderVideo('vid_project01', { revision: 2, output_path: '/tmp/final.mp4' })
    await actions.saveImageOutput('img_project01', { output_id: 'out_result001', output_path: '/tmp/final.png' })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://127.0.0.1:3456/api/media/images/projects/img_project01/submit')
    expect(JSON.parse(String(fetchImpl.mock.calls[0]?.[1]?.body))).toEqual({
      confirm_unknown_retry: true,
    })
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('http://127.0.0.1:3456/api/media/videos/projects/vid_project01/render')
    expect(JSON.parse(String(fetchImpl.mock.calls[1]?.[1]?.body))).toEqual({
      revision: 2,
      output_path: '/tmp/final.mp4',
    })
    expect(fetchImpl.mock.calls[2]?.[0]).toBe('http://127.0.0.1:3456/api/media/images/projects/img_project01/outputs/out_result001/save')
    expect(JSON.parse(String(fetchImpl.mock.calls[2]?.[1]?.body))).toEqual({ output_path: '/tmp/final.png' })
  })

  it('rejects a weak process capability', () => {
    expect(() => new ElectronMediaActions({
      getServerUrl: async () => 'http://127.0.0.1:3456',
      capability: 'short',
    })).toThrow('too short')
  })
})
