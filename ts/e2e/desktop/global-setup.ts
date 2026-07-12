import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export default function globalSetup(): void {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const resultsRoot = path.resolve(here, '../../test-results/desktop-e2e')
  rmSync(resultsRoot, { recursive: true, force: true })
  mkdirSync(resultsRoot, { recursive: true })
}
