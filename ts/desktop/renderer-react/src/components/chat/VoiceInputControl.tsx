import { useEffect, useRef, useState } from 'react'
import { voiceApi } from '../../api/voice'
import { toast } from '../../stores/toastStore'
import { IconMic, IconRefresh, IconSpinner, IconX } from '../shared/icons'

type VoiceState = 'idle' | 'requesting' | 'recording' | 'transcribing' | 'error'

function recorderMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined
  return ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find(type => MediaRecorder.isTypeSupported?.(type))
}

function formatElapsed(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

export function VoiceInputControl({ onTranscript }: { onTranscript: (text: string) => void }) {
  const [state, setState] = useState<VoiceState>('idle')
  const [elapsed, setElapsed] = useState(0)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const lastBlobRef = useRef<Blob | null>(null)
  const timerRef = useRef<number | null>(null)
  const cancelledRef = useRef(false)

  const release = () => {
    if (timerRef.current != null) window.clearInterval(timerRef.current)
    timerRef.current = null
    streamRef.current?.getTracks().forEach(track => track.stop())
    streamRef.current = null
    recorderRef.current = null
  }

  useEffect(() => () => release(), [])

  const transcribe = async (blob: Blob) => {
    if (!blob.size) {
      setState('error')
      toast('没有录到声音，请重新录一次')
      return
    }
    lastBlobRef.current = blob
    setState('transcribing')
    try {
      const text = await voiceApi.transcribe(blob)
      onTranscript(text)
      setState('idle')
      setElapsed(0)
      lastBlobRef.current = null
    } catch (error) {
      setState('error')
      toast(error instanceof Error ? error.message : '语音转写失败')
    }
  }

  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      setState('error')
      toast('当前系统不支持麦克风录音')
      return
    }
    setState('requesting')
    cancelledRef.current = false
    chunksRef.current = []
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mimeType = recorderMimeType()
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
      recorderRef.current = recorder
      recorder.ondataavailable = event => { if (event.data.size) chunksRef.current.push(event.data) }
      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType || mimeType || 'audio/webm' })
        release()
        if (cancelledRef.current) {
          chunksRef.current = []
          setState('idle')
          setElapsed(0)
          return
        }
        void transcribe(blob)
      }
      recorder.start(250)
      setElapsed(0)
      setState('recording')
      timerRef.current = window.setInterval(() => setElapsed(value => value + 1), 1000)
    } catch (error) {
      release()
      setState('error')
      toast(error instanceof DOMException && error.name === 'NotAllowedError' ? '没有麦克风权限，请在系统设置中允许后重试' : '无法开始录音，请检查麦克风')
    }
  }

  const stop = () => {
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
  }

  const cancel = () => {
    cancelledRef.current = true
    if (recorderRef.current?.state === 'recording') recorderRef.current.stop()
    else { release(); setState('idle'); setElapsed(0) }
  }

  if (state === 'recording') {
    return <div className="flex items-center gap-1" data-testid="voice-recording"><span className="px-1 text-[11px] tabular-nums" style={{ color: 'var(--color-error)' }}>{formatElapsed(elapsed)}</span><button type="button" onClick={cancel} title="取消录音" aria-label="取消录音" className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)' }}><IconX size={16} /></button><button type="button" onClick={stop} title="停止并转写" aria-label="停止并转写" className="flex h-8 w-8 items-center justify-center rounded-full" style={{ background: 'var(--color-primary)', color: 'var(--color-on-primary)' }}><span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: 'var(--color-on-primary)' }} /></button></div>
  }
  if (state === 'requesting' || state === 'transcribing') return <button type="button" disabled title={state === 'requesting' ? '正在请求麦克风' : '正在转写'} aria-label={state === 'requesting' ? '正在请求麦克风' : '正在转写'} className="flex h-8 w-8 items-center justify-center rounded-full" data-testid="voice-transcribing"><IconSpinner size={16} /></button>
  if (state === 'error') return <button type="button" onClick={() => lastBlobRef.current ? void transcribe(lastBlobRef.current) : void start()} title="重试语音输入" aria-label="重试语音输入" className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-warning)' }} data-testid="voice-retry"><IconRefresh size={16} /></button>
  return <button type="button" title="语音输入" aria-label="语音输入" onClick={() => void start()} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors hover:bg-[var(--color-surface-hover)]" style={{ color: 'var(--color-text-secondary)' }} data-testid="voice-input"><IconMic size={18} /></button>
}
