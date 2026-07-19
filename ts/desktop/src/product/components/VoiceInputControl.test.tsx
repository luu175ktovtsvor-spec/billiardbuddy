import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { productVoiceApi } from '../api/voice'
import { useUIStore } from '../../stores/uiStore'
import { VoiceInputControl, type VoiceInputState } from './VoiceInputControl'

vi.mock('../api/voice', () => ({
  productVoiceApi: { transcribe: vi.fn() },
}))

class FakeMediaRecorder {
  static isTypeSupported = vi.fn(() => true)
  static instances: FakeMediaRecorder[] = []
  readonly mimeType: string
  state: RecordingState = 'inactive'
  ondataavailable: ((event: BlobEvent) => void) | null = null
  onstop: (() => void) | null = null

  constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
    this.mimeType = options?.mimeType || 'audio/webm'
    FakeMediaRecorder.instances.push(this)
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
let getUserMediaMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  FakeMediaRecorder.instances = []
  useUIStore.setState({ toasts: [] })
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder as unknown as typeof MediaRecorder)
  getUserMediaMock = vi.fn(async () => ({
    getTracks: () => [{ stop: stopTrack }],
  } as unknown as MediaStream))
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: getUserMediaMock,
    },
  })
})

describe('VoiceInputControl', () => {
  it('records, transcribes and returns text to the product composer owner', async () => {
    vi.mocked(productVoiceApi.transcribe).mockResolvedValue('今晚八点开始比赛')
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
    expect(productVoiceApi.transcribe).toHaveBeenCalledWith(
      expect.any(Blob),
      expect.objectContaining({ language: 'zh', signal: expect.any(AbortSignal) }),
    )
    expect(states).toEqual(expect.arrayContaining(['requesting', 'recording', 'transcribing', 'idle']))
    expect(stopTrack).toHaveBeenCalled()
  })

  it('stays usable when the desktop runs it inside StrictMode', async () => {
    vi.mocked(productVoiceApi.transcribe).mockResolvedValue('二号台需要加时')
    const onTranscript = vi.fn()
    render(
      <StrictMode>
        <VoiceInputControl onTranscript={onTranscript} />
      </StrictMode>,
    )

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await screen.findByTestId('voice-recording')
    fireEvent.click(screen.getByRole('button', { name: '停止并转写' }))

    await waitFor(() => expect(onTranscript).toHaveBeenCalledWith('二号台需要加时'))
  })

  it('does not let a cancelled microphone request take over a later recording', async () => {
    const stopFirstTrack = vi.fn()
    const stopSecondTrack = vi.fn()
    let resolveFirstRequest: ((stream: MediaStream) => void) | undefined
    const firstRequest = new Promise<MediaStream>((resolve) => {
      resolveFirstRequest = resolve
    })
    getUserMediaMock
      .mockImplementationOnce(() => firstRequest)
      .mockResolvedValueOnce({
        getTracks: () => [{ stop: stopSecondTrack }],
      } as unknown as MediaStream)

    render(<VoiceInputControl onTranscript={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await screen.findByTestId('voice-requesting')
    fireEvent.click(screen.getByRole('button', { name: '取消录音' }))
    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await screen.findByTestId('voice-recording')

    resolveFirstRequest?.({
      getTracks: () => [{ stop: stopFirstTrack }],
    } as unknown as MediaStream)

    await waitFor(() => expect(stopFirstTrack).toHaveBeenCalledOnce())
    expect(FakeMediaRecorder.instances).toHaveLength(1)
    expect(screen.getByTestId('voice-recording')).toBeTruthy()
    expect(stopSecondTrack).not.toHaveBeenCalled()
  })

  it('cancels a recording without sending audio to the gateway', async () => {
    render(<VoiceInputControl onTranscript={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await screen.findByTestId('voice-recording')
    fireEvent.click(screen.getByRole('button', { name: '取消录音' }))

    await screen.findByTestId('voice-input')
    expect(productVoiceApi.transcribe).not.toHaveBeenCalled()
    expect(stopTrack).toHaveBeenCalled()
  })

  it('cancels an in-flight transcription without filling the composer or showing an error', async () => {
    let requestSignal: AbortSignal | undefined
    vi.mocked(productVoiceApi.transcribe).mockImplementation((_blob, options) => new Promise<string>(
      (_resolve, reject) => {
        requestSignal = options?.signal
        requestSignal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        }, { once: true })
      },
    ))
    const onTranscript = vi.fn()
    render(<VoiceInputControl onTranscript={onTranscript} />)

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await screen.findByTestId('voice-recording')
    fireEvent.click(screen.getByRole('button', { name: '停止并转写' }))
    await screen.findByTestId('voice-transcribing')

    fireEvent.click(screen.getByRole('button', { name: '取消转写' }))

    await screen.findByTestId('voice-input')
    await waitFor(() => expect(requestSignal?.aborted).toBe(true))
    expect(onTranscript).not.toHaveBeenCalled()
    expect(useUIStore.getState().toasts).toEqual([])
  })

  it('cancels an active transcription when its product task becomes unavailable', async () => {
    let resolveTranscription: ((text: string) => void) | undefined
    vi.mocked(productVoiceApi.transcribe).mockImplementation(() => new Promise<string>((resolve) => {
      resolveTranscription = resolve
    }))
    const onTranscript = vi.fn()
    const view = render(<VoiceInputControl onTranscript={onTranscript} />)

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await screen.findByTestId('voice-recording')
    fireEvent.click(screen.getByRole('button', { name: '停止并转写' }))
    await screen.findByTestId('voice-transcribing')

    view.rerender(<VoiceInputControl onTranscript={onTranscript} disabled />)
    resolveTranscription?.('这段内容不应回填')

    await screen.findByTestId('voice-input')
    await waitFor(() => expect(onTranscript).not.toHaveBeenCalled())
    expect(stopTrack).toHaveBeenCalled()
  })

  it('uses a safe recovery message when transcription fails', async () => {
    const rawError = 'DeepSeek provider rejected /private/.claude/settings.json token'
    vi.mocked(productVoiceApi.transcribe).mockRejectedValue(new Error(rawError))
    render(<VoiceInputControl onTranscript={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: '语音输入' }))
    await screen.findByTestId('voice-recording')
    fireEvent.click(screen.getByRole('button', { name: '停止并转写' }))

    await waitFor(() => expect(useUIStore.getState().toasts).toContainEqual(expect.objectContaining({
      type: 'error',
      message: '语音转写暂时无法完成，请稍后重试。',
    })))
    expect(useUIStore.getState().toasts.some((toast) => toast.message === rawError)).toBe(false)
  })
})
