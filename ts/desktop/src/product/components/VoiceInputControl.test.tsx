import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { voiceApi } from '../../api/voice'
import { useUIStore } from '../../stores/uiStore'
import { VoiceInputControl, type VoiceInputState } from './VoiceInputControl'

vi.mock('../../api/voice', () => ({
  voiceApi: { transcribe: vi.fn() },
}))

class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true)
  readonly mimeType: string
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || 'audio/webm'
  }

  start() {
    this.state = 'recording'
  }

  stop() {
    this.state = 'inactive'
    this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) } as BlobEvent)
    this.onstop?.()
  }
}

const stopTrack = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  useUIStore.setState({ toasts: [] })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder)
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: stopTrack }],
      } as unknown as MediaStream)),
    },
  })
})

describe('VoiceInputControl', () => {
  it('records, transcribes and returns text to the product composer owner', async () => {
    vi.mocked(voiceApi.transcribe).mockResolvedValue('今晚八点开始比赛')
    const onTranscript = vi.fn()
    const states: VoiceInputState[] = []
    render(
      <VoiceInputControl
        onTranscript={onTranscript}
        onStateChange={(state) => states.push(state)}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await screen.findByTestId('voice-recording')
    fireEvent.click(screen.getByRole('button', { name: '停止并转写' }))

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('今晚八点开始比赛'))
    expect(voiceApi.transcribe).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({ language: 'zh', signal: expect.any(AbortSignal) }),
    )
    expect(states).toEqual(expect.arrayContaining(['requesting', 'recording', 'transcribing', 'idle']))
    expect(stopTrack).toHaveBeenCalled()
  })

  it('cancels a recording without sending audio to the gateway', async () => {
    render(<VoiceInputControl onTranscript={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await screen.findByTestId('voice-recording')
    fireEvent.click(screen.getByRole('button', { name: '取消录音' }))

    await screen.findByTestId('voice-input')
    expect(voiceApi.transcribe).not.toHaveBeenCalled()
    expect(stopTrack).toHaveBeenCalled()
  })
})
