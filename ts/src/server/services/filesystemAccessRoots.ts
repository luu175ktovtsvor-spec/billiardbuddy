import * as path from 'node:path'
import * as os from 'node:os'
import {
  isSameOrInsidePathForPlatform,
  normalizeDriveRootPathForPlatform,
} from './windowsDrivePath.js'

const registeredRoots = new Set<string>()

function isWithinRoot(targetPath: string, rootPath: string): boolean {
  return isSameOrInsidePathForPlatform(targetPath, rootPath)
}

export function registerFilesystemAccessRoot(rootPath: string | null | undefined): void {
  if (!rootPath) return
  registeredRoots.add(path.resolve(normalizeDriveRootPathForPlatform(rootPath)))
}

/**
 * Register the directory of a file this session actually changed so it becomes
 * previewable, even when the user pointed the model at an absolute path outside
 * the session workdir (a different folder, or a different drive on Windows).
 *
 * Writing the file was already authorized via the permission system, so reading
 * it back for a preview is consistent. Files inside the workdir need nothing —
 * they are previewable already — so those are skipped to keep the root set tight.
 */
export function registerChangedFileAccessRoot(
  absoluteFilePath: string | null | undefined,
  workDir: string | null | undefined,
): void {
  if (!absoluteFilePath) return
  const resolved = path.resolve(normalizeDriveRootPathForPlatform(absoluteFilePath))
  if (workDir) {
    const root = path.resolve(normalizeDriveRootPathForPlatform(workDir))
    if (isWithinRoot(resolved, root)) return
  }
  registeredRoots.add(path.dirname(resolved))
}

export function isWithinRegisteredFilesystemRoot(targetPath: string): boolean {
  for (const rootPath of registeredRoots) {
    if (isWithinRoot(targetPath, rootPath)) return true
  }
  return false
}

/**
 * Restrict local preview reads to user-controlled roots. Kept with the root
 * registry because both the default and dynamically registered roots are part
 * of the same preview access policy.
 */
export function isAllowedFilesystemPath(targetPath: string): boolean {
  const resolvedPath = path.resolve(normalizeDriveRootPathForPlatform(targetPath))
  const homeDir = path.resolve(os.homedir())

  if (isWithinRoot(resolvedPath, homeDir) || isWithinRoot(resolvedPath, '/tmp')) {
    return true
  }

  if (isWithinRegisteredFilesystemRoot(resolvedPath)) {
    return true
  }

  // macOS reports /tmp as /private/tmp via native folder pickers and realpath().
  return process.platform === 'darwin' && isWithinRoot(resolvedPath, '/private/tmp')
}

export function clearFilesystemAccessRootsForTests(): void {
  registeredRoots.clear()
}
