import { Check, LoaderCircle, Mic, RefreshCw, Square, Upload, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { productVoiceApi } from '../api/voice'
import { useUIStore } from '../../stores/uiStore'
import type { ProductVoiceTranscriptionResponse, VoiceConsumer } from '../../../../shared/contracts/voice'

export type VoiceInputState =
  | 'idle'
  | 'requesting'
  | 'recording'
  | 'transcribing'
  | 'reviewing'
  | 'saving'
  | 'error'

export type VoiceInputControlProps = {
  onTranscript: (text: string) => void
  onStateChange?: (state: VoiceInputState) => void
  disabled?: boolean
  language?: string
  className?: string
  consumer?: VoiceConsumer
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
  consumer,
}: VoiceInputControlProps) {
  const [state, setStateValue] = useState<VoiceInputState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const [review, setReview] = useState<ProductVoiceTranscriptionResponse | null>(null)
  const [reviewText, setReviewText] = useState('')
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
  const uploadInputRef = useRef<HTMLInputElement | null>(null)

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
    setReview(null)
    setReviewText('')
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
      const result = await productVoiceApi.transcribe(blob, {
        language,
        signal: controller.signal,
      })
      if (controller.signal.aborted || !isCurrentLifecycle(lifecycle)) return
      setReview(result)
      setReviewText(result.text)
      lastBlobRef.current = null
      setElapsedForLifecycle(0, lifecycle)
      setState('reviewing', lifecycle)
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
  }, [addToast, isCurrentLifecycle, language, setElapsedForLifecycle, setState])

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
    setReview(null)
    setReviewText('')
    setElapsedForLifecycle(0)
    setState('idle')
  }

  const upload = (file: File | undefined) => {
    if (!file || disabled || !mountedRef.current) return
    const lifecycle = beginOperation()
    chunksRef.current = []
    lastBlobRef.current = null
    void transcribe(file, lifecycle)
  }

  const confirm = async () => {
    if (!review || !reviewText.trim() || !mountedRef.current) return
    const lifecycle = lifecycleRef.current
    setState('saving', lifecycle)
    try {
      let transcript = review.transcript
      const current = transcript.revisions.find(revision => revision.id === transcript.current_revision_id)
      const text = reviewText.trim()
      if (!current) throw new Error('current transcript revision is missing')
      if (text !== current.text) {
        transcript = await productVoiceApi.revise(transcript.id, current.id, text)
      }
      if (consumer) {
        transcript = await productVoiceApi.bind(
          transcript.id,
          transcript.current_revision_id,
          consumer,
        )
      }
      if (!isCurrentLifecycle(lifecycle)) return
      onTranscript(text)
      setReview(null)
      setReviewText('')
      setState('idle', lifecycle)
    } catch {
      if (!isCurrentLifecycle(lifecycle)) return
      setState('reviewing', lifecycle)
      addToast({ type: 'error', message: '转写文本暂时无法保存，请稍后重试。' })
    }
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

  if (state === 'reviewing' || state === 'saving') {
    return (
      <div className="flex min-w-[260px] items-end gap-1" data-testid="voice-reviewing">
        <textarea
          aria-label="校正转写文本"
          value={reviewText}
          onChange={(event) => setReviewText(event.target.value)}
          disabled={state === 'saving'}
          rows={2}
          className="min-w-0 flex-1 resize-y rounded-lg border border-[var(--color-border)] bg-[var(--color-app-main)] px-2 py-1 text-xs leading-5 text-[var(--color-text-primary)]"
        />
        <button type="button" onClick={cancel} disabled={state === 'saving'} title="放弃转写" aria-label="放弃转写" className={`${buttonClass} text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:opacity-40`}>
          <X size={16} aria-hidden="true" />
        </button>
        <button type="button" onClick={() => { void confirm() }} disabled={state === 'saving' || !reviewText.trim()} title="确认并使用转写" aria-label="确认并使用转写" className={`${buttonClass} bg-[var(--color-primary)] text-[var(--color-on-primary)] disabled:opacity-40`}>
          {state === 'saving' ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : <Check size={16} aria-hidden="true" />}
        </button>
      </div>
    )
  }

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
    <div className="flex items-center gap-1">
      <input
        ref={uploadInputRef}
        type="file"
        accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg,.webm"
        className="hidden"
        aria-label="选择音频文件"
        onChange={(event) => {
          upload(event.currentTarget.files?.[0])
          event.currentTarget.value = ''
        }}
      />
      <button type="button" title="上传音频并转写" aria-label="上传音频并转写" onClick={() => uploadInputRef.current?.click()} disabled={disabled} className={`${buttonClass} text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40`} data-testid="voice-upload">
        <Upload size={16} aria-hidden="true" />
      </button>
      <button type="button" title="语音输入" aria-label="语音输入" onClick={() => void start()} disabled={disabled} className={`${buttonClass} text-[var(--color-text-secondary)] hover:bg-[var(--color-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40`} data-testid="voice-input">
        <Mic size={18} aria-hidden="true" />
      </button>
    </div>
  )
}
