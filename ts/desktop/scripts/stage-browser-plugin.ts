import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveCargoCommand, verifyProductContent, verifyProductSkill, verifyStdioMcpHandshake } from './native-build-tools'

type SupportedTarget =
  | 'aarch64-apple-darwin'
  | 'x86_64-apple-darwin'
  | 'x86_64-pc-windows-msvc'
  | 'aarch64-pc-windows-msvc'

type Options = { destinationDir: string, target: SupportedTarget, verifyOnly?: boolean }
const PLUGIN = 'billiardbuddy-browser-use'
const desktopRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const sourceRoot = join(repositoryRoot, 'native', PLUGIN)
const pluginSourceRoot = join(desktopRoot, 'runtime-assets', 'plugins', PLUGIN)

function supported(value: string): value is SupportedTarget {
  return ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].includes(value)
}
function detectTarget(platform = process.platform, arch = process.arch): SupportedTarget {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  throw new Error(`不支持的 BilliardBuddy Browser 插件平台: ${platform}/${arch}`)
}
function binary(target: SupportedTarget) { return target.includes('windows') ? `${PLUGIN}.exe` : PLUGIN }
function file(path: string) {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`Browser 插件缺少正式文件: ${path}`)
}
function cargo(): string {
  return resolveCargoCommand('缺少 Rust Cargo；请在 macOS/Windows 原生构建机或 GitHub Actions 上构建 BilliardBuddy Browser 插件')
}
function run(command: string, arguments_: string[], cwd?: string) {
  const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8', timeout: 20 * 60_000 })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter((value): value is string => Boolean(value?.trim())).join('\n')
    throw new Error(`Browser 插件命令失败: ${command} ${arguments_.join(' ')}${detail ? `\n${detail}` : ''}`)
  }
}

export function verifyStagedBrowserPlugin(options: Options) {
  const root = join(resolve(options.destinationDir), PLUGIN)
  for (const path of [
    join(root, '.codex-plugin', 'plugin.json'),
    join(root, '.mcp.json'),
    join(root, 'skills', 'browser-use', 'SKILL.md'),
    join(root, 'bin', binary(options.target)),
  ]) file(path)
  const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8')) as { name?: unknown, mcpServers?: unknown, skills?: unknown }
  if (manifest.name !== PLUGIN || manifest.mcpServers !== './.mcp.json' || manifest.skills !== './skills/') throw new Error('Browser 插件 manifest 无效')
  verifyProductContent(join(root, '.codex-plugin', 'plugin.json'))
  verifyProductSkill(join(root, 'skills', 'browser-use', 'SKILL.md'))
  const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, { command?: unknown, cwd?: unknown, env_vars?: unknown }> }
  const server = mcp.mcpServers?.[PLUGIN]
  if (server?.command !== `./bin/${PLUGIN}` || server.cwd !== '.' || !Array.isArray(server.env_vars) || !server.env_vars.includes('CODEX_HOME')) throw new Error('Browser 插件 MCP 配置无效')
  const marketplace = JSON.parse(readFileSync(join(resolve(options.destinationDir), '..', '.agents', 'plugins', 'marketplace.json'), 'utf8')) as { plugins?: Array<{ name?: unknown, source?: { path?: unknown } }> }
  if (!marketplace.plugins?.some(entry => entry.name === PLUGIN && entry.source?.path === `./plugins/${PLUGIN}`)) throw new Error('BilliardBuddy 本地市场缺少 Browser 插件')
  const staged = join(root, 'bin', binary(options.target))
  if (lstatSync(staged).size < 100_000) throw new Error('Browser 插件二进制大小无效')
  verifyStdioMcpHandshake(staged, options.target, PLUGIN)
}

export function stageBrowserPlugin(options: Options) {
  if (options.verifyOnly) return verifyStagedBrowserPlugin(options)
  for (const path of [
    join(sourceRoot, 'Cargo.toml'), join(sourceRoot, 'Cargo.lock'), join(sourceRoot, 'src', 'main.rs'),
    join(pluginSourceRoot, '.codex-plugin', 'plugin.json'), join(pluginSourceRoot, '.mcp.json'), join(pluginSourceRoot, 'skills', 'browser-use', 'SKILL.md'),
  ]) file(path)
  const destination = resolve(options.destinationDir)
  const marketplaceRoot = join(destination, '..')
  mkdirSync(join(marketplaceRoot, '.agents', 'plugins'), { recursive: true })
  copyFileSync(join(desktopRoot, 'runtime-assets', 'marketplace.json'), join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json'))
  const root = join(destination, PLUGIN)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(pluginSourceRoot, root, { recursive: true, dereference: false, filter: source => !source.endsWith('/bin') && !source.endsWith('\\bin') })
  run(cargo(), ['build', '--locked', '--release', '--target', options.target, '--manifest-path', join(sourceRoot, 'Cargo.toml')], sourceRoot)
  const built = join(sourceRoot, 'target', options.target, 'release', binary(options.target))
  file(built)
  const staged = join(root, 'bin', binary(options.target))
  mkdirSync(join(root, 'bin'), { recursive: true })
  copyFileSync(built, staged)
  if (!options.target.includes('windows')) chmodSync(staged, 0o755)
  verifyStagedBrowserPlugin(options)
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const verifyOnly = args.includes('--verify')
  const valueFor = (flag: string) => {
    const index = args.indexOf(flag)
    return index < 0 ? undefined : args[index + 1]
  }
  const target = valueFor('--target') ?? process.env.BILLIARDBUDDY_BROWSER_PLUGIN_TARGET ?? detectTarget()
  if (!supported(target)) throw new Error(`不支持的 Browser 插件 target: ${target}`)
  const destinationDir = valueFor('--destination') ?? join(desktopRoot, 'runtime-assets', 'agent-marketplace', 'plugins')
  stageBrowserPlugin({ destinationDir, target, verifyOnly })
  console.log(`[browser-plugin] ${verifyOnly ? 'verified' : 'staged'} for ${target}`)
}
