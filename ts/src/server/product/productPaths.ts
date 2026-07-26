import * as os from 'node:os'
import * as path from 'node:path'

export function getProductConfigDir(): string {
  const configured = process.env.BILLIARDBUDDY_CONFIG_DIR?.trim()
  return configured ? path.resolve(configured) : path.join(os.homedir(), '.BilliardBuddy')
}
