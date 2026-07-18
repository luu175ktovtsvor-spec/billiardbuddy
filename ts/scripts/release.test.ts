import { describe, expect, test } from 'bun:test'
import { assertReleaseGitState, bumpVersion, type ReleaseGit } from './release'

function fakeGit(options: {
  branch?: string
  status?: string
  tagExists?: boolean
} = {}): ReleaseGit {
  return {
    async output(args) {
      if (args[0] === 'branch') return options.branch ?? 'main'
      if (args[0] === 'status') return options.status ?? ''
      throw new Error(`Unexpected git output call: ${args.join(' ')}`)
    },
    async succeeds(args) {
      if (args[0] === 'rev-parse') return options.tagExists ?? false
      throw new Error(`Unexpected git succeeds call: ${args.join(' ')}`)
    },
  }
}

describe('release safety', () => {
  test('bumps semantic versions', () => {
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4')
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0')
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0')
    expect(bumpVersion('1.2.3', '4.5.6')).toBe('4.5.6')
  })

  test('rejects malformed, repeated, and decreasing versions', () => {
    expect(() => bumpVersion('current', 'patch')).toThrow('not semantic')
    expect(() => bumpVersion('1.2.3', '1.2.3')).toThrow('must be greater')
    expect(() => bumpVersion('1.2.3', '1.2.2')).toThrow('must be greater')
    expect(() => bumpVersion('1.2.3', '1.1.9')).toThrow('must be greater')
  })

  test('rejects release from a non-main branch', async () => {
    await expect(assertReleaseGitState('v1.2.4', fakeGit({ branch: 'dev' }))).rejects.toThrow(
      'Release must run from main',
    )
  })

  test('rejects dirty tracked state and existing tags', async () => {
    await expect(assertReleaseGitState('v1.2.4', fakeGit({ status: ' M desktop/package.json' }))).rejects.toThrow(
      'clean tracked worktree and index',
    )
    await expect(assertReleaseGitState('v1.2.4', fakeGit({ tagExists: true }))).rejects.toThrow(
      'tag already exists',
    )
  })

  test('accepts clean main with a new tag', async () => {
    await expect(assertReleaseGitState('v1.2.4', fakeGit())).resolves.toBeUndefined()
  })
})
