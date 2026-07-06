import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadEnvFiles, parseDotEnv } from './envLoader'

test('parseDotEnv:解析基础 key=value,支持引号,跳过非法 key', () => {
  expect(parseDotEnv(`
    # comment
    A=1
    B="two"
    C='three'
    BAD-KEY=no
  `)).toEqual({ A: '1', B: 'two', C: 'three' })
})

test('loadEnvFiles:后面的文件覆盖前面的文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'env-loader-'))
  try {
    writeFileSync(join(dir, 'a.env'), 'A=1\nB=old\n')
    writeFileSync(join(dir, 'b.env'), 'B=new\n')
    expect(loadEnvFiles(['a.env', 'b.env'], dir)).toEqual({ A: '1', B: 'new' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
