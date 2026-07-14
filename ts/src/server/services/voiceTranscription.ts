import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { delimiter } from 'node:path'
import { basename, extname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { ASSET_IDS, managedAssetPath } from '../../assets/assetManager'
import { transcribeAssetsPreparingReason } from '../../media/mediaBinaries'
import {
  RemoteTranscriptionError,
  localTranscriptionRequested,
  resolveRemoteTranscriptionConfig,
  transcribeRemoteFile,
  type RemoteTranscriptionFetch,
} from '../../media/remoteTranscription'

export class VoiceTranscriptionError extends Error {
  constructor(message: string, readonly status = 422) {
    super(message)
  }
}

interface TranscribeOptions {
  stateRoot: string
  env?: Record<string, string | undefined>
  fetchImpl?: RemoteTranscriptionFetch
  language?: string
  timeoutMs?: number
}

interface CommandContext {
  input: string
  output: string
  outputBase: string
  model: string
  language: string
}

interface ProcessResult {
  stdout: string
  stderr: string
}

export async function transcribeVoiceFile(file: File, opts: TranscribeOptions): Promise<{ text: string }> {
  const env = opts.env ?? process.env
  if (file.size === 0) throw new VoiceTranscriptionError('没收到录音内容，请重新录一次', 400)
  if (resolveRemoteTranscriptionConfig(env)) {
    try {
      const result = await transcribeRemoteFile(file, {
        env,
        language: opts.language,
        responseFormat: 'json',
        timeoutMs: opts.timeoutMs ?? 10 * 60_000,
        fetchImpl: opts.fetchImpl,
      })
      return { text: result.text }
    } catch (error) {
      if (error instanceof RemoteTranscriptionError) throw new VoiceTranscriptionError(error.message, error.status)
      throw error
    }
  }
  if (env.QF_TRANSCRIBE_MODE?.trim().toLowerCase() === 'remote') {
    throw new VoiceTranscriptionError('语音识别服务器未配置', 503)
  }
  if (!localTranscriptionRequested(env)) {
    throw new VoiceTranscriptionError('语音识别服务器未配置', 503)
  }
  const bytes = Buffer.from(await file.arrayBuffer())
  const workDir = join(opts.stateRoot, 'voice-tmp', crypto.randomUUID())
  await mkdir(workDir, { recursive: true })
  try {
    const suffix = safeAudioSuffix(file.name)
    const rawPath = join(workDir, `input${suffix}`)
    await writeFile(rawPath, bytes)
    const direct = await tryTranscribePath(rawPath, workDir, { ...opts, env }).catch(err => err)
    if (!(direct instanceof Error)) return direct
    const wav = await convertToWav(rawPath, workDir, env).catch(() => null)
    if (wav) {
      const converted = await tryTranscribePath(wav, workDir, { ...opts, env }).catch(err => err)
      if (!(converted instanceof Error)) return converted
    }
    if (direct instanceof VoiceTranscriptionError && (direct.message.includes('未配置') || direct.status === 503)) throw direct
    throw new VoiceTranscriptionError('没听清，请再说一次或改用文字输入', 422)
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function tryTranscribePath(input: string, workDir: string, opts: TranscribeOptions): Promise<{ text: string }> {
  const env = opts.env ?? process.env
  const language = opts.language || env.WHISPER_LANGUAGE || 'zh'
  const outputBase = join(workDir, 'transcript')
  const output = `${outputBase}.txt`
  const model = resolveWhisperModel(env)
  const custom = env.WHISPER_TRANSCRIBE_COMMAND?.trim()
  if (!custom) {
    // 功能门:转写组件还在后台下载时给明确的"准备中"(503 + 大白话),同时已触发按需下载;
    // 没接资产管理器(单测/纯开发)时此处为 null,走下面原有的"未配置"提示。
    const preparing = transcribeAssetsPreparingReason(env)
    if (preparing) throw new VoiceTranscriptionError(`语音输入的${preparing}`, 503)
  }
  const command = custom
    ? commandFromTemplate(custom, { input, output, outputBase, model, language }, env)
    : whisperCppCommand(input, { input, output, outputBase, model, language }, env)
  if (!command) {
    throw new VoiceTranscriptionError('语音转写模型未配置:请设置 WHISPER_TRANSCRIBE_COMMAND 或 WHISPER_CLI/WHISPER_CPP_BIN 后再使用语音输入。', 422)
  }
  const result = await runProcess(command.bin, command.args, { cwd: workDir, timeoutMs: opts.timeoutMs ?? 10 * 60_000 })
  const text = await readTranscriptText(output, result)
  if (!text.trim()) throw new VoiceTranscriptionError('没听清，请再说一次或改用文字输入', 422)
  return { text }
}

function commandFromTemplate(template: string, ctx: CommandContext, env: Record<string, string | undefined>): { bin: string; args: string[] } | null {
  const parts = splitCommand(template).map(part => expandTemplate(part, ctx))
  const bin = parts.shift()
  if (!bin) return null
  const resolved = resolveExecutable(bin, env)
  if (!resolved) throw new VoiceTranscriptionError(`语音转写命令不可用:${bin}`, 422)
  return { bin: resolved, args: parts }
}

function whisperCppCommand(input: string, ctx: CommandContext, env: Record<string, string | undefined>): { bin: string; args: string[] } | null {
  const bin = resolveExecutable(env.WHISPER_CLI || env.WHISPER_CPP_BIN || '', env)
    ?? managedAssetPath(ASSET_IDS.whisperCli)
    ?? resolveExecutable(join(process.cwd(), 'desktop', 'binaries', platformWhisperName()), env)
    ?? resolveExecutable(join(process.cwd(), '..', 'desktop', 'binaries', platformWhisperName()), env)
    ?? resolveExecutable('whisper-cli', env)
    ?? resolveExecutable('main', env)
  if (!bin) return null
  if (!ctx.model) throw new VoiceTranscriptionError('语音转写模型未配置:请设置 WHISPER_MODEL_PATH/WHISPER_CPP_MODEL。', 422)
  return {
    bin,
    args: ['-m', ctx.model, '-f', input, '-l', ctx.language, '-otxt', '-of', ctx.outputBase],
  }
}

async function readTranscriptText(output: string, result: ProcessResult): Promise<string> {
  if (existsSync(output)) return (await readFile(output, 'utf8')).trim()
  const stdout = result.stdout.trim()
  if (!stdout) return ''
  const jsonMatch = stdout.match(/\{[\s\S]*\}/)
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as unknown
      if (parsed && typeof parsed === 'object' && 'text' in parsed && typeof (parsed as { text?: unknown }).text === 'string') {
        return (parsed as { text: string }).text.trim()
      }
    } catch {
      // 不是 JSON 输出就按纯文本处理。
    }
  }
  return stdout
    .split(/\r?\n/)
    .filter(line => !/^\s*(whisper_|system_info|main:|processing|output_)/i.test(line))
    .join('\n')
    .trim()
}

async function convertToWav(input: string, workDir: string, env: Record<string, string | undefined>): Promise<string> {
  const ffmpeg = resolveFfmpeg(env)
  if (!ffmpeg) throw new VoiceTranscriptionError('ffmpeg 未配置', 422)
  const wav = join(workDir, 'converted.wav')
  await runProcess(ffmpeg, ['-y', '-i', input, '-ar', '16000', '-ac', '1', wav], { cwd: workDir, timeoutMs: 120_000 })
  return wav
}

function resolveFfmpeg(env: Record<string, string | undefined>): string | null {
  return resolveExecutable(env.FFMPEG_BIN || '', env)
    ?? managedAssetPath(ASSET_IDS.ffmpeg)
    ?? resolveExecutable(join(process.cwd(), 'desktop', 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), env)
    ?? resolveExecutable(join(process.cwd(), '..', 'desktop', 'node_modules', 'ffmpeg-static', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'), env)
    ?? resolveExecutable('ffmpeg', env)
}

function resolveWhisperModel(env: Record<string, string | undefined>): string {
  const direct = env.WHISPER_MODEL_PATH || env.WHISPER_CPP_MODEL
  if (direct && existsSync(direct)) return direct
  const managed = managedAssetPath(ASSET_IDS.whisperModel)
  if (managed) return managed
  const dir = env.WHISPER_MODEL_DIR
  if (dir && existsSync(dir)) {
    const candidateNames = ['ggml-medium.bin', 'ggml-large-v3.bin', 'ggml-small.bin', 'model.bin']
    for (const name of candidateNames) {
      const candidate = join(dir, name)
      if (existsSync(candidate)) return candidate
    }
  }
  return ''
}

function safeAudioSuffix(name: string): string {
  const ext = extname(basename(name || 'audio.webm')).toLowerCase()
  if (!ext || ext.length > 12 || /[^a-z0-9.]/.test(ext)) return '.webm'
  return ext
}

function splitCommand(input: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  for (const ch of input) {
    if (escaped) {
      cur += ch
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur)
        cur = ''
      }
      continue
    }
    cur += ch
  }
  if (cur) out.push(cur)
  return out
}

function expandTemplate(value: string, ctx: CommandContext): string {
  return value
    .replaceAll('{input}', ctx.input)
    .replaceAll('{output}', ctx.output)
    .replaceAll('{outputBase}', ctx.outputBase)
    .replaceAll('{model}', ctx.model)
    .replaceAll('{language}', ctx.language)
}

function resolveExecutable(command: string, env: Record<string, string | undefined>): string | null {
  if (!command.trim()) return null
  const direct = command.includes('/') || command.includes('\\') ? resolve(command) : ''
  if (direct && existsSync(direct)) return direct
  const path = env.PATH || process.env.PATH || ''
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, `${command}${ext}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function platformWhisperName(): string {
  return process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli'
}

function runProcess(bin: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<ProcessResult> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(bin, args, { cwd: opts.cwd, windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      proc.kill('SIGKILL')
      reject(new VoiceTranscriptionError('语音转写超时，请稍后重试', 422))
    }, opts.timeoutMs)
    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')
    proc.stdout.on('data', chunk => { stdout += chunk })
    proc.stderr.on('data', chunk => { stderr += chunk })
    proc.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', code => {
      clearTimeout(timer)
      if (code === 0) resolvePromise({ stdout, stderr })
      else reject(new VoiceTranscriptionError(stderr.trim() || `语音转写进程失败:${code}`, 422))
    })
  })
}
