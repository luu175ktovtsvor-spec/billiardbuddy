import {
  RemoteTranscriptionError,
  transcribeRemoteFile,
  type RemoteTranscriptionFetch,
} from '../../media/remoteTranscription.js'

export class VoiceTranscriptionError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message)
    this.name = 'VoiceTranscriptionError'
  }
}

export type VoiceTranscriptionOptions = {
  env?: Record<string, string | undefined>
  fetchImpl?: RemoteTranscriptionFetch
  language?: string
  signal?: AbortSignal
  timeoutMs?: number
  consentReceiptId?: string
  providerProtocol?: string
  operationId?: string
}

export async function transcribeVoiceFile(
  file: File,
  opts: VoiceTranscriptionOptions = {},
): Promise<{ text: string }> {
  if (file.size === 0) {
    throw new VoiceTranscriptionError('没收到录音内容，请重新录一次', 400)
  }

  try {
    return await transcribeRemoteFile(file, opts)
  } catch (error) {
    if (error instanceof RemoteTranscriptionError) {
      throw new VoiceTranscriptionError(error.message, error.status)
    }
    throw error
  }
}
