import fs from 'node:fs'
import path from 'node:path'

const ROOT_CACHE_LIMIT = 64
const rootCache = new Map<string, string | null>()
const canonicalCache = new Map<string, string | null>()

function cacheResult(
  cache: Map<string, string | null>,
  key: string,
  value: string | null,
): string | null {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > ROOT_CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return value
}

function normalizeExistingDirectory(input: string): string | null {
  try {
    const resolved = fs.realpathSync(path.resolve(input))
    return fs.statSync(resolved).isDirectory() ? resolved : path.dirname(resolved)
  } catch {
    return null
  }
}

/** Find the active checkout containing a directory. */
export function findProductGitRoot(startPath: string): string | null {
  const key = path.resolve(startPath)
  if (rootCache.has(key)) return rootCache.get(key) ?? null
  let current = normalizeExistingDirectory(key)
  if (!current) return cacheResult(rootCache, key, null)

  while (true) {
    try {
      const marker = path.join(current, '.git')
      const stat = fs.lstatSync(marker)
      if (stat.isDirectory() || stat.isFile()) {
        return cacheResult(rootCache, key, current.normalize('NFC'))
      }
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = path.dirname(current)
    if (parent === current) return cacheResult(rootCache, key, null)
    current = parent
  }
}

function resolveWorktreeMainRoot(checkoutRoot: string): string {
  try {
    const marker = path.join(checkoutRoot, '.git')
    if (!fs.lstatSync(marker).isFile()) return checkoutRoot
    const markerValue = fs.readFileSync(marker, 'utf8').trim()
    if (!markerValue.startsWith('gitdir:')) return checkoutRoot

    const worktreeGitDir = fs.realpathSync(
      path.resolve(checkoutRoot, markerValue.slice('gitdir:'.length).trim()),
    )
    const commonDir = fs.realpathSync(
      path.resolve(
        worktreeGitDir,
        fs.readFileSync(path.join(worktreeGitDir, 'commondir'), 'utf8').trim(),
      ),
    )
    if (path.resolve(path.dirname(worktreeGitDir)) !== path.join(commonDir, 'worktrees')) {
      return checkoutRoot
    }
    const backlinkPath = fs.readFileSync(path.join(worktreeGitDir, 'gitdir'), 'utf8').trim()
    const backlink = path.join(fs.realpathSync(path.dirname(backlinkPath)), path.basename(backlinkPath))
    if (backlink !== path.join(fs.realpathSync(checkoutRoot), '.git')) return checkoutRoot
    return (path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir).normalize('NFC')
  } catch {
    return checkoutRoot
  }
}

/** Resolve all worktrees of one repository to one stable product identity. */
export function findProductCanonicalGitRoot(startPath: string): string | null {
  const checkoutRoot = findProductGitRoot(startPath)
  if (!checkoutRoot) return null
  if (canonicalCache.has(checkoutRoot)) return canonicalCache.get(checkoutRoot) ?? null
  return cacheResult(canonicalCache, checkoutRoot, resolveWorktreeMainRoot(checkoutRoot))
}

export function resetProductGitCachesForTests(): void {
  rootCache.clear()
  canonicalCache.clear()
}
