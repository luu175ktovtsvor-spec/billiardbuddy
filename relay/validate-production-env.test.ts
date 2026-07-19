import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = new URL('./validate-production-env.sh', import.meta.url).pathname

const deployScript = new URL('./deploy.sh', import.meta.url).pathname

function validate(env: string, ...args: string[]) {
  const directory = mkdtempSync(join(tmpdir(), 'billiardbuddy-relay-capacity-'))
  const envFile = join(directory, 'relay.env')
  writeFileSync(envFile, env, { mode: 0o600 })
  try {
    return spawnSync('bash', [script, ...args, envFile], { encoding: 'utf8' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('1000-window relay production preflight', () => {
  test('accepts durable storage with the 1000-task admission profile', () => {
    const result = validate("RELAY_DB='/opt/qfrelay/relay.db'\nRELAY_BLOB_DIR=\"/opt/qfrelay/blobs\"\nRELAY_QUEUE_MAX=1200\nRELAY_USER_MAX=10\nRELAY_IMG_CONC=6\nRELAY_IMG_USER_CONC=1\n")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('queue=1200 user=10 image_conc=6 image_user_conc=1')
  })

  test('returns the configured default blob directory for deployment without exposing other env values', () => {
    const result = validate('RELAY_DB=/opt/qfrelay/relay.db\nRELAY_BLOB_DIR=/opt/qfrelay/blobs\nRELAY_OPENAI_KEY=secret-never-output\n', '--print-blob-dir')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('/opt/qfrelay/blobs\n')
    expect(result.stderr).not.toContain('secret-never-output')
  })

  test('returns a safe custom blob directory for deployment', () => {
    const result = validate('RELAY_DB=/opt/qfrelay/relay.db\nRELAY_BLOB_DIR=/mnt/qfrelay/blob-store/\n', '--print-blob-dir')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('/mnt/qfrelay/blob-store\n')
  })

  test('rejects the legacy queue profile before a restart can lose 1000-task readiness', () => {
    const result = validate('RELAY_DB=/opt/qfrelay/relay.db\nRELAY_BLOB_DIR=/opt/qfrelay/blobs\nRELAY_QUEUE_MAX=600\nRELAY_USER_MAX=5\n')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('RELAY_QUEUE_MAX must be at least 1000')
  })

  test('rejects in-memory storage and never evaluates EnvironmentFile content', () => {
    const result = validate('RELAY_DB=:memory:\nRELAY_BLOB_DIR=$(whoami)\n')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('RELAY_DB must be a persistent SQLite path')
  })

  test('rejects blob shell references and relative paths before deployment can create them', () => {
    const shellReference = validate('RELAY_DB=/opt/qfrelay/relay.db\nRELAY_BLOB_DIR=${APPDIR}/blobs\n')
    expect(shellReference.status).toBe(1)
    expect(shellReference.stderr).toContain('RELAY_BLOB_DIR contains unsafe path characters')

    const relativePath = validate('RELAY_DB=/opt/qfrelay/relay.db\nRELAY_BLOB_DIR=../blobs\n')
    expect(relativePath.status).toBe(1)
    expect(relativePath.stderr).toContain('RELAY_BLOB_DIR must be a non-root absolute path')

    const systemDirectory = validate('RELAY_DB=/opt/qfrelay/relay.db\nRELAY_BLOB_DIR=/etc\n')
    expect(systemDirectory.status).toBe(1)
    expect(systemDirectory.stderr).toContain('RELAY_BLOB_DIR must name a dedicated blob directory')
  })

  test('deploy prepares the parsed blob directory instead of a hard-coded default', () => {
    const deploy = readFileSync(deployScript, 'utf8')
    expect(deploy).toContain('validate-production-env.sh" --print-blob-dir "$APPDIR/relay.env"')
    expect(deploy).toContain('mkdir -p -- "$relay_blob_dir"')
    expect(deploy).toContain('chmod 700 -- "$relay_blob_dir"')
    expect(deploy).not.toContain('mkdir -p "$APPDIR/blobs"')
  })
})
