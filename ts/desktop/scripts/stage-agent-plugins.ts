import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

type SupportedTarget =
  | 'aarch64-apple-darwin'
  | 'x86_64-apple-darwin'
  | 'x86_64-pc-windows-msvc'
  | 'aarch64-pc-windows-msvc'

type AgentPluginStageOptions = {
  destinationDir: string
  target: SupportedTarget
  verifyOnly?: boolean
}

type AgentPluginCliOptions = {
  destinationDir?: string
  target?: string
  verifyOnly: boolean
}

const COMPUTER_USE_PLUGIN = 'billiardbuddy-computer-use'
const desktopRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const sourceRoot = join(repositoryRoot, 'native', COMPUTER_USE_PLUGIN)
const packagedSourceRoot = join(desktopRoot, 'runtime-assets', 'plugins', COMPUTER_USE_PLUGIN)
const macosServiceName = 'BilliardBuddy Computer Use.app'
const windowsServiceName = 'BilliardBuddyComputerUseService.exe'

export function parseAgentPluginCliOptions(argv: string[]): AgentPluginCliOptions {
  let destinationDir: string | undefined
  let target: string | undefined
  let verifyOnly = false
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--verify') {
      verifyOnly = true
      continue
    }
    if (argument === '--destination' || argument === '--target') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} 需要一个值`)
      if (argument === '--destination') destinationDir = value
      else target = value
      index += 1
      continue
    }
    throw new Error(`未知本地插件参数: ${argument}`)
  }
  return { destinationDir, target, verifyOnly }
}

export function detectAgentPluginTarget(
  platform = process.platform,
  arch = process.arch,
): SupportedTarget {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  throw new Error(`不支持的 BilliardBuddy 本地插件平台: ${platform}/${arch}`)
}

export function isSupportedAgentPluginTarget(value: string): value is SupportedTarget {
  return [
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
    'aarch64-pc-windows-msvc',
  ].includes(value)
}

export function computerUseBinaryName(target: SupportedTarget): string {
  return target.includes('windows') ? `${COMPUTER_USE_PLUGIN}.exe` : COMPUTER_USE_PLUGIN
}

function run(command: string, args: string[], cwd?: string): void {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 20 * 60_000 })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n')
    throw new Error(`本地插件命令失败: ${command} ${args.join(' ')}${detail ? `\n${detail}` : ''}`)
  }
}

function cargoCommand(): string {
  const explicit = process.env.CARGO?.trim()
  if (explicit && existsSync(explicit)) return explicit
  const onPath = Bun.which('cargo')
  if (onPath) return onPath
  throw new Error('缺少 Rust Cargo；请在 macOS/Windows 原生构建机或 GitHub Actions 上构建 BilliardBuddy 本地插件')
}

function expectedPluginFiles(destinationDir: string, target: SupportedTarget): string[] {
  const root = join(resolve(destinationDir), COMPUTER_USE_PLUGIN)
  const files = [
    join(resolve(destinationDir), '..', '.agents', 'plugins', 'marketplace.json'),
    join(root, '.codex-plugin', 'plugin.json'),
    join(root, '.mcp.json'),
    join(root, 'skills', 'computer-use', 'SKILL.md'),
    join(root, 'bin', computerUseBinaryName(target)),
  ]
  if (target.includes('apple-darwin')) {
    files.push(join(root, 'bin', macosServiceName, 'Contents', 'Info.plist'))
    files.push(join(root, 'bin', macosServiceName, 'Contents', 'MacOS', 'BilliardBuddyComputerUseService'))
  }
  if (target.includes('windows')) files.push(join(root, 'bin', windowsServiceName))
  return files
}

function requireRegularFile(path: string): void {
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`本地插件缺少正式文件: ${path}`)
  }
}

function validatePluginMetadata(destinationDir: string): void {
  const root = join(resolve(destinationDir), COMPUTER_USE_PLUGIN)
  const manifest = JSON.parse(readFileSync(join(root, '.codex-plugin', 'plugin.json'), 'utf8')) as Record<string, unknown>
  if (manifest.name !== COMPUTER_USE_PLUGIN || manifest.mcpServers !== './.mcp.json' || manifest.skills !== './skills/') {
    throw new Error('Computer Use 插件 manifest 不符合 M1 合同')
  }
  const mcp = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
    mcpServers?: Record<string, { command?: unknown, cwd?: unknown, env_vars?: unknown }>
  }
  const server = mcp.mcpServers?.[COMPUTER_USE_PLUGIN]
  if (
    !server
    || server.command !== `./bin/${COMPUTER_USE_PLUGIN}`
    || server.cwd !== '.'
    || !Array.isArray(server.env_vars)
    || !server.env_vars.includes('CODEX_HOME')
  ) {
    throw new Error('Computer Use 插件 MCP 配置不符合 M1 合同')
  }
  const marketplace = JSON.parse(readFileSync(join(resolve(destinationDir), '..', '.agents', 'plugins', 'marketplace.json'), 'utf8')) as {
    name?: unknown
    plugins?: Array<{ name?: unknown, source?: { source?: unknown, path?: unknown } }>
  }
  const entry = marketplace.plugins?.find(candidate => candidate.name === COMPUTER_USE_PLUGIN)
  if (marketplace.name !== 'billiardbuddy-local' || entry?.source?.source !== 'local' || entry?.source?.path !== `./plugins/${COMPUTER_USE_PLUGIN}`) {
    throw new Error('BilliardBuddy 本地市场缺少 Computer Use 插件')
  }
}

function adHocSignMacBinary(path: string): void {
  if (process.platform !== 'darwin') return
  run('codesign', ['--sign', '-', '--force', '--timestamp=none', path])
}

function stageMacComputerUseService(destinationBin: string, target: SupportedTarget): void {
  const source = join(sourceRoot, 'macos', 'BilliardBuddyComputerUseService.swift')
  const infoPlist = join(sourceRoot, 'macos', 'Info.plist')
  requireRegularFile(source)
  requireRegularFile(infoPlist)
  const swiftc = process.env.SWIFTC?.trim() || Bun.which('swiftc')
  if (!swiftc) {
    throw new Error('缺少 Swift 编译器；macOS Computer Use 原生服务必须在 macOS 原生构建机或 GitHub Actions 上构建')
  }
  const serviceRoot = join(destinationBin, macosServiceName)
  const serviceExecutable = join(serviceRoot, 'Contents', 'MacOS', 'BilliardBuddyComputerUseService')
  rmSync(serviceRoot, { recursive: true, force: true })
  mkdirSync(join(serviceRoot, 'Contents', 'MacOS'), { recursive: true })
  copyFileSync(infoPlist, join(serviceRoot, 'Contents', 'Info.plist'))
  run(swiftc, [
    '-O',
    '-target', target === 'aarch64-apple-darwin' ? 'arm64-apple-macos14.0' : 'x86_64-apple-macos14.0',
    '-framework', 'AppKit',
    '-framework', 'ApplicationServices',
    '-framework', 'CoreGraphics',
    '-framework', 'CoreImage',
    '-framework', 'CoreMedia',
    '-framework', 'ScreenCaptureKit',
    source,
    '-o', serviceExecutable,
  ])
  chmodSync(serviceExecutable, 0o755)
  adHocSignMacBinary(serviceRoot)
}

function stageWindowsComputerUseService(destinationBin: string): void {
  const source = join(sourceRoot, 'windows', 'BilliardBuddyComputerUseService.cpp')
  requireRegularFile(source)
  const service = join(destinationBin, windowsServiceName)
  rmSync(service, { force: true })
  const compilerArguments = [
    '/nologo', '/std:c++20', '/O2', '/EHsc', '/DUNICODE', '/D_UNICODE', source, `/Fe${service}`,
    '/link', 'Crypt32.lib', 'Gdi32.lib', 'Ole32.lib', 'OleAut32.lib', 'Shell32.lib', 'UIAutomationCore.lib', 'Windowscodecs.lib',
  ]
  const compiler = process.env.CXX?.trim() || Bun.which('cl.exe') || Bun.which('cl')
  if (compiler) {
    run(compiler, compilerArguments)
    return
  }
  const programFilesX86 = process.env['ProgramFiles(x86)']
  const vswhere = programFilesX86 && join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!vswhere || !existsSync(vswhere)) {
    throw new Error('缺少 MSVC C++ 编译器；Windows Computer Use 原生服务必须在 Windows 原生构建机或 GitHub Actions 上构建')
  }
  const lookup = spawnSync(vswhere, [
    '-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath',
  ], { encoding: 'utf8', timeout: 60_000 })
  const installation = lookup.status === 0 ? lookup.stdout.trim() : ''
  const vcvars = installation && join(installation, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
  if (!vcvars || !existsSync(vcvars)) {
    throw new Error('Windows 构建机没有可用的 MSVC x64 工具链')
  }
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`
  // Do not pass /s here. Its special quote stripping breaks a Visual Studio
  // installation path containing spaces before `call` can initialize MSVC.
  run(process.env.ComSpec || 'cmd.exe', [
    '/d', '/c',
    `call ${quote(vcvars)} >nul && cl.exe ${compilerArguments.map(quote).join(' ')}`,
  ])
}

export function verifyStagedAgentPlugins(options: AgentPluginStageOptions): void {
  const pluginRoot = join(resolve(options.destinationDir), COMPUTER_USE_PLUGIN)
  for (const path of expectedPluginFiles(options.destinationDir, options.target)) requireRegularFile(path)
  validatePluginMetadata(options.destinationDir)
  const binary = join(pluginRoot, 'bin', computerUseBinaryName(options.target))
  if (lstatSync(binary).size < 100_000) throw new Error(`Computer Use 插件二进制大小无效: ${basename(binary)}`)
  if (options.target.includes('apple-darwin')) {
    const service = join(pluginRoot, 'bin', macosServiceName, 'Contents', 'MacOS', 'BilliardBuddyComputerUseService')
    if (lstatSync(service).size < 100_000) throw new Error('Computer Use macOS 原生服务二进制大小无效')
  }
  if (options.target.includes('windows')) {
    const service = join(pluginRoot, 'bin', windowsServiceName)
    if (lstatSync(service).size < 100_000) throw new Error('Computer Use Windows 原生服务二进制大小无效')
  }
}

export function stageAgentPlugins(options: AgentPluginStageOptions): void {
  if (options.verifyOnly) return verifyStagedAgentPlugins(options)
  for (const path of [
    join(sourceRoot, 'Cargo.toml'),
    join(sourceRoot, 'Cargo.lock'),
    join(sourceRoot, 'src', 'main.rs'),
    join(sourceRoot, 'windows', 'BilliardBuddyComputerUseService.cpp'),
    join(packagedSourceRoot, '.codex-plugin', 'plugin.json'),
    join(packagedSourceRoot, '.mcp.json'),
    join(packagedSourceRoot, 'skills', 'computer-use', 'SKILL.md'),
  ]) requireRegularFile(path)

  const cargo = cargoCommand()
  run(cargo, [
    'build', '--locked', '--release', '--target', options.target,
    '--manifest-path', join(sourceRoot, 'Cargo.toml'),
  ], sourceRoot)

  const sourceBinary = join(sourceRoot, 'target', options.target, 'release', computerUseBinaryName(options.target))
  requireRegularFile(sourceBinary)
  const destination = resolve(options.destinationDir)
  const marketplaceRoot = join(destination, '..')
  const marketplaceDestination = join(marketplaceRoot, '.agents', 'plugins', 'marketplace.json')
  mkdirSync(join(marketplaceRoot, '.agents', 'plugins'), { recursive: true })
  copyFileSync(join(desktopRoot, 'runtime-assets', 'marketplace.json'), marketplaceDestination)
  const pluginDestination = join(destination, COMPUTER_USE_PLUGIN)
  rmSync(pluginDestination, { recursive: true, force: true })
  cpSync(packagedSourceRoot, pluginDestination, { recursive: true, dereference: false })
  const destinationBin = join(pluginDestination, 'bin')
  mkdirSync(destinationBin, { recursive: true })
  const stagedBinary = join(destinationBin, computerUseBinaryName(options.target))
  copyFileSync(sourceBinary, stagedBinary)
  if (!options.target.includes('windows')) {
    chmodSync(stagedBinary, 0o755)
    adHocSignMacBinary(stagedBinary)
    stageMacComputerUseService(destinationBin, options.target)
  } else {
    stageWindowsComputerUseService(destinationBin)
  }
  verifyStagedAgentPlugins(options)
}

if (import.meta.main) {
  const cli = parseAgentPluginCliOptions(process.argv.slice(2))
  const requestedTarget = cli.target ?? process.env.BILLIARDBUDDY_AGENT_PLUGIN_TARGET ?? detectAgentPluginTarget()
  if (!isSupportedAgentPluginTarget(requestedTarget)) throw new Error(`不支持的本地插件 target: ${requestedTarget}`)
  const destinationDir = cli.destinationDir ?? join(desktopRoot, 'runtime-assets', 'agent-marketplace', 'plugins')
  stageAgentPlugins({ destinationDir, target: requestedTarget, verifyOnly: cli.verifyOnly })
  console.log(`[agent-plugins] ${cli.verifyOnly ? 'verified' : 'staged'} for ${requestedTarget}`)
}
