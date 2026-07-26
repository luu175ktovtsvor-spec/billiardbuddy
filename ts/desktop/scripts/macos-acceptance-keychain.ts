import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

function security(args: string[]): string {
  const result = spawnSync('security', args, { encoding: 'utf8' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`security ${args[0] ?? ''} 失败`)
  return result.stdout.trim()
}

function keychainPaths(output: string): string[] {
  return [...output.matchAll(/"([^"]+)"/g)].map(match => match[1]!).filter(Boolean)
}

export type TemporaryAcceptanceKeychain = { restore(): void }

function restoreUserKeychains(defaultPath: string, searchList: string[], temporaryPath: string): void {
  security(['default-keychain', '-d', 'user', '-s', defaultPath])
  security(['list-keychains', '-d', 'user', '-s', ...searchList])
  const deleted = spawnSync('security', ['delete-keychain', temporaryPath], { encoding: 'utf8' })
  if (deleted.error || deleted.status !== 0) throw new Error('无法删除临时验收 Keychain')
}

export function useTemporaryAcceptanceKeychain(tempRoot: string): TemporaryAcceptanceKeychain {
  if (process.platform !== 'darwin') throw new Error('临时验收 Keychain 只能在 macOS 使用')
  const originalDefault = keychainPaths(security(['default-keychain', '-d', 'user']))[0]
  const originalSearchList = keychainPaths(security(['list-keychains', '-d', 'user']))
  if (!originalDefault || originalSearchList.length === 0) throw new Error('无法读取用户 Keychain 配置')

  const keychainPath = join(tempRoot, 'acceptance.keychain-db')
  const password = randomBytes(24).toString('hex')
  const safeStoragePassword = randomBytes(32).toString('base64url')
  security(['create-keychain', '-p', password, keychainPath])
  try {
    security(['set-keychain-settings', '-lut', '21600', keychainPath])
    security(['unlock-keychain', '-p', password, keychainPath])
    security([
      'add-generic-password',
      '-a', 'BilliardBuddy Key',
      '-s', 'BilliardBuddy Safe Storage',
      '-A',
      '-w', safeStoragePassword,
      keychainPath,
    ])
    // Isolate the lookup as well as the default write target. Otherwise Chromium
    // can find an older ad-hoc build's Safe Storage item in login.keychain and
    // block on its stale code-signing ACL before it ever creates the test item.
    security(['list-keychains', '-d', 'user', '-s', keychainPath])
    security(['default-keychain', '-d', 'user', '-s', keychainPath])
  } catch (error) {
    try { restoreUserKeychains(originalDefault, originalSearchList, keychainPath) } catch {}
    throw error
  }

  let restored = false
  return {
    restore() {
      if (restored) return
      restoreUserKeychains(originalDefault, originalSearchList, keychainPath)
      restored = true
    },
  }
}
