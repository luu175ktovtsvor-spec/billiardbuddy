import { extractFile, listPackage } from '@electron/asar'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
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
  '/electron-dist/preview-preload.cjs',
  '/package.json',
  '/runtime-assets/resources/preview-agent.js',
]

const forbiddenProductStrings = [
  'attachMediaProject',
  'GW_MIMO_NATIVE',
  'qwenChat',
  '/api/v1/chat',
  '/api/v1/qwen',
  'src-tauri',
  'computer-use',
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
  const entries = listPackage(archive, { isPack: false })
    .map((entry) => entry.replaceAll('\\', '/'))
  for (const entry of requiredEntries) {
    if (!entries.includes(entry)) throw new Error(`app.asar 缺少正式运行文件: ${entry}`)
  }
  const forbiddenPath = entries.find((entry) =>
    !entry.startsWith('/node_modules/')
    && /(?:^|\/)(?:src-tauri|query|core|cli|tui)(?:\/|$)/i.test(entry))
  if (forbiddenPath) throw new Error(`app.asar 残留旧运行路径: ${forbiddenPath}`)

  const productTextEntries = entries.filter((entry) =>
    entry === '/dist/index.html'
    || entry === '/package.json'
    || /^\/dist\/assets\/.*\.js$/.test(entry)
    || /^\/electron-dist\/.*\.cjs$/.test(entry)
    || entry === '/runtime-assets/resources/preview-agent.js')
  for (const entry of productTextEntries) {
    const value = extractFile(archive, entry.slice(1)).toString('utf8')
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

  for (const extensionFile of ['manifest.json', 'service-worker.js', 'content-script.js']) {
    if (!existsSync(join(resources, 'browser-extension', extensionFile))) {
      throw new Error(`安装包缺少受控浏览器扩展文件: ${extensionFile}`)
    }
  }

  const productConfig = parseJsonFile(join(resources, 'product-config.json'))
  requireExactKeys(productConfig, ['$comment', 'gatewayUrl'], 'product-config.json')
  if (typeof productConfig.gatewayUrl !== 'string' || !/^https:\/\//.test(productConfig.gatewayUrl)) {
    throw new Error('product-config.json 缺少 HTTPS Gateway 地址')
  }
  const productSecrets = parseJsonFile(join(resources, 'product-secrets.json'))
  requireExactKeys(productSecrets, ['gatewayBootstrapCredential', 'licenseKey'], 'product-secrets.json')
  for (const key of ['gatewayBootstrapCredential', 'licenseKey']) {
    if (typeof productSecrets[key] !== 'string' || !productSecrets[key].trim()) {
      throw new Error(`product-secrets.json 缺少 ${key}`)
    }
  }

  const toolchainDir = join(resources, 'app.asar.unpacked', 'runtime-assets', 'binaries')
  stageMediaToolchain({ destinationDir: toolchainDir, platform: options.platform, verifyOnly: true })
  const sidecar = options.platform === 'darwin'
    ? 'billiardbuddy-sidecar-aarch64-apple-darwin'
    : 'billiardbuddy-sidecar-x86_64-pc-windows-msvc.exe'
  if (!existsSync(join(toolchainDir, sidecar))) throw new Error(`安装包缺少正式 sidecar: ${sidecar}`)
}

if (import.meta.main) {
  const options = parseArgs(process.argv.slice(2))
  auditPackagedResources(options)
  console.log(`[package-audit] passed for ${options.platform}: ${options.resourcesDir}`)
}
