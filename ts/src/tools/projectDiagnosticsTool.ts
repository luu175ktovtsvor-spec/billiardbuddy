import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Tool, ToolContext } from './Tool'
import { StreamingOutputSanitizer } from './outputSanitize'

const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 300_000
const DEFAULT_MAX_OUTPUT_BYTES = 80_000
const MAX_OUTPUT_BYTES = 500_000
const MAX_TEST_SUGGESTIONS = 5
const MAX_TEST_SCAN_ENTRIES = 800
const MAX_TEST_SCAN_DEPTH = 4

type DiagnosticsCheck = 'auto' | 'typecheck' | 'lint' | 'test'
type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm'

export interface ProjectDiagnosticsInput {
  path?: string
  check?: DiagnosticsCheck
  test_paths?: string | string[]
  timeout_ms?: number | string
  max_output_bytes?: number | string
}

interface PackageInfo {
  dir: string
  packagePath: string
  scripts: Record<string, string>
  parseError?: string
}

interface PickedScript {
  check: Exclude<DiagnosticsCheck, 'auto'>
  name: string
  body: string
  command: string
  manager: PackageManager
}

interface PickedPackageScript {
  pkg: PackageInfo
  script: PickedScript
}

interface PickedInvalidPackage {
  pkg: PackageInfo
  error: string
}

interface TestSuggestion {
  path: string
  cwd: string
  command: string
}

interface FocusedTestTargets {
  paths: string[]
  error: string | null
}

export const projectDiagnosticsTool: Tool<ProjectDiagnosticsInput> = {
  name: 'project_diagnostics',
  description:
    'Run a bounded project diagnostic script from the nearest package.json. Input: { path?, check?, test_paths?, timeout_ms?, max_output_bytes? }. Auto runs typecheck/lint only; check:"test" must be explicit and may use test_paths for focused tests.',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Optional file or directory to start from. Defaults to workspace root.' },
      check: { type: 'string', enum: ['auto', 'typecheck', 'lint', 'test'], description: 'Diagnostic kind. Default auto prefers typecheck then lint; tests are explicit.' },
      test_paths: { type: ['array', 'string'], items: { type: 'string' }, description: 'Optional existing workspace-relative test file/directory path(s) appended to the package test script. Only used with check:"test".' },
      timeout_ms: { type: ['number', 'string'], description: `Optional timeout in ms, capped at ${MAX_TIMEOUT_MS}.` },
      max_output_bytes: { type: ['number', 'string'], description: `Optional combined stdout/stderr tail cap, capped at ${MAX_OUTPUT_BYTES}.` },
    },
  },
  isReadOnly: false,
  isReadOnlyFor(input) {
    return normalizeCheck(input?.check) !== 'test'
  },
  requiresApprovalFor(input) {
    return normalizeCheck(input?.check) === 'test'
  },
  approvalClassFor(input) {
    return normalizeCheck(input?.check) === 'test' ? 'file' : undefined
  },
  fatalReasonFor(input) {
    const check = normalizeCheck(input?.check)
    if (!check) return 'project_diagnostics check 必须是 auto/typecheck/lint/test'
    return null
  },
  approvalReasonFor(input) {
    return {
      what: '运行项目测试诊断',
      why: `模型请求执行 ${normalizeCheck(input?.check) || 'test'} 检查,用于确认代码改动没有破坏行为。`,
      impact: '测试脚本可能生成缓存、快照或临时文件,所以需要按文件类动作处理。',
    }
  },
  async previewFor(input, ctx) {
    const check = normalizeCheck(input?.check) ?? 'auto'
    const start = await resolveStartDirectory(ctx, input?.path)
    const packages = await findPackageChain(ctx.workspace.root, start)
    if (!packages.length) {
      return `<project_diagnostics_preview status="missing_package_json" start="${relativePath(ctx, start)}" />`
    }
    const picked = pickScriptFromPackages(packages, check, ctx.workspace.root)
    if (!picked) {
      const nearest = packages[0]!
      return [
        '<project_diagnostics_preview status="missing_script">',
        `package: ${relativePath(ctx, nearest.packagePath)}`,
        `check: ${check}`,
        `available: ${Object.keys(nearest.scripts).sort().join(',')}`,
        '</project_diagnostics_preview>',
      ].join('\n')
    }
    if ('error' in picked) {
      return [
        '<project_diagnostics_preview status="invalid_package_json">',
        `package: ${relativePath(ctx, picked.pkg.packagePath)}`,
        `error: ${picked.error}`,
        '</project_diagnostics_preview>',
      ].join('\n')
    }
    const { pkg, script } = picked
    const unsafe = unsafeDiagnosticReason(script)
    if (unsafe) {
      return [
        '<project_diagnostics_preview status="rejected">',
        `package: ${relativePath(ctx, pkg.packagePath)}`,
        `check: ${script.check}`,
        `script: ${script.name}`,
        `reason: ${unsafe}`,
        `body: ${script.body}`,
        '</project_diagnostics_preview>',
      ].join('\n')
    }
    const testTargets = script.check === 'test'
      ? await resolveFocusedTestTargets(ctx, pkg.dir, input?.test_paths)
      : { paths: [], error: hasTestPaths(input?.test_paths) ? 'test_paths 只在 check="test" 时生效' : null }
    if (testTargets.error) {
      return [
        '<project_diagnostics_preview status="invalid_test_path">',
        `package: ${relativePath(ctx, pkg.packagePath)}`,
        `check: ${script.check}`,
        `script: ${script.name}`,
        `reason: ${testTargets.error}`,
        '</project_diagnostics_preview>',
      ].join('\n')
    }
    const command = appendTestPathArgs(script.command, testTargets.paths)
    return [
      '<project_diagnostics_preview status="ready">',
      `package: ${relativePath(ctx, pkg.packagePath)}`,
      `cwd: ${relativePath(ctx, pkg.dir)}`,
      `check: ${script.check}`,
      `script: ${script.name}`,
      `manager: ${script.manager}`,
      `command: ${command}`,
      testTargets.paths.length ? `test_targets:\n${testTargets.paths.map(path => `- ${path}`).join('\n')}` : 'test_targets: all',
      `timeout_ms: ${clampNumber(input?.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)}`,
      `max_output_bytes: ${clampNumber(input?.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES)}`,
      '</project_diagnostics_preview>',
    ].join('\n')
  },
  async execute(input, ctx) {
    const check = normalizeCheck(input?.check) ?? 'auto'
    const start = await resolveStartDirectory(ctx, input?.path)
    const packages = await findPackageChain(ctx.workspace.root, start)
    if (!packages.length) {
      return `<project_diagnostics status="missing_package_json" start="${xmlAttr(relativePath(ctx, start))}" />`
    }
    const picked = pickScriptFromPackages(packages, check, ctx.workspace.root)
    if (!picked) {
      const nearest = packages[0]!
      return `<project_diagnostics status="missing_script" package="${xmlAttr(relativePath(ctx, nearest.packagePath))}" check="${check}" available="${xmlAttr(Object.keys(nearest.scripts).sort().join(','))}" />`
    }
    if ('error' in picked) {
      return `<project_diagnostics status="invalid_package_json" package="${xmlAttr(relativePath(ctx, picked.pkg.packagePath))}" error="${xmlAttr(picked.error)}" />`
    }
    const { pkg, script } = picked
    const unsafe = unsafeDiagnosticReason(script)
    if (unsafe) {
      return `<project_diagnostics status="rejected" package="${xmlAttr(relativePath(ctx, pkg.packagePath))}" check="${script.check}" script="${xmlAttr(script.name)}" reason="${xmlAttr(unsafe)}">\n${xmlText(script.body)}\n</project_diagnostics>`
    }
    const testSuggestions = await collectTestSuggestions(ctx, input?.path, start, packages)
    const testTargets = script.check === 'test'
      ? await resolveFocusedTestTargets(ctx, pkg.dir, input?.test_paths)
      : { paths: [], error: hasTestPaths(input?.test_paths) ? 'test_paths 只在 check="test" 时生效' : null }
    if (testTargets.error) {
      return `<project_diagnostics status="invalid_test_path" package="${xmlAttr(relativePath(ctx, pkg.packagePath))}" check="${script.check}" script="${xmlAttr(script.name)}" reason="${xmlAttr(testTargets.error)}" />`
    }
    const command = appendTestPathArgs(script.command, testTargets.paths)

    const result = await runDiagnostic(command, pkg.dir, {
      timeoutMs: clampNumber(input?.timeout_ms, DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS),
      maxOutputBytes: clampNumber(input?.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES, MAX_OUTPUT_BYTES),
      signal: ctx.signal,
      progressEmit: ctx.progressEmit,
    })
    return [
      `<project_diagnostics status="completed" package="${xmlAttr(relativePath(ctx, pkg.packagePath))}" cwd="${xmlAttr(relativePath(ctx, pkg.dir))}" check="${script.check}" script="${xmlAttr(script.name)}" manager="${script.manager}" exit_code="${result.exitCode}" elapsed_ms="${result.elapsedMs}" timed_out="${result.timedOut}" truncated="${result.truncatedBytes > 0}">`,
      `<command>${xmlText(command)}</command>`,
      formatTestTargets(testTargets.paths),
      formatTestSuggestions(testSuggestions),
      '<output>',
      xmlText(result.output),
      '</output>',
      '</project_diagnostics>',
    ].filter(Boolean).join('\n')
  },
}

async function resolveStartDirectory(ctx: ToolContext, inputPath: unknown): Promise<string> {
  const abs = ctx.workspace.resolve(typeof inputPath === 'string' && inputPath.trim() ? inputPath : '.', 'read')
  const root = resolve(ctx.workspace.root)
  let current = abs
  while (true) {
    const info = await stat(current).catch(() => null)
    if (info) return info.isDirectory() ? current : dirname(current)
    if (current === root) return root
    const next = dirname(current)
    if (next === current || !isInside(root, next)) return root
    current = next
  }
}

async function findPackageChain(root: string, start: string): Promise<PackageInfo[]> {
  const workspaceRoot = resolve(root)
  let dir = resolve(start)
  const packages: PackageInfo[] = []
  while (dir === workspaceRoot || isInside(workspaceRoot, dir)) {
    const packagePath = join(dir, 'package.json')
    if (existsSync(packagePath)) {
      try {
        const parsed = JSON.parse(await readFile(packagePath, 'utf8')) as { scripts?: unknown }
        const scripts = normalizeScripts(parsed.scripts)
        packages.push({ dir, packagePath, scripts })
      } catch (error) {
        packages.push({
          dir,
          packagePath,
          scripts: {},
          parseError: error instanceof Error ? error.message : String(error),
        })
      }
    }
    const next = dirname(dir)
    if (next === dir) break
    dir = next
  }
  return packages
}

function normalizeScripts(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim()) out[key] = value
  }
  return out
}

function pickScriptFromPackages(packages: PackageInfo[], requested: DiagnosticsCheck, root: string): PickedPackageScript | PickedInvalidPackage | null {
  for (const pkg of packages) {
    if (pkg.parseError) return { pkg, error: pkg.parseError }
    const script = pickScript(pkg, requested, root)
    if (script) return { pkg, script }
  }
  return null
}

async function collectTestSuggestions(
  ctx: ToolContext,
  inputPath: unknown,
  startDir: string,
  packages: PackageInfo[],
): Promise<TestSuggestion[]> {
  const picked = pickScriptFromPackages(packages, 'test', ctx.workspace.root)
  if (!picked || 'error' in picked) return []
  if (unsafeDiagnosticReason(picked.script)) return []

  const target = ctx.workspace.resolve(typeof inputPath === 'string' && inputPath.trim() ? inputPath : '.', 'read')
  const candidatePaths = await findNearbyTestFiles(target, startDir, picked.pkg.dir)
  return candidatePaths.map(abs => {
    const testPath = relative(picked.pkg.dir, abs) || '.'
    return {
      path: relativePath(ctx, abs),
      cwd: relativePath(ctx, picked.pkg.dir),
      command: `${picked.script.command} -- ${shellQuote(testPath)}`,
    }
  })
}

async function resolveFocusedTestTargets(ctx: ToolContext, packageDir: string, rawPaths: unknown): Promise<FocusedTestTargets> {
  const items = normalizeStringList(rawPaths)
  if (!items.length) return { paths: [], error: null }
  const pkg = resolve(packageDir)
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    let abs: string
    try {
      abs = ctx.workspace.resolve(item, 'read')
    } catch (error) {
      return { paths: [], error: `测试路径无效:${errText(error)}` }
    }
    const resolved = resolve(abs)
    if (!isInside(pkg, resolved)) {
      return { paths: [], error: `测试路径不在 package 内:${item}` }
    }
    const info = await stat(resolved).catch(() => null)
    if (!info || (!info.isFile() && !info.isDirectory())) {
      return { paths: [], error: `测试路径不存在或不是文件/目录:${item}` }
    }
    const rel = relative(pkg, resolved).replaceAll('\\', '/') || '.'
    if (seen.has(rel)) continue
    seen.add(rel)
    out.push(rel)
  }
  return { paths: out, error: null }
}

function normalizeStringList(value: unknown): string[] {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? [value] : []
  return items.map(item => typeof item === 'string' ? item.trim() : '').filter(Boolean)
}

function hasTestPaths(value: unknown): boolean {
  return normalizeStringList(value).length > 0
}

async function findNearbyTestFiles(target: string, startDir: string, packageDir: string): Promise<string[]> {
  const out = new Map<string, string>()
  const root = resolve(packageDir)
  const targetInfo = await stat(target).catch(() => null)
  const add = async (abs: string) => {
    const resolved = resolve(abs)
    if (!isInside(root, resolved)) return
    if (out.has(resolved)) return
    const info = await stat(resolved).catch(() => null)
    if (!info?.isFile() || !isTestFile(resolved)) return
    out.set(resolved, resolved)
  }

  if (targetInfo?.isFile() && isTestFile(target)) {
    await add(target)
  }

  if (targetInfo?.isDirectory()) {
    await collectTestFilesInDirectory(target, root, out)
  } else {
    const dir = targetInfo?.isDirectory() ? target : dirname(target)
    for (const candidate of exactTestCandidates(target)) {
      await add(join(dir, candidate))
      await add(join(dir, '__tests__', candidate))
      if (out.size >= MAX_TEST_SUGGESTIONS) break
    }
    if (out.size < MAX_TEST_SUGGESTIONS && isInside(root, startDir)) {
      await collectTestFilesInDirectory(startDir, root, out)
    }
  }

  return Array.from(out.keys()).slice(0, MAX_TEST_SUGGESTIONS)
}

async function collectTestFilesInDirectory(dir: string, root: string, out: Map<string, string>, depth = 0, state: { entries: number } = { entries: 0 }): Promise<void> {
  if (out.size >= MAX_TEST_SUGGESTIONS || state.entries >= MAX_TEST_SCAN_ENTRIES || depth > MAX_TEST_SCAN_DEPTH) return
  const resolved = resolve(dir)
  if (!isInside(root, resolved)) return
  const entries = await readdir(resolved, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (out.size >= MAX_TEST_SUGGESTIONS || state.entries >= MAX_TEST_SCAN_ENTRIES) return
    if (shouldSkipTestScanEntry(entry.name)) continue
    state.entries += 1
    const abs = join(resolved, entry.name)
    if (entry.isDirectory()) {
      await collectTestFilesInDirectory(abs, root, out, depth + 1, state)
      continue
    }
    if (entry.isFile() && isTestFile(abs)) out.set(abs, abs)
  }
}

function exactTestCandidates(target: string): string[] {
  const file = basename(target)
  const ext = extname(file)
  const stem = ext ? file.slice(0, -ext.length) : file
  if (!stem || isTestFile(file)) return [file]
  const exts = testExtensionsFor(ext)
  const candidates: string[] = []
  for (const candidateExt of exts) {
    candidates.push(`${stem}.test${candidateExt}`, `${stem}.spec${candidateExt}`)
    if (candidateExt === '.py') candidates.push(`test_${stem}.py`, `${stem}_test.py`)
  }
  return Array.from(new Set(candidates))
}

function testExtensionsFor(ext: string): string[] {
  const normalized = ext.toLowerCase()
  if (normalized === '.tsx') return ['.tsx', '.ts', '.jsx', '.js']
  if (normalized === '.ts') return ['.ts', '.tsx', '.js', '.jsx']
  if (normalized === '.jsx') return ['.jsx', '.js', '.tsx', '.ts']
  if (normalized === '.js' || normalized === '.mjs' || normalized === '.cjs') return ['.js', '.jsx', '.ts', '.tsx']
  if (normalized === '.py') return ['.py']
  return ['.ts', '.tsx', '.js', '.jsx']
}

function isTestFile(path: string): boolean {
  const file = basename(path).toLowerCase()
  return /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ||
    /\.(test|spec)\.py$/.test(file) ||
    /^test_.+\.py$/.test(file) ||
    /_test\.py$/.test(file)
}

function shouldSkipTestScanEntry(name: string): boolean {
  return name === 'node_modules' ||
    name === '.git' ||
    name === '.next' ||
    name === '.turbo' ||
    name === 'dist' ||
    name === 'build' ||
    name === 'coverage' ||
    name === 'output' ||
    name === '.backups'
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(value)) return value
  return `'${value.replaceAll("'", "'\\''")}'`
}

function appendTestPathArgs(command: string, testPaths: string[]): string {
  if (!testPaths.length) return command
  return `${command} -- ${testPaths.map(shellQuote).join(' ')}`
}

function formatTestTargets(paths: string[]): string {
  if (!paths.length) return ''
  return [
    `<test_targets count="${paths.length}">`,
    ...paths.map(path => `<target path="${xmlAttr(path)}" />`),
    '</test_targets>',
  ].join('\n')
}

function formatTestSuggestions(suggestions: TestSuggestion[]): string {
  if (!suggestions.length) return ''
  return [
    `<test_suggestions count="${suggestions.length}">`,
    ...suggestions.map(item => `<suggestion path="${xmlAttr(item.path)}" cwd="${xmlAttr(item.cwd)}" command="${xmlAttr(item.command)}" />`),
    '</test_suggestions>',
  ].join('\n')
}

function pickScript(pkg: PackageInfo, requested: DiagnosticsCheck, root: string): PickedScript | null {
  const candidates = requested === 'auto'
    ? ['typecheck', 'check:types', 'lint', 'check', 'lint:ci']
    : scriptCandidates(requested)
  for (const name of candidates) {
    const body = pkg.scripts[name]
    if (!body) continue
    const manager = detectPackageManager(pkg.dir, root)
    return { check: requested === 'auto' ? inferCheck(name) : requested, name, body, command: `${manager} run ${name}`, manager }
  }
  return null
}

function scriptCandidates(check: Exclude<DiagnosticsCheck, 'auto'>): string[] {
  if (check === 'typecheck') return ['typecheck', 'check:types', 'types', 'tsc']
  if (check === 'lint') return ['lint', 'lint:ci', 'check', 'biome:check']
  return ['test', 'test:unit', 'test:ci']
}

function inferCheck(scriptName: string): Exclude<DiagnosticsCheck, 'auto'> {
  if (scriptName.includes('lint') || scriptName === 'check' || scriptName.includes('biome')) return 'lint'
  return 'typecheck'
}

function detectPackageManager(dir: string, root: string): PackageManager {
  const workspaceRoot = resolve(root)
  let current = resolve(dir)
  while (current === workspaceRoot || isInside(workspaceRoot, current)) {
    const declared = packageManagerFromPackageJson(current)
    if (declared) return declared
    const lockfile = packageManagerFromLockfile(current)
    if (lockfile) return lockfile
    const next = dirname(current)
    if (next === current) break
    current = next
  }
  return 'npm'
}

function packageManagerFromLockfile(dir: string): PackageManager | null {
  if (existsSync(join(dir, 'bun.lock')) || existsSync(join(dir, 'bun.lockb'))) return 'bun'
  if (existsSync(join(dir, 'pnpm-lock.yaml'))) return 'pnpm'
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn'
  if (existsSync(join(dir, 'package-lock.json')) || existsSync(join(dir, 'npm-shrinkwrap.json'))) return 'npm'
  return null
}

function packageManagerFromPackageJson(dir: string): PackageManager | null {
  const packagePath = join(dir, 'package.json')
  if (!existsSync(packagePath)) return null
  try {
    const parsed = JSON.parse(readFileSync(packagePath, 'utf8')) as { packageManager?: unknown }
    if (typeof parsed.packageManager !== 'string') return null
    return packageManagerFromSpec(parsed.packageManager)
  } catch {
    return null
  }
}

function packageManagerFromSpec(spec: string): PackageManager | null {
  const name = spec.trim().split('@')[0]
  if (name === 'bun' || name === 'pnpm' || name === 'yarn' || name === 'npm') return name
  return null
}

function unsafeDiagnosticReason(script: PickedScript): string | null {
  const body = script.body.trim()
  const lower = body.toLowerCase()
  if (/[;&|]\s*(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee)\b/.test(lower) || /^(rm|mv|cp|mkdir|rmdir|touch|chmod|chown|ln|tee)\b/.test(lower)) {
    return '脚本包含文件写改/删除命令,请改用 run_command 并显式确认'
  }
  if (/(^|[^<])>>?[^&]/.test(body) || /\b\d>>?/.test(body)) return '脚本包含输出重定向,可能写文件'
  if (/\b(sed|perl)\s+.*\s-i\b/.test(lower) || /\b(sed|perl)\s+-i\b/.test(lower)) return '脚本包含原地改写'
  if (/(^|\s)(--fix|--write|--update|--watch)(\s|$)/.test(lower)) return '脚本包含 fix/write/update/watch 参数'
  if (/\b(npm|pnpm|yarn|bun)\s+(install|add|upgrade|update|publish)\b/.test(lower)) return '脚本包含依赖安装/发布动作'
  if (/\b(curl|wget|ssh|scp|sftp|ftp|nc|netcat)\b/.test(lower)) return '脚本包含网络/远程访问动作'
  if (script.check === 'typecheck' && !looksLikeTypecheckCommand(lower)) {
    return 'typecheck 脚本不像类型检查命令'
  }
  if (script.check === 'lint' && !looksLikeLintCommand(lower)) {
    return 'lint/check 脚本不像静态检查命令'
  }
  if (script.check === 'test' && !/\b(bun\s+test|vitest|jest|mocha|node\s+--test|pytest|echo)\b/.test(lower)) {
    return 'test 脚本不像测试命令'
  }
  return null
}

function looksLikeTypecheckCommand(body: string): boolean {
  return /\b(tsc|vue-tsc|svelte-check|astro\s+check|echo|node\s+--version|bun\s+--version)\b/.test(body) ||
    /\b(npm|pnpm|yarn|bun)\b[^\n;&|]*\b(typecheck|check:types|types|tsc)\b/.test(body) ||
    /\b(turbo|nx|lerna)\b[^\n;&|]*\b(typecheck|check:types|types|tsc)\b/.test(body)
}

function looksLikeLintCommand(body: string): boolean {
  return /\b(eslint|biome\s+check|oxlint|tsc|next\s+lint|echo)\b/.test(body) ||
    /\b(npm|pnpm|yarn|bun)\b[^\n;&|]*\b(lint|lint:ci|check|biome:check|oxlint)\b/.test(body) ||
    /\b(turbo|nx|lerna)\b[^\n;&|]*\b(lint|lint:ci|check|biome:check|oxlint)\b/.test(body)
}

function runDiagnostic(command: string, cwd: string, opts: { timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal; progressEmit?: ToolContext['progressEmit'] }): Promise<{ exitCode: number; elapsedMs: number; timedOut: boolean; truncatedBytes: number; output: string }> {
  const startedAt = Date.now()
  const output = new TailBuffer(opts.maxOutputBytes)
  const liveProgress: LiveProgressState = { emittedBytes: 0, truncated: false }
  const streamSanitizers: Record<'stdout' | 'stderr', StreamingOutputSanitizer> = {
    stdout: new StreamingOutputSanitizer(),
    stderr: new StreamingOutputSanitizer(),
  }
  const isWin = process.platform === 'win32'
  const child = isWin
    ? spawn('cmd', ['/c', command], { cwd, env: sanitizedProcessEnv() })
    : spawn('sh', ['-c', command], { cwd, env: sanitizedProcessEnv(), detached: true })
  return new Promise(resolvePromise => {
    let timedOut = false
    let settled = false
    emitDiagnosticProgress(opts.progressEmit, `正在运行诊断：${command}\n`, opts.maxOutputBytes, liveProgress)
    const timer = setTimeout(() => {
      timedOut = true
      killChildTree(child)
    }, opts.timeoutMs)
    const onAbort = () => killChildTree(child)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', d => appendSanitizedOutput(output, streamSanitizers.stdout, d, opts.progressEmit, liveProgress, opts.maxOutputBytes))
    child.stderr?.on('data', d => appendSanitizedOutput(output, streamSanitizers.stderr, d, opts.progressEmit, liveProgress, opts.maxOutputBytes))
    const finish = (exitCode: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      flushSanitizedOutput(output, streamSanitizers.stdout, opts.progressEmit, liveProgress, opts.maxOutputBytes)
      flushSanitizedOutput(output, streamSanitizers.stderr, opts.progressEmit, liveProgress, opts.maxOutputBytes)
      resolvePromise({
        exitCode,
        elapsedMs: Date.now() - startedAt,
        timedOut,
        truncatedBytes: output.truncatedBytes,
        output: output.toString().trim(),
      })
    }
    child.on('error', err => {
      output.append(`命令启动失败:${err.message}`)
      finish(-1)
    })
    child.on('close', code => finish(code ?? -1))
  })
}

interface LiveProgressState {
  emittedBytes: number
  truncated: boolean
}

function appendSanitizedOutput(
  output: TailBuffer,
  sanitizer: StreamingOutputSanitizer,
  chunk: Buffer,
  progressEmit: ToolContext['progressEmit'],
  liveProgress: LiveProgressState,
  maxOutputBytes: number,
): void {
  const sanitized = sanitizer.push(chunk)
  if (!sanitized) return
  output.append(sanitized)
  emitDiagnosticProgress(progressEmit, sanitized, maxOutputBytes, liveProgress)
}

function flushSanitizedOutput(
  output: TailBuffer,
  sanitizer: StreamingOutputSanitizer,
  progressEmit: ToolContext['progressEmit'],
  liveProgress: LiveProgressState,
  maxOutputBytes: number,
): void {
  const sanitized = sanitizer.flush()
  if (!sanitized) return
  output.append(sanitized)
  emitDiagnosticProgress(progressEmit, sanitized, maxOutputBytes, liveProgress)
}

function emitDiagnosticProgress(
  progressEmit: ToolContext['progressEmit'],
  chunk: string,
  maxBytes: number,
  state: LiveProgressState,
): void {
  if (!progressEmit || !chunk) return
  const buf = Buffer.from(chunk)
  const remaining = Math.max(0, maxBytes - state.emittedBytes)
  if (remaining <= 0) {
    emitDiagnosticTruncationNotice(progressEmit, state)
    return
  }
  const send = buf.length <= remaining ? buf : buf.subarray(0, remaining)
  state.emittedBytes += send.length
  try {
    progressEmit({ type: 'tool_progress', tool: 'project_diagnostics', stream: 'stdout', chunk: send.toString('utf8') })
  } catch {
    // 进度事件只服务 UI,不能影响诊断本身。
  }
  if (buf.length > remaining) emitDiagnosticTruncationNotice(progressEmit, state)
}

function emitDiagnosticTruncationNotice(progressEmit: NonNullable<ToolContext['progressEmit']>, state: LiveProgressState): void {
  if (state.truncated) return
  state.truncated = true
  try {
    progressEmit({
      type: 'tool_progress',
      tool: 'project_diagnostics',
      stream: 'stderr',
      chunk: '\n[诊断实时输出过长,后续片段已省略;最终结果会保留尾部日志]\n',
    })
  } catch {
    // ignore
  }
}

function killChildTree(child: ReturnType<typeof spawn>): void {
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch {
      // 回退到只杀直接子进程。
    }
  }
  child.kill('SIGKILL')
}

function sanitizedProcessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || isSecretEnvName(key)) continue
    env[key] = value
  }
  return env
}

function isSecretEnvName(key: string): boolean {
  return /(^|_)(API_?KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL|COOKIE|SESSION)$/i.test(key) ||
    /^(OPENAI|ANTHROPIC|ARK|QF_GATEWAY|VIDEO|IMAGE)_/i.test(key)
}

function normalizeCheck(value: unknown): DiagnosticsCheck | null {
  if (value == null || value === '') return 'auto'
  if (value === 'auto' || value === 'typecheck' || value === 'lint' || value === 'test') return value
  return null
}

function clampNumber(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.max(1, Math.min(max, Math.floor(n)))
}

function errText(error: unknown): string {
  if (!error || typeof error !== 'object') return String(error)
  const maybe = error as { message?: unknown }
  return typeof maybe.message === 'string' ? maybe.message : String(error)
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!!rel && !rel.startsWith('..') && !isAbsolute(rel))
}

function relativePath(ctx: ToolContext, abs: string): string {
  return relative(ctx.workspace.root, abs) || '.'
}

function xmlAttr(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
}

function xmlText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

class TailBuffer {
  private readonly chunks: Buffer[] = []
  bytes = 0
  truncatedBytes = 0

  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer | string): void {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    if (!buf.length || this.maxBytes <= 0) return
    if (buf.length >= this.maxBytes) {
      this.truncatedBytes += this.bytes + buf.length - this.maxBytes
      this.chunks.length = 0
      this.chunks.push(buf.subarray(buf.length - this.maxBytes))
      this.bytes = this.maxBytes
      return
    }
    this.chunks.push(buf)
    this.bytes += buf.length
    this.trim()
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.bytes).toString('utf8')
  }

  private trim(): void {
    let overflow = this.bytes - this.maxBytes
    while (overflow > 0 && this.chunks.length) {
      const first = this.chunks[0]!
      if (first.length <= overflow) {
        this.chunks.shift()
        this.bytes -= first.length
        this.truncatedBytes += first.length
        overflow -= first.length
        continue
      }
      this.chunks[0] = first.subarray(overflow)
      this.bytes -= overflow
      this.truncatedBytes += overflow
      overflow = 0
    }
  }
}
