import { describe, expect, it } from 'vitest'
import { ELECTRON_IPC_CHANNELS } from './channels'
import {
  ELECTRON_IPC_VALIDATORS,
  isElectronIpcChannel,
  validateElectronIpcPayload,
} from './capabilities'

describe('Electron IPC capabilities', () => {
  it('has a validator for every exposed invoke channel', () => {
    expect(Object.keys(ELECTRON_IPC_VALIDATORS).sort()).toEqual(
      Object.values(ELECTRON_IPC_CHANNELS).sort(),
    )
  })

  it('rejects channels outside the desktop host contract', () => {
    expect(isElectronIpcChannel(ELECTRON_IPC_CHANNELS.appGetVersion)).toBe(true)
    expect(isElectronIpcChannel('ipcRenderer:send-anything')).toBe(false)
  })

  it('validates structured payloads before they reach ipcRenderer.invoke', () => {
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.shellOpen, 'https://example.com')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.shellOpen, { url: 'https://example.com' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardReadText, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardWriteText, 'paste me')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.clipboardWriteText, { text: 'paste me' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowClose, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowClose, {})).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowStartDragging, undefined)).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowStartDragging, { deltaX: 4, deltaY: -2 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowOpenProductTask, 'task_abc-123')).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.windowOpenProductTask, '../private')).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: 1, data: 'pwd\n' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalWrite, { sessionId: '1', data: 'pwd\n' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: 80, rows: 24, cwd: '/tmp' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.terminalSpawn, { cols: '80', rows: 24 })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: 'http://127.0.0.1:7890' })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: '' })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.updateCheck, { proxy: 'http://127.0.0.1:7890', extra: true })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mediaSubmitImage, {
      projectId: 'img_project01',
      confirmUnknownRetry: true,
      confirmedDataEgress: true,
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mediaSubmitImage, {
      projectId: '../escape',
      confirmUnknownRetry: false,
      confirmedDataEgress: true,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mediaStartImageOperation, {
      projectId: 'img_project01',
      input: {
        revision: 3,
        base_version_id: 'ver_base0001',
        kind: 'inpaint',
        instruction: '只修改蒙版区域',
        mask_data_url: 'data:image/png;base64,AAAA',
        confirm_unknown_retry: false,
      },
      confirmedDataEgress: true,
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mediaStartImageOperation, {
      projectId: 'img_project01',
      input: {
        revision: 3,
        base_version_id: '../escape',
        kind: 'inpaint',
        instruction: '只修改蒙版区域',
        confirm_unknown_retry: false,
      },
      confirmedDataEgress: true,
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mediaSubmitImage, {
      projectId: 'img_project01',
      confirmUnknownRetry: false,
      confirmedDataEgress: true,
      capability: 'must-not-cross-ipc',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mediaRenderVideo, {
      projectId: 'vid_project01',
      revision: 3,
      outputPath: '/tmp/export.mp4',
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mediaRenderVideo, {
      projectId: 'vid_project01',
      revision: -1,
      outputPath: '/tmp/export.mp4',
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mediaSaveImageOutput, {
      projectId: 'img_project01',
      input: { output_id: 'out_result001', output_path: '/tmp/final.png' },
    })).toBe(true)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mediaSaveImageOutput, {
      projectId: 'img_project01',
      input: { output_id: '../escape', output_path: '/tmp/final.png' },
    })).toBe(false)
    expect(validateElectronIpcPayload(ELECTRON_IPC_CHANNELS.mediaSaveImageOutput, {
      projectId: 'img_project01',
      input: { version_id: 'ver_result001', output_path: '/tmp/final.png' },
    })).toBe(true)
  })
})
