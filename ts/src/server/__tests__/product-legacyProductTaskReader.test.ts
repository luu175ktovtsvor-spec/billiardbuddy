import { describe, expect, test } from 'bun:test'
import * as fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { readStrictLegacyProductTasks } from '../product/legacyProductTaskReader.js'
const fixture = (version: 1 | 3 | 4) => new URL(`../../../fixtures/migrations/product-task-disk-v${version}.json`, import.meta.url)
describe('strict legacy product task reader', () => {
  for (const version of [1, 3, 4] as const) test(`reads v${version} without writing it`, async () => {
    const bytes = await fs.readFile(fixture(version)); const before = createHash('sha256').update(bytes).digest('hex')
    const tasks = readStrictLegacyProductTasks(JSON.parse(bytes.toString()).store)
    expect(tasks.length).toBeGreaterThan(0); expect(createHash('sha256').update(await fs.readFile(fixture(version))).digest('hex')).toBe(before)
  })
  test('rejects provisional v2 and invalid schemas', () => { expect(() => readStrictLegacyProductTasks({ version: 2, tasks: {} })).toThrow('UNSUPPORTED_SCHEMA'); expect(() => readStrictLegacyProductTasks({ version: 9, tasks: {} })).toThrow('UNSUPPORTED_SCHEMA') })
})
