import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Per-install identity for fair scheduling (BilliardBuddy 50~100-user private beta).
 *
 * Every managed build shares activation inputs, so the gateway can no longer treat all installs as
 * one user. On first launch we generate an unpredictable installationId and persist it in
 * the product data root (the active CLAUDE_CONFIG_DIR). It is injected ONLY into the server
 * sidecar env (BB_INSTALLATION_ID); the sidecar attaches it as `X-QF-Client-ID` on gateway
 * requests so the gateway can subdivide per-user fairness by install.
 *
 * Boundary: it must NEVER reach the renderer, the CLI subprocess, providers.json, or logs.
 *  - CLI subprocess: stripped at every spawn chokepoint (HOST_ONLY_GATEWAY_ENV_KEYS).
 *  - renderer / providers.json: never written there (it is a request-time header from env).
 * It is used ONLY for scheduling and usage attribution — it grants no permission and cannot
 * bypass the gateway's global caps.
 */

const INSTALLATION_ID_FILE = 'installation-id.json'
/** Must satisfy the gateway's X-QF-Client-ID format: [A-Za-z0-9._-]{8,128}. */
const INSTALLATION_ID_PATTERN = /^[A-Za-z0-9._-]{8,128}$/

function newId(generate: () => string): string {
  return `bb-${generate().replace(/[^A-Za-z0-9]/g, '')}`.slice(0, 128)
}

/**
 * Read the persisted installationId from the product data root, or generate+persist one on
 * first launch. Persist is best-effort (0600); a write failure still returns a valid id for
 * this run. `generate` is injectable for tests.
 */
export function ensureInstallationId(configDir: string, generate: () => string = randomUUID): string {
  const file = path.join(configDir, INSTALLATION_ID_FILE)
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { installationId?: unknown }
    if (typeof parsed.installationId === 'string' && INSTALLATION_ID_PATTERN.test(parsed.installationId)) {
      return parsed.installationId
    }
  } catch {
    // Missing or corrupt → (re)generate below.
  }
  const id = newId(generate)
  try {
    fs.mkdirSync(configDir, { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ installationId: id }, null, 2), { mode: 0o600 })
  } catch {
    // Best effort — a read-only data root still gets a stable-per-run id.
  }
  return id
}

/**
 * Overlay the installationId onto a SERVER sidecar env as BB_INSTALLATION_ID. A value already
 * present (dev/ops override) always wins. Returns a new object; pass an empty id to leave the
 * env untouched.
 */
export function applyInstallationIdToEnv(baseEnv: NodeJS.ProcessEnv, id: string | undefined): NodeJS.ProcessEnv {
  if (!id || baseEnv.BB_INSTALLATION_ID) return baseEnv
  return { ...baseEnv, BB_INSTALLATION_ID: id }
}
