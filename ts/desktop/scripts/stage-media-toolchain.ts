import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { chmodSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { type WindowsNativeTarget, verifyWindowsPeMachine } from './native-build-tools'

type SupportedPlatform = 'darwin' | 'win32'

type BinaryHashMode = 'sha256' | 'mach-o-code-signature-neutral-sha256'

type SourceManifest = {
  schemaVersion: 1
  version: string
  license: 'LGPL-2.1-or-later' | 'LGPL-3.0-or-later'
  sourceUrl: string
  licenseSha256: string
  files: Record<string, string>
  binaryHashMode?: BinaryHashMode
}

type StagedManifest = Omit<SourceManifest, 'binaryHashMode'> & {
  binaryHashMode: BinaryHashMode
  buildConfiguration: string
  binaryVersion: string
}

export type MediaToolchainStageOptions = {
  sourceDir?: string
  destinationDir: string
  platform: SupportedPlatform
  target?: WindowsNativeTarget
  verifyOnly?: boolean
}

export type MediaToolchainCliOptions = {
  destinationDir?: string
  platform?: string
  target?: string
  verifyOnly: boolean
}

const SOURCE_MANIFEST = 'media-toolchain-source.json'
const STAGED_MANIFEST = 'media-toolchain-manifest.json'
const LICENSE_FILE = 'media-toolchain-LICENSE.txt'

function binaryNames(platform: SupportedPlatform): [string, string] {
  return platform === 'win32' ? ['ffmpeg.exe', 'ffprobe.exe'] : ['ffmpeg', 'ffprobe']
}

export function parseMediaToolchainCliOptions(argv: string[]): MediaToolchainCliOptions {
  let destinationDir: string | undefined
  let platform: string | undefined
  let target: string | undefined
  let verifyOnly = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--verify') {
      verifyOnly = true
      continue
    }
    if (argument === '--destination' || argument === '--platform' || argument === '--target') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} 需要一个值`)
      if (argument === '--destination') destinationDir = value
      else if (argument === '--platform') platform = value
      else target = value
      index += 1
      continue
    }
    throw new Error(`未知媒体工具链参数: ${argument}`)
  }

  return { destinationDir, platform, target, verifyOnly }
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function isThinMachO64(path: string): boolean {
  const bytes = readFileSync(path)
  return bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf
}

export function machOCodeSignatureNeutralSha256(path: string): string {
  const bytes = readFileSync(path)
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf) {
    throw new Error(`不是受支持的 64 位小端 Mach-O 文件: ${path}`)
  }

  const commandCount = bytes.readUInt32LE(16)
  const commandsSize = bytes.readUInt32LE(20)
  const commandsEnd = 32 + commandsSize
  if (commandsEnd > bytes.length) throw new Error(`Mach-O load commands 越界: ${path}`)

  const normalized = Buffer.from(bytes)
  let commandOffset = 32
  let signatureOffset: number | undefined
  let signatureSize: number | undefined
  let linkEditFound = false
  for (let index = 0; index < commandCount; index += 1) {
    if (commandOffset + 8 > commandsEnd) throw new Error(`Mach-O load command 不完整: ${path}`)
    const command = bytes.readUInt32LE(commandOffset)
    const commandSize = bytes.readUInt32LE(commandOffset + 4)
    if (commandSize < 8 || commandOffset + commandSize > commandsEnd) {
      throw new Error(`Mach-O load command 大小无效: ${path}`)
    }
    if (command === 0x1d) {
      if (commandSize < 16 || signatureOffset !== undefined) {
        throw new Error(`Mach-O code signature command 无效: ${path}`)
      }
      signatureOffset = bytes.readUInt32LE(commandOffset + 8)
      signatureSize = bytes.readUInt32LE(commandOffset + 12)
      normalized.writeUInt32LE(0, commandOffset + 8)
      normalized.writeUInt32LE(0, commandOffset + 12)
    }
    if (command === 0x19 && commandSize >= 72) {
      const segmentName = bytes.subarray(commandOffset + 8, commandOffset + 24)
        .toString('utf8')
        .replace(/\0+$/, '')
      if (segmentName === '__LINKEDIT') {
        if (linkEditFound) throw new Error(`Mach-O 包含重复的 __LINKEDIT segment: ${path}`)
        linkEditFound = true
        // codesign extends __LINKEDIT to fit the new signature and updates these
        // two sizes. All other segment metadata and executable bytes remain hashed.
        normalized.writeBigUInt64LE(0n, commandOffset + 32)
        normalized.writeBigUInt64LE(0n, commandOffset + 48)
      }
    }
    commandOffset += commandSize
  }
  if (commandOffset !== commandsEnd) throw new Error(`Mach-O load commands 长度不一致: ${path}`)
  if (signatureOffset === undefined || signatureSize === undefined) {
    throw new Error(`Mach-O 缺少 code signature command: ${path}`)
  }
  if (!linkEditFound) throw new Error(`Mach-O 缺少 __LINKEDIT segment: ${path}`)
  if (signatureOffset < commandsEnd || signatureOffset + signatureSize > bytes.length) {
    throw new Error(`Mach-O code signature 区域越界: ${path}`)
  }

  return createHash('sha256')
    .update(normalized.subarray(0, signatureOffset))
    .update(normalized.subarray(signatureOffset + signatureSize))
    .digest('hex')
}

function binaryHash(path: string, mode: BinaryHashMode): string {
  return mode === 'mach-o-code-signature-neutral-sha256'
    ? machOCodeSignatureNeutralSha256(path)
    : sha256(path)
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T
}

function validateMetadata(manifest: SourceManifest): void {
  if (manifest.schemaVersion !== 1 || !manifest.version.trim()) throw new Error('媒体工具链 manifest 缺少有效版本')
  if (!['LGPL-2.1-or-later', 'LGPL-3.0-or-later'].includes(manifest.license)) {
    throw new Error(`媒体工具链只接受审核过的 LGPL 构建，当前为 ${manifest.license}`)
  }
  if (!/^https:\/\//.test(manifest.sourceUrl)) throw new Error('媒体工具链 manifest 必须记录 HTTPS 源码地址')
  if (!/^[a-f0-9]{64}$/.test(manifest.licenseSha256?.toLowerCase() ?? '')) {
    throw new Error('媒体工具链 manifest 缺少许可证文件 SHA-256')
  }
  if (manifest.binaryHashMode && !['sha256', 'mach-o-code-signature-neutral-sha256'].includes(manifest.binaryHashMode)) {
    throw new Error(`媒体工具链 manifest 使用了不支持的二进制哈希模式: ${manifest.binaryHashMode}`)
  }
}

function verifyBuildConfiguration(value: string): void {
  if (/--enable-(?:gpl|nonfree)(?:\s|$)/i.test(value)) {
    throw new Error('媒体工具链包含 GPL 或 nonfree 构建参数，不能进入当前安装包')
  }
}

function inspectBinary(path: string, args: string[]): string {
  const result = spawnSync(path, args, { encoding: 'utf8', timeout: 15_000 })
  if (result.error || result.status !== 0) {
    throw new Error(`无法执行媒体工具 ${path}: ${result.error?.message ?? result.stderr ?? `exit ${result.status}`}`)
  }
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
}

type BinaryAudit = {
  version: string
  buildConfiguration: string
}

function normalizedBuildConfiguration(value: string): string {
  const flags = value.match(/--[^\s]+/g) ?? []
  if (flags.length === 0) throw new Error('媒体工具链无法读取构建参数')
  return [...new Set(flags)].sort().join(' ')
}

function binaryVersion(value: string, name: string): string {
  const match = /(?:ffmpeg|ffprobe) version\s+([^\s]+)/i.exec(value)
  if (!match?.[1]) throw new Error(`无法读取 ${name} 版本`)
  return match[1]
}

function verifyBinaryLicense(value: string, name: string): void {
  if (!/GNU\s+Lesser\s+General\s+Public\s+License/i.test(value)) {
    throw new Error(`${name} 未声明 GNU Lesser General Public License`)
  }
}

function auditBinary(path: string, name: string): BinaryAudit {
  const versionOutput = inspectBinary(path, ['-version'])
  const buildConfiguration = normalizedBuildConfiguration(inspectBinary(path, ['-hide_banner', '-buildconf']))
  verifyBuildConfiguration(buildConfiguration)
  verifyBinaryLicense(inspectBinary(path, ['-L']), name)
  return {
    version: binaryVersion(versionOutput, name),
    buildConfiguration,
  }
}

function verifyMatchingBinaries(
  directory: string,
  names: [string, string],
  manifest: SourceManifest,
): BinaryAudit {
  const ffmpeg = auditBinary(join(directory, names[0]), names[0])
  const ffprobe = auditBinary(join(directory, names[1]), names[1])
  if (ffmpeg.version !== ffprobe.version) throw new Error('ffmpeg 与 ffprobe 版本不一致')
  if (ffmpeg.buildConfiguration !== ffprobe.buildConfiguration) {
    throw new Error('ffmpeg 与 ffprobe 构建参数不一致')
  }
  const expectedLicense = ffmpeg.buildConfiguration.includes('--enable-version3')
    ? 'LGPL-3.0-or-later'
    : 'LGPL-2.1-or-later'
  if (manifest.license !== expectedLicense) {
    throw new Error(`媒体工具链许可证与构建参数不一致，应为 ${expectedLicense}`)
  }
  return ffmpeg
}

function verifyLicenseFile(directory: string, fileName: string, manifest: SourceManifest): void {
  const path = join(directory, fileName)
  if (!existsSync(path)) throw new Error(`缺少媒体工具链许可证: ${path}`)
  if (sha256(path) !== manifest.licenseSha256.toLowerCase()) {
    throw new Error('媒体工具链许可证 SHA-256 不匹配')
  }
  if (!/GNU\s+LESSER\s+GENERAL\s+PUBLIC\s+LICENSE/i.test(readFileSync(path, 'utf8'))) {
    throw new Error('媒体工具链许可证文件不是 GNU Lesser General Public License')
  }
}

function verifyHashes(directory: string, manifest: SourceManifest, names: string[]): void {
  const mode = manifest.binaryHashMode ?? 'sha256'
  for (const name of names) {
    const path = join(directory, name)
    if (!existsSync(path)) throw new Error(`缺少媒体工具链文件: ${path}`)
    const expected = manifest.files[name]?.toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(expected ?? '')) throw new Error(`manifest 缺少 ${name} 的 SHA-256`)
    const actual = binaryHash(path, mode)
    if (actual !== expected) throw new Error(`${name} SHA-256 不匹配`)
  }
}

function verifiedWindowsTarget(platform: SupportedPlatform, target: string | undefined): WindowsNativeTarget | undefined {
  if (platform !== 'win32') return undefined
  if (target === 'x86_64-pc-windows-msvc' || target === 'aarch64-pc-windows-msvc') return target
  throw new Error('Windows 媒体工具链必须指定 x86_64-pc-windows-msvc 或 aarch64-pc-windows-msvc target')
}

function verifyWindowsMediaMachine(directory: string, names: string[], target: WindowsNativeTarget | undefined): void {
  if (!target) return
  for (const name of names) verifyWindowsPeMachine(join(directory, name), target)
}

export function stageMediaToolchain(options: MediaToolchainStageOptions): void {
  if (options.platform !== 'darwin' && options.platform !== 'win32') {
    throw new Error(`不支持的媒体工具链平台: ${options.platform}`)
  }
  const names = binaryNames(options.platform)
  const windowsTarget = verifiedWindowsTarget(options.platform, options.target)
  const destination = resolve(options.destinationDir)
  if (options.verifyOnly) {
    const manifestPath = join(destination, STAGED_MANIFEST)
    if (!existsSync(manifestPath) || !existsSync(join(destination, LICENSE_FILE))) {
      throw new Error('安装包缺少已审核的 FFmpeg/ffprobe 或许可证；请先执行 stage:media-toolchain')
    }
    const manifest = readJson<StagedManifest>(manifestPath)
    validateMetadata(manifest)
    verifyHashes(destination, manifest, names)
    verifyLicenseFile(destination, LICENSE_FILE, manifest)
    verifyWindowsMediaMachine(destination, names, windowsTarget)
    const audit = verifyMatchingBinaries(destination, names, manifest)
    if (audit.version !== manifest.binaryVersion || audit.buildConfiguration !== manifest.buildConfiguration) {
      throw new Error('安装包媒体工具链与已审核 manifest 不一致')
    }
    return
  }

  if (!options.sourceDir) throw new Error('缺少 BB_MEDIA_TOOLCHAIN_SOURCE_DIR，不能制作带视频能力的安装包')
  const source = resolve(options.sourceDir)
  const sourceManifestPath = join(source, SOURCE_MANIFEST)
  const sourceLicensePath = join(source, 'LICENSE.txt')
  if (!existsSync(sourceManifestPath) || !existsSync(sourceLicensePath)) {
    throw new Error(`媒体工具链源目录必须包含 ${SOURCE_MANIFEST} 和 LICENSE.txt`)
  }
  const manifest = readJson<SourceManifest>(sourceManifestPath)
  validateMetadata(manifest)
  verifyHashes(source, manifest, names)
  verifyLicenseFile(source, 'LICENSE.txt', manifest)
  verifyWindowsMediaMachine(source, names, windowsTarget)
  const audit = verifyMatchingBinaries(source, names, manifest)

  mkdirSync(destination, { recursive: true })
  for (const stale of ['ffmpeg', 'ffprobe', 'ffmpeg.exe', 'ffprobe.exe', STAGED_MANIFEST, LICENSE_FILE]) {
    rmSync(join(destination, stale), { force: true })
  }
  for (const name of names) {
    copyFileSync(join(source, name), join(destination, name))
    if (options.platform !== 'win32') chmodSync(join(destination, name), 0o755)
  }
  copyFileSync(sourceLicensePath, join(destination, LICENSE_FILE))
  const binaryHashMode: BinaryHashMode = options.platform === 'darwin'
    && names.every((name) => isThinMachO64(join(destination, name)))
    ? 'mach-o-code-signature-neutral-sha256'
    : 'sha256'
  const staged: StagedManifest = {
    ...manifest,
    binaryHashMode,
    files: Object.fromEntries(names.map((name) => [name, binaryHash(join(destination, name), binaryHashMode)])),
    buildConfiguration: audit.buildConfiguration,
    binaryVersion: audit.version,
  }
  writeFileSync(join(destination, STAGED_MANIFEST), `${JSON.stringify(staged, null, 2)}\n`, { mode: 0o644 })
  stageMediaToolchain({ ...options, sourceDir: undefined, verifyOnly: true })
}

if (import.meta.main) {
  const desktopRoot = resolve(import.meta.dir, '..')
  const cli = parseMediaToolchainCliOptions(process.argv.slice(2))
  const platform = (cli.platform ?? process.env.BB_MEDIA_TOOLCHAIN_PLATFORM ?? process.platform) as SupportedPlatform
  if (!['darwin', 'win32'].includes(platform)) throw new Error(`不支持的媒体工具链平台: ${platform}`)
  const target = cli.target
    ?? process.env.BB_MEDIA_TOOLCHAIN_TARGET
    ?? process.env.BILLIARDBUDDY_WINDOWS_TARGET
    ?? (platform === 'win32' && process.arch === 'x64'
      ? 'x86_64-pc-windows-msvc'
      : platform === 'win32' && process.arch === 'arm64'
        ? 'aarch64-pc-windows-msvc'
        : undefined)
  stageMediaToolchain({
    sourceDir: process.env.BB_MEDIA_TOOLCHAIN_SOURCE_DIR,
    destinationDir: cli.destinationDir ?? join(desktopRoot, 'runtime-assets', 'binaries'),
    platform,
    target: verifiedWindowsTarget(platform, target),
    verifyOnly: cli.verifyOnly,
  })
  console.log(`[media-toolchain] ${cli.verifyOnly ? 'verified' : 'staged'} for ${platform}`)
}
