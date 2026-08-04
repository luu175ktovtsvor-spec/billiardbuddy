import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveCargoCommand, runMsvcCompiler, verifyProductContent, verifyProductSkill, verifyStdioMcpHandshake } from './native-build-tools'

type Target = 'aarch64-apple-darwin' | 'x86_64-apple-darwin' | 'x86_64-pc-windows-msvc' | 'aarch64-pc-windows-msvc'
type Options = { destinationDir: string, target: Target, verifyOnly?: boolean }
const PLUGIN = 'billiardbuddy-record-replay'
const MAC_APP = 'BilliardBuddy Record Replay.app'
const WINDOWS_SERVICE = 'BilliardBuddyRecordReplayService.exe'
const desktopRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const sourceRoot = join(repositoryRoot, 'native', PLUGIN)
const pluginSource = join(desktopRoot, 'runtime-assets', 'plugins', PLUGIN)

function detect(platform = process.platform, arch = process.arch): Target {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  throw new Error(`不支持的 Record and Replay 插件平台: ${platform}/${arch}`)
}
function supported(value: string): value is Target { return ['aarch64-apple-darwin', 'x86_64-apple-darwin', 'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc'].includes(value) }
function binary(target: Target) { return target.includes('windows') ? `${PLUGIN}.exe` : PLUGIN }
function file(path: string) { if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`Record and Replay 插件缺少正式文件: ${path}`) }
function run(command: string, arguments_: string[], cwd?: string) {
  const result = spawnSync(command, arguments_, { cwd, encoding: 'utf8', timeout: 20 * 60_000 })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter((value): value is string => Boolean(value?.trim())).join('\n')
    throw new Error(`Record and Replay 构建命令失败: ${command} ${arguments_.join(' ')}${detail ? `\n${detail}` : ''}`)
  }
}
function cargo() { return resolveCargoCommand('缺少 Rust Cargo；请在原生构建机或 GitHub Actions 上构建 Record and Replay 插件') }
function macService(destination: string, target: Target) {
  const source = join(sourceRoot, 'macos', 'BilliardBuddyRecordReplayService.swift'); const info = join(sourceRoot, 'macos', 'Info.plist'); file(source); file(info)
  const swiftc = process.env.SWIFTC?.trim() || Bun.which('swiftc'); if (!swiftc) throw new Error('缺少 Swift 编译器')
  const root = join(destination, MAC_APP); const executable = join(root, 'Contents', 'MacOS', 'BilliardBuddyRecordReplayService'); rmSync(root, { recursive: true, force: true }); mkdirSync(join(root, 'Contents', 'MacOS'), { recursive: true }); copyFileSync(info, join(root, 'Contents', 'Info.plist'))
  run(swiftc, ['-O', '-target', target === 'aarch64-apple-darwin' ? 'arm64-apple-macos14.0' : 'x86_64-apple-macos14.0', '-framework', 'AppKit', '-framework', 'ApplicationServices', source, '-o', executable])
  chmodSync(executable, 0o755); run('codesign', ['--sign', '-', '--force', '--timestamp=none', root])
}
function windowsService(destination: string) {
  const source = join(sourceRoot, 'windows', 'BilliardBuddyRecordReplayService.cpp'); file(source); const output = join(destination, WINDOWS_SERVICE); rmSync(output, { force: true })
  const arguments_ = ['/nologo', '/std:c++20', '/O2', '/EHsc', '/DUNICODE', '/D_UNICODE', source, `/Fe${output}`, '/link', 'User32.lib']
  const compiler = process.env.CXX?.trim() || Bun.which('cl.exe') || Bun.which('cl'); if (compiler) return run(compiler, arguments_)
  const programFilesX86 = process.env['ProgramFiles(x86)']; const vswhere = programFilesX86 && join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe'); if (!vswhere || !existsSync(vswhere)) throw new Error('缺少 MSVC C++ 编译器')
  const result = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', timeout: 60_000 }); const install = result.status === 0 ? result.stdout.trim() : ''; const vcvars = install && join(install, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat'); if (!vcvars || !existsSync(vcvars)) throw new Error('Windows 构建机没有可用的 MSVC x64 工具链')
  runMsvcCompiler(vcvars, arguments_, 'Record and Replay Windows 原生服务编译失败')
}

export function verifyStagedRecordReplayPlugin(options: Options) {
  const root = join(resolve(options.destinationDir), PLUGIN)
  for (const path of [join(root, '.codex-plugin', 'plugin.json'), join(root, '.mcp.json'), join(root, 'skills', 'record-and-replay', 'SKILL.md'), join(root, 'bin', binary(options.target))]) file(path)
  const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8')) as { name?: unknown, mcpServers?: unknown, skills?: unknown }
  if (manifest.name !== PLUGIN || manifest.mcpServers !== './.mcp.json' || manifest.skills !== './skills/') throw new Error('Record and Replay 插件 manifest 无效')
  verifyProductContent(join(root, '.codex-plugin', 'plugin.json'))
  verifyProductSkill(join(root, 'skills', 'record-and-replay', 'SKILL.md'))
  const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as { mcpServers?: Record<string, { command?: unknown, cwd?: unknown, env_vars?: unknown }> }; const server = mcp.mcpServers?.[PLUGIN]
  if (server?.command !== `./bin/${PLUGIN}` || server.cwd !== '.' || !Array.isArray(server.env_vars) || !server.env_vars.includes('CODEX_HOME')) throw new Error('Record and Replay MCP 配置无效')
  const marketplace = JSON.parse(readFileSync(join(resolve(options.destinationDir), '..', '.agents', 'plugins', 'marketplace.json'), 'utf8')) as { plugins?: Array<{ name?: unknown, source?: { path?: unknown } }> }
  if (!marketplace.plugins?.some(entry => entry.name === PLUGIN && entry.source?.path === `./plugins/${PLUGIN}`)) throw new Error('本地市场缺少 Record and Replay 插件')
  const staged = join(root, 'bin', binary(options.target))
  if (lstatSync(staged).size < 100_000) throw new Error('Record and Replay MCP 二进制大小无效')
  verifyStdioMcpHandshake(staged, options.target, PLUGIN)
  const service = options.target.includes('windows') ? join(root, 'bin', WINDOWS_SERVICE) : join(root, 'bin', MAC_APP, 'Contents', 'MacOS', 'BilliardBuddyRecordReplayService')
  file(service); if (lstatSync(service).size < 100_000) throw new Error('Record and Replay 原生录制器二进制大小无效')
}

export function stageRecordReplayPlugin(options: Options) {
  if (options.verifyOnly) return verifyStagedRecordReplayPlugin(options)
  for (const path of [join(sourceRoot, 'Cargo.toml'), join(sourceRoot, 'Cargo.lock'), join(sourceRoot, 'src', 'main.rs'), join(sourceRoot, 'macos', 'BilliardBuddyRecordReplayService.swift'), join(sourceRoot, 'windows', 'BilliardBuddyRecordReplayService.cpp'), join(pluginSource, '.codex-plugin', 'plugin.json'), join(pluginSource, '.mcp.json'), join(pluginSource, 'skills', 'record-and-replay', 'SKILL.md')]) file(path)
  if (readFileSync(join(sourceRoot, 'windows', 'BilliardBuddyRecordReplayService.cpp'), 'utf8').includes('windowTitle')) throw new Error('Record and Replay 不得记录 Windows 窗口标题')
  const destination = resolve(options.destinationDir); const market = join(destination, '..'); mkdirSync(join(market, '.agents', 'plugins'), { recursive: true }); copyFileSync(join(desktopRoot, 'runtime-assets', 'marketplace.json'), join(market, '.agents', 'plugins', 'marketplace.json'))
  const root = join(destination, PLUGIN); rmSync(root, { recursive: true, force: true }); mkdirSync(destination, { recursive: true }); cpSync(pluginSource, root, { recursive: true, dereference: false, filter: source => !source.endsWith('/bin') && !source.endsWith('\\bin') }); const bin = join(root, 'bin'); mkdirSync(bin, { recursive: true })
  run(cargo(), ['build', '--locked', '--release', '--target', options.target, '--manifest-path', join(sourceRoot, 'Cargo.toml')], sourceRoot); const built = join(sourceRoot, 'target', options.target, 'release', binary(options.target)); file(built); const staged = join(bin, binary(options.target)); copyFileSync(built, staged); if (!options.target.includes('windows')) { chmodSync(staged, 0o755); macService(bin, options.target) } else windowsService(bin)
  verifyStagedRecordReplayPlugin(options)
}

if (import.meta.main) {
  const args = process.argv.slice(2); const valueFor = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1] }; const target = valueFor('--target') ?? process.env.BILLIARDBUDDY_RECORD_REPLAY_PLUGIN_TARGET ?? detect(); if (!supported(target)) throw new Error(`不支持的 Record and Replay target: ${target}`)
  stageRecordReplayPlugin({ destinationDir: valueFor('--destination') ?? join(desktopRoot, 'runtime-assets', 'agent-marketplace', 'plugins'), target, verifyOnly: args.includes('--verify') }); console.log(`[record-replay-plugin] ${args.includes('--verify') ? 'verified' : 'staged'} for ${target}`)
}
