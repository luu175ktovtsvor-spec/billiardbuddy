import { defineConfig } from '@playwright/test'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const resultsRoot = path.resolve(here, '../../test-results/desktop-e2e')

export default defineConfig({
  testDir: here,
  testMatch: 'desktop.spec.ts',
  globalSetup: path.join(here, 'global-setup.ts'),
  fullyParallel: false,
  workers: 1,
  timeout: 20_000,
  expect: { timeout: 5_000 },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  outputDir: path.join(resultsRoot, 'artifacts'),
  reporter: [
    ['line'],
    ['json', { outputFile: path.join(resultsRoot, 'results.json') }],
    ['html', { outputFolder: path.join(resultsRoot, 'report'), open: 'never' }],
  ],
})
