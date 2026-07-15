// 生图增强·高清尺寸放大。复用本地 FFmpeg 的 Lanczos 缩放与轻锐化，不引入额外模型权重。
// 它只增加像素尺寸并保持内容，不声称恢复原图中不存在的细节；真正的生成式修复走 edit_image。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { ffmpegBinFrom, mediaBinaryAvailable } from './mediaBinaries'

/** 本地高清放大引擎不可用——上层据此优雅回退,不崩。 */
export class UpscaleUnavailableError extends Error {
  constructor(message: string, readonly reason: string) {
    super(message)
    this.name = 'UpscaleUnavailableError'
  }
}

export interface UpscaleOptions {
  env?: Record<string, string | undefined>
  signal?: AbortSignal
  /** 放大倍数(2/3/4),默认 4。 */
  scale?: number
  /** 输出路径;不给则在输入旁生成 <name>_x<scale>.png。 */
  outputPath?: string
  timeoutMs?: number
}

/** 高清尺寸放大是否可用。上层功能门据此决定拦不拦。 */
export function upscaleAvailable(env?: Record<string, string | undefined>): boolean {
  return mediaBinaryAvailable('ffmpeg', env)
}

/** 高清尺寸放大一张图,返回成图绝对路径。FFmpeg 缺失时抛可识别错误。 */
export async function upscaleImage(inputPath: string, opts: UpscaleOptions = {}): Promise<string> {
  if (!upscaleAvailable(opts.env)) throw new UpscaleUnavailableError('高清放大组件未就绪', '需要 FFmpeg')
  const bin = ffmpegBinFrom(opts.env)
  if (!existsSync(inputPath)) throw new Error(`找不到要放大的图:${inputPath}`)
  const scale = opts.scale === 2 || opts.scale === 3 ? opts.scale : 4
  const ext = extname(inputPath) || '.png'
  const out = opts.outputPath ?? join(dirname(inputPath), `${basename(inputPath, ext)}_x${scale}.png`)
  await mkdir(dirname(out), { recursive: true })
  const filter = `scale=iw*${scale}:ih*${scale}:flags=lanczos,unsharp=5:5:0.35:5:5:0.0`
  const args = ['-y', '-loglevel', 'error', '-i', inputPath, '-vf', filter, '-frames:v', '1', out]
  await runUpscaleProc(bin, args, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 180_000 })
  if (!existsSync(out)) throw new Error('高清放大完成但没生成图片')
  return out
}

function runUpscaleProc(bin: string, args: string[], opts: { signal?: AbortSignal; timeoutMs: number }): Promise<void> {
  if (opts.signal?.aborted) return Promise.reject(new Error('任务已取消'))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('高清放大超时')) }, opts.timeoutMs)
    const onAbort = () => { child.kill('SIGKILL'); reject(new Error('任务已取消')) }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stderr?.on('data', (d) => { stderr += String(d) })
    child.on('error', (err) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (code === 0) resolvePromise()
      else reject(new Error(`高清放大失败(code ${code}):${stderr.slice(0, 300)}`))
    })
  })
}
