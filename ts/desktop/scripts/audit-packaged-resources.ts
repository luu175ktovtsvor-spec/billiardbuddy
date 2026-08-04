import { extractFile, listPackage } from '@electron/asar'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { detectCodexEngineTarget, verifyStagedCodexEngine } from './stage-codex-engine'
import { stageMediaToolchain } from './stage-media-toolchain'

type Platform = 'darwin' | 'win32'

type AuditOptions = {
  resourcesDir: string
  platform: Platform
}

const requiredEntries = [
  '/dist/index.html',
  '/electron-dist/main.cjs',
  '/electron-dist/preload.cjs',
  '/package.json',
]

const allowedElectronEntries = new Set([
  '/electron-dist/main.cjs',
  '/electron-dist/preload.cjs',
])

const forbiddenProductStrings = [
  'attachMediaProject',
  'Claude Code',
  'CLAUDE.md',
  '.claude-plugin',
  'claude-api',
  'good-claude',
  'GW_MIMO_NATIVE',
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__',
  'qwenChat',
  '/api/v1/chat',
  '/api/v1/qwen',
  '/api/product/tasks/',
  '/ws/product/tasks/',
  'src-tauri',
  'ProductTask',
  'agent-worker',
  'preview-agent',
  'desktop:browser:',
  'desktop:preview:',
  'desktop:terminal:',
  'client_react_error_boundary',
  'node-pty',
]

function parseArgs(argv: string[]): AuditOptions {
  let resourcesDir: string | undefined
  let platform: Platform | undefined
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!value) throw new Error(`${name ?? '参数'} 需要一个值`)
    if (name === '--resources') resourcesDir = value
    else if (name === '--platform' && (value === 'darwin' || value === 'win32')) platform = value
    else throw new Error(`未知安装包审计参数: ${name} ${value}`)
  }
  if (!resourcesDir) throw new Error('安装包审计缺少 --resources')
  if (!platform) throw new Error('安装包审计缺少有效的 --platform')
  return { resourcesDir: resolve(resourcesDir), platform }
}

function parseJsonFile(path: string): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync(path, 'utf8'))
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${basename(path)} 不是对象`)
  return parsed as Record<string, unknown>
}

function requireExactKeys(value: Record<string, unknown>, expected: string[], label: string): void {
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} 字段不符合发行合同: ${actual.join(', ')}`)
  }
}

function auditProductArchive(archive: string): void {
  if (!existsSync(archive)) throw new Error(`安装包缺少 app.asar: ${archive}`)
  const archiveEntries = listPackage(archive, { isPack: false })
  const archiveEntryByPortablePath = new Map(
    archiveEntries.map((entry) => [entry.replaceAll('\\', '/'), entry]),
  )
  const entries = [...archiveEntryByPortablePath.keys()]
  for (const entry of requiredEntries) {
    if (!entries.includes(entry)) throw new Error(`app.asar 缺少正式运行文件: ${entry}`)
  }
  const unexpectedElectronEntry = entries.find((entry) => (
    entry.startsWith('/electron-dist/') && !allowedElectronEntries.has(entry)
  ))
  if (unexpectedElectronEntry) {
    throw new Error(`app.asar 残留非正式 Electron 产物: ${unexpectedElectronEntry}`)
  }
  const forbiddenPath = entries.find((entry) =>
    !entry.startsWith('/node_modules/')
    && /(?:^|\/)(?:src-tauri|query|core|cli|tui)(?:\/|$)/i.test(entry))
  if (forbiddenPath) throw new Error(`app.asar 残留旧运行路径: ${forbiddenPath}`)

  const productTextEntries = entries.filter((entry) =>
    entry === '/dist/index.html'
    || entry === '/package.json'
    || /^\/dist\/assets\/.*\.js$/.test(entry)
    || /^\/electron-dist\/.*\.cjs$/.test(entry))
  for (const entry of productTextEntries) {
    const archiveEntry = archiveEntryByPortablePath.get(entry)
    if (!archiveEntry) throw new Error(`app.asar 无法解析正式运行文件: ${entry}`)
    const value = extractFile(archive, archiveEntry.slice(1)).toString('utf8')
    const forbidden = forbiddenProductStrings.find((candidate) => value.includes(candidate))
    if (forbidden) throw new Error(`app.asar 的 ${entry} 残留旧运行字符串: ${forbidden}`)
  }

  const packaged = JSON.parse(extractFile(archive, 'package.json').toString('utf8')) as {
    name?: string
    main?: string
    dependencies?: Record<string, string>
  }
  if (packaged.name !== 'billiardbuddy-desktop' || packaged.main !== 'electron-dist/main.cjs') {
    throw new Error('app.asar package.json 不是正式 BilliardBuddy Electron 入口')
  }
  const sourcePackage = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
  }
  if (JSON.stringify(packaged.dependencies) !== JSON.stringify(sourcePackage.dependencies)) {
    throw new Error('安装包依赖与当前正式依赖清单不一致')
  }
}

export function auditPackagedResources(options: AuditOptions): void {
  const resources = resolve(options.resourcesDir)
  auditProductArchive(join(resources, 'app.asar'))

  const productConfig = parseJsonFile(join(resources, 'product-config.json'))
  requireExactKeys(productConfig, ['$comment', 'gatewayUrl', 'imageRelayUrl'], 'product-config.json')
  if (typeof productConfig.gatewayUrl !== 'string' || !/^https:\/\//.test(productConfig.gatewayUrl)) {
    throw new Error('product-config.json 缺少 HTTPS Gateway 地址')
  }
  if (productConfig.imageRelayUrl !== 'https://zzyppz.cn/image-generation') {
    throw new Error('product-config.json 缺少正式 HTTPS Image Relay 地址')
  }
  if (existsSync(join(resources, 'product-secrets.json'))) {
    throw new Error('安装包不得包含 product-secrets.json')
  }

  const toolchainDir = join(resources, 'app.asar.unpacked', 'runtime-assets', 'binaries')
  stageMediaToolchain({ destinationDir: toolchainDir, platform: options.platform, verifyOnly: true })
  verifyStagedCodexEngine({
    destinationDir: toolchainDir,
    target: detectCodexEngineTarget(options.platform, options.platform === 'darwin' ? 'arm64' : 'x64'),
    verifyOnly: true,
  })
  const sidecar = options.platform === 'darwin'
    ? 'billiardbuddy-sidecar-aarch64-apple-darwin'
    : 'billiardbuddy-sidecar-x86_64-pc-windows-msvc.exe'
  const sidecarPath = join(toolchainDir, sidecar)
  if (!existsSync(sidecarPath)) throw new Error(`安装包缺少正式 sidecar: ${sidecar}`)
  const sidecarBytes = readFileSync(sidecarPath)
  // Bun's standalone runtime embeds one upstream build-rule filename. It is
  // compiler payload, not BilliardBuddy source or prompt, so exclude only that
  // runtime-owned filename while auditing every other product marker.
  const forbiddenSidecarString = forbiddenProductStrings
    .filter(candidate => candidate !== 'CLAUDE.md')
    .find(candidate => sidecarBytes.includes(Buffer.from(candidate)))
  if (forbiddenSidecarString) {
    throw new Error(`安装包 sidecar 残留旧运行字符串: ${forbiddenSidecarString}`)
  }
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  auditPackagedResources(options)
  console.log(`[package-audit] passed for ${options.platform}: ${options.resourcesDir}`)
}
