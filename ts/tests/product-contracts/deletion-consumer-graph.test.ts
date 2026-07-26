import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { validate } from '../../scripts/product-contracts/check.ts'

const tsRoot = resolve(import.meta.dir, '../..')
const source = JSON.parse(readFileSync(resolve(tsRoot, 'product-contracts/contract-source.json'), 'utf8'))

test('rejects an unrelated build.files entry as a deletion consumer', () => {
  const invalid = structuredClone(source)
  const edge = invalid.deletion_candidates.at(-1).edges[0]
  edge.object.symbol = 'dist/**'
  edge.object.definition.path = 'ts/desktop/package.json'
  edge.object.definition.pointer = '/build/files/0'
  edge.object.definition.text = '"dist/**"'
  edge.consumer.path = 'ts/desktop/package.json'
  edge.consumer.symbol = 'build.files[1]'
  edge.consumer.reference.kind = 'json_entry'
  edge.consumer.reference.pointer = '/build/files/1'
  edge.consumer.reference.text = '"electron-dist/**"'
  expect(() => validate(invalid)).toThrow('JSON consumer does not reference object entry')
})
