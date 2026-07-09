import { expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { isEncrypted, makeCredentialCipher } from './credentialCipher'

const keyHex = randomBytes(32).toString('hex')

test('with a key: encrypt produces ciphertext that hides the plaintext and round-trips', () => {
  const cipher = makeCredentialCipher(keyHex)
  expect(cipher.enabled).toBe(true)
  const secret = 'sk-super-secret-gateway-token'
  const enc = cipher.encrypt(secret)
  expect(enc).not.toBe(secret)
  expect(enc).not.toContain(secret)
  expect(isEncrypted(enc)).toBe(true)
  expect(enc.startsWith('enc:v1:')).toBe(true)
  expect(cipher.decrypt(enc)).toBe(secret)
})

test('encryption is non-deterministic (fresh IV per call) but both decrypt back', () => {
  const cipher = makeCredentialCipher(keyHex)
  const a = cipher.encrypt('same-secret')
  const b = cipher.encrypt('same-secret')
  expect(a).not.toBe(b)
  expect(cipher.decrypt(a)).toBe('same-secret')
  expect(cipher.decrypt(b)).toBe('same-secret')
})

test('legacy plaintext passes through decrypt unchanged (seamless migration)', () => {
  const cipher = makeCredentialCipher(keyHex)
  expect(cipher.decrypt('legacy-plaintext-key')).toBe('legacy-plaintext-key')
})

test('no key: cipher disabled, values pass through unchanged both ways', () => {
  const cipher = makeCredentialCipher(undefined)
  expect(cipher.enabled).toBe(false)
  expect(cipher.encrypt('plain')).toBe('plain')
  expect(cipher.decrypt('plain')).toBe('plain')
})

test('malformed key hex disables encryption (no silent crash)', () => {
  expect(makeCredentialCipher('not-hex').enabled).toBe(false)
  expect(makeCredentialCipher('abcd').enabled).toBe(false) // too short
})

test('ciphertext without a key throws rather than leaking', () => {
  const enc = makeCredentialCipher(keyHex).encrypt('secret')
  expect(() => makeCredentialCipher(undefined).decrypt(enc)).toThrow()
})

test('wrong key fails to decrypt (GCM auth tag rejects)', () => {
  const enc = makeCredentialCipher(keyHex).encrypt('secret')
  const otherKey = randomBytes(32).toString('hex')
  expect(() => makeCredentialCipher(otherKey).decrypt(enc)).toThrow()
})

test('tampered ciphertext is rejected (GCM integrity)', () => {
  const cipher = makeCredentialCipher(keyHex)
  const enc = cipher.encrypt('secret')
  const tampered = `${enc.slice(0, -2)}AA`
  expect(() => cipher.decrypt(tampered)).toThrow()
})
