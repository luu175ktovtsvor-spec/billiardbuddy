import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

// 凭据 at-rest 加密的密钥来源(electron 主进程侧)。
// 思路:主进程用 Electron safeStorage(底层走 macOS Keychain / Windows DPAPI)保护一把随机 DEK(数据加密密钥),
// DEK 以 safeStorage 密文落盘(userData/credential-key.enc,绝不明文)。启动时解出 DEK(hex)经环境 QF_CRED_KEY 传给
// sidecar(Bun,没有 safeStorage),sidecar 用它 AES-256-GCM 加密 providers.json 里的 apiKey/authToken。
// safeStorage 不可用时返回 null → 不传密钥 → sidecar 回退明文(不倒退旧行为)。
//
// ⚠️ 注意:本文件只依赖 node: 内置模块,不 import 'electron',以便 bun test 能直接跑(safeStorage 由调用方注入)。

/** Electron `safeStorage` 的最小接口(注入以便测试)。 */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

export interface CredentialKeyDeps {
  existsSyncFn?: (p: string) => boolean
  readFileSyncFn?: (p: string) => Buffer
  writeFileSyncFn?: (p: string, data: Buffer, opts?: { mode?: number }) => void
  mkdirSyncFn?: (p: string, opts?: { recursive?: boolean }) => void
  generateKeyHex?: () => string
}

const KEY_BYTES = 32 // AES-256
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/

/**
 * 解析/生成 sidecar 用的凭据加密密钥(DEK,hex)。
 * - safeStorage 不可用 → 返回 null(调用方不传 QF_CRED_KEY,sidecar 回退明文)。
 * - keyFilePath 已存在且能解出合法 DEK → 复用(保证跨重启稳定,老密文仍可解)。
 * - 否则生成新 DEK,用 safeStorage 加密后写盘(mode 0600),返回明文 DEK。
 */
export function resolveCredentialKey(
  safeStorage: SafeStorageLike,
  keyFilePath: string,
  deps: CredentialKeyDeps = {},
): string | null {
  if (!safeStorage.isEncryptionAvailable()) return null

  const existsSyncFn = deps.existsSyncFn ?? existsSync
  const readFileSyncFn = deps.readFileSyncFn ?? (p => readFileSync(p))
  const writeFileSyncFn = deps.writeFileSyncFn ?? ((p, data, opts) => writeFileSync(p, data, opts))
  const mkdirSyncFn = deps.mkdirSyncFn ?? ((p, opts) => { mkdirSync(p, opts) })
  const generateKeyHex = deps.generateKeyHex ?? (() => randomBytes(KEY_BYTES).toString('hex'))

  if (existsSyncFn(keyFilePath)) {
    try {
      const keyHex = safeStorage.decryptString(readFileSyncFn(keyFilePath))
      if (KEY_HEX_RE.test(keyHex)) return keyHex
      // 解出来不是合法 DEK(损坏/被换) → 落到下面重新生成
    } catch {
      // 解密失败(safeStorage 后端变了/文件损坏) → 重新生成
    }
  }

  const keyHex = generateKeyHex()
  mkdirSyncFn(dirname(keyFilePath), { recursive: true })
  writeFileSyncFn(keyFilePath, safeStorage.encryptString(keyHex), { mode: 0o600 })
  return keyHex
}
