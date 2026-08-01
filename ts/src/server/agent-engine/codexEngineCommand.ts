import * as fs from 'node:fs/promises'
import * as path from 'node:path'

function engineBinaryName(platform: NodeJS.Platform): string {
  return platform === 'win32'
    ? 'codex-app-server-x86_64-pc-windows-msvc.exe'
    : 'codex-app-server-aarch64-apple-darwin'
}

/**
 * Resolves only the binary staged by the desktop runtime.  The renderer never
 * provides this value: Electron removes inherited values and injects its own
 * verified runtime-assets directory before it launches the local server.
 */
export async function resolveManagedCodexEngineCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string[]> {
  const configuredDirectory = env.BB_CODEX_ENGINE_BIN_DIR?.trim()
  if (!configuredDirectory || !path.isAbsolute(configuredDirectory)) throw new Error('CODEX_ENGINE_BINARY_UNAVAILABLE')
  const directoryStat = await fs.lstat(configuredDirectory)
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('CODEX_ENGINE_BINARY_UNAVAILABLE')
  const directory = await fs.realpath(configuredDirectory)
  const candidate = path.join(directory, engineBinaryName(platform))
  const stat = await fs.lstat(candidate)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('CODEX_ENGINE_BINARY_UNAVAILABLE')
  if (platform !== 'win32' && (stat.mode & 0o111) === 0) throw new Error('CODEX_ENGINE_BINARY_UNAVAILABLE')
  const resolved = await fs.realpath(candidate)
  if (path.dirname(resolved) !== directory) throw new Error('CODEX_ENGINE_BINARY_UNAVAILABLE')
  return [resolved]
}
