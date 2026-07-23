import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import {
  parseFrontmatter,
  splitPathInFrontmatter,
} from '../../utils/frontmatterParser.js'
import { findCanonicalGitRoot, findGitRoot } from '../../utils/git.js'

const PRODUCT_INSTRUCTION_NAMES = ['AGENTS.md', 'BilliardBuddy.md'] as const
const COMPATIBLE_INSTRUCTION_NAMES = [
  'CLAUDE.md',
  path.join('.claude', 'CLAUDE.md'),
] as const
const LOCAL_INSTRUCTION_NAME = 'CLAUDE.local.md'
const MAX_FILE_CHARS = 40_000
const MAX_TOTAL_CHARS = 100_000

export type ProductInstructionSource = {
  path: string
  content: string
  paths?: string[]
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

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function listRuleFiles(directory: string): string[] {
  const rulesRoot = path.join(directory, '.claude', 'rules')
  const result: string[] = []
  const visit = (current: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const candidate = path.join(current, entry.name)
      if (entry.isDirectory()) visit(candidate)
      else if (entry.isFile() && entry.name.endsWith('.md')) result.push(candidate)
    }
  }
  visit(rulesRoot)
  return result
}

function selectWithinBudget(
  discovered: DiscoveredProductInstruction[],
): ProductInstructionSource[] {
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
    selected.set(instruction.outputOrder, {
      path: instruction.path,
      content,
      ...(instruction.paths ? { paths: instruction.paths } : {}),
    })
    remaining -= content.length
  }

  return discovered
    .map(instruction => selected.get(instruction.outputOrder))
    .filter((instruction): instruction is ProductInstructionSource => instruction !== undefined)
}

function discoverInstructionCandidates(
  workDir: string,
  rootDir: string,
  candidatesForDirectory: (directory: string) => readonly string[],
): ProductInstructionSource[] {
  let canonicalRoot: string
  let canonicalWorkDir: string
  try {
    canonicalRoot = fs.realpathSync(rootDir)
    canonicalWorkDir = fs.realpathSync(workDir)
  } catch {
    return []
  }
  if (!isWithinRoot(canonicalRoot, canonicalWorkDir)) return []

  const seen = new Set<string>()
  const discovered: DiscoveredProductInstruction[] = []
  const directories = directoriesFromRoot(canonicalRoot, canonicalWorkDir)

  for (const [directoryPriority, directory] of directories.entries()) {
    for (const [namePriority, candidate] of candidatesForDirectory(directory).entries()) {
      let canonical: string
      try {
        const info = fs.statSync(candidate)
        if (!info.isFile()) continue
        canonical = fs.realpathSync(candidate)
      } catch {
        continue
      }
      if (!isWithinRoot(canonicalRoot, canonical) || seen.has(canonical)) continue
      seen.add(canonical)

      const raw = fs.readFileSync(canonical, 'utf8')
      if (!raw.trim()) continue
      const isRule = isWithinRoot(path.join(directory, '.claude', 'rules'), canonical)
      const parsed = parseFrontmatter(raw, canonical)
      const basename = path.basename(candidate)
      const isCompatible = basename === 'CLAUDE.md' || basename === LOCAL_INSTRUCTION_NAME
      const content = isRule || isCompatible ? parsed.content : raw
      if (!content.trim()) continue
      const conditionalPaths = isRule && parsed.frontmatter.paths
        ? splitPathInFrontmatter(parsed.frontmatter.paths)
        : []
      discovered.push({
        path: canonical,
        content,
        ...(conditionalPaths.length > 0 ? { paths: conditionalPaths } : {}),
        directoryPriority,
        namePriority,
        outputOrder: discovered.length,
      })
    }
  }

  return selectWithinBudget(discovered)
}

export function discoverProductInstructions(
  workDir: string,
  rootDir = findCanonicalGitRoot(workDir) ?? workDir,
): ProductInstructionSource[] {
  return discoverInstructionCandidates(
    workDir,
    rootDir,
    directory => PRODUCT_INSTRUCTION_NAMES.map(name => path.join(directory, name)),
  )
}

/** Resolve one immutable, project-only ProductTask instruction snapshot. */
export function discoverProductProjectInstructions(
  workDir: string,
  rootDir = findGitRoot(workDir) ?? workDir,
): ProductInstructionSource[] {
  return discoverInstructionCandidates(workDir, rootDir, directory => [
    ...COMPATIBLE_INSTRUCTION_NAMES.map(name => path.join(directory, name)),
    ...listRuleFiles(directory),
    ...PRODUCT_INSTRUCTION_NAMES.map(name => path.join(directory, name)),
    path.join(directory, LOCAL_INSTRUCTION_NAME),
  ])
}

export type ProductInstructionSnapshot = {
  digest: string
  prompt: string | null
  sources: ProductInstructionSource[]
}

export function createProductInstructionSnapshot(
  workDir: string,
): ProductInstructionSnapshot {
  // Use the active checkout root, not the canonical main-worktree root. An
  // isolated worktree must read its own branch's instructions and remain
  // inside its own filesystem boundary.
  const discoveredRoot = findGitRoot(workDir) ?? workDir
  let root = discoveredRoot
  try {
    root = fs.realpathSync(discoveredRoot)
  } catch {
    // Discovery below returns an empty snapshot for an invalid workspace.
  }
  const sources = discoverProductProjectInstructions(workDir, root)
  const prompt = sources.length === 0
    ? null
    : [
        '# BilliardBuddy project instructions',
        '',
        'These are the complete project-scoped instructions for this task. They are ordered from the repository root toward the active directory; later files take precedence when instructions conflict. The current user request always has highest priority.',
        '',
        ...sources.flatMap(source => [
          `## ${path.relative(root, source.path) || path.basename(source.path)}`,
          ...(source.paths
            ? [`Applies only to paths matching: ${source.paths.join(', ')}`]
            : []),
          '',
          source.content,
          '',
        ]),
      ].join('\n')
  const digest = createHash('sha256')
    .update(sources.map(source => `${source.path}\0${source.paths?.join('\0') ?? ''}\0${source.content}`).join('\0'))
    .digest('hex')
  return { digest, prompt, sources }
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
