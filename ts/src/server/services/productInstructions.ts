import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { findCanonicalGitRoot } from '../../utils/git.js'

const PRODUCT_INSTRUCTION_NAMES = ['AGENTS.md', 'BilliardBuddy.md'] as const
const MAX_FILE_CHARS = 40_000
const MAX_TOTAL_CHARS = 100_000

export type ProductInstructionSource = {
  path: string
  content: string
}

type DiscoveredProductInstruction = ProductInstructionSource & {
  directoryPriority: number
  namePriority: number
  outputOrder: number
}

function truncateContent(content: string, limit: number): string {
  if (content.length <= limit) return content
  const suffix = '\n\n[content truncated]'
  if (limit <= suffix.length) return content.slice(0, limit)
  return `${content.slice(0, limit - suffix.length)}${suffix}`
}

function directoriesFromRoot(root: string, workDir: string): string[] {
  const relative = path.relative(root, workDir)
  if (relative.startsWith('..') || path.isAbsolute(relative)) return [workDir]
  const dirs = [root]
  let current = root
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    dirs.push(current)
  }
  return dirs
}

export function discoverProductInstructions(
  workDir: string,
  rootDir = findCanonicalGitRoot(workDir) ?? workDir,
): ProductInstructionSource[] {
  const seen = new Set<string>()
  const discovered: DiscoveredProductInstruction[] = []
  const directories = directoriesFromRoot(rootDir, workDir)

  for (const [directoryPriority, directory] of directories.entries()) {
    for (const [namePriority, name] of PRODUCT_INSTRUCTION_NAMES.entries()) {
      const candidate = path.join(directory, name)
      let canonical: string
      try {
        const info = fs.statSync(candidate)
        if (!info.isFile()) continue
        canonical = fs.realpathSync(candidate)
      } catch {
        continue
      }
      if (seen.has(canonical)) continue
      seen.add(canonical)

      const raw = fs.readFileSync(canonical, 'utf8')
      if (!raw.trim()) continue
      discovered.push({
        path: canonical,
        content: raw,
        directoryPriority,
        namePriority,
        outputOrder: discovered.length,
      })
    }
  }

  let remaining = MAX_TOTAL_CHARS
  const selected = new Map<number, ProductInstructionSource>()
  const byRetentionPriority = [...discovered].sort((left, right) =>
    right.directoryPriority - left.directoryPriority
      || right.namePriority - left.namePriority
      || right.outputOrder - left.outputOrder,
  )

  for (const instruction of byRetentionPriority) {
    if (remaining <= 0) break
    const limit = Math.min(MAX_FILE_CHARS, remaining)
    const content = truncateContent(instruction.content, limit)
    selected.set(instruction.outputOrder, { path: instruction.path, content })
    remaining -= content.length
  }

  return discovered
    .map(instruction => selected.get(instruction.outputOrder))
    .filter((instruction): instruction is ProductInstructionSource => instruction !== undefined)
}

export function prepareProductInstructionsFile(workDir: string): string | null {
  const sources = discoverProductInstructions(workDir)
  if (sources.length === 0) return null

  const root = findCanonicalGitRoot(workDir) ?? workDir
  const key = createHash('sha256').update(root).digest('hex').slice(0, 24)
  const directory = path.join(
    getClaudeConfigHomeDir(),
    'billiardbuddy',
    'product-instructions',
  )
  const outputPath = path.join(directory, `${key}.md`)
  const body = [
    '# BilliardBuddy project instructions',
    '',
    'These files supplement the native CLAUDE.md instruction chain. Files are ordered from the repository root toward the active directory; later files take precedence when instructions conflict. The current user request always has highest priority.',
    '',
    ...sources.flatMap(source => [
      `## ${path.relative(root, source.path) || path.basename(source.path)}`,
      '',
      source.content,
      '',
    ]),
  ].join('\n')

  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temporary = `${outputPath}.tmp-${randomUUID()}`
  fs.writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(temporary, outputPath)
  return outputPath
}
