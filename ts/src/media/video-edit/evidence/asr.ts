import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  resolveTranscribeAvailability,
  TranscribeUnavailableError,
  transcribeVideoWordLevel,
  type VideoTranscript,
} from '../../transcribe'

export interface AsrResult {
  transcript: VideoTranscript | null
  provider: string
  providerVersion: string
  warning?: string
}

export interface AsrAdapter {
  readonly id: string
  readonly version: string
  transcribe(
    path: string,
    workDir: string,
    signal?: AbortSignal,
    onProgress?: (progress: number, stage?: string) => Promise<void> | void,
  ): Promise<AsrResult>
}

export class WhisperCppAsrAdapter implements AsrAdapter {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  get id(): string {
    const requestedMode = this.env.QF_TRANSCRIBE_MODE?.trim().toLowerCase()
    return requestedMode === 'remote' || resolveTranscribeAvailability(this.env).mode === 'remote'
      ? 'gateway-asr'
      : 'whisper.cpp'
  }

  get version(): string {
    return this.id === 'gateway-asr' ? 'remote-v1' : 'baseline-v1'
  }

  async transcribe(
    path: string,
    workDir: string,
    signal?: AbortSignal,
    onProgress?: (progress: number, stage?: string) => Promise<void> | void,
  ): Promise<AsrResult> {
    await mkdir(workDir, { recursive: true })
    try {
      const transcript = await transcribeVideoWordLevel(path, workDir, { env: this.env, signal, onProgress })
      return { transcript, provider: this.id, providerVersion: this.version }
    } catch (error) {
      if (signal?.aborted) throw error
      if (error instanceof TranscribeUnavailableError) {
        return { transcript: null, provider: this.id, providerVersion: this.version, warning: error.reason }
      }
      return {
        transcript: null,
        provider: this.id,
        providerVersion: this.version,
        warning: error instanceof Error ? error.message : '语音识别失败',
      }
    }
  }
}

export interface FutureAsrAdapterConfig {
  kind: 'qwen3-asr' | 'sensevoice'
  endpoint?: string
  modelPath?: string
}

export function asrWorkDirectory(projectDir: string, sourceId: string): string {
  return join(projectDir, 'evidence', 'asr-work', sourceId)
}
