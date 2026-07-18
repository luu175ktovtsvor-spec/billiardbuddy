import { describe, expect, test } from 'bun:test'
import {
  RELEASE_SOURCE_PATHS,
  assertReleaseInputsTracked,
  findUntrackedReleaseInputs,
  parseNullSeparatedPaths,
  type GitOutput,
} from './check-release-tracked-files'

describe('release source tracking audit', () => {
  test('covers the Windows workflow and complete desktop release tree', () => {
    expect(RELEASE_SOURCE_PATHS).toContain('.github/workflows/desktop-build-win.yml')
    expect(RELEASE_SOURCE_PATHS).toContain('ts/desktop')
    expect(RELEASE_SOURCE_PATHS).toContain('ts/src')
    expect(RELEASE_SOURCE_PATHS).toContain('ts/bun.lock')
  })

  test('parses git null-delimited output without losing spaces', () => {
    expect(parseNullSeparatedPaths('desktop/src/a.ts\0desktop/src/with space.ts\0')).toEqual([
      'desktop/src/a.ts',
      'desktop/src/with space.ts',
    ])
  })

  test('reports untracked release inputs', async () => {
    const gitOutput: GitOutput = async () => ({
      code: 0,
      stdout: 'desktop/src/new.ts\0src/server/new.ts\0',
      stderr: '',
    })
    await expect(findUntrackedReleaseInputs(gitOutput)).resolves.toEqual([
      'desktop/src/new.ts',
      'src/server/new.ts',
    ])
    await expect(assertReleaseInputsTracked(gitOutput)).rejects.toThrow(
      'Release source contains 2 untracked file(s)',
    )
  })

  test('passes when every release input is tracked', async () => {
    const gitOutput: GitOutput = async () => ({ code: 0, stdout: '', stderr: '' })
    await expect(assertReleaseInputsTracked(gitOutput)).resolves.toBeUndefined()
  })
})
