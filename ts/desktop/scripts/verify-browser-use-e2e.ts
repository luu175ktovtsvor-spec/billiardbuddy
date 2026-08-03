import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

type Target = 'aarch64-apple-darwin' | 'x86_64-apple-darwin' | 'x86_64-pc-windows-msvc' | 'aarch64-pc-windows-msvc'
const desktopRoot = resolve(import.meta.dir, '..')
const plugin = 'billiardbuddy-browser-use'

function target(value: string | undefined): Target {
  if (value === 'aarch64-apple-darwin' || value === 'x86_64-apple-darwin' || value === 'x86_64-pc-windows-msvc' || value === 'aarch64-pc-windows-msvc') return value
  throw new Error('Browser E2E requires a supported --target')
}

const args = process.argv.slice(2)
const valueFor = (flag: string) => {
  const index = args.indexOf(flag)
  return index < 0 ? undefined : args[index + 1]
}
const platformTarget = target(valueFor('--target'))
const executable = join(desktopRoot, 'runtime-assets', 'agent-marketplace', 'plugins', plugin, 'bin', platformTarget.includes('windows') ? `${plugin}.exe` : plugin)
const electron = join(desktopRoot, 'node_modules', 'electron', 'cli.js')
if (!existsSync(executable) || !existsSync(electron)) throw new Error('Browser E2E 缺少已暂存插件或 Electron 运行时')

const output = mkdtempSync(join(tmpdir(), 'billiardbuddy-browser-e2e-bundle-'))
try {
  const result = await Bun.build({
    entrypoints: [join(desktopRoot, 'electron', 'browserUseE2e.ts')],
    outdir: output,
    target: 'node',
    format: 'cjs',
    external: ['electron'],
  })
  if (!result.success || result.outputs.length !== 1) throw new Error(`Browser E2E 测试入口构建失败: ${result.logs.map(log => log.message).join('\n')}`)
  const test = result.outputs[0]?.path
  if (!test) throw new Error('Browser E2E 测试入口不存在')
  const node = Bun.which('node')
  if (!node) throw new Error('Browser E2E 缺少 Node.js 运行时')
  const run = spawnSync(node, [electron, test, executable], {
    cwd: desktopRoot,
    encoding: 'utf8',
    timeout: 90_000,
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: 'true' },
  })
  if (run.error || run.status !== 0) {
    const detail = [run.error?.message, run.stdout, run.stderr].filter((value): value is string => Boolean(value?.trim())).join('\n')
    throw new Error(`Browser E2E 验证失败${detail ? `\n${detail}` : ''}`)
  }
  console.log('[browser-e2e] verified Electron host and Rust MCP security boundary')
} finally {
  rmSync(output, { recursive: true, force: true })
}
