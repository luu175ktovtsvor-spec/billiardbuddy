import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { machOCodeSignatureNeutralSha256 } from './stage-media-toolchain'

type SupportedTarget =
  | 'aarch64-apple-darwin'
  | 'x86_64-apple-darwin'
  | 'x86_64-pc-windows-msvc'
  | 'aarch64-pc-windows-msvc'

type BinaryHashMode = 'sha256' | 'mach-o-code-signature-neutral-sha256'

type EngineManifest = {
  schemaVersion: 1
  engine: 'codex-app-server'
  sourceRepository: 'https://github.com/openai/codex'
  sourceRevision: string
  patchSha256: string
  target: SupportedTarget
  binary: string
  binaryHashMode: BinaryHashMode
  binarySha256: string
  binarySize: number
  license: 'Apache-2.0'
  licenseSha256: string
  noticeSha256: string
}

export type CodexEngineStageOptions = {
  destinationDir: string
  target: SupportedTarget
  verifyOnly?: boolean
}

export type CodexEngineCliOptions = {
  destinationDir?: string
  target?: string
  verifyOnly: boolean
}

const EXPECTED_SOURCE_REVISION = 'ee0247f95a6fe2b094ba2253d82cae2a2b4c2dff'
const ENGINE_NAME = 'codex-app-server'
const LICENSE_FILE = 'codex-engine-LICENSE.txt'
const NOTICE_FILE = 'codex-engine-NOTICE.txt'

const desktopRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const engineRoot = join(repositoryRoot, 'third_party', 'codex-engine')
const engineWorkspace = join(engineRoot, 'codex-rs')
const enginePatches = [
  join(repositoryRoot, 'third_party', 'codex-engine-patches', '0001-host-managed-tools-only.patch'),
] as const

export function parseCodexEngineCliOptions(argv: string[]): CodexEngineCliOptions {
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
    throw new Error(`未知 Codex 引擎参数: ${argument}`)
  }

  return { destinationDir, target, verifyOnly }
}

export function detectCodexEngineTarget(
  platform = process.platform,
  arch = process.arch,
): SupportedTarget {
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin'
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin'
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc'
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc'
  throw new Error(`不支持的 Codex 引擎平台: ${platform}/${arch}`)
}

export function isSupportedCodexEngineTarget(value: string): value is SupportedTarget {
  return [
    'aarch64-apple-darwin',
    'x86_64-apple-darwin',
    'x86_64-pc-windows-msvc',
    'aarch64-pc-windows-msvc',
  ].includes(value)
}

export function codexEngineBinaryName(target: SupportedTarget): string {
  return target.includes('windows') ? `${ENGINE_NAME}.exe` : ENGINE_NAME
}

export function stagedCodexEngineBinaryName(target: SupportedTarget): string {
  return target.includes('windows')
    ? `${ENGINE_NAME}-${target}.exe`
    : `${ENGINE_NAME}-${target}`
}

export function codexEngineManifestName(target: SupportedTarget): string {
  return `codex-engine-manifest-${target}.json`
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function enginePatchSha256(): string {
  // The staged binary was built with exactly this one compatibility patch.
  // Keep its manifest value the SHA-256 of that exact build input rather than
  // inventing a new aggregate format and invalidating a sound signed asset.
  return sha256(enginePatches[0])
}

function isThinMachO64(path: string): boolean {
  const bytes = readFileSync(path)
  return bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf
}

function hashBinary(path: string, mode: BinaryHashMode): string {
  return mode === 'mach-o-code-signature-neutral-sha256'
    ? machOCodeSignatureNeutralSha256(path)
    : sha256(path)
}

function readManifest(path: string): EngineManifest {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${basename(path)} 不是有效的 Codex 引擎清单`)
  }
  return value as EngineManifest
}

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    // The pinned App Server enables LTO. A clean macOS release link can take
    // longer than 30 minutes on a busy developer machine, while GitHub's
    // release runners retain a 90 minute job budget.
    timeout: 60 * 60_000,
  })
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr]
      .filter((value): value is string => Boolean(value?.trim()))
      .join('\n')
    throw new Error(`Codex 引擎命令失败: ${command} ${args.join(' ')}${detail ? `\n${detail}` : ''}`)
  }
  return result.stdout.trim()
}

function assertCleanSource(): void {
  const revision = run('git', ['rev-parse', 'HEAD'], engineRoot)
  if (revision !== EXPECTED_SOURCE_REVISION) {
    throw new Error(`Codex 引擎源码版本不符合产品锁定：期望 ${EXPECTED_SOURCE_REVISION}，实际 ${revision}`)
  }
  const status = run('git', ['status', '--short'], engineRoot)
  if (status) throw new Error('Codex 引擎源码目录存在未提交改动，拒绝以不确定源码构建安装包')
  for (const file of ['LICENSE', 'NOTICE']) {
    if (!existsSync(join(engineRoot, file))) throw new Error(`Codex 引擎源码缺少 ${file}`)
  }
  for (const patch of enginePatches) {
    if (!existsSync(patch)) throw new Error(`Codex 引擎源码补丁缺失: ${basename(patch)}`)
    run('git', ['apply', '--check', patch], engineRoot)
  }
}

function resolveCargoCommand(): string {
  const explicit = process.env.CARGO?.trim()
  if (explicit && existsSync(explicit)) return explicit
  const onPath = Bun.which('cargo')
  if (onPath) return onPath
  const cargoHome = process.env.CARGO_HOME?.trim() || join(homedir(), '.cargo')
  const bundled = process.platform === 'win32'
    ? join(cargoHome, 'bin', 'cargo.exe')
    : join(cargoHome, 'bin', 'cargo')
  if (existsSync(bundled)) return bundled
  throw new Error('缺少 Rust Cargo；无法从锁定 Codex 源码构建产品内核')
}

function applyPatchAndBuild(target: SupportedTarget): string {
  assertCleanSource()
  const appliedPatches: string[] = []
  let buildError: unknown
  try {
    for (const patch of enginePatches) {
      run('git', ['apply', '--whitespace=nowarn', patch], engineRoot)
      appliedPatches.push(patch)
    }
    run(resolveCargoCommand(), [
      'build',
      '--locked',
      '--release',
      '--target', target,
      '--package', ENGINE_NAME,
      '--bin', ENGINE_NAME,
    ], engineWorkspace)
  } catch (error) {
    buildError = error
  }

  let revertError: unknown
  for (const patch of [...appliedPatches].reverse()) {
    try {
      run('git', ['apply', '--reverse', '--whitespace=nowarn', patch], engineRoot)
    } catch (error) {
      revertError ??= error
    }
  }

  if (revertError) {
    throw new Error(`Codex 引擎补丁无法恢复；源码目录已保留供排查：${String(revertError)}`)
  }
  if (buildError) throw buildError
  assertCleanSource()

  const builtBinary = join(engineWorkspace, 'target', target, 'release', codexEngineBinaryName(target))
  if (!existsSync(builtBinary) || !lstatSync(builtBinary).isFile() || lstatSync(builtBinary).size < 1_000_000) {
    throw new Error(`Codex 引擎构建产物无效: ${builtBinary}`)
  }
  return builtBinary
}

function adHocSignMacBinary(path: string): void {
  const remove = spawnSync('codesign', ['--remove-signature', path], { encoding: 'utf8' })
  if (remove.error || remove.status !== 0) {
    throw new Error(`无法移除 Codex 引擎旧签名: ${remove.error?.message ?? remove.stderr}`)
  }
  const sign = spawnSync('codesign', ['--sign', '-', '--force', '--timestamp=none', path], { encoding: 'utf8' })
  if (sign.error || sign.status !== 0) {
    throw new Error(`无法为 Codex 引擎添加临时 macOS 签名: ${sign.error?.message ?? sign.stderr}`)
  }
}

function verifyManifest(manifest: EngineManifest, target: SupportedTarget): void {
  const expectedBinary = stagedCodexEngineBinaryName(target)
  if (
    manifest.schemaVersion !== 1
    || manifest.engine !== ENGINE_NAME
    || manifest.sourceRepository !== 'https://github.com/openai/codex'
    || manifest.sourceRevision !== EXPECTED_SOURCE_REVISION
    || manifest.target !== target
    || manifest.binary !== expectedBinary
    || manifest.license !== 'Apache-2.0'
  ) {
    throw new Error('Codex 引擎清单不符合产品发行合同')
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.patchSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.binarySha256)
    || !/^[a-f0-9]{64}$/.test(manifest.licenseSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.noticeSha256)) {
    throw new Error('Codex 引擎清单缺少 SHA-256')
  }
  if (!Number.isSafeInteger(manifest.binarySize) || manifest.binarySize < 1_000_000) {
    throw new Error('Codex 引擎清单缺少有效二进制大小')
  }
  if (!['sha256', 'mach-o-code-signature-neutral-sha256'].includes(manifest.binaryHashMode)) {
    throw new Error(`Codex 引擎清单使用了不支持的哈希模式: ${manifest.binaryHashMode}`)
  }
}

export function verifyStagedCodexEngine(options: CodexEngineStageOptions): void {
  const destination = resolve(options.destinationDir)
  const manifestPath = join(destination, codexEngineManifestName(options.target))
  const binaryPath = join(destination, stagedCodexEngineBinaryName(options.target))
  const licensePath = join(destination, LICENSE_FILE)
  const noticePath = join(destination, NOTICE_FILE)
  for (const path of [manifestPath, binaryPath, licensePath, noticePath]) {
    if (!existsSync(path)) throw new Error(`安装包缺少受管 Codex 引擎文件: ${path}`)
  }
  if (!lstatSync(binaryPath).isFile() || lstatSync(binaryPath).isSymbolicLink()) {
    throw new Error('安装包中的 Codex 引擎不是普通文件')
  }
  const manifest = readManifest(manifestPath)
  verifyManifest(manifest, options.target)
  if (enginePatchSha256() !== manifest.patchSha256) {
    throw new Error('Codex 引擎补丁哈希不符合当前产品源码')
  }
  if (sha256(licensePath) !== manifest.licenseSha256 || sha256(noticePath) !== manifest.noticeSha256) {
    throw new Error('Codex 引擎 LICENSE 或 NOTICE 哈希不匹配')
  }
  const binarySize = lstatSync(binaryPath).size
  if (binarySize < 1_000_000) {
    throw new Error('Codex 引擎二进制大小无效')
  }
  // macOS codesign replaces only the code-signature region and extends
  // __LINKEDIT. The neutral hash below deliberately excludes that mutable
  // region, so a post-pack signing pass must not be rejected for changing size.
  if (manifest.binaryHashMode === 'sha256' && binarySize !== manifest.binarySize) {
    throw new Error('Codex 引擎二进制大小不匹配')
  }
  if (hashBinary(binaryPath, manifest.binaryHashMode) !== manifest.binarySha256) {
    throw new Error('Codex 引擎二进制哈希不匹配')
  }
}

export function stageCodexEngine(options: CodexEngineStageOptions): void {
  if (options.verifyOnly) return verifyStagedCodexEngine(options)

  const destination = resolve(options.destinationDir)
  const builtBinary = applyPatchAndBuild(options.target)
  mkdirSync(destination, { recursive: true })

  const stagedBinary = join(destination, stagedCodexEngineBinaryName(options.target))
  const manifestPath = join(destination, codexEngineManifestName(options.target))
  copyFileSync(builtBinary, stagedBinary)
  if (!options.target.includes('windows')) {
    chmodSync(stagedBinary, 0o755)
    adHocSignMacBinary(stagedBinary)
  }
  copyFileSync(join(engineRoot, 'LICENSE'), join(destination, LICENSE_FILE))
  copyFileSync(join(engineRoot, 'NOTICE'), join(destination, NOTICE_FILE))

  const binaryHashMode: BinaryHashMode = options.target.includes('apple') && isThinMachO64(stagedBinary)
    ? 'mach-o-code-signature-neutral-sha256'
    : 'sha256'
  const manifest: EngineManifest = {
    schemaVersion: 1,
    engine: ENGINE_NAME,
    sourceRepository: 'https://github.com/openai/codex',
    sourceRevision: EXPECTED_SOURCE_REVISION,
    patchSha256: enginePatchSha256(),
    target: options.target,
    binary: stagedCodexEngineBinaryName(options.target),
    binaryHashMode,
    binarySha256: hashBinary(stagedBinary, binaryHashMode),
    binarySize: lstatSync(stagedBinary).size,
    license: 'Apache-2.0',
    licenseSha256: sha256(join(destination, LICENSE_FILE)),
    noticeSha256: sha256(join(destination, NOTICE_FILE)),
  }
  rmSync(manifestPath, { force: true })
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 })
  verifyStagedCodexEngine(options)
}

if (import.meta.main) {
  const cli = parseCodexEngineCliOptions(process.argv.slice(2))
  const requestedTarget = cli.target ?? process.env.CODEX_ENGINE_TARGET ?? detectCodexEngineTarget()
  if (!isSupportedCodexEngineTarget(requestedTarget)) {
    throw new Error(`不支持的 Codex 引擎 target: ${requestedTarget}`)
  }
  const destinationDir = cli.destinationDir ?? join(desktopRoot, 'runtime-assets', 'binaries')
  stageCodexEngine({ destinationDir, target: requestedTarget, verifyOnly: cli.verifyOnly })
  console.log(`[codex-engine] ${cli.verifyOnly ? 'verified' : 'staged'} for ${requestedTarget}`)
}
