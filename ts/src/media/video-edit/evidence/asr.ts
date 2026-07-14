import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { TranscribeUnavailableError, transcribeVideoWordLevel, type VideoTranscript } from '../../transcribe'

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
  readonly id = 'whisper.cpp'
  readonly version = 'baseline-v1'

  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

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
        return { transcript: null, provider: this.id, providerVersion: this.version, warning: '本地语音转写组件尚未就绪，可继续环境剪辑或稍后重试转写' }
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
