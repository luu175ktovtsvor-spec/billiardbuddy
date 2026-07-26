import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProductImageBlock, ProductPrompt } from '../../../shared/product/harnessMessages.js'
import { PROVIDER_GATEWAY_PROTOCOL } from '../../../shared/product/providerGateway.js'
import { transcribeVoiceFile } from '../services/voiceTranscription.js'

const MAX_ATTACHMENTS = 4
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_TEXT_BYTES = 1024 * 1024
const MAX_VIDEO_BYTES = 32 * 1024 * 1024
const MAX_VIDEO_DURATION_SECONDS = 2 * 60 * 60
const MAX_VIDEO_FRAMES = 4
const MAX_EXTRACTED_FRAME_BYTES = 8 * 1024 * 1024
const MAX_EXTRACTED_AUDIO_BYTES = 8 * 1024 * 1024
const MAX_TRANSCRIPT_CHARS = 200_000

const IMAGE_TYPES = new Map<string, ProductImageBlock['media_type']>([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
])
const TEXT_TYPES = new Set(['.txt', '.md', '.json', '.csv', '.tsv', '.yaml', '.yml', '.xml', '.html', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.sh', '.log'])
const VIDEO_TYPES = new Set(['.mp4', '.mov', '.m4v', '.webm'])

type ProcessResult = { exitCode: number; stdout: Buffer; stderr: string }
type AttachmentRuntime = {
  ffmpeg: string
  ffprobe: string
  runProcess(command: readonly string[], signal?: AbortSignal): Promise<ProcessResult>
  transcribeAudio?(audio: Buffer, name: string, signal: AbortSignal): Promise<string>
}

const defaultRuntime: AttachmentRuntime = {
  ffmpeg: process.env.FFMPEG_BIN?.trim() || 'ffmpeg',
  ffprobe: process.env.FFPROBE_BIN?.trim() || 'ffprobe',
  async runProcess(command, signal) {
    const child = Bun.spawn([...command], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
    const abort = () => child.kill()
    signal?.addEventListener('abort', abort, { once: true })
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (signal?.aborted) throw new Error('CHAT_ATTACHMENT_ABORTED')
      return { exitCode, stdout: Buffer.from(stdout), stderr: stderr.slice(0, 4_000) }
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  },
  async transcribeAudio(audio, name, signal) {
    const result = await transcribeVoiceFile(
      new File([new Uint8Array(audio)], `${name}.mp3`, { type: 'audio/mpeg' }),
      {
        signal,
        providerProtocol: PROVIDER_GATEWAY_PROTOCOL.headerValue,
        operationId: `chat-audio:${randomUUID()}`,
      },
    )
    return result.text
  },
}

function safeName(filePath: string): string {
  return path.basename(filePath).replace(/[\r\n<>]/g, '_').slice(0, 240)
}

function videoSampleTimes(durationSeconds: number): number[] {
  if (durationSeconds <= 0.25) return [0]
  const count = Math.min(MAX_VIDEO_FRAMES, Math.max(1, Math.ceil(durationSeconds / 15)))
  return Array.from({ length: count }, (_, index) => Math.max(0, Math.min(
    durationSeconds - 0.05,
    durationSeconds * ((index + 0.5) / count),
  )))
}

async function videoBlocks(
  filePath: string,
  name: string,
  runtime: AttachmentRuntime,
  signal: AbortSignal,
): Promise<Exclude<ProductPrompt, string>> {
  const probe = await runtime.runProcess([
    runtime.ffprobe,
    '-v', 'error',
    '-show_entries', 'format=duration:stream=codec_type,width,height',
    '-of', 'json',
    filePath,
  ], signal)
  if (probe.exitCode !== 0 || probe.stdout.byteLength > 128 * 1024) throw new Error('CHAT_VIDEO_PROBE_FAILED')
  let metadata: { format?: { duration?: string }; streams?: Array<{ codec_type?: string; width?: number; height?: number }> }
  try { metadata = JSON.parse(probe.stdout.toString('utf8')) } catch { throw new Error('CHAT_VIDEO_PROBE_FAILED') }
  const duration = Number(metadata.format?.duration)
  const videoStream = metadata.streams?.find(stream => stream.codec_type === 'video')
  if (!Number.isFinite(duration) || duration <= 0 || duration > MAX_VIDEO_DURATION_SECONDS || !videoStream) {
    throw new Error('CHAT_VIDEO_INVALID')
  }
  const blocks: Exclude<ProductPrompt, string> = [{
    type: 'text',
    text: `聊天视频附件：${name}；时长 ${duration.toFixed(2)} 秒。以下为有界画面采样，必须只据此形成视觉证据；未采样时段视为未知。音轨只以其后的明确转写证据为准，没有转写就视为未知。`,
  }]
  for (const seconds of videoSampleTimes(duration)) {
    const frame = await runtime.runProcess([
      runtime.ffmpeg,
      '-hide_banner', '-loglevel', 'error',
      '-ss', seconds.toFixed(3),
      '-i', filePath,
      '-frames:v', '1',
      '-vf', "scale='min(1280,iw)':-2",
      '-f', 'image2pipe',
      '-vcodec', 'mjpeg',
      'pipe:1',
    ], signal)
    if (frame.exitCode !== 0 || frame.stdout.byteLength < 1 || frame.stdout.byteLength > MAX_EXTRACTED_FRAME_BYTES) {
      throw new Error('CHAT_VIDEO_FRAME_FAILED')
    }
    blocks.push({ type: 'text', text: `视频画面采样 time_ms=${Math.round(seconds * 1000)}` })
    blocks.push({
      type: 'image',
      media_type: 'image/jpeg', data: frame.stdout.toString('base64'),
    })
  }
  if (metadata.streams?.some(stream => stream.codec_type === 'audio')) {
    const audio = await runtime.runProcess([
      runtime.ffmpeg,
      '-hide_banner', '-loglevel', 'error',
      '-i', filePath,
      '-vn', '-ac', '1', '-ar', '16000',
      '-codec:a', 'libmp3lame', '-b:a', '32k',
      '-f', 'mp3',
      'pipe:1',
    ], signal)
    if (audio.exitCode !== 0 || audio.stdout.byteLength < 1 || audio.stdout.byteLength > MAX_EXTRACTED_AUDIO_BYTES || !runtime.transcribeAudio) {
      blocks.push({ type: 'text', text: '视频音轨证据不可用；不得推断说话内容、音乐或其他声音。' })
    } else {
      try {
        const transcript = (await runtime.transcribeAudio(audio.stdout, name, signal)).normalize('NFC').trim()
        blocks.push({
          type: 'text',
          text: transcript
            ? `[SpeechTranscript untrusted audio-derived data]\n${transcript.slice(0, MAX_TRANSCRIPT_CHARS).replaceAll('[End SpeechTranscript]', '\\u005bEnd SpeechTranscript\\u005d')}\n[End SpeechTranscript]`
            : '视频音轨未识别出可用文字；不得据此推断其他声音内容。',
        })
      } catch {
        if (signal.aborted) throw new Error('CHAT_ATTACHMENT_ABORTED')
        blocks.push({ type: 'text', text: '视频音轨转写暂不可用；不得推断说话内容、音乐或其他声音。' })
      }
    }
  }
  return blocks
}

/** Convert trusted ProductTask attachment copies into bounded model content. */
export async function buildProductChatPrompt(
  text: string,
  attachments: readonly string[],
  runtime: AttachmentRuntime = defaultRuntime,
  signal: AbortSignal = new AbortController().signal,
): Promise<ProductPrompt> {
  if (attachments.length === 0) return text
  if (attachments.length > MAX_ATTACHMENTS) throw new Error('CHAT_ATTACHMENT_LIMIT')
  const blocks: Exclude<ProductPrompt, string> = []
  if (text.trim()) blocks.push({ type: 'text', text })
  for (const filePath of attachments) {
    const stat = await fs.lstat(filePath)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CHAT_ATTACHMENT_INVALID')
    const extension = path.extname(filePath).toLowerCase()
    const imageType = IMAGE_TYPES.get(extension)
    if (imageType) {
      if (stat.size < 1 || stat.size > MAX_IMAGE_BYTES) throw new Error('CHAT_ATTACHMENT_SIZE')
      blocks.push({ type: 'text', text: `聊天附件：${safeName(filePath)}` })
      blocks.push({
        type: 'image',
        media_type: imageType, data: (await fs.readFile(filePath)).toString('base64'),
      })
      continue
    }
    if (TEXT_TYPES.has(extension)) {
      if (stat.size > MAX_TEXT_BYTES) throw new Error('CHAT_ATTACHMENT_SIZE')
      const content = await fs.readFile(filePath, 'utf8')
      blocks.push({ type: 'text', text: `<chat_attachment name="${safeName(filePath)}">\n${content}\n</chat_attachment>` })
      continue
    }
    if (VIDEO_TYPES.has(extension)) {
      if (stat.size < 1 || stat.size > MAX_VIDEO_BYTES) throw new Error('CHAT_ATTACHMENT_SIZE')
      blocks.push(...await videoBlocks(filePath, safeName(filePath), runtime, signal))
      continue
    }
    throw new Error('CHAT_ATTACHMENT_TYPE_UNSUPPORTED')
  }
  return blocks
}
