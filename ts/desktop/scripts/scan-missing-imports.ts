/**
 * scan-missing-imports.ts
 *
 * 在编译 sidecar 之前，扫描 src/ 里所有相对路径的 import / require / 类型 import
 * specifier，找出磁盘上不存在的目标并停止构建；同时从正式 sidecar 入口建立
 * 生产可达图，拒绝继续保留没有消费者的 CLI、TUI、旧 Harness 或占位模块。
 *
 * 导入基线中已经存在的 feature-gated stub 都是 Git 跟踪文件，fresh checkout
 * 无需重新生成。新的缺口通常意味着迁移或重构断链，不能再用万能 Proxy 自动
 * 掩盖，否则 Browser、Workflow、上下文压缩等真实能力可能被静默替换成 noop。
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'

const repoRoot = path.resolve(import.meta.dir, '../..')
const srcRoot = path.join(repoRoot, 'src')
const adaptersRoot = path.join(repoRoot, 'adapters')

const IMPORT_PATTERNS = [
  // import X from './foo'
  /from\s+['"](\.[^'"]+)['"]/g,
  // import('./foo')
  /import\s*\(\s*['"](\.[^'"]+)['"]/g,
  // require('./foo')
  /require\s*\(\s*['"](\.[^'"]+)['"]/g,
  // import './foo' (side-effect only)
  /import\s+['"](\.[^'"]+)['"]/g,
  // typeof import('./foo')
  /typeof\s+import\s*\(\s*['"](\.[^'"]+)['"]/g,
]

const SOURCE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts', '.mjs', '.cjs'])

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules') continue
    if (entry.name === '__tests__') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walk(full)
    } else if (entry.isFile() && SOURCE_EXT.has(path.extname(entry.name))) {
      yield full
    }
  }
}

function resolveCandidates(importer: string, spec: string): string[] {
  const importerDir = path.dirname(importer)
  const base = path.resolve(importerDir, spec)
  return [
    base,
    base + '.ts',
    base + '.tsx',
    base + '.mts',
    base + '.cts',
    base + '.js',
    base + '.jsx',
    base + '.mjs',
    base + '.cjs',
    base.replace(/\.(m|c)?js$/, '.ts'),
    base.replace(/\.(m|c)?js$/, '.tsx'),
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
  ]
}

function missingTargetPath(importer: string, spec: string): string {
  const importerDir = path.dirname(importer)
  const base = path.resolve(importerDir, spec)
  // 把 .js 还原成 .ts —— TS 源里写 .js 是 ESM-on-Node 的惯例
  if (base.endsWith('.js')) return base.slice(0, -3) + '.ts'
  if (base.endsWith('.jsx')) return base.slice(0, -4) + '.tsx'
  if (path.extname(base) === '') return base + '.ts'
  return base
}

function existingTarget(importer: string, spec: string): string | null {
  for (const candidate of resolveCandidates(importer, spec)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

function isProductionSource(file: string): boolean {
  const normalized = file.split(path.sep).join('/')
  return !normalized.includes('/__tests__/')
    && !normalized.endsWith('.test.ts')
    && !normalized.endsWith('.test.tsx')
    && !normalized.endsWith('.test.js')
    && !normalized.endsWith('.test.jsx')
}

async function reachableFrom(entrypoints: string[]): Promise<Set<string>> {
  const reachable = new Set<string>()
  const pending = [...entrypoints]
  while (pending.length > 0) {
    const file = pending.pop()!
    if (reachable.has(file) || !existsSync(file) || !statSync(file).isFile()) continue
    reachable.add(file)

    let contents: string
    try {
      contents = await readFile(file, 'utf8')
    } catch {
      continue
    }
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(contents)) !== null) {
        const target = existingTarget(file, match[1]!)
        if (target && !reachable.has(target)) pending.push(target)
      }
    }
  }
  return reachable
}

async function* walkRoots(roots: string[]): AsyncGenerator<string> {
  for (const root of roots) {
    if (!existsSync(root)) continue
    yield* walk(root)
  }
}

async function main() {
  const missing = new Map<string, Set<string>>() // stubPath → set of importers
  const productionSources: string[] = []
  let scannedFiles = 0

  for await (const file of walkRoots([srcRoot, adaptersRoot])) {
    scannedFiles++
    if (isProductionSource(file)) productionSources.push(file)
    let contents: string
    try {
      contents = await readFile(file, 'utf8')
    } catch {
      continue
    }

    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(contents)) !== null) {
        const spec = match[1]!
        if (!spec.startsWith('.')) continue
        if (existingTarget(file, spec)) continue
        const targetPath = missingTargetPath(file, spec)
        if (!missing.has(targetPath)) missing.set(targetPath, new Set())
        missing.get(targetPath)!.add(path.relative(repoRoot, file))
      }
    }
  }

  console.log(`[scan] scanned ${scannedFiles} source files`)
  console.log(`[scan] missing ${missing.size} import targets`)
  if (missing.size > 0) {
    for (const [targetPath, importers] of missing) {
      const rel = path.relative(repoRoot, targetPath)
      const sample = [...importers].slice(0, 2).join(', ')
      console.error(
        `[scan] missing: ${rel} (referenced from ${sample}${importers.size > 2 ? `, +${importers.size - 2}` : ''})`,
      )
    }
    throw new Error(
      `[scan] ${missing.size} unresolved relative import target(s); restore the real module or remove its consumer`,
    )
  }

  const entrypoint = path.join(repoRoot, 'desktop', 'sidecars', 'billiardbuddy-sidecar.ts')
  const reachable = await reachableFrom([entrypoint])
  const unreachable = productionSources.filter(file => !reachable.has(file)).sort()
  console.log(`[scan] production sources ${productionSources.length}; reachable ${productionSources.length - unreachable.length}`)
  if (unreachable.length > 0) {
    for (const file of unreachable) console.error(`[scan] unreachable production source: ${path.relative(repoRoot, file)}`)
    throw new Error(`[scan] ${unreachable.length} production source file(s) have no path from the BilliardBuddy sidecar entrypoint`)
  }
}

await main()
