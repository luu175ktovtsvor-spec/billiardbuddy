import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { AuthAuthority, AuthError, FileAuthorityStore, parseLicenseProvisioning } from './authEntitlement'

const paths: string[] = []
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }) })

function authority(file: string, revision = 1, active = true, deviceLimit = 1, options: ConstructorParameters<typeof FileAuthorityStore>[1] = {}) {
  return new AuthAuthority({
    store: new FileAuthorityStore(file, options),
    signingKey: 'test-signing-key-that-is-long-enough-for-authorization',
    licenses: [{ licenseKey: 'license-0001', principalId: 'principal-1', deviceLimit, active, revision }],
  })
}
function stateFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'bb-authority-'))
  paths.push(directory)
  return join(directory, 'authority.json')
}
function activation(installationId: string) { return { licenseKey: 'license-0001', installationId } }

// Two authorities model independently-started gateway instances sharing one durable file.
test('two durable instances atomically enforce device limit and issue a usable winner token', async () => {
  const file = stateFile()
  const first = authority(file)
  const second = authority(file)
  const [one, two] = await Promise.allSettled([
    Promise.resolve().then(() => first.activate(activation('install-0001'))),
    Promise.resolve().then(() => second.activate(activation('install-0002'))),
  ])
  const fulfilled = [one, two].filter((result): result is PromiseFulfilledResult<ReturnType<AuthAuthority['activate']>> => result.status === 'fulfilled')
  expect(fulfilled).toHaveLength(1)
  expect(authority(file).verifyAccess(fulfilled[0].value.accessToken).pid).toBe('principal-1')
})

test('refresh and installation revocation serialize without resurrecting a session', async () => {
  const file = stateFile()
  const first = authority(file)
  const tokens = first.activate(activation('install-0001'))
  const second = authority(file)
  const [refresh] = await Promise.allSettled([
    Promise.resolve().then(() => second.refresh(tokens.refreshToken)),
    Promise.resolve().then(() => first.revokeInstallation('install-0001')),
  ])
  expect(() => authority(file).verifyAccess(tokens.accessToken)).toThrow(AuthError)
  if (refresh.status === 'fulfilled') expect(() => authority(file).verifyAccess(refresh.value.accessToken)).toThrow(AuthError)
  expect(() => authority(file).refresh(tokens.refreshToken)).toThrow(AuthError)
})

test('newer inactive provisioning revokes access and refresh across restart', () => {
  const file = stateFile()
  const tokens = authority(file, 1, true).activate(activation('install-0001'))
  const restarted = authority(file, 2, false)
  expect(() => restarted.verifyAccess(tokens.accessToken)).toThrow(AuthError)
  expect(() => restarted.refresh(tokens.refreshToken)).toThrow(AuthError)
})

test('revoked registration cannot reactivate and replacement revokes old sessions', () => {
  const file = stateFile()
  const auth = authority(file, 1, true, 1)
  const old = auth.activate(activation('install-0001'))
  const replacement = auth.activate({ ...activation('install-0002'), replaceInstallationId: 'install-0001' })
  expect(() => auth.verifyAccess(old.accessToken)).toThrow(AuthError)
  expect(auth.verifyAccess(replacement.accessToken).iid).toBe('install-0002')
  expect(() => auth.activate(activation('install-0001'))).toThrow(AuthError)
})

test('strictly rejects invalid provisioning and malformed device limits', () => {
  for (const raw of [
    'not json', '{}', '[{"licenseKey":"license-0001","principalId":"principal-1","deviceLimit":1,"active":true}]',
    '[{"licenseKey":"license-0001","principalId":"principal-1","deviceLimit":"1","active":true,"revision":1}]',
    '[{"licenseKey":"license-0001","principalId":"principal-1","deviceLimit":0,"active":true,"revision":1}]',
    '[{"licenseKey":"license-0001","principalId":"principal-1","deviceLimit":1.5,"active":true,"revision":1}]',
    '[{"licenseKey":"license-0001","principalId":"principal-1","deviceLimit":null,"active":true,"revision":1}]',
  ]) expect(() => parseLicenseProvisioning(raw)).toThrow()
})

test('strictly fails closed for malformed state and provisioning revision conflicts', () => {
  for (const raw of [
    'not json',
    '{"version":1,"revision":0,"entitlements":[],"registrations":[],"sessions":[],"extra":true}',
    '{"version":1,"revision":"0","entitlements":[],"registrations":[],"sessions":[]}',
    '{"version":1,"revision":0,"entitlements":[{"licenseKey":"license-0001","principalId":"principal-1","active":true,"deviceLimit":0,"authorityRevision":1}],"registrations":[],"sessions":[]}',
  ]) {
    const file = stateFile()
    writeFileSync(file, raw)
    expect(() => authority(file)).toThrow()
  }

  const clean = stateFile()
  authority(clean)
  expect(() => authority(clean, 1, false)).toThrow('License provisioning revision conflicts')
  expect(() => authority(clean, 0)).toThrow('Invalid license provisioning')
})

test('file store writes owner-only state', () => {
  const file = stateFile()
  authority(file)
  expect(statSync(file).mode & 0o777).toBe(0o600)
  expect(statSync(dirname(file)).mode & 0o777).toBe(0o700)
})

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${path}`)
}
function lockHolder(file: string, ready: string, holdMs: number, release?: string) {
  const moduleUrl = new URL('./authEntitlement.ts', import.meta.url).href
  const source = `import { FileAuthorityStore } from ${JSON.stringify(moduleUrl)}; import { writeFileSync, existsSync } from 'node:fs'; const [file, ready, hold, release] = process.argv.slice(1); new FileAuthorityStore(file, { lockTimeoutMs: 2000, lockRetryMs: 2, staleLockMs: 10 }).withLock(() => { writeFileSync(ready, 'ready'); if (release) { while (!existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5) } else Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(hold)); });`
  return Bun.spawn([process.execPath, '-e', source, file, ready, String(holdMs), release ?? ''])
}

test('a healthy multi-process lock survives longer than staleLockMs and a killed owner is reclaimed', async () => {
  const file = stateFile()
  const ready = `${file}.ready`
  const holder = lockHolder(file, ready, 300)
  await waitForFile(ready)
  await Bun.sleep(40)
  const contender = new FileAuthorityStore(file, { lockTimeoutMs: 30, lockRetryMs: 2, staleLockMs: 10 })
  expect(() => contender.withLock(() => undefined)).toThrow('Gateway authority lock timeout')
  await holder.exited

  const deadReady = `${file}.dead-ready`
  const deadOwner = lockHolder(file, deadReady, 5_000)
  await waitForFile(deadReady)
  deadOwner.kill('SIGKILL')
  await deadOwner.exited
  expect(() => contender.withLock(() => undefined)).not.toThrow()
})

test('two Bun reclaimers atomically claim one dead lock and never overlap a new holder', async () => {
  const file = stateFile()
  const deadReady = `${file}.dead-ready`
  const deadOwner = lockHolder(file, deadReady, 5_000)
  await waitForFile(deadReady)
  deadOwner.kill('SIGKILL')
  await deadOwner.exited

  const events = `${file}.events`
  const moduleUrl = new URL('./authEntitlement.ts', import.meta.url).href
  const source = `import { FileAuthorityStore } from ${JSON.stringify(moduleUrl)}; import { appendFileSync } from 'node:fs'; const [file, events, id] = process.argv.slice(1); new FileAuthorityStore(file, { lockTimeoutMs: 3000, lockRetryMs: 2 }).withLock(() => { appendFileSync(events, 'start '+id+String.fromCharCode(10)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 80); appendFileSync(events, 'end '+id+String.fromCharCode(10)); });`
  const reclaimers = ['reclaimer-a', 'reclaimer-b'].map(id => Bun.spawn([process.execPath, '-e', source, file, events, id]))
  await waitForFile(events)
  const newHolder = Bun.spawn([process.execPath, '-e', source, file, events, 'new-holder'])
  await Promise.all([...reclaimers, newHolder].map(child => child.exited))

  const lines = readFileSync(events, 'utf8').trim().split('\n')
  expect(lines.filter(line => line.startsWith('start reclaimer-'))).toHaveLength(2)
  expect(lines.filter(line => line === 'start new-holder')).toHaveLength(1)
  let active = 0
  for (const line of lines) {
    active += line.startsWith('start ') ? 1 : -1
    expect(active).toBeGreaterThanOrEqual(0)
    expect(active).toBeLessThanOrEqual(1)
  }
  expect(active).toBe(0)
})

test('an old holder finally cannot delete a replacement lock owner record', async () => {
  const file = stateFile()
  const ready = `${file}.ready`
  const release = `${file}.release`
  const holder = lockHolder(file, ready, 0, release)
  await waitForFile(ready)
  const lock = `${file}.lock`
  rmSync(lock, { recursive: true, force: true })
  mkdirSync(lock, { mode: 0o700 })
  chmodSync(lock, 0o700)
  writeFileSync(`${lock}/owner.json`, JSON.stringify({ nonce: 'n'.repeat(32), pid: process.pid, hostname: 'replacement', startMarker: 'replacement' }), { mode: 0o600 })
  writeFileSync(release, 'release')
  await holder.exited
  expect(existsSync(lock)).toBe(true)
})

test('three Bun processes never overlap their file-lock critical sections', async () => {
  const file = stateFile()
  const events = `${file}.events`
  const moduleUrl = new URL('./authEntitlement.ts', import.meta.url).href
  const source = `import { FileAuthorityStore } from ${JSON.stringify(moduleUrl)}; import { appendFileSync } from 'node:fs'; const [file, events, id] = process.argv.slice(1); new FileAuthorityStore(file, { lockTimeoutMs: 2000, lockRetryMs: 2 }).withLock(() => { appendFileSync(events, 'start '+id+String.fromCharCode(10)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40); appendFileSync(events, 'end '+id+String.fromCharCode(10)); });`
  const children = ['one', 'two', 'three'].map(id => Bun.spawn([process.execPath, '-e', source, file, events, id]))
  await Promise.all(children.map(child => child.exited))
  let active = 0
  for (const line of readFileSync(events, 'utf8').trim().split('\n')) {
    active += line.startsWith('start ') ? 1 : -1
    expect(active).toBeGreaterThanOrEqual(0)
    expect(active).toBeLessThanOrEqual(1)
  }
  expect(active).toBe(0)
})
