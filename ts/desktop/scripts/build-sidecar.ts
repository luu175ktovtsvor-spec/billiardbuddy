import { mkdir } from 'node:fs/promises'
import path from 'node:path'

/** 照 cc-haha build-sidecars.ts:bun build --compile 出单文件二进制 + macOS ad-hoc 重签。
 *  起步只编本机 target;全平台矩阵(CI)是 W13。 */
const desktopDir = path.resolve(import.meta.dir, '..')
const binariesDir = path.join(desktopDir, 'binaries')
await mkdir(binariesDir, { recursive: true })

function hostTriple(): string {
  const p = process.platform
  const a = process.arch
  if (p === 'darwin' && a === 'arm64') return 'aarch64-apple-darwin'
  if (p === 'darwin' && a === 'x64') return 'x86_64-apple-darwin'
  if (p === 'win32' && a === 'x64') return 'x86_64-pc-windows-msvc'
  if (p === 'win32' && a === 'arm64') return 'aarch64-pc-windows-msvc'
  if (p === 'linux' && a === 'x64') return 'x86_64-unknown-linux-gnu'
  if (p === 'linux' && a === 'arm64') return 'aarch64-unknown-linux-gnu'
  throw new Error(`unsupported host ${p}/${a}`)
}

type BunCompileTarget =
  | 'bun-darwin-arm64'
  | 'bun-darwin-x64'
  | 'bun-windows-x64-baseline'
  | 'bun-windows-arm64'
  | 'bun-linux-x64-baseline'
  | 'bun-linux-arm64'

function bunTarget(triple: string): BunCompileTarget {
  switch (triple) {
    case 'aarch64-apple-darwin':
      return 'bun-darwin-arm64'
    case 'x86_64-apple-darwin':
      return 'bun-darwin-x64'
    // 老 CPU 用 baseline,否则起后端就崩(研究 Q5:baseline 真实且必需)
    case 'x86_64-pc-windows-msvc':
      return 'bun-windows-x64-baseline'
    case 'aarch64-pc-windows-msvc':
      return 'bun-windows-arm64'
    case 'x86_64-unknown-linux-gnu':
      return 'bun-linux-x64-baseline'
    case 'aarch64-unknown-linux-gnu':
      return 'bun-linux-arm64'
    default:
      throw new Error(`unsupported triple ${triple}`)
  }
}

const triple = process.env.SIDECAR_TARGET_TRIPLE || hostTriple()
const outfile = path.join(
  binariesDir,
  `backend-sidecar-${triple}${triple.includes('windows') ? '.exe' : ''}`,
)

const result = await Bun.build({
  entrypoints: [path.join(desktopDir, 'sidecars/backend-sidecar.ts')],
  minify: { whitespace: true, identifiers: true, syntax: true },
  sourcemap: 'none',
  target: 'bun',
  compile: { target: bunTarget(triple), outfile },
})

if (!result.success) {
  throw new Error(`[build-sidecar] compile failed:\n${result.logs.map(l => l.message).join('\n')}`)
}
console.log(`[build-sidecar] -> ${outfile}`)

// macOS:Bun 编译二进制签名坏(load code signature error 4 → SIGKILL),strip + ad-hoc 重签(研究 Q5)。
if (process.platform === 'darwin') {
  await Bun.spawn(['codesign', '--remove-signature', outfile], { stdout: 'inherit', stderr: 'inherit' }).exited
  const sign = Bun.spawn(['codesign', '--sign', '-', '--force', '--timestamp=none', outfile], {
    stdout: 'inherit',
    stderr: 'inherit',
  })
  if ((await sign.exited) !== 0) throw new Error('[build-sidecar] ad-hoc codesign failed')
  console.log(`[build-sidecar] ad-hoc signed ${outfile}`)
}
