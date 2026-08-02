import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  CODEX_ENGINE_MANIFEST_SCHEMA,
  CODEX_ENGINE_NAME,
  CODEX_ENGINE_PRODUCT_PATCHES,
  CODEX_ENGINE_SOURCE_REPOSITORY,
  CODEX_ENGINE_SOURCE_REVISION,
  type CodexEngineProductPatch,
} from '../../shared/product/codexEngineContract'
import { machOCodeSignatureNeutralSha256 } from './stage-media-toolchain'

type SupportedTarget =
  | 'aarch64-apple-darwin'
  | 'x86_64-apple-darwin'
  | 'x86_64-pc-windows-msvc'
  | 'aarch64-pc-windows-msvc'

type BinaryHashMode = 'sha256' | 'mach-o-code-signature-neutral-sha256'

type EngineManifest = {
  schemaVersion: typeof CODEX_ENGINE_MANIFEST_SCHEMA
  engine: typeof CODEX_ENGINE_NAME
  sourceRepository: typeof CODEX_ENGINE_SOURCE_REPOSITORY
  sourceRevision: string
  productPatches: CodexEngineProductPatch[]
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
  /**
   * A CI-built App Server binary from the same pinned source and reviewed
   * patch set. This avoids recompiling Cargo on a developer machine; callers
   * must still pass the resulting staged directory through `verify`.
   */
  prebuiltBinary?: string
}

export type CodexEngineCliOptions = {
  destinationDir?: string
  target?: string
  prebuiltBinary?: string
  verifyOnly: boolean
}

const LICENSE_FILE = 'codex-engine-LICENSE.txt'
const NOTICE_FILE = 'codex-engine-NOTICE.txt'

const desktopRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const engineRoot = join(repositoryRoot, 'third_party', 'codex-engine')
const productPatchRoot = join(repositoryRoot, 'third_party', 'codex-engine-patches')

export function parseCodexEngineCliOptions(argv: string[]): CodexEngineCliOptions {
  let destinationDir: string | undefined
  let target: string | undefined
  let prebuiltBinary: string | undefined
  let verifyOnly = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--verify') {
      verifyOnly = true
      continue
    }
    if (argument === '--destination' || argument === '--target' || argument === '--prebuilt-binary') {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} 需要一个值`)
      if (argument === '--destination') destinationDir = value
      else if (argument === '--target') target = value
      else prebuiltBinary = value
      index += 1
      continue
    }
    throw new Error(`未知 Codex 引擎参数: ${argument}`)
  }

  if (verifyOnly && prebuiltBinary !== undefined) {
    throw new Error('--verify 不能与 --prebuilt-binary 同时使用')
  }
  return { destinationDir, target, prebuiltBinary, verifyOnly }
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
  return target.includes('windows') ? `${CODEX_ENGINE_NAME}.exe` : CODEX_ENGINE_NAME
}

export function stagedCodexEngineBinaryName(target: SupportedTarget): string {
  return target.includes('windows')
    ? `${CODEX_ENGINE_NAME}-${target}.exe`
    : `${CODEX_ENGINE_NAME}-${target}`
}

export function codexEngineManifestName(target: SupportedTarget): string {
  return `codex-engine-manifest-${target}.json`
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function productPatchSha256(path: string): string {
  // Match Git's LF canonicalization so a Windows checkout cannot alter the
  // identity recorded in the reviewed product-patch contract.
  const canonicalPatch = readFileSync(path, 'utf8').replace(/\r\n/g, '\n')
  return createHash('sha256').update(canonicalPatch, 'utf8').digest('hex')
}

function expectedProductPatches(): CodexEngineProductPatch[] {
  if (!existsSync(productPatchRoot) || !lstatSync(productPatchRoot).isDirectory()) {
    throw new Error(`缺少 Codex 引擎产品补丁目录: ${productPatchRoot}`)
  }

  const expectedPatches = [...CODEX_ENGINE_PRODUCT_PATCHES]
    .sort((left, right) => left.file.localeCompare(right.file))
  const expectedFiles = expectedPatches.map(patch => patch.file)
  const actualFiles = readdirSync(productPatchRoot, { withFileTypes: true })
    .map(entry => entry.name)
    .sort()
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((file, index) => file !== expectedFiles[index])) {
    throw new Error(`Codex 引擎产品补丁清单不完整或包含未审核文件: ${actualFiles.join(', ') || '（空）'}`)
  }

  return expectedPatches.map(patch => {
    const path = join(productPatchRoot, patch.file)
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
      throw new Error(`Codex 引擎产品补丁不是普通文件: ${path}`)
    }
    if (productPatchSha256(path) !== patch.sha256) {
      throw new Error(`Codex 引擎产品补丁内容不符合发行合同: ${patch.file}`)
    }
    return { file: patch.file, sha256: patch.sha256 }
  })
}

function matchesExpectedProductPatches(value: unknown, expected: readonly CodexEngineProductPatch[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && value.every((patch, index) => {
      const expectedPatch = expected[index]
      if (!expectedPatch || !patch || typeof patch !== 'object') return false
      return !Array.isArray(patch)
        && Object.keys(patch).length === 2
        && (patch as CodexEngineProductPatch).file === expectedPatch.file
        && (patch as CodexEngineProductPatch).sha256 === expectedPatch.sha256
    })
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

function assertPinnedSource(): void {
  const revision = run('git', ['rev-parse', 'HEAD'], engineRoot)
  if (revision !== CODEX_ENGINE_SOURCE_REVISION) {
    throw new Error(`Codex 引擎源码版本不符合产品锁定：期望 ${CODEX_ENGINE_SOURCE_REVISION}，实际 ${revision}`)
  }
  for (const file of ['LICENSE', 'NOTICE']) {
    if (!existsSync(join(engineRoot, file))) throw new Error(`Codex 引擎源码缺少 ${file}`)
  }
}

function assertCleanSource(): void {
  assertPinnedSource()
  const status = run('git', ['status', '--short'], engineRoot)
  if (status) throw new Error('Codex 引擎源码目录存在未提交改动，拒绝以不确定源码构建安装包')
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

function applyProductPatches(sourceRoot: string, patches: readonly CodexEngineProductPatch[]): void {
  for (const patch of patches) {
    const patchPath = join(productPatchRoot, patch.file)
    if (productPatchSha256(patchPath) !== patch.sha256) {
      throw new Error(`Codex 引擎产品补丁在构建前发生变化: ${patch.file}`)
    }
    run('git', ['apply', '--check', patchPath], sourceRoot)
    run('git', ['apply', '--whitespace=nowarn', patchPath], sourceRoot)
  }
  run('git', ['diff', '--check'], sourceRoot)
}

function withPatchedEngineSource<T>(
  patches: readonly CodexEngineProductPatch[],
  action: (sourceRoot: string) => T,
): T {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'billiardbuddy-codex-engine-'))
  const sourceRoot = join(temporaryRoot, 'source')
  let worktreeCreated = false

  try {
    run('git', ['worktree', 'add', '--detach', sourceRoot, CODEX_ENGINE_SOURCE_REVISION], engineRoot)
    worktreeCreated = true
    applyProductPatches(sourceRoot, patches)
    return action(sourceRoot)
  } finally {
    if (worktreeCreated) {
      try {
        run('git', ['worktree', 'remove', '--force', sourceRoot], engineRoot)
      } finally {
        rmSync(temporaryRoot, { recursive: true, force: true })
      }
    } else {
      rmSync(temporaryRoot, { recursive: true, force: true })
    }
  }
}

function buildPatchedSource(target: SupportedTarget, sourceRoot: string): string {
  const sourceWorkspace = join(sourceRoot, 'codex-rs')
  run(resolveCargoCommand(), [
    'build',
    '--locked',
    '--release',
    '--target', target,
    '--package', CODEX_ENGINE_NAME,
    '--bin', CODEX_ENGINE_NAME,
  ], sourceWorkspace)

  const builtBinary = join(sourceWorkspace, 'target', target, 'release', codexEngineBinaryName(target))
  if (!existsSync(builtBinary) || !lstatSync(builtBinary).isFile() || lstatSync(builtBinary).size < 1_000_000) {
    throw new Error(`Codex 引擎构建产物无效: ${builtBinary}`)
  }
  return builtBinary
}

function prebuiltBinary(path: string): string {
  const binary = resolve(path)
  if (!existsSync(binary)) throw new Error(`预构建 Codex 引擎不存在: ${binary}`)
  const stat = lstatSync(binary)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1_000_000) {
    throw new Error(`预构建 Codex 引擎无效: ${binary}`)
  }
  return binary
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
  const expectedPatches = expectedProductPatches()
  if (
    manifest.schemaVersion !== CODEX_ENGINE_MANIFEST_SCHEMA
    || manifest.engine !== CODEX_ENGINE_NAME
    || manifest.sourceRepository !== CODEX_ENGINE_SOURCE_REPOSITORY
    || manifest.sourceRevision !== CODEX_ENGINE_SOURCE_REVISION
    || !matchesExpectedProductPatches(manifest.productPatches, expectedPatches)
    || manifest.target !== target
    || manifest.binary !== expectedBinary
    || manifest.license !== 'Apache-2.0'
  ) {
    throw new Error('Codex 引擎清单不符合产品发行合同')
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.binarySha256)
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

function stagePreparedCodexEngine(
  options: CodexEngineStageOptions,
  sourceBinary: string,
  patches: readonly CodexEngineProductPatch[],
): void {
  const destination = resolve(options.destinationDir)
  mkdirSync(destination, { recursive: true })

  const stagedBinary = join(destination, stagedCodexEngineBinaryName(options.target))
  const manifestPath = join(destination, codexEngineManifestName(options.target))
  copyFileSync(sourceBinary, stagedBinary)
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
    schemaVersion: CODEX_ENGINE_MANIFEST_SCHEMA,
    engine: CODEX_ENGINE_NAME,
    sourceRepository: CODEX_ENGINE_SOURCE_REPOSITORY,
    sourceRevision: CODEX_ENGINE_SOURCE_REVISION,
    productPatches: patches,
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

export function stageCodexEngine(options: CodexEngineStageOptions): void {
  if (options.verifyOnly) return verifyStagedCodexEngine(options)

  const patches = expectedProductPatches()
  if (options.prebuiltBinary !== undefined) {
    // GitHub's build job applies this same reviewed patch set before Cargo
    // produces the binary. It leaves that checkout dirty by design, so only
    // require the pinned revision and legal files here—not a clean worktree.
    assertPinnedSource()
    stagePreparedCodexEngine(options, prebuiltBinary(options.prebuiltBinary), patches)
    assertPinnedSource()
    return
  }

  assertCleanSource()
  withPatchedEngineSource(patches, sourceRoot => {
    stagePreparedCodexEngine(options, buildPatchedSource(options.target, sourceRoot), patches)
  })
  assertCleanSource()
}

if (import.meta.main) {
  const cli = parseCodexEngineCliOptions(process.argv.slice(2))
  const requestedTarget = cli.target ?? process.env.CODEX_ENGINE_TARGET ?? detectCodexEngineTarget()
  if (!isSupportedCodexEngineTarget(requestedTarget)) {
    throw new Error(`不支持的 Codex 引擎 target: ${requestedTarget}`)
  }
  const destinationDir = cli.destinationDir ?? join(desktopRoot, 'runtime-assets', 'binaries')
  stageCodexEngine({
    destinationDir,
    target: requestedTarget,
    verifyOnly: cli.verifyOnly,
    ...(cli.prebuiltBinary === undefined ? {} : { prebuiltBinary: cli.prebuiltBinary }),
  })
  console.log(`[codex-engine] ${cli.verifyOnly ? 'verified' : 'staged'} for ${requestedTarget}`)
}
