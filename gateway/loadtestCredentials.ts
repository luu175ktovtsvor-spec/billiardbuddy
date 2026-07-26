import { lstat, readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

const MAX_TOKEN_FILE_BYTES = 1024 * 1024

function validToken(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 16 && value.length <= 16_384 && !/[\r\n\0]/.test(value)
}

/**
 * A production installation identity is encoded in its signed access token.
 * Untrusted request headers cannot manufacture additional installations, so a
 * multi-installation load test must receive one real short-lived token per
 * installation through an owner-only JSON file.
 */
export async function loadLoadtestInstallationTokens(
  installationCount: number,
  env: Record<string, string | undefined> = process.env,
): Promise<string[]> {
  if (!Number.isSafeInteger(installationCount) || installationCount < 1 || installationCount > 1_000) {
    throw new Error('installation count must be between 1 and 1000')
  }
  const file = env.BB_LOADTEST_TOKENS_FILE?.trim()
  if (file) {
    if (!isAbsolute(file)) throw new Error('BB_LOADTEST_TOKENS_FILE must be an absolute path')
    const stat = await lstat(file).catch(() => null)
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_TOKEN_FILE_BYTES) {
      throw new Error('BB_LOADTEST_TOKENS_FILE must be a bounded regular file')
    }
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) {
      throw new Error('BB_LOADTEST_TOKENS_FILE must be readable and writable only by its owner')
    }
    let parsed: unknown
    try { parsed = JSON.parse(await readFile(file, 'utf8')) } catch { throw new Error('BB_LOADTEST_TOKENS_FILE must contain valid JSON') }
    if (!Array.isArray(parsed) || parsed.length !== installationCount || !parsed.every(validToken)) {
      throw new Error(`BB_LOADTEST_TOKENS_FILE must contain exactly ${installationCount} access tokens`)
    }
    if (new Set(parsed).size !== parsed.length) throw new Error('BB_LOADTEST_TOKENS_FILE access tokens must be unique')
    return parsed
  }

  const token = env.BB_LOADTEST_TOKEN?.trim()
  if (installationCount !== 1 || !validToken(token)) {
    throw new Error('multi-installation runs require BB_LOADTEST_TOKENS_FILE; BB_LOADTEST_TOKEN is valid only for one installation')
  }
  return [token]
}
