import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = new URL('./validate-production-capacity-env.sh', import.meta.url).pathname

function validate(env: string) {
  const directory = mkdtempSync(join(tmpdir(), 'billiardbuddy-gateway-capacity-'))
  const envFile = join(directory, 'gw.env')
  writeFileSync(envFile, env, { mode: 0o600 })
  try {
    return spawnSync('bash', [script, envFile], { encoding: 'utf8' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('1000-window gateway deployment capacity preflight', () => {
  test('accepts source defaults when the non-secret capacity keys are absent', () => {
    const result = validate('GW_APP_TOKENS={"opaque":"owner"}\n')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('deepseek=1000 user=10 token=1000 image_ipm=1200 image_waiters=200 idle_timeout=300')
  })

  test('accepts the explicit 1000-window profile with systemd-style quoting', () => {
    const result = validate("GW_DEEPSEEK_CONC='1000'\nGW_DEEPSEEK_USER_CONC=10\nGW_DEEPSEEK_TOKEN_CONC=\"1000\"\nGW_IMG_IPM=1200\nGW_IMG_QUEUE_MAX=200\nGW_SERVER_IDLE_TIMEOUT_SECONDS=300\n")
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('deepseek=1000 user=10 token=1000')
  })

  test('rejects a legacy 800/8/800 profile instead of silently deploying below the target', () => {
    const result = validate('GW_DEEPSEEK_CONC=800\nGW_DEEPSEEK_USER_CONC=8\nGW_DEEPSEEK_TOKEN_CONC=800\n')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('GW_DEEPSEEK_CONC must be at least 1000')
  })

  test('rejects malformed capacity values without evaluating the EnvironmentFile', () => {
    const result = validate('GW_DEEPSEEK_CONC=$(whoami)\n')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('GW_DEEPSEEK_CONC must be a non-negative decimal integer')
  })
})
