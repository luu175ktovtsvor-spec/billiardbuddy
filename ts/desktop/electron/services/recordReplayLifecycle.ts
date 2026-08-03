import { mkdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'

/**
 * A recorder is never allowed to outlive the BilliardBuddy desktop host.
 * The native recorder polls this fixed private stop marker and has its own
 * maximum duration as a second safety bound.
 */
export function requestRecordReplayStop(userDataPath: string): void {
  const root = path.join(userDataPath, 'agent-runtime', 'record-replay')
  try {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    writeFileSync(path.join(root, 'stop'), 'app-quit\n', { encoding: 'utf8', mode: 0o600 })
  } catch {
    // The recorder also expires itself. Quit must not be blocked by cleanup.
  }
}
