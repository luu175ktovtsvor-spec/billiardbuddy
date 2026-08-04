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
  BILLIARDBUDDY_AGENT_ENGINE_NAME,
  CODEX_CODE_MODE_HOST_NAME,
  CODEX_ENGINE_MANIFEST_SCHEMA,
  CODEX_ENGINE_NAME,
  CODEX_ENGINE_PRODUCT_PATCHES,
  CODEX_ENGINE_SOURCE_REPOSITORY,
  CODEX_ENGINE_SOURCE_REVISION,
  type CodexEngineProductPatch,
} from '../../shared/product/codexEngineContract'
import {
  binaryIntegritySha256,
  isThinMachO64,
  type BinaryHashMode,
} from '../../shared/product/binaryIntegrity'
import { type WindowsNativeTarget, verifyWindowsPeMachine } from './native-build-tools'

type SupportedTarget =
  | 'aarch64-apple-darwin'
  | 'x86_64-apple-darwin'
  | 'x86_64-pc-windows-msvc'
  | 'aarch64-pc-windows-msvc'

const WINDOWS_SANDBOX_HELPER_FILENAMES = [
  'codex-windows-sandbox-setup.exe',
  'codex-command-runner.exe',
] as const

type WindowsSandboxHelperName = typeof WINDOWS_SANDBOX_HELPER_FILENAMES[number]

type WindowsSandboxHelperManifest = {
  name: WindowsSandboxHelperName
  sha256: string
  size: number
}

type PrebuiltWindowsSandboxHelpers = {
  setup: string
  commandRunner: string
}

type PreparedCodexEngine = {
  binary: string
  codeModeHost: string
  ripgrep: string
  windowsSandboxHelpers?: PrebuiltWindowsSandboxHelpers
}

type EngineManifest = {
  schemaVersion: typeof CODEX_ENGINE_MANIFEST_SCHEMA
  engine: typeof BILLIARDBUDDY_AGENT_ENGINE_NAME
  sourceRepository: typeof CODEX_ENGINE_SOURCE_REPOSITORY
  sourceRevision: string
  productPatches: CodexEngineProductPatch[]
  target: SupportedTarget
  binary: string
  binaryHashMode: BinaryHashMode
  binarySha256: string
  binarySize: number
  codeModeHost: string
  codeModeHostHashMode: BinaryHashMode
  codeModeHostSha256: string
  codeModeHostSize: number
  ripgrep: string
  ripgrepHashMode: BinaryHashMode
  ripgrepSha256: string
  ripgrepSize: number
  windowsSandboxHelpers?: WindowsSandboxHelperManifest[]
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
  /** Companion built from the same pinned revision and reviewed patches. */
  prebuiltCodeModeHost?: string
  /**
   * Windows-only upstream helpers required by the original Rust sandbox
   * implementation. They intentionally retain the source filenames because
   * the locked Core resolves them relative to its own executable.
   */
  prebuiltWindowsSandboxHelpers?: PrebuiltWindowsSandboxHelpers
}

export type CodexEngineCliOptions = {
  destinationDir?: string
  target?: string
  prebuiltBinary?: string
  prebuiltCodeModeHost?: string
  prebuiltWindowsSandboxSetup?: string
  prebuiltWindowsCommandRunner?: string
  verifyOnly: boolean
}

// These are product resources, not upstream executable names. Their contents
// retain the upstream Apache-2.0 license and NOTICE attribution verbatim.
const LICENSE_FILE = 'THIRD_PARTY_LICENSES.txt'
const NOTICE_FILE = 'THIRD_PARTY_NOTICES.txt'
const LEGACY_STAGED_FILES = [
  'codex-engine-LICENSE.txt',
  'codex-engine-NOTICE.txt',
]

const desktopRoot = resolve(import.meta.dir, '..')
const repositoryRoot = resolve(desktopRoot, '..', '..')
const engineRoot = join(repositoryRoot, 'third_party', 'codex-engine')
const productPatchRoot = join(repositoryRoot, 'third_party', 'codex-engine-patches')

export function parseCodexEngineCliOptions(argv: string[]): CodexEngineCliOptions {
  let destinationDir: string | undefined
  let target: string | undefined
  let prebuiltBinary: string | undefined
  let prebuiltCodeModeHost: string | undefined
  let prebuiltWindowsSandboxSetup: string | undefined
  let prebuiltWindowsCommandRunner: string | undefined
  let verifyOnly = false

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--verify') {
      verifyOnly = true
      continue
    }
    if (
      argument === '--destination'
      || argument === '--target'
      || argument === '--prebuilt-binary'
      || argument === '--prebuilt-code-mode-host'
      || argument === '--prebuilt-windows-sandbox-setup'
      || argument === '--prebuilt-windows-command-runner'
    ) {
      const value = argv[index + 1]
      if (!value || value.startsWith('--')) throw new Error(`${argument} 需要一个值`)
      if (argument === '--destination') destinationDir = value
      else if (argument === '--target') target = value
      else if (argument === '--prebuilt-binary') prebuiltBinary = value
      else if (argument === '--prebuilt-code-mode-host') prebuiltCodeModeHost = value
      else if (argument === '--prebuilt-windows-sandbox-setup') prebuiltWindowsSandboxSetup = value
      else prebuiltWindowsCommandRunner = value
      index += 1
      continue
    }
    throw new Error(`未知 Codex 引擎参数: ${argument}`)
  }

  if (verifyOnly && (
    prebuiltBinary !== undefined
    || prebuiltCodeModeHost !== undefined
    || prebuiltWindowsSandboxSetup !== undefined
    || prebuiltWindowsCommandRunner !== undefined
  )) {
    throw new Error('--verify 不能与预构建 Codex 引擎文件同时使用')
  }
  if ((prebuiltWindowsSandboxSetup === undefined) !== (prebuiltWindowsCommandRunner === undefined)) {
    throw new Error('Windows Sandbox 预构建辅助程序必须同时提供 setup 与 command-runner')
  }
  if ((prebuiltBinary === undefined) !== (prebuiltCodeModeHost === undefined)) {
    throw new Error('预构建 Codex App Server 与 Code Mode Host 必须同时提供')
  }
  return {
    destinationDir,
    target,
    prebuiltBinary,
    prebuiltCodeModeHost,
    prebuiltWindowsSandboxSetup,
    prebuiltWindowsCommandRunner,
    verifyOnly,
  }
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

/** A cross-compiled companion is integrity-audited but never executed on the wrong host architecture. */
export function canExecuteCodexEngineTarget(
  target: SupportedTarget,
  platform = process.platform,
  arch = process.arch,
): boolean {
  try {
    return target === detectCodexEngineTarget(platform, arch)
  } catch {
    return false
  }
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

export function codexCodeModeHostBinaryName(target: SupportedTarget): string {
  return target.includes('windows') ? `${CODEX_CODE_MODE_HOST_NAME}.exe` : CODEX_CODE_MODE_HOST_NAME
}

export function codexRipgrepBinaryName(target: SupportedTarget): string {
  return target.includes('windows') ? 'rg.exe' : 'rg'
}

export function stagedCodexEngineBinaryName(target: SupportedTarget): string {
  return target.includes('windows')
    ? `${BILLIARDBUDDY_AGENT_ENGINE_NAME}-${target}.exe`
    : `${BILLIARDBUDDY_AGENT_ENGINE_NAME}-${target}`
}

export function codexEngineManifestName(target: SupportedTarget): string {
  return `agent-engine-manifest-${target}.json`
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

function hashBinary(path: string, mode: BinaryHashMode): string {
  return binaryIntegritySha256(readFileSync(path), mode)
}

function readManifest(path: string): EngineManifest {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${basename(path)} 不是有效的 Codex 引擎清单`)
  }
  return value as EngineManifest
}

function run(command: string, args: string[], cwd?: string, environment?: NodeJS.ProcessEnv): string {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
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

function resolvePythonCommand(): string {
  const configured = process.env.PYTHON?.trim()
  const candidates = [
    configured,
    ...['python3.13', 'python3.12', 'python3.11', 'python3.10', 'python3'].map(name => Bun.which(name)),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const version = spawnSync(candidate, ['-c', 'import sys; print(sys.version_info[:2] >= (3, 10))'], { encoding: 'utf8' })
    if (!version.error && version.status === 0 && version.stdout.trim() === 'True') return candidate
  }
  throw new Error('锁定 Codex 打包脚本需要 Python 3.10 或更高版本')
}

function rustyV8Environment(target: SupportedTarget): NodeJS.ProcessEnv {
  // Reuse the package helper from the locked Codex source. It selects the
  // sandbox-enabled V8 pair, verifies the release checksum manifest and keeps
  // Cargo aligned with the exact upstream revision instead of duplicating the
  // download contract in BilliardBuddy.
  const python = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(join(engineRoot, 'scripts'))})`,
    'from codex_package.targets import TARGET_SPECS',
    'from codex_package.v8 import resolve_codex_v8_cargo_env',
    'print(json.dumps(resolve_codex_v8_cargo_env(TARGET_SPECS[sys.argv[1]])))',
  ].join('; ')
  const output = run(resolvePythonCommand(), ['-c', python, target], engineRoot)
  const value: unknown = JSON.parse(output)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rusty_v8 准备结果无效')
  const archive = (value as { RUSTY_V8_ARCHIVE?: unknown }).RUSTY_V8_ARCHIVE
  const binding = (value as { RUSTY_V8_SRC_BINDING_PATH?: unknown }).RUSTY_V8_SRC_BINDING_PATH
  if (typeof archive !== 'string' || typeof binding !== 'string') throw new Error('rusty_v8 准备结果缺少路径')
  return { ...process.env, RUSTY_V8_ARCHIVE: archive, RUSTY_V8_SRC_BINDING_PATH: binding }
}

function officialCodexRipgrep(target: SupportedTarget): string {
  // The locked Codex package helper owns the exact ripgrep version, target
  // mapping, download origin, size and SHA-256. Reusing it keeps search and
  // runtime PATH behavior aligned with the same source revision as Core.
  const python = [
    'import json, sys',
    `sys.path.insert(0, ${JSON.stringify(join(engineRoot, 'scripts'))})`,
    'from codex_package.targets import TARGET_SPECS',
    'from codex_package.ripgrep import resolve_rg_bin',
    'print(json.dumps(str(resolve_rg_bin(TARGET_SPECS[sys.argv[1]], None))))',
  ].join('; ')
  const value: unknown = JSON.parse(run(resolvePythonCommand(), ['-c', python, target], engineRoot))
  if (typeof value !== 'string') throw new Error('Codex 官方 ripgrep 准备结果无效')
  return validPrebuiltFile(value, 'Codex 官方 ripgrep', 1_000_000)
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

function validPrebuiltFile(path: string, label: string, minimumSize: number): string {
  const resolved = resolve(path)
  if (!existsSync(resolved)) throw new Error(`${label}不存在: ${resolved}`)
  const stat = lstatSync(resolved)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < minimumSize) {
    throw new Error(`${label}无效: ${resolved}`)
  }
  return resolved
}

function buildPatchedSource(target: SupportedTarget, sourceRoot: string): PreparedCodexEngine {
  const sourceWorkspace = join(sourceRoot, 'codex-rs')
  const buildEnvironment = rustyV8Environment(target)
  run(resolveCargoCommand(), [
    'build',
    '--locked',
    '--release',
    '--target', target,
    '--package', CODEX_ENGINE_NAME,
    '--bin', CODEX_ENGINE_NAME,
  ], sourceWorkspace, buildEnvironment)

  const builtBinary = join(sourceWorkspace, 'target', target, 'release', codexEngineBinaryName(target))
  const binary = validPrebuiltFile(builtBinary, 'Codex App Server 构建产物', 1_000_000)
  run(resolveCargoCommand(), [
    'build',
    '--locked',
    '--release',
    '--target', target,
    '--package', CODEX_CODE_MODE_HOST_NAME,
    '--bin', CODEX_CODE_MODE_HOST_NAME,
  ], sourceWorkspace, buildEnvironment)
  const codeModeHost = validPrebuiltFile(
    join(sourceWorkspace, 'target', target, 'release', codexCodeModeHostBinaryName(target)),
    'Codex Code Mode Host 构建产物',
    1_000_000,
  )
  const ripgrep = officialCodexRipgrep(target)
  if (!target.includes('windows')) return { binary, codeModeHost, ripgrep }

  run(resolveCargoCommand(), [
    'build',
    '--locked',
    '--release',
    '--target', target,
    '--package', 'codex-windows-sandbox',
    '--bin', 'codex-windows-sandbox-setup',
    '--bin', 'codex-command-runner',
  ], sourceWorkspace, buildEnvironment)
  const outputDir = join(sourceWorkspace, 'target', target, 'release')
  return {
    binary,
    codeModeHost,
    ripgrep,
    windowsSandboxHelpers: {
      setup: validPrebuiltFile(
        join(outputDir, WINDOWS_SANDBOX_HELPER_FILENAMES[0]),
        'Codex Windows Sandbox setup 辅助程序',
        64 * 1024,
      ),
      commandRunner: validPrebuiltFile(
        join(outputDir, WINDOWS_SANDBOX_HELPER_FILENAMES[1]),
        'Codex Windows Sandbox command-runner 辅助程序',
        64 * 1024,
      ),
    },
  }
}

function prebuiltEngine(options: CodexEngineStageOptions): PreparedCodexEngine {
  if (options.prebuiltBinary === undefined) throw new Error('预构建 Codex App Server 缺失')
  if (options.prebuiltCodeModeHost === undefined) throw new Error('预构建 Codex Code Mode Host 缺失')
  const binary = validPrebuiltFile(options.prebuiltBinary, '预构建 Codex App Server', 1_000_000)
  const codeModeHost = validPrebuiltFile(options.prebuiltCodeModeHost, '预构建 Codex Code Mode Host', 1_000_000)
  const ripgrep = officialCodexRipgrep(options.target)
  if (!options.target.includes('windows')) {
    if (options.prebuiltWindowsSandboxHelpers !== undefined) {
      throw new Error('非 Windows 目标不应提供 Windows Sandbox 辅助程序')
    }
    return { binary, codeModeHost, ripgrep }
  }
  const helpers = options.prebuiltWindowsSandboxHelpers
  if (!helpers) throw new Error('Windows 预构建 Codex 引擎缺少原生 Sandbox 辅助程序')
  return {
    binary,
    codeModeHost,
    ripgrep,
    windowsSandboxHelpers: {
      setup: validPrebuiltFile(helpers.setup, '预构建 Windows Sandbox setup 辅助程序', 64 * 1024),
      commandRunner: validPrebuiltFile(helpers.commandRunner, '预构建 Windows Sandbox command-runner 辅助程序', 64 * 1024),
    },
  }
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

function verifiedWindowsSandboxHelpers(
  manifest: EngineManifest,
  target: SupportedTarget,
): WindowsSandboxHelperManifest[] {
  if (!target.includes('windows')) {
    if (manifest.windowsSandboxHelpers !== undefined) {
      throw new Error('非 Windows Codex 引擎清单不得声明 Windows Sandbox 辅助程序')
    }
    return []
  }
  const helpers = manifest.windowsSandboxHelpers
  if (!Array.isArray(helpers) || helpers.length !== WINDOWS_SANDBOX_HELPER_FILENAMES.length) {
    throw new Error('Windows Codex 引擎清单缺少完整 Sandbox 辅助程序')
  }
  return helpers.map((helper, index) => {
    const expectedName = WINDOWS_SANDBOX_HELPER_FILENAMES[index]
    if (
      !helper
      || helper.name !== expectedName
      || !/^[a-f0-9]{64}$/.test(helper.sha256)
      || !Number.isSafeInteger(helper.size)
      || helper.size < 64 * 1024
    ) {
      throw new Error(`Windows Sandbox 辅助程序清单无效: ${expectedName}`)
    }
    return helper
  })
}

function verifyManifest(manifest: EngineManifest, target: SupportedTarget): WindowsSandboxHelperManifest[] {
  const expectedBinary = stagedCodexEngineBinaryName(target)
  const expectedPatches = expectedProductPatches()
  if (
    manifest.schemaVersion !== CODEX_ENGINE_MANIFEST_SCHEMA
    || manifest.engine !== BILLIARDBUDDY_AGENT_ENGINE_NAME
    || manifest.sourceRepository !== CODEX_ENGINE_SOURCE_REPOSITORY
    || manifest.sourceRevision !== CODEX_ENGINE_SOURCE_REVISION
    || !matchesExpectedProductPatches(manifest.productPatches, expectedPatches)
    || manifest.target !== target
    || manifest.binary !== expectedBinary
    || manifest.codeModeHost !== codexCodeModeHostBinaryName(target)
    || manifest.ripgrep !== codexRipgrepBinaryName(target)
    || manifest.license !== 'Apache-2.0'
  ) {
    throw new Error('Codex 引擎清单不符合产品发行合同')
  }
  if (!/^[a-f0-9]{64}$/.test(manifest.binarySha256)
    || !/^[a-f0-9]{64}$/.test(manifest.codeModeHostSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.ripgrepSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.licenseSha256)
    || !/^[a-f0-9]{64}$/.test(manifest.noticeSha256)) {
    throw new Error('Codex 引擎清单缺少 SHA-256')
  }
  if (!Number.isSafeInteger(manifest.binarySize) || manifest.binarySize < 1_000_000) {
    throw new Error('Codex 引擎清单缺少有效二进制大小')
  }
  if (!Number.isSafeInteger(manifest.codeModeHostSize) || manifest.codeModeHostSize < 1_000_000) {
    throw new Error('Codex 引擎清单缺少有效 Code Mode Host 大小')
  }
  if (!Number.isSafeInteger(manifest.ripgrepSize) || manifest.ripgrepSize < 1_000_000) {
    throw new Error('Codex 引擎清单缺少有效 ripgrep 大小')
  }
  if (!['sha256', 'mach-o-code-signature-neutral-sha256'].includes(manifest.binaryHashMode)) {
    throw new Error(`Codex 引擎清单使用了不支持的哈希模式: ${manifest.binaryHashMode}`)
  }
  if (!['sha256', 'mach-o-code-signature-neutral-sha256'].includes(manifest.codeModeHostHashMode)) {
    throw new Error(`Codex 引擎清单使用了不支持的 Code Mode Host 哈希模式: ${manifest.codeModeHostHashMode}`)
  }
  if (!['sha256', 'mach-o-code-signature-neutral-sha256'].includes(manifest.ripgrepHashMode)) {
    throw new Error(`Codex 引擎清单使用了不支持的 ripgrep 哈希模式: ${manifest.ripgrepHashMode}`)
  }
  return verifiedWindowsSandboxHelpers(manifest, target)
}

export function verifyStagedCodexEngine(options: CodexEngineStageOptions): void {
  const destination = resolve(options.destinationDir)
  const manifestPath = join(destination, codexEngineManifestName(options.target))
  const binaryPath = join(destination, stagedCodexEngineBinaryName(options.target))
  const codeModeHostPath = join(destination, codexCodeModeHostBinaryName(options.target))
  const ripgrepPath = join(destination, codexRipgrepBinaryName(options.target))
  const licensePath = join(destination, LICENSE_FILE)
  const noticePath = join(destination, NOTICE_FILE)
  for (const path of [manifestPath, binaryPath, codeModeHostPath, ripgrepPath, licensePath, noticePath]) {
    if (!existsSync(path)) throw new Error(`安装包缺少受管 Codex 引擎文件: ${path}`)
  }
  if (!lstatSync(binaryPath).isFile() || lstatSync(binaryPath).isSymbolicLink()) {
    throw new Error('安装包中的 Codex 引擎不是普通文件')
  }
  if (!lstatSync(codeModeHostPath).isFile() || lstatSync(codeModeHostPath).isSymbolicLink()) {
    throw new Error('安装包中的 Codex Code Mode Host 不是普通文件')
  }
  if (!lstatSync(ripgrepPath).isFile() || lstatSync(ripgrepPath).isSymbolicLink()) {
    throw new Error('安装包中的 ripgrep 不是普通文件')
  }
  const manifest = readManifest(manifestPath)
  const windowsSandboxHelpers = verifyManifest(manifest, options.target)
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
  const codeModeHostSize = lstatSync(codeModeHostPath).size
  if (codeModeHostSize < 1_000_000) throw new Error('Codex Code Mode Host 二进制大小无效')
  if (manifest.codeModeHostHashMode === 'sha256' && codeModeHostSize !== manifest.codeModeHostSize) {
    throw new Error('Codex Code Mode Host 二进制大小不匹配')
  }
  if (hashBinary(codeModeHostPath, manifest.codeModeHostHashMode) !== manifest.codeModeHostSha256) {
    throw new Error('Codex Code Mode Host 二进制哈希不匹配')
  }
  const ripgrepSize = lstatSync(ripgrepPath).size
  if (
    manifest.ripgrep !== codexRipgrepBinaryName(options.target)
    || (manifest.ripgrepHashMode === 'sha256' && ripgrepSize !== manifest.ripgrepSize)
    || ripgrepSize < 1_000_000
    || hashBinary(ripgrepPath, manifest.ripgrepHashMode) !== manifest.ripgrepSha256
  ) {
    throw new Error('Codex 官方 ripgrep 校验失败')
  }
  if (canExecuteCodexEngineTarget(options.target)) {
    const codeModeHostSmoke = spawnSync(codeModeHostPath, ['--help'], { encoding: 'utf8', timeout: 10_000 })
    if (
      codeModeHostSmoke.error
      || codeModeHostSmoke.status !== 0
      || !`${codeModeHostSmoke.stdout}\n${codeModeHostSmoke.stderr}`.includes('--listen')
    ) {
      throw new Error('Codex Code Mode Host 无法作为同平台 companion 启动')
    }
  } else {
    console.log(`[codex-engine] skipped executable smoke for cross target ${options.target}`)
  }
  for (const helper of windowsSandboxHelpers) {
    const helperPath = join(destination, helper.name)
    if (!existsSync(helperPath)) throw new Error(`安装包缺少 Windows Sandbox 辅助程序: ${helper.name}`)
    const stat = lstatSync(helperPath)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== helper.size || sha256(helperPath) !== helper.sha256) {
      throw new Error(`Windows Sandbox 辅助程序校验失败: ${helper.name}`)
    }
  }
  if (options.target.includes('windows')) {
    // Cross-target staging validates the exact Core executables as PE without
    // executing them. The later unpacked-app audit covers every native asset.
    const target = options.target as WindowsNativeTarget
    for (const executable of [
      binaryPath,
      codeModeHostPath,
      ripgrepPath,
      ...windowsSandboxHelpers.map(helper => join(destination, helper.name)),
    ]) verifyWindowsPeMachine(executable, target)
  }
}

function stagePreparedCodexEngine(
  options: CodexEngineStageOptions,
  source: PreparedCodexEngine,
  patches: readonly CodexEngineProductPatch[],
): void {
  const destination = resolve(options.destinationDir)
  mkdirSync(destination, { recursive: true })

  const stagedBinary = join(destination, stagedCodexEngineBinaryName(options.target))
  const stagedCodeModeHost = join(destination, codexCodeModeHostBinaryName(options.target))
  const stagedRipgrep = join(destination, codexRipgrepBinaryName(options.target))
  const manifestPath = join(destination, codexEngineManifestName(options.target))
  // Copy first: a CI prebuilt binary may be the previous staged resource in
  // this same directory. Removing the legacy name before the copy would make
  // that valid upgrade input disappear.
  if (resolve(source.binary) !== stagedBinary) copyFileSync(source.binary, stagedBinary)
  if (resolve(source.codeModeHost) !== stagedCodeModeHost) copyFileSync(source.codeModeHost, stagedCodeModeHost)
  if (resolve(source.ripgrep) !== stagedRipgrep) copyFileSync(source.ripgrep, stagedRipgrep)
  for (const legacy of [
    ...LEGACY_STAGED_FILES,
    `codex-app-server-${options.target}${options.target.includes('windows') ? '.exe' : ''}`,
    `codex-engine-manifest-${options.target}.json`,
  ]) {
    rmSync(join(destination, legacy), { force: true })
  }
  if (!options.target.includes('windows')) {
    for (const helper of WINDOWS_SANDBOX_HELPER_FILENAMES) {
      rmSync(join(destination, helper), { force: true })
    }
  }
  if (!options.target.includes('windows')) {
    chmodSync(stagedBinary, 0o755)
    adHocSignMacBinary(stagedBinary)
    chmodSync(stagedCodeModeHost, 0o755)
    adHocSignMacBinary(stagedCodeModeHost)
    chmodSync(stagedRipgrep, 0o755)
    adHocSignMacBinary(stagedRipgrep)
  }
  const windowsSandboxHelpers = options.target.includes('windows')
    ? source.windowsSandboxHelpers
    : undefined
  if (options.target.includes('windows') && !windowsSandboxHelpers) {
    throw new Error('Windows Codex 引擎缺少原生 Sandbox 辅助程序')
  }
  const stagedWindowsSandboxHelpers = windowsSandboxHelpers
    ? [
      { name: WINDOWS_SANDBOX_HELPER_FILENAMES[0], source: windowsSandboxHelpers.setup },
      { name: WINDOWS_SANDBOX_HELPER_FILENAMES[1], source: windowsSandboxHelpers.commandRunner },
    ].map(helper => {
      const destinationPath = join(destination, helper.name)
      copyFileSync(helper.source, destinationPath)
      const stat = lstatSync(destinationPath)
      return { name: helper.name, sha256: sha256(destinationPath), size: stat.size }
    })
    : undefined
  copyFileSync(join(engineRoot, 'LICENSE'), join(destination, LICENSE_FILE))
  copyFileSync(join(engineRoot, 'NOTICE'), join(destination, NOTICE_FILE))

  const binaryHashMode: BinaryHashMode = options.target.includes('apple') && isThinMachO64(readFileSync(stagedBinary))
    ? 'mach-o-code-signature-neutral-sha256'
    : 'sha256'
  const codeModeHostHashMode: BinaryHashMode = options.target.includes('apple') && isThinMachO64(readFileSync(stagedCodeModeHost))
    ? 'mach-o-code-signature-neutral-sha256'
    : 'sha256'
  const ripgrepHashMode: BinaryHashMode = options.target.includes('apple') && isThinMachO64(readFileSync(stagedRipgrep))
    ? 'mach-o-code-signature-neutral-sha256'
    : 'sha256'
  const manifest: EngineManifest = {
    schemaVersion: CODEX_ENGINE_MANIFEST_SCHEMA,
    engine: BILLIARDBUDDY_AGENT_ENGINE_NAME,
    sourceRepository: CODEX_ENGINE_SOURCE_REPOSITORY,
    sourceRevision: CODEX_ENGINE_SOURCE_REVISION,
    productPatches: patches,
    target: options.target,
    binary: stagedCodexEngineBinaryName(options.target),
    binaryHashMode,
    binarySha256: hashBinary(stagedBinary, binaryHashMode),
    binarySize: lstatSync(stagedBinary).size,
    codeModeHost: codexCodeModeHostBinaryName(options.target),
    codeModeHostHashMode,
    codeModeHostSha256: hashBinary(stagedCodeModeHost, codeModeHostHashMode),
    codeModeHostSize: lstatSync(stagedCodeModeHost).size,
    ripgrep: codexRipgrepBinaryName(options.target),
    ripgrepHashMode,
    ripgrepSha256: hashBinary(stagedRipgrep, ripgrepHashMode),
    ripgrepSize: lstatSync(stagedRipgrep).size,
    ...(stagedWindowsSandboxHelpers === undefined ? {} : { windowsSandboxHelpers: stagedWindowsSandboxHelpers }),
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
  if (options.prebuiltBinary !== undefined || options.prebuiltCodeModeHost !== undefined) {
    // GitHub's build job applies this same reviewed patch set before Cargo
    // produces the binary. It leaves that checkout dirty by design, so only
    // require the pinned revision and legal files here—not a clean worktree.
    assertPinnedSource()
    stagePreparedCodexEngine(options, prebuiltEngine(options), patches)
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
    ...(cli.prebuiltCodeModeHost === undefined ? {} : { prebuiltCodeModeHost: cli.prebuiltCodeModeHost }),
    ...(cli.prebuiltWindowsSandboxSetup === undefined || cli.prebuiltWindowsCommandRunner === undefined
      ? {}
      : {
        prebuiltWindowsSandboxHelpers: {
          setup: cli.prebuiltWindowsSandboxSetup,
          commandRunner: cli.prebuiltWindowsCommandRunner,
        },
      }),
  })
  console.log(`[codex-engine] ${cli.verifyOnly ? 'verified' : 'staged'} for ${requestedTarget}`)
}
