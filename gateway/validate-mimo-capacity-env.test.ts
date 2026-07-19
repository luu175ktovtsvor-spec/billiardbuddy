import { describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const script = new URL('./validate-mimo-capacity-env.sh', import.meta.url).pathname

function validate(env: string) {
  const directory = mkdtempSync(join(tmpdir(), 'billiardbuddy-mimo-capacity-'))
  const envFile = join(directory, 'gw.env')
  writeFileSync(envFile, env, { mode: 0o600 })
  try {
    return spawnSync('bash', [script, envFile], { encoding: 'utf8' })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('MiMo deployment capacity preflight', () => {
  test('accepts the explicit 64 = 48 + 16 production reservation', () => {
    const result = validate('GW_MIMO_CONC=64\nGW_MIMO_NATIVE_CONC=48\nGW_VISION_CONC=16\n')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('MiMo capacity validated: total=64 native=48 vision=16\n')
  })

  test('accepts systemd-style quoted decimal values without evaluating the file', () => {
    const result = validate('GW_MIMO_CONC="64"\nGW_MIMO_NATIVE_CONC=\'48\'\nGW_VISION_CONC="16"\n')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('MiMo capacity validated: total=64 native=48 vision=16\n')
  })

  test('derives the same valid legacy partition as the gateway when only total is set', () => {
    const result = validate('GW_MIMO_CONC=16\n')
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('MiMo capacity validated: total=16 native=4 vision=12\n')
  })

  test('rejects a partial or inconsistent explicit reservation before service restart', () => {
    const result = validate('GW_MIMO_CONC=64\nGW_MIMO_NATIVE_CONC=51\nGW_VISION_CONC=12\n')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('GW_MIMO_NATIVE_CONC + GW_VISION_CONC must equal GW_MIMO_CONC')
  })

  test('does not accept malformed capacity values as an implicit fallback', () => {
    const result = validate('GW_MIMO_CONC=sixty-four\n')
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('GW_MIMO_CONC must be a positive decimal integer')
  })
})
