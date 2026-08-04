import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const temporaryRoots: string[] = []
const script = resolve(import.meta.dir, 'migrate-image-relay-data.sh')

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bb-image-relay-data-migration-'))
  temporaryRoots.push(root)
  return root
}

function fixture(): { root: string; legacy: string; target: string; snapshot: string } {
  const root = temporaryRoot()
  const legacy = join(root, 'relay')
  const blobs = join(legacy, 'blobs')
  mkdirSync(blobs, { recursive: true, mode: 0o700 })
  const db = new Database(join(legacy, 'relay.db'))
  db.exec('CREATE TABLE tasks(id TEXT PRIMARY KEY, status TEXT NOT NULL); INSERT INTO tasks VALUES(\'legacy-unacknowledged\', \'succeeded\')')
  db.close()
  writeFileSync(join(blobs, 'legacy-unacknowledged.out.json'), JSON.stringify({ data: ['preserved image bytes'] }), { mode: 0o600 })
  return { root, legacy, target: join(root, 'image-relay'), snapshot: join(root, 'image-relay-recovery') }
}

async function createUncheckpointedWalTask(databasePath: string): Promise<Bun.Subprocess> {
  const ready = `${databasePath}.writer-ready`
  const source = [
    'import { Database } from "bun:sqlite"',
    'const path = process.argv[1]',
    'const ready = process.argv[2]',
    'if (!path || !ready) process.exit(64)',
    'const db = new Database(path)',
    'db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE IF NOT EXISTS wal_tasks(id TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO wal_tasks VALUES(\\\'committed-only-in-wal\\\', \\\'must-survive\\\')")',
    'await Bun.write(ready, "ready")',
    // Keep an otherwise idle SQLite connection alive so its committed frames
    // remain in the WAL. The migration's checkpoint must succeed with no
    // active transaction, then the test terminates this helper.
    'await new Promise(() => {})',
  ].join('; ')
  const writer = Bun.spawn({ cmd: ['bun', '-e', source, databasePath, ready], stdout: 'pipe', stderr: 'pipe' })
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(ready)) return writer
    await Bun.sleep(10)
  }
  writer.kill()
  await writer.exited
  throw new Error('could not create WAL fixture')
}

function run(root: string, extra: Record<string, string> = {}) {
  return Bun.spawnSync({
    cmd: ['bash', script],
    env: {
      ...process.env,
      BILLIARDBUDDY_IMAGE_RELAY_MIGRATION_TEST_MODE: '1',
      BILLIARDBUDDY_IMAGE_RELAY_DATA_ROOT: root,
      ...extra,
    },
    stdout: 'pipe', stderr: 'pipe',
  })
}

function text(value: Uint8Array): string { return new TextDecoder().decode(value) }
function mode(path: string): number { return lstatSync(path).mode & 0o777 }

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

test('creates a root-only verifiable recovery snapshot before atomically moving the legacy SQLite/CAS tree', () => {
  const paths = fixture()
  const sourceDatabase = readFileSync(join(paths.legacy, 'relay.db'))
  const sourceBlob = readFileSync(join(paths.legacy, 'blobs', 'legacy-unacknowledged.out.json'))

  const result = run(paths.root)

  expect(result.exitCode).toBe(0)
  expect(text(result.stdout)).toContain(`MIGRATED_IMAGE_RELAY_DATA=${paths.target}`)
  expect(text(result.stdout)).toContain(`IMAGE_RELAY_RECOVERY_SNAPSHOT=${paths.snapshot}`)
  expect(() => lstatSync(paths.legacy)).toThrow()
  expect(readFileSync(join(paths.target, 'relay.db'))).toEqual(sourceDatabase)
  expect(readFileSync(join(paths.target, 'blobs', 'legacy-unacknowledged.out.json'))).toEqual(sourceBlob)
  expect(readFileSync(join(paths.snapshot, 'relay.db'))).toEqual(sourceDatabase)
  expect(readFileSync(join(paths.snapshot, 'blobs', 'legacy-unacknowledged.out.json'))).toEqual(sourceBlob)
  const manifest = readFileSync(join(paths.snapshot, 'manifest.sha256'), 'utf8')
  expect(manifest).toContain('relay.db')
  expect(manifest).toContain('blobs/legacy-unacknowledged.out.json')
  expect(mode(paths.target)).toBe(0o700)
  expect(mode(join(paths.target, 'relay.db'))).toBe(0o600)
  expect(mode(paths.snapshot)).toBe(0o700)
  expect(mode(join(paths.snapshot, 'manifest.sha256'))).toBe(0o600)
})

test('checkpoints committed WAL frames before snapshot and atomic move', async () => {
  const paths = fixture()
  const writer = await createUncheckpointedWalTask(join(paths.legacy, 'relay.db'))
  try {
    const wal = join(paths.legacy, 'relay.db-wal')
    expect(lstatSync(wal).isFile()).toBe(true)
    expect(readFileSync(wal).byteLength).toBeGreaterThan(0)

    const result = run(paths.root)

    expect(result.exitCode).toBe(0)
    for (const databasePath of [join(paths.target, 'relay.db'), join(paths.snapshot, 'relay.db')]) {
      const database = new Database(databasePath, { readonly: true })
      expect(database.query("SELECT value FROM wal_tasks WHERE id = 'committed-only-in-wal'").get()).toEqual({ value: 'must-survive' })
      database.close()
    }
  } finally {
    writer.kill()
    await writer.exited
  }
})

test('does not move legacy data if recovery snapshot creation fails', () => {
  const paths = fixture()

  const result = run(paths.root, { BILLIARDBUDDY_IMAGE_RELAY_TEST_FAIL_AFTER_SNAPSHOT: '1' })

  expect(result.exitCode).not.toBe(0)
  expect(text(result.stderr)).toContain('forced test failure after recovery snapshot')
  expect(lstatSync(paths.legacy).isDirectory()).toBe(true)
  expect(() => lstatSync(paths.target)).toThrow()
  expect(lstatSync(paths.snapshot).isDirectory()).toBe(true)
  expect(readFileSync(join(paths.snapshot, 'manifest.sha256'), 'utf8')).toContain('relay.db')
})

test('fails closed when the target exists and leaves legacy data untouched', () => {
  const paths = fixture()
  mkdirSync(paths.target, { mode: 0o700 })

  const result = run(paths.root)

  expect(result.exitCode).not.toBe(0)
  expect(text(result.stderr)).toContain('target image relay data directory already exists')
  expect(lstatSync(paths.legacy).isDirectory()).toBe(true)
  expect(() => lstatSync(paths.snapshot)).toThrow()
})

test('refuses to overwrite an existing recovery snapshot on a repeated migration', () => {
  const paths = fixture()
  expect(run(paths.root).exitCode).toBe(0)
  const manifest = readFileSync(join(paths.snapshot, 'manifest.sha256'), 'utf8')

  const repeated = run(paths.root)

  expect(repeated.exitCode).not.toBe(0)
  expect(text(repeated.stderr)).toContain('target image relay data directory already exists')
  expect(readFileSync(join(paths.snapshot, 'manifest.sha256'), 'utf8')).toBe(manifest)
})

test('refuses an existing recovery snapshot before moving a still-present legacy tree', () => {
  const paths = fixture()
  mkdirSync(paths.snapshot, { mode: 0o700 })
  writeFileSync(join(paths.snapshot, 'manifest.sha256'), 'immutable recovery evidence\n', { mode: 0o600 })

  const result = run(paths.root)

  expect(result.exitCode).not.toBe(0)
  expect(text(result.stderr)).toContain('recovery snapshot already exists')
  expect(lstatSync(paths.legacy).isDirectory()).toBe(true)
  expect(() => lstatSync(paths.target)).toThrow()
  expect(readFileSync(join(paths.snapshot, 'manifest.sha256'), 'utf8')).toBe('immutable recovery evidence\n')
})

test('refuses a symlink in the old relay tree before it can snapshot or move it', () => {
  const paths = fixture()
  symlinkSync('/tmp', join(paths.legacy, 'blobs', 'unsafe-link'))

  const result = run(paths.root)

  expect(result.exitCode).not.toBe(0)
  expect(text(result.stderr)).toContain('refusing symbolic link')
  expect(lstatSync(paths.legacy).isDirectory()).toBe(true)
  expect(() => lstatSync(paths.target)).toThrow()
  expect(() => lstatSync(paths.snapshot)).toThrow()
})

test('refuses a nested mountpoint before it can snapshot or move legacy data', () => {
  const paths = fixture()

  const result = run(paths.root, { BILLIARDBUDDY_IMAGE_RELAY_TEST_FAKE_NESTED_MOUNT: 'blobs' })

  expect(result.exitCode).not.toBe(0)
  expect(text(result.stderr)).toContain('refusing nested mountpoint')
  expect(lstatSync(paths.legacy).isDirectory()).toBe(true)
  expect(() => lstatSync(paths.target)).toThrow()
  expect(() => lstatSync(paths.snapshot)).toThrow()
})
