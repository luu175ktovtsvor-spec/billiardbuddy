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

test('bundledEnvCandidates:QF_BUNDLED_ENV 优先,其次 exec 相对,最后 cwd 相对', async () => {
  const { bundledEnvCandidates } = await import('./envLoader')
  const cands = bundledEnvCandidates({ QF_BUNDLED_ENV: '/explicit/bundled.env' }, '/app/Resources/binaries/sidecar', '/work')
  expect(cands[0]).toBe('/explicit/bundled.env')
  expect(cands[1]).toBe('/app/Resources/bundled.env')
  expect(cands[2]).toBe('/work/../desktop/bundled.env'.replace('/work/../', '/'))
  // 不设 QF_BUNDLED_ENV 时 exec 相对领先(打包版 cwd=userData,cwd 相对指不到包内)。
  const noExplicit = bundledEnvCandidates({}, '/app/Resources/binaries/sidecar', '/work')
  expect(noExplicit[0]).toBe('/app/Resources/bundled.env')
})
