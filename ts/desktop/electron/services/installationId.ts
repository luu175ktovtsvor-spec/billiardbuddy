import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Stable installation identity for BilliardBuddy activation and local ownership.
 *
 * On first launch Main generates an unpredictable ID in the product data root and
 * registers it during the authenticated activation exchange. The Gateway encodes
 * that verified identity in the short-lived access token; ordinary product requests
 * never send a caller-asserted installation header.
 *
 * Boundary: the ID belongs to Electron Main and the activation service. It never
 * reaches the renderer, Rust App Server process, provider files, model prompt, or logs. It is
 * identity metadata, not a permission or provider credential.
 */

const INSTALLATION_ID_FILE = 'installation-id.json'
/** Stable file and activation identifier format. */
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
