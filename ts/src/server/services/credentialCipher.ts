import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// 凭据 at-rest 加密(sidecar 侧,Bun 无 safeStorage):用主进程经环境传来的 32 字节 DEK(QF_CRED_KEY,
// hex)做 AES-256-GCM。落盘只写密文,格式 = `enc:v1:` + base64(iv):base64(tag):base64(ciphertext)。
// DEK 本身由 electron 主进程用 safeStorage(OS keychain/DPAPI)保护,不明文落盘(见 desktop/electron/services/credentialKey.ts)。
const SCHEME = 'enc:v1:'

export interface CredentialCipher {
  /** 是否配置了可用密钥;false = 无 DEK,原样透传(回退明文,不倒退旧行为)。 */
  readonly enabled: boolean
  /** 明文 → 密文(带 `enc:v1:` 前缀);无密钥或已是密文时原样返回。 */
  encrypt(plaintext: string): string
  /** 密文 → 明文;非密文(旧的明文串)原样透传,实现无缝迁移。密文但无密钥则抛错。 */
  decrypt(stored: string): string
}

/** 是否是本方案写出的密文(用于迁移/落盘断言)。 */
export function isEncrypted(value: string): boolean {
  return typeof value === 'string' && value.startsWith(SCHEME)
}

/** DEK 必须是 64 位 hex(32 字节 = AES-256);非法/缺失返回 null → cipher 禁用。 */
function parseKey(keyHex: string | undefined): Buffer | null {
  const hex = keyHex?.trim()
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null
  return Buffer.from(hex, 'hex')
}

export function makeCredentialCipher(keyHex?: string): CredentialCipher {
  const key = parseKey(keyHex)
  return {
    enabled: !!key,
    encrypt(plaintext: string): string {
      if (!key || isEncrypted(plaintext)) return plaintext
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', key, iv)
      const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      return SCHEME + [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join(':')
    },
    decrypt(stored: string): string {
      if (!isEncrypted(stored)) return stored
      if (!key) throw new Error('credentialCipher: 落盘是密文但未配置解密密钥(QF_CRED_KEY 缺失)')
      const parts = stored.slice(SCHEME.length).split(':')
      if (parts.length !== 3) throw new Error('credentialCipher: 密文格式非法')
      const [ivB64, tagB64, dataB64] = parts as [string, string, string]
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'))
      decipher.setAuthTag(Buffer.from(tagB64, 'base64'))
      return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8')
    },
  }
}
