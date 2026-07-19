import { LoaderCircle, Mic, RefreshCw, Square, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { productVoiceApi } from '../api/voice'
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
  const lifecycleRef = useRef(0)
  const mountedRef = useRef(false)
  const disabledRef = useRef(disabled)

  const isCurrentLifecycle = useCallback((lifecycle: number) => (
    mountedRef.current && lifecycleRef.current === lifecycle
  ), [])

  const setState = useCallback((next: VoiceInputState, lifecycle?: number) => {
    if (!mountedRef.current || (lifecycle !== undefined && lifecycleRef.current !== lifecycle)) return
    setStateValue(next)
    onStateChange?.(next)
  }, [onStateChange])

  const setElapsedForLifecycle = useCallback((next: number, lifecycle?: number) => {
    if (!mountedRef.current || (lifecycle !== undefined && lifecycleRef.current !== lifecycle)) return
    setElapsed(next)
  }, [])

  const releaseRecorder = useCallback(() => {
    const recorder = recorderRef.current
    const stream = streamRef.current
    if (timerRef.current != null) window.clearInterval(timerRef.current)
    timerRef.current = null
    streamRef.current = null
    recorderRef.current = null
    if (recorder?.state === 'recording') recorder.stop()
    stream?.getTracks().forEach((track) => track.stop())
  }, [])

  const beginOperation = useCallback(() => {
    lifecycleRef.current += 1
    requestRef.current?.abort()
    requestRef.current = null
    releaseRecorder()
    return lifecycleRef.current
  }, [releaseRecorder])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      lifecycleRef.current += 1
      requestRef.current?.abort()
      requestRef.current = null
      releaseRecorder()
    }
  }, [releaseRecorder])

  useEffect(() => {
    const becameDisabled = disabled && !disabledRef.current
    disabledRef.current = disabled
    if (!becameDisabled || !mountedRef.current) return
    beginOperation()
    chunksRef.current = []
    lastBlobRef.current = null
    setElapsedForLifecycle(0)
    setState('idle')
  }, [beginOperation, disabled, setElapsedForLifecycle, setState])

  const transcribe = useCallback(async (blob: Blob, lifecycle: number) => {
    if (!isCurrentLifecycle(lifecycle)) return
    if (!blob.size) {
      setState('error', lifecycle)
      addToast({ type: 'error', message: '没有录到声音，请重新录一次' })
      return
    }

    lastBlobRef.current = blob
    const controller = new AbortController()
    requestRef.current = controller
    setState('transcribing', lifecycle)
    try {
      const text = await productVoiceApi.transcribe(blob, {
        language,
        signal: controller.signal,
      })
      if (controller.signal.aborted || !isCurrentLifecycle(lifecycle)) return
      onTranscript(text)
      if (!isCurrentLifecycle(lifecycle)) return
      lastBlobRef.current = null
      setElapsedForLifecycle(0, lifecycle)
      setState('idle', lifecycle)
    } catch {
      if (controller.signal.aborted || !isCurrentLifecycle(lifecycle)) return
      setState('error', lifecycle)
      addToast({
        type: 'error',
        message: '语音转写暂时无法完成，请稍后重试。',
      })
    } finally {
      if (requestRef.current === controller) requestRef.current = null
    }
  }, [addToast, isCurrentLifecycle, language, onTranscript, setElapsedForLifecycle, setState])

  const start = useCallback(async () => {
    if (disabled || !mountedRef.current) return
    const lifecycle = beginOperation()
    chunksRef.current = []
    lastBlobRef.current = null
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('error', lifecycle)
      addToast({ type: 'error', message: '当前系统不支持麦克风录音' })
      return
    }

    setState('requesting', lifecycle)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (!isCurrentLifecycle(lifecycle)) {
        stream.getTracks().forEach((track) => track.stop())
        return
      }
      streamRef.current = stream
      const mimeType = recorderMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      recorder.ondataavailable = (event) => {
        if (isCurrentLifecycle(lifecycle) && event.data.size) chunksRef.current.push(event.data)
      }
      recorder.onstop = () => {
        if (!isCurrentLifecycle(lifecycle)) return
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType || 'audio/webm',
        })
        releaseRecorder()
        if (!isCurrentLifecycle(lifecycle)) return
        void transcribe(blob, lifecycle)
      }
      recorder.start(250)
      setElapsedForLifecycle(0, lifecycle)
      setState('recording', lifecycle)
      timerRef.current = window.setInterval(
        () => {
          if (isCurrentLifecycle(lifecycle)) setElapsed((value) => value + 1)
        },
        1_000,
      )
    } catch (error) {
      if (!isCurrentLifecycle(lifecycle)) return
      releaseRecorder()
      setState('error', lifecycle)
      addToast({
        type: 'error',
        message: error instanceof DOMException && error.name === 'NotAllowedError'
          ? '没有麦克风权限，请在系统设置中允许后重试'
          : '无法开始录音，请检查麦克风',
      })
    }
  }, [addToast, beginOperation, disabled, isCurrentLifecycle, releaseRecorder, setElapsedForLifecycle, setState, transcribe])

  const stop = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }

  const cancel = () => {
    beginOperation()
    chunksRef.current = []
    lastBlobRef.current = null
    setElapsedForLifecycle(0)
    setState('idle')
  }

  const retry = () => {
    const blob = lastBlobRef.current
    if (blob) {
      const lifecycle = beginOperation()
      void transcribe(blob, lifecycle)
      return
    }
    void start()
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
      <button type="button" onClick={retry} disabled={disabled} title="重试语音输入" aria-label="重试语音输入" className={`${buttonClass} text-[var(--color-warning)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40`} data-testid="voice-retry">
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
