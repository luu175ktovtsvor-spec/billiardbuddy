// 生图增强·超分放大(Real-ESRGAN ncnn-vulkan · 免费商用 · 本机二进制,不引 Python)。
// 用途:海报拿去印易拉宝/喷绘会糊 → 2/3/4x 超分放大到高清。
// 硬约束(对齐 transcribe.ts):二进制未打包/下载好 → 优雅降级抛 UpscaleUnavailableError,
// 由上层功能门回退"正在准备组件 x%",绝不崩、不假装放大成功。二进制走 child_process.spawn,
// 不进 package.json、不 require .node(避 Bun+Windows 段错误,同 whisper-cli)。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { resolveRealesrganPath } from './mediaBinaries'

/** 超分引擎不可用(二进制未打包/下载)——上层据此优雅回退,不崩。 */
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
  /** 模型名(realesrgan-x4plus 通用照片 / realesrgan-x4plus-anime 动漫),默认通用。 */
  model?: string
  timeoutMs?: number
}

/** 超分是否可用(二进制就绪)。上层功能门据此决定拦不拦。 */
export function upscaleAvailable(env?: Record<string, string | undefined>): boolean {
  return !!resolveRealesrganPath(env)
}

/** 超分放大一张图,返回成图绝对路径。二进制缺 → 抛 UpscaleUnavailableError(上层回退占位)。 */
export async function upscaleImage(inputPath: string, opts: UpscaleOptions = {}): Promise<string> {
  const bin = resolveRealesrganPath(opts.env)
  if (!bin) throw new UpscaleUnavailableError('超分二进制未就绪', '需打包/下载 Real-ESRGAN(realesrgan-ncnn-vulkan)')
  if (!existsSync(inputPath)) throw new Error(`找不到要放大的图:${inputPath}`)
  const scale = opts.scale === 2 || opts.scale === 3 ? opts.scale : 4
  const ext = extname(inputPath) || '.png'
  const out = opts.outputPath ?? join(dirname(inputPath), `${basename(inputPath, ext)}_x${scale}.png`)
  await mkdir(dirname(out), { recursive: true })
  const args = ['-i', inputPath, '-o', out, '-s', String(scale)]
  if (opts.model) args.push('-n', opts.model)
  await runUpscaleProc(bin, args, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? 180_000 })
  if (!existsSync(out)) throw new Error('超分完成但没生成成图')
  return out
}

function runUpscaleProc(bin: string, args: string[], opts: { signal?: AbortSignal; timeoutMs: number }): Promise<void> {
  if (opts.signal?.aborted) return Promise.reject(new Error('任务已取消'))
  return new Promise((resolvePromise, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('超分超时')) }, opts.timeoutMs)
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
      else reject(new Error(`超分失败(code ${code}):${stderr.slice(0, 300)}`))
    })
  })
}
