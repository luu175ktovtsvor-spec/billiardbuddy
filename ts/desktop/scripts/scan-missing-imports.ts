/**
 * scan-missing-imports.ts
 *
 * 在编译 sidecar 之前，扫描 src/ 里所有相对路径的 import / require / 类型 import
 * specifier，找出磁盘上不存在的目标并停止构建。
 *
 * 导入基线中已经存在的 feature-gated stub 都是 Git 跟踪文件，fresh checkout
 * 无需重新生成。新的缺口通常意味着迁移或重构断链，不能再用万能 Proxy 自动
 * 掩盖，否则 Browser、Workflow、上下文压缩等真实能力可能被静默替换成 noop。
 */

import { readdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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

async function* walkRoots(roots: string[]): AsyncGenerator<string> {
  for (const root of roots) {
    if (!existsSync(root)) continue
    yield* walk(root)
  }
}

async function main() {
  const missing = new Map<string, Set<string>>() // stubPath → set of importers
  let scannedFiles = 0

  for await (const file of walkRoots([srcRoot, adaptersRoot])) {
    scannedFiles++
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
        const candidates = resolveCandidates(file, spec)
        let exists = false
        for (const c of candidates) {
          if (existsSync(c)) {
            exists = true
            break
          }
        }
        if (exists) continue
        const targetPath = missingTargetPath(file, spec)
        if (!missing.has(targetPath)) missing.set(targetPath, new Set())
        missing.get(targetPath)!.add(path.relative(repoRoot, file))
      }
    }
  }

  console.log(`[scan] scanned ${scannedFiles} source files`)
  console.log(`[scan] missing ${missing.size} import targets`)
  if (missing.size === 0) return

  for (const [targetPath, importers] of missing) {
    const rel = path.relative(repoRoot, targetPath)
    const sample = [...importers].slice(0, 2).join(', ')
    console.error(
      `[scan] missing: ${rel} (referenced from ${sample}${importers.size > 2 ? `, +${importers.size - 2}` : ''})`,
    )
  }
  throw new Error(
    `[scan] ${missing.size} unresolved relative import target(s); restore the real module or add an explicitly reviewed tracked stub`,
  )
}

await main()
