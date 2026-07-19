import { LoaderCircle, Mic, RefreshCw, Square, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { voiceApi } from '../../api/voice'
import { useUIStore } from '../../stores/uiStore'

export type VoiceInputState =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'transcribing'
  | 'error'

export type VoiceInputControlProps = {
  onTranscript: (text: string) => void
  onStateChange?: (state: VoiceInputState) => void
  disabled?: boolean
  language?: string
  className?: string
}

function recorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return [
    'audio/webm;codecs=opus',
    'audio/mp4',
    'audio/webm',
  ].find((type) => MediaRecorder.isTypeSupported?.(type))
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/** Product composer microphone capture. It returns a transcript but never sends it. */
export function VoiceInputControl({
  onTranscript,
  onStateChange,
  disabled = false,
  language = 'zh',
  className = '',
}: VoiceInputControlProps) {
  const [state, setStateValue] = useState<VoiceInputState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const addToast = useUIStore((store) => store.addToast)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const lastBlobRef = useRef<Blob | null>(null)
  const timerRef = useRef<number | null>(null)
  const requestRef = useRef<AbortController | null>(null)
  const cancelledRef = useRef(false)
  const mountedRef = useRef(true)

  const setState = useCallback((next: VoiceInputState) => {
    if (!mountedRef.current) return
    setStateValue(next)
    onStateChange?.(next)
  }, [onStateChange])

  const releaseRecorder = useCallback(() => {
    if (timerRef.current != null) window.clearInterval(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    recorderRef.current = null
  }, [])

  useEffect(() => () => {
    mountedRef.current = false
    cancelledRef.current = true
    requestRef.current?.abort()
    releaseRecorder()
  }, [releaseRecorder])

  const transcribe = useCallback(async (blob: Blob) => {
    if (!blob.size) {
      setState('error')
      addToast({ type: 'error', message: '没有录到声音，请重新录一次' })
      return
    }

    lastBlobRef.current = blob
    const controller = new AbortController()
    requestRef.current = controller
    setState('transcribing')
    try {
      const text = await voiceApi.transcribe(blob, {
        language,
        signal: controller.signal,
      })
      if (controller.signal.aborted) return
      onTranscript(text)
      lastBlobRef.current = null
      setElapsed(0)
      setState('idle')
    } catch {
      if (controller.signal.aborted) {
        setElapsed(0)
        setState('idle')
        return
      }
      setState('error')
      addToast({
        type: 'error',
        message: '语音转写暂时无法完成，请稍后重试。',
      })
    } finally {
      if (requestRef.current === controller) requestRef.current = null
    }
  }, [addToast, language, onTranscript, setState])

  const start = useCallback(async () => {
    if (disabled) return
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('error')
      addToast({ type: 'error', message: '当前系统不支持麦克风录音' })
      return
    }

    setState('requesting')
    cancelledRef.current = false
    chunksRef.current = []
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (cancelledRef.current) {
        stream.getTracks().forEach((track) => track.stop())
        setState('idle')
        return
      }
      streamRef.current = stream
      const mimeType = recorderMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        })
        releaseRecorder()
        if (cancelledRef.current) {
          chunksRef.current = []
          setElapsed(0)
          setState('idle')
          return
        }
        void transcribe(blob)
      }
      recorder.start(250)
      setElapsed(0)
      setState('recording')
      timerRef.current = window.setInterval(
        () => setElapsed((value) => value + 1),
        1_000,
      )
    } catch (error) {
      releaseRecorder()
      setState('error')
      addToast({
        type: 'error',
        message: error instanceof DOMException && error.name === 'NotAllowedError'
          ? '没有麦克风权限，请在系统设置中允许后重试'
          : '无法开始录音，请检查麦克风',
      })
    }
  }, [addToast, disabled, releaseRecorder, setState, transcribe])

  const stop = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }

  const cancel = () => {
    cancelledRef.current = true
    requestRef.current?.abort()
    requestRef.current = null
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop()
      return
    }
    releaseRecorder()
    setElapsed(0)
    setState('idle')
  }

  const buttonClass = `flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${className}`

  if (state === 'recording') {
    return (
      <div className="flex items-center gap-1" data-testid="voice-recording">
        <span className="px-1 text-[11px] tabular-nums text-[var(--color-error)]">
          {formatElapsed(elapsed)}
        </span>
        <button type="button" onClick={cancel} title="取消录音" aria-label="取消录音" className={`${buttonClass} text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]`}>
          <X size={16} aria-hidden="true" />
        </button>
        <button type="button" onClick={stop} title="停止并转写" aria-label="停止并转写" className={`${buttonClass} bg-[var(--color-primary)] text-[var(--color-on-primary)]`}>
          <Square size={12} fill="currentColor" aria-hidden="true" />
        </button>
      </div>
    )
  }

  if (state === 'transcribing') {
    return (
      <button type="button" onClick={cancel} title="取消转写" aria-label="取消转写" className={`${buttonClass} text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]`} data-testid="voice-transcribing">
        <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
      </button>
    )
  }

  if (state === 'requesting') {
    return (
      <button type="button" onClick={cancel} title="取消录音" aria-label="取消录音" className={`${buttonClass} text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)]`} data-testid="voice-requesting">
        <LoaderCircle size={16} className="animate-spin" aria-hidden="true" />
      </button>
    )
  }

  if (state === 'error') {
    return (
      <button type="button" onClick={() => lastBlobRef.current ? void transcribe(lastBlobRef.current) : void start()} disabled={disabled} title="重试语音输入" aria-label="重试语音输入" className={`${buttonClass} text-[var(--color-warning)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40`} data-testid="voice-retry">
        <RefreshCw size={16} aria-hidden="true" />
      </button>
    )
  }

  return (
    <button type="button" title="语音输入" aria-label="语音输入" onClick={() => void start()} disabled={disabled} className={`${buttonClass} text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40`} data-testid="voice-input">
      <Mic size={18} aria-hidden="true" />
    </button>
  )
}
